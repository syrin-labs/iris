#!/usr/bin/env node
// The behaviour matrix: what every advertised tool ACTUALLY does, recorded rather than described.
//
//   node bench/harness/behaviour-matrix.mjs --port 4460 --app http://localhost:4319/
//   node bench/harness/behaviour-matrix.mjs --update-baseline
//
// Why this exists: SKILL.md (22KB), the cheat sheet (19KB) and usage.md (70KB) were all WRITTEN,
// not measured, and every one of them drifted. Measured 2026-08-23: the canonical recipe in
// SKILL.md calls a tool the default surface does not advertise; usage.md teaches the act ->
// observe -> assert loop that tool-surface.ts records as the top field regression; and
// `act_and_wait` with no `until` returned `verified:"yes"` while no page of 66 said so, because
// nobody ran it.
//
// So the manual is GENERATED from what a probe returned. A claim with no probe behind it does not
// go in the manual. When a probe's answer changes, the baseline diff reddens and somebody decides
// whether the change was intended.
//
// Deliberately NOT a test file: it needs a live daemon and a live app, which is the whole point.
// `behaviour-baseline.json` is what the fast gate compares against.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './mcp-line-client.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE = join(ROOT, 'bench', 'behaviour-baseline.json');
const MANUAL = join(ROOT, 'docs', 'reticle-manual.md');
const CLI = join(ROOT, 'packages', 'server', 'dist', 'cli.js');

const argv = process.argv.slice(2);
const flag = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const PORT = Number(flag('--port', '4460'));
const APP = flag('--app', 'http://localhost:4319/');
const UPDATE = argv.includes('--update-baseline');

/**
 * How a result is classified. The names are the vocabulary the manual is written in, so they are
 * about what the AGENT sees, not about how the server got there.
 */
const Outcome = {
  VERIFIED: 'verified:yes',
  FAILED: 'verified:no',
  UNKNOWN: 'verified:unknown',
  NO_FAULT: 'verified:no-fault',
  OK: 'ran',
  REFUSED_TEACHING: 'refused (names the fix)',
  REFUSED_BARE: 'refused (no fix named)',
  TIMEOUT: 'timed out',
};

/** A refusal earns TEACHING only if an agent could act on it without reading anything else. */
const TEACHES =
  /a valid call looks like|did you mean|expected|available|instead|pass a |call reticle_|use reticle_|valid \w+ are/i;

/**
 * Only these draw a verdict. Everything else that happens to CONTAIN the word is reporting somebody
 * else's: `reticle_context` returns `proven: [{ verified: "yes" }]`, the run's memory of verdicts
 * already taken, and reading that as the context tool's own answer flipped it from `ran` to
 * `verified:yes` between two identical runs. Which is the gate working — it caught a change that
 * was real, in this classifier.
 */
const VERDICT_TOOLS = new Set([
  'reticle_act_and_wait',
  'reticle_assert',
  'reticle_verify',
  'reticle_reconcile',
]);

function classify(reply, text, tool) {
  if (true === reply.__timeout) return Outcome.TIMEOUT;
  if (true === reply.result?.isError || reply.error !== undefined)
    return TEACHES.test(text) ? Outcome.REFUSED_TEACHING : Outcome.REFUSED_BARE;
  if (!VERDICT_TOOLS.has(tool)) return Outcome.OK;
  for (const [needle, out] of [
    ['"verified":"yes"', Outcome.VERIFIED],
    ['"verified":"no-fault"', Outcome.NO_FAULT],
    ['"verified":"no"', Outcome.FAILED],
    ['"verified":"unknown"', Outcome.UNKNOWN],
  ])
    if (text.includes(needle)) return out;
  return Outcome.OK;
}

/**
 * The permutation classes. Every tool is probed against the ones that apply to it, so the manual
 * can state what happens for each rather than describing only the happy path.
 */
const CLASS = {
  CANONICAL: 'the documented call',
  MISSING_REQUIRED: 'a required argument omitted',
  UNKNOWN_ARG: 'an argument the tool does not declare',
  BAD_ENUM: 'a value outside the allowed set',
  OUT_OF_RANGE: 'a number outside its range',
  DEAD_REF: 'a ref that no longer resolves',
  NO_EXPECTATION: 'no expectation declared',
};

const results = [];
async function probe(client, { tool, klass, args, note, sid, timeoutMs = 30000 }) {
  const reply = await client.call(
    tool,
    false === sid ? args : { sessionId: sid, ...args },
    timeoutMs,
  );
  const text = String(reply.result?.content?.[0]?.text ?? JSON.stringify(reply.error ?? reply));
  results.push({
    tool,
    class: klass,
    args,
    outcome: classify(reply, text, tool),
    bytes: text.length,
    ...(note === undefined ? {} : { note }),
    excerpt: text.slice(0, 300),
  });
}

async function main() {
  const client = connect({ cli: CLI, port: PORT, cwd: ROOT });
  await client.init();

  const lease = await client.call(
    'reticle_run',
    { tool: 'reticle_lease', args: { action: 'acquire', url: APP } },
    90000,
  );
  const leaseText = String(lease.result?.content?.[0]?.text ?? '');
  if (!leaseText.includes('"ready":true'))
    throw new Error(`no session: ${leaseText.slice(0, 300)}`);

  const sessions = JSON.parse(
    String((await client.call('reticle_sessions', {})).result?.content?.[0]?.text ?? '{}'),
  );
  const sid = (sessions.sessions ?? [])[0]?.sessionId;
  if (sid === undefined) throw new Error('lease reported ready and no session was listed');

  const snapText = String(
    (await client.call('reticle_snapshot', { sessionId: sid, mode: 'interactive' }, 40000)).result
      ?.content?.[0]?.text ?? '',
  );
  const refs = [...snapText.matchAll(/\(ref=(e\d+)\)/g)].map((m) => m[1]);
  if (0 === refs.length) throw new Error('the app rendered no interactive controls to probe');
  const [first] = refs;
  const last = refs[refs.length - 1];

  const P = (tool, klass, args, note, timeoutMs) =>
    probe(client, { tool, klass, args, note, sid, timeoutMs });

  // Read tools: canonical + the two ways an agent gets an argument wrong.
  for (const tool of [
    'reticle_snapshot',
    'reticle_query',
    'reticle_network',
    'reticle_console',
    'reticle_state',
    'reticle_observe',
  ]) {
    await P(tool, CLASS.UNKNOWN_ARG, { thisArgDoesNotExist: 1 });
  }
  await P('reticle_snapshot', CLASS.CANONICAL, { mode: 'interactive' }, undefined, 40000);
  await P('reticle_snapshot', CLASS.BAD_ENUM, { mode: 'not-a-mode' });
  await P('reticle_query', CLASS.CANONICAL, { by: 'role', value: 'button' });
  await P('reticle_query', CLASS.BAD_ENUM, { by: 'telepathy', value: 'x' });
  await P('reticle_network', CLASS.CANONICAL, { limit: 5 });
  await P('reticle_network', CLASS.OUT_OF_RANGE, { limit: -1 });
  await P(
    'reticle_state',
    CLASS.OUT_OF_RANGE,
    { depth: -5 },
    'a negative depth was silently ignored before v2.12.0',
  );
  await P('reticle_state', CLASS.CANONICAL, { depth: 2 });

  // The verdict path — the reason this file exists.
  //
  // Probes are NOT independent: each one leaves the page where it finished, and a predicate that
  // the PREVIOUS probe already made true grades `already_true` (correctly — a consequence that held
  // before the action proves nothing about it). Measured: the canonical declared call read
  // `verified:"unknown"` purely because the probe before it had left the same error on screen.
  // So every verdict probe starts from a reloaded page, and the matrix measures the tool rather
  // than the order this file happens to be written in.
  // The reset RE-SNAPSHOTS: a reload destroys every ref, so reusing one across it is a stale-ref
  // refusal rather than a verdict — which is Reticle behaving correctly and the harness measuring
  // the wrong thing. Returns the button this app's flow ends on.
  const freshButton = async () => {
    await client.call('reticle_navigate', { sessionId: sid, url: APP, reload: true }, 30000);
    const tree = String(
      (await client.call('reticle_snapshot', { sessionId: sid, mode: 'interactive' }, 40000)).result
        ?.content?.[0]?.text ?? '',
    );
    const found = [...tree.matchAll(/\(ref=(e\d+)\)/g)].map((m) => m[1]);
    if (0 === found.length) throw new Error('the reloaded page rendered no controls');
    return found[found.length - 1];
  };

  await P(
    'reticle_act_and_wait',
    CLASS.NO_EXPECTATION,
    { ref: await freshButton(), action: 'click' },
    'no `until`: this returned verified:"yes" before v2.12.0',
  );
  // A real declared consequence — the shape the manual should show as the good call. An explicit
  // `{kind:"settled"}` is deliberately NOT canonical: it is the idle wait, not a claim about the
  // app, and it correctly grades `no-fault`.
  await P(
    'reticle_act_and_wait',
    CLASS.CANONICAL,
    {
      ref: await freshButton(),
      action: 'click',
      until: { kind: 'text', value: 'Invalid email or password' },
      timeout_ms: 6000,
    },
    'a consequence the click CAUSES: the shape that earns verified:"yes"',
  );
  await P(
    'reticle_act_and_wait',
    CLASS.NO_EXPECTATION,
    { ref: await freshButton(), action: 'click', until: { kind: 'settled' } },
    'an explicit `{kind:"settled"}` is the idle wait, not a declaration, so it grades no-fault too',
  );
  await P(
    'reticle_act_and_wait',
    CLASS.BAD_ENUM,
    { ref: last, action: 'click', until: [{ kind: 'text', value: 'x' }] },
    'a bare array is not a predicate',
  );
  await P('reticle_act_and_wait', CLASS.DEAD_REF, { ref: 'e999999', action: 'click' });

  // Acting.
  await P('reticle_act', CLASS.MISSING_REQUIRED, { ref: first });
  await P('reticle_act', CLASS.BAD_ENUM, { ref: first, action: 'teleport' });
  await P(
    'reticle_act',
    CLASS.UNKNOWN_ARG,
    { ref: first, action: 'fill', value: 'x' },
    'action arguments nest under `args`',
  );
  await P('reticle_act', CLASS.CANONICAL, { ref: first, action: 'fill', args: { value: 'probe' } });

  // Asserting.
  await P('reticle_assert', CLASS.MISSING_REQUIRED, {});
  await P('reticle_assert', CLASS.CANONICAL, {
    predicate: { kind: 'text', value: 'Sign in' },
    timeout_ms: 3000,
  });

  // The meta tools, which are how an agent reaches everything unadvertised.
  await P('reticle_tools', CLASS.CANONICAL, {}, undefined, 20000);
  await probe(client, {
    tool: 'reticle_run',
    klass: CLASS.BAD_ENUM,
    args: { tool: 'reticle_nope', args: {} },
    sid: false,
  });
  await probe(client, {
    tool: 'reticle_run',
    klass: CLASS.CANONICAL,
    args: { tool: 'reticle_context', args: {} },
    sid: false,
    timeoutMs: 30000,
  });

  // Release the lease. A pooled context lives 300s, so a few back-to-back runs exhaust the pool and
  // the next one dies on "no session" — which looks exactly like a broken app and is not.
  const leaseId = JSON.parse(leaseText).sessionId;
  if ('string' === typeof leaseId)
    await client.call(
      'reticle_run',
      { tool: 'reticle_lease', args: { action: 'release', sessionId: leaseId } },
      30000,
    );

  client.close();
  return results;
}

/** Group by tool, preserving first-probed order — the manual reads in the order an agent meets them. */
function byTool(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.tool)) out.set(r.tool, []);
    out.get(r.tool).push(r);
  }
  return out;
}

function renderManual(rows) {
  // Frontmatter, not an H1: docs.json publishes this page and the index guard requires
  // title/description and forbids a duplicate H1 under it. A colon inside a value must be quoted
  // or the page silently 404s on the docs site, which nothing else in CI would catch.
  const lines = [
    '---',
    "title: 'Reticle: what each tool actually does'",
    'description: Generated from real calls against a running app. Every row is a probe that ran and the answer it got.',
    'icon: table-list',
    '---',
    '',
    '**Generated by `bench/harness/behaviour-matrix.mjs`. Do not edit by hand.**',
    '',
    // One line per paragraph: prettier reflows markdown prose, so a hard-wrapped paragraph here
    // comes back reformatted and the format gate blocks the next commit. Generating what prettier
    // would produce means running the matrix never leaves a dirty tree.
    'Every row below is a call that was made against a running app and the answer that came back. Nothing here is described from the source or from intent. If a claim has no probe behind it, it is not in this file. That is the whole point: the hand-written guides drifted, and the drift was invisible because nobody ran them.',
    '',
    '`refused (names the fix)` means the error told you what to call instead, so you can correct without reading anything else. `refused (no fix named)` means it did not.',
    '',
  ];
  for (const [tool, probes] of byTool(rows)) {
    lines.push(`## ${tool}`, '');
    lines.push('| you call it with | you get back | bytes |');
    // Spaced pipes: prettier's markdown table style. Same reason as the prose above.
    lines.push('| --- | --- | --- |');
    for (const p of probes) {
      const args = JSON.stringify(p.args).replace(/\|/g, '\\|');
      lines.push(`| ${p.class}: \`${args}\` | ${p.outcome} | ${String(p.bytes)} |`);
    }
    lines.push('');
    for (const p of probes.filter((x) => x.note !== undefined)) lines.push(`- ${p.note}`, '');
  }
  return lines.join('\n');
}

/**
 * The comparison the gate makes: outcome per (tool, class, args). Byte counts move run to run and
 * are deliberately excluded — a payload growing 40 bytes is not a behaviour change.
 *
 * Live refs are normalised to `<ref>` because they are minted fresh on every snapshot: a page
 * reloaded between probes hands out `e105`, then `e205`, then `e304`, so keying on the literal
 * would report every run as entirely new and the gate would never mean anything. A ref that must
 * NOT resolve (`e999999`) keeps its literal value — the whole point of that probe is the number.
 */
const normalise = (args) => JSON.stringify(args).replace(/"e\d{1,4}"/g, '"<ref>"');
/**
 * Hand the written manual to the repo's own formatter.
 *
 * The format gate covers `docs/`, so a generated page has to come out the way prettier would write
 * it or the next commit is blocked by a file nobody edited. Reproducing its markdown rules here —
 * prose reflow, then table column padding — was two rounds of chasing and would break again the
 * next time the config moved. Calling the formatter cannot drift from the gate, because it IS the
 * gate.
 *
 * Best-effort: a checkout without prettier still gets a correct manual, just an unformatted one.
 */
function formatWritten(file) {
  const r = spawnSync('npx', ['prettier', '--write', '--log-level', 'silent', file], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  if (0 !== r.status) console.log(`note: could not format ${file} — run \`pnpm format\` yourself`);
}

const shape = (rows) =>
  Object.fromEntries(rows.map((r) => [`${r.tool} | ${r.class} | ${normalise(r.args)}`, r.outcome]));

const rows = await main();
const now = shape(rows);

if (UPDATE || !existsSync(BASELINE)) {
  writeFileSync(BASELINE, `${JSON.stringify({ probes: rows.length, shape: now }, null, 2)}\n`);
  writeFileSync(MANUAL, `${renderManual(rows)}\n`);
  formatWritten(MANUAL);
  console.log(
    `wrote ${String(rows.length)} probes to behaviour-baseline.json and docs/reticle-manual.md`,
  );
  process.exit(0);
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8')).shape;
const changed = Object.keys(now).filter((k) => base[k] !== undefined && base[k] !== now[k]);
const added = Object.keys(now).filter((k) => base[k] === undefined);
const gone = Object.keys(base).filter((k) => now[k] === undefined);

writeFileSync(MANUAL, `${renderManual(rows)}\n`);
formatWritten(MANUAL);
for (const k of changed) console.log(`CHANGED  ${k}\n  was ${base[k]}\n  now ${now[k]}`);
for (const k of added) console.log(`NEW      ${k} -> ${now[k]}`);
for (const k of gone) console.log(`MISSING  ${k} (was ${base[k]})`);

if (0 === changed.length && 0 === gone.length) {
  console.log(`behaviour matrix: ${String(rows.length)} probes, no behaviour changed`);
  process.exit(0);
}
console.log(
  '\nBehaviour changed. If that was intended, re-run with --update-baseline and commit the diff.',
);
process.exit(1);
