// Soak the MCP link and profile every tool it drives — the two Phase 4 questions in one run.
//
//   node apps/e2e/soak.mjs                 # against a bench-app already on :4310
//   node apps/e2e/soak.mjs --rounds 40     # longer soak
//   node apps/e2e/soak.mjs --record        # append a row to bench/soak-history.jsonl + rewrite the profile
//   node apps/e2e/soak.mjs --self-check    # prove the gate can go RED without touching a daemon
//
// WHY THIS EXISTS
//
// "The MCP connection breaks a lot" is the oldest open complaint about this product, and every gate
// in this repo answers it with a boolean. A boolean cannot express "a lot", and a number nobody
// RECORDS cannot regress — so a link that quietly degrades from 1 drop in 500 calls to 1 in 20 would
// pass every check here today, right up until a user notices. This records the rate.
//
// It also answers the sharper question: WHICH tool is breaking. `mcp-stress-test` proves the server
// survives; `tool-surface-sweep` proves each tool is callable once. Neither says that
// `reticle_snapshot` fails one time in thirty, because one call cannot have a failure rate.
//
// WHAT IS GATED, AND WHAT IS DELIBERATELY NOT
//
//   HARD GATE   answer rate. Every call must be ANSWERED — the product's own claim, and the thing
//               `transport-faults-test` proves under injected faults. Deterministic: a call is
//               answered or it is not.
//   HARD GATE   per-tool failure rate, against the recorded baseline. Also deterministic.
//   RECORDED    latency (p50/p95/max, per tool). NOT gated on an absolute duration, ever.
//
// That last line is a deliberate deviation from the phrase "latency budget" in the plan, and the
// reason is written down in CLAUDE.md: timing assertions are a bug. A p95 budget in wall-clock
// milliseconds is a statement about the machine, so it goes red only under parallel CI load — which
// teaches everyone to re-run it, and a gate people re-run is a gate that has stopped working. The
// number is still worth having, so it is recorded, printed, and diffed against the baseline as a
// LOUD WARN. A human reads a 4x p95 jump; a robot must not fail the build for it.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// NOT imported at the top. `mcp-client.mjs` resolves the built CLI at module load and THROWS if
// `packages/server/dist/cli.js` is absent — so a static import would make `--self-check` require a
// full build, when the entire point of the self-check is that it needs no infrastructure at all.
// Caught by running it in an empty directory rather than by assuming; it is imported at the one
// place that genuinely needs a CLI, below.
import { waitForSession } from './wait-for-session.mjs';
import { sweepBatteryOrphans, transportAlive, Attribution, attributeOutcome } from './gate-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = process.env.RETICLE_PORT ?? '4400';
const APP = process.env.SOAK_APP_URL ?? 'http://localhost:4310/';
const HISTORY = path.join(ROOT, 'bench', 'soak-history.jsonl');
const PROFILE = path.join(ROOT, 'bench', 'TOOL-PROFILE.md');

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};
const ROUNDS = Number(arg('--rounds', '20'));
const RECORD = process.argv.includes('--record');
/**
 * Idle time between rounds, and the difference between a soak and a call-volume test.
 *
 * 150 calls back-to-back complete in seconds and prove throughput. They cannot prove the thing users
 * actually report, which is the link dying while NOBODY is calling it — the agent is thinking, the
 * connection sits idle, and the next tool call finds it gone. Keep-alives, idle shutdown and proxy
 * timeouts all live in that gap, and a soak with no idle never enters it.
 *
 * Default is small so CI stays fast; `--idle-ms 30000 --rounds 60` is a half-hour soak for a release.
 */
const IDLE_MS = Number(arg('--idle-ms', '250'));

/**
 * The rotation, and the honest limit of this profile.
 *
 * Read-only tools only, chosen because a soak REPEATS them: driving `reticle_act` two hundred times
 * mutates the app out from under later rounds, and then a rising failure rate measures the fixture
 * drifting rather than the tool degrading. The coverage number is printed rather than rounded up —
 * this profiles the repeatable surface, not all 48 advertised tools, and saying otherwise would make
 * the artifact lie in the direction that flatters it.
 */
const ROTATION = [
  { name: 'reticle_sessions', args: {} },
  { name: 'reticle_snapshot', args: {} },
  { name: 'reticle_query', args: { by: 'role', value: 'button' } },
  { name: 'reticle_console', args: {} },
  { name: 'reticle_network', args: {} },
  { name: 'reticle_capabilities', args: {} },
];

/** A call that took longer than this is reported as a suspected hang, not averaged into a p95. */
const HANG_SUSPECT_MS = 30_000;
/** A p95 this many times the baseline is shouted about. It never fails the run — see the header. */
const LATENCY_SHOUT_FACTOR = 4;
/**
 * ...but only once it is also slow in absolute terms.
 *
 * Without this floor the first real run shouted "reticle_sessions p95 8ms vs 1ms (>4x)", which is
 * true, meaningless, and exactly how a warning channel dies: a ratio on a 1ms baseline crosses 4x
 * from ordinary scheduler noise, so every run warns and people stop reading the warnings. A jump
 * nobody could perceive is not worth a line of output.
 */
const LATENCY_SHOUT_FLOOR_MS = 50;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Per-tool roll-up. Latency is descriptive; `failures`/`unanswered` are what the gate reads. */
export function summarise(calls) {
  const byTool = new Map();
  for (const call of calls) {
    const entry = byTool.get(call.name) ?? { name: call.name, calls: 0, failures: 0, unanswered: 0, ms: [] };
    entry.calls += 1;
    if (call.answered !== true) entry.unanswered += 1;
    else if (call.failed === true) entry.failures += 1;
    entry.ms.push(call.ms);
    byTool.set(call.name, entry);
  }
  return [...byTool.values()]
    .map((entry) => {
      const sorted = [...entry.ms].sort((a, b) => a - b);
      return {
        name: entry.name,
        calls: entry.calls,
        failures: entry.failures,
        unanswered: entry.unanswered,
        failureRate: entry.calls === 0 ? 0 : (entry.failures + entry.unanswered) / entry.calls,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        max: sorted.at(-1) ?? 0,
      };
    })
    .sort((a, b) => b.failureRate - a.failureRate || b.p95 - a.p95);
}

/**
 * The gate. Answer rate and failure rate only — see the header for why latency is not in here.
 *
 * `baseline` may be null (first ever run): a first run establishes the number and cannot regress
 * against nothing, but it can still fail the absolute claim that every call is answered.
 */
export function gateSoak(row, baseline) {
  const failures = [];
  const warnings = [];

  // `attributeOutcome` returns { outcome, because } — NOT a bare string. Comparing the object to
  // Attribution.INCONCLUSIVE silently never matched, so this guard was dead code in the real path
  // while the self-check passed, because the self-check hand-fed it a string production never
  // produces. It now reads `.outcome`, and the self-check below calls the real function.
  if (row.attribution?.outcome === Attribution.INCONCLUSIVE) {
    // Never attribute to the product what the transport can explain — harness rule 4.
    return {
      failures: [],
      warnings: [`INCONCLUSIVE: ${String(row.attribution.because)}`],
      inconclusive: true,
    };
  }

  if (row.answered !== row.calls) {
    failures.push(
      `${String(row.calls - row.answered)} of ${String(row.calls)} calls were never answered — ` +
        'every call must be answered, which is the claim transport-faults-test proves under injected faults',
    );
  }
  if (row.linkDrops > 0) {
    failures.push(
      `the held-open MCP link dropped ${String(row.linkDrops)} time(s) while the transport was up — ` +
        'a soak holds ONE connection; a drop here is the disconnection users report',
    );
  }
  for (const tool of row.perTool) {
    if (tool.failureRate === 0) continue;
    const before = baseline?.perTool?.find((t) => t.name === tool.name);
    // No baseline for this tool: any failure at all is new information and blocks.
    if (before === undefined || tool.failureRate > before.failureRate) {
      failures.push(
        `${tool.name} failed ${String(tool.failures + tool.unanswered)}/${String(tool.calls)} ` +
          `(${(tool.failureRate * 100).toFixed(1)}%${before === undefined ? ', no recorded baseline' : `, was ${(before.failureRate * 100).toFixed(1)}%`})`,
      );
    }
  }
  for (const tool of row.perTool) {
    const before = baseline?.perTool?.find((t) => t.name === tool.name);
    if (
      before !== undefined &&
      before.p95 > 0 &&
      tool.p95 >= LATENCY_SHOUT_FLOOR_MS &&
      tool.p95 > before.p95 * LATENCY_SHOUT_FACTOR
    ) {
      warnings.push(
        `${tool.name} p95 ${String(tool.p95)}ms vs ${String(before.p95)}ms recorded ` +
          `(>${String(LATENCY_SHOUT_FACTOR)}x). NOT failing the run — read it, do not re-run it.`,
      );
    }
    if (tool.max >= HANG_SUSPECT_MS) {
      warnings.push(`${tool.name} had a call of ${String(tool.max)}ms — suspected hang, worth a look`);
    }
  }
  return { failures, warnings, inconclusive: false };
}

function lastRow() {
  if (!existsSync(HISTORY)) return null;
  const lines = readFileSync(HISTORY, 'utf8').trim().split('\n').filter(Boolean);
  const last = lines.at(-1);
  return last === undefined ? null : JSON.parse(last);
}

function renderProfile(row) {
  const lines = [
    '# Tool profile',
    '',
    '> Per-tool latency and failure rate under a held-open MCP link.',
    '> Generated by `node apps/e2e/soak.mjs --record` — do not edit by hand.',
    '',
    `**${String(row.calls)} calls** over ${String(row.rounds)} rounds on one connection, ` +
      `${String(row.idleMs)}ms idle between rounds (${String(row.soakSeconds)}s total) · ` +
      `answered ${String(row.answered)}/${String(row.calls)} · link drops ${String(row.linkDrops)} · ` +
      `${row.date} · \`${row.git_sha}\``,
    '',
    'Latency is **recorded, not gated**. A wall-clock budget is a statement about the machine and',
    'goes red only under load, which teaches people to re-run the gate. Failure rate is gated.',
    '',
    `Profiles the ${String(row.perTool.length)} repeatable read-only tools, not all ` +
      `${String(row.advertised)} advertised — a soak that repeats a mutating tool measures the ` +
      'fixture drifting, not the tool degrading.',
    '',
    '| tool | calls | failures | failure rate | p50 | p95 | max |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const tool of row.perTool) {
    lines.push(
      `| \`${tool.name}\` | ${String(tool.calls)} | ${String(tool.failures + tool.unanswered)} ` +
        `| ${(tool.failureRate * 100).toFixed(1)}% | ${String(tool.p50)}ms | ${String(tool.p95)}ms | ${String(tool.max)}ms |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

// ── self-check ────────────────────────────────────────────────────────────────────────────────
// A gate that has never been watched failing is not a gate. Synthetic rows only — no daemon, no app.
function selfCheck() {
  const ok = (cond, msg) => {
    if (!cond) {
      console.error(`self-check FAILED: ${msg}`);
      process.exit(1);
    }
    console.log(`   ✅ ${msg}`);
  };
  const clean = {
    calls: 100,
    answered: 100,
    linkDrops: 0,
    // The REAL function, not a hand-written literal. The first version of this self-check wrote the
    // string `Attribution.INCONCLUSIVE` here, which is a shape attributeOutcome never returns — so
    // every case below passed while the guard they were checking could not fire.
    attribution: attributeOutcome({ connected: true, transportAliveThroughout: true }),
    perTool: [{ name: 'reticle_snapshot', calls: 100, failures: 0, unanswered: 0, failureRate: 0, p50: 10, p95: 20, max: 30 }],
  };
  ok(gateSoak(clean, null).failures.length === 0, 'a clean soak passes');
  ok(
    gateSoak({ ...clean, answered: 97 }, null).failures.length > 0,
    'three unanswered calls FAIL — every call must be answered',
  );
  ok(
    gateSoak({ ...clean, linkDrops: 1 }, null).failures.length > 0,
    'one link drop FAILS — the soak holds a single connection',
  );
  const flaky = {
    ...clean,
    perTool: [{ name: 'reticle_snapshot', calls: 100, failures: 3, unanswered: 0, failureRate: 0.03, p50: 10, p95: 20, max: 30 }],
  };
  ok(gateSoak(flaky, null).failures.length > 0, 'a 3% tool failure rate with no baseline FAILS');
  ok(
    gateSoak(flaky, { perTool: [{ name: 'reticle_snapshot', failureRate: 0.05, p95: 20 }] }).failures.length === 0,
    'the same 3% passes against a recorded 5% baseline — it improved',
  );
  ok(
    gateSoak(flaky, { perTool: [{ name: 'reticle_snapshot', failureRate: 0.01, p95: 20 }] }).failures.length > 0,
    '3% against a recorded 1% FAILS — that is the regression this exists to catch',
  );
  const slow = {
    ...clean,
    perTool: [{ name: 'reticle_snapshot', calls: 100, failures: 0, unanswered: 0, failureRate: 0, p50: 10, p95: 500, max: 500 }],
  };
  const slowResult = gateSoak(slow, { perTool: [{ name: 'reticle_snapshot', failureRate: 0, p95: 20 }] });
  ok(slowResult.failures.length === 0, 'a 25x p95 blowout does NOT fail the run');
  ok(slowResult.warnings.length > 0, '...but it is shouted about, which is the whole compromise');
  // The floor, learned from the first real run shouting "8ms vs 1ms (>4x)".
  const jitter = {
    ...clean,
    perTool: [{ name: 'reticle_snapshot', calls: 100, failures: 0, unanswered: 0, failureRate: 0, p50: 1, p95: 8, max: 9 }],
  };
  ok(
    gateSoak(jitter, { perTool: [{ name: 'reticle_snapshot', failureRate: 0, p95: 1 }] }).warnings.length === 0,
    'an 8x jump on a 1ms baseline is SILENT — sub-perceptible noise must not train people to ignore warnings',
  );
  const deadTransport = attributeOutcome({ connected: false, transportAliveThroughout: false });
  ok(
    gateSoak({ ...clean, answered: 0, attribution: deadTransport }, null).inconclusive === true,
    'a dead transport is INCONCLUSIVE, never a product failure — harness rule 4',
  );
  ok(
    gateSoak({ ...clean, answered: 0, attribution: deadTransport }, null).failures.length === 0,
    '...and it raises NO failures, so a flaky machine never reads as a broken product',
  );
  ok(
    attributeOutcome({
      connected: true,
      transportAliveThroughout: true,
      hasCapabilities: false,
    }).outcome === Attribution.FAIL,
    'connected with hasCapabilities:false is a FAIL — connected is not verifiable',
  );
  ok(
    attributeOutcome({ connected: true, transportAliveThroughout: true }).outcome === Attribution.PASS,
    'omitting hasCapabilities keeps the soak meaning: the link stayed up',
  );
  console.log('\nsoak self-check: ok (the gate refuses what it must, and tolerates what it must)\n');
}

if (process.argv.includes('--self-check')) {
  selfCheck();
  process.exit(0);
}

// ── the soak ──────────────────────────────────────────────────────────────────────────────────
await sweepBatteryOrphans([], { onNote: (n) => console.log(`   · ${n}`) });

const { McpStdioClient } = await import('../../bench/harness/mcp-client.mjs');
const client = new McpStdioClient(
  'node',
  ['packages/server/dist/cli.js', 'mcp', '--port', PORT, '--drive', APP],
  { RETICLE_PORT: PORT, RETICLE_ADVERTISE_ALL_TOOLS: '1', RETICLE_TELEMETRY: '0' },
);

console.log(`\n=== SOAK: ${String(ROUNDS)} rounds x ${String(ROTATION.length)} tools on ONE held-open link ===`);
await client.start();

const advertised = await client.listTools();
const takesSession = new Set(
  advertised.filter((t) => t.inputSchema?.properties?.sessionId !== undefined).map((t) => t.name),
);

const callOnce = async (name, args) => {
  const started = Date.now();
  try {
    const result = await client.request('tools/call', { name, arguments: args }, 60_000);
    const text = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { answered: true, failed: result?.isError === true, ms: Date.now() - started, parsed };
  } catch (error) {
    // A throw here is the call never coming back — a timeout or a dead transport. That is the
    // population this soak exists to count, so it is `answered: false`, distinct from a tool that
    // answered with a refusal.
    return { answered: false, failed: true, ms: Date.now() - started, error: String(error.message) };
  }
};

const [driven] = await waitForSession(
  async () => (await callOnce('reticle_sessions', {})).parsed?.sessions ?? [],
  (s) => String(s?.url ?? '').startsWith(APP),
  { what: `the driven app on ${APP}` },
);
const DRIVEN = driven.sessionId ?? driven.id;

const SOAK_STARTED = Date.now();
const calls = [];
let linkDrops = 0;
let transportHeld = true;
for (let round = 1; round <= ROUNDS; round += 1) {
  for (const step of ROTATION) {
    const args = takesSession.has(step.name) ? { sessionId: DRIVEN, ...step.args } : step.args;
    const result = await callOnce(step.name, args);
    calls.push({ name: step.name, ...result });
  }
  // The link is meant to survive the whole soak. Check the transport rather than inferring from a
  // failed call: a tool can refuse for its own reasons while the connection is perfectly healthy.
  if (!(await transportAlive(Number(PORT)))) {
    transportHeld = false;
  } else if (!transportHeld) {
    linkDrops += 1;
    transportHeld = true;
  }
  if (round % 5 === 0) {
    const answered = calls.filter((c) => c.answered).length;
    console.log(`   round ${String(round)}/${String(ROUNDS)} — ${String(answered)}/${String(calls.length)} answered`);
  }
  // Let the link go quiet. This is where the reported disconnects happen, so a soak that never
  // pauses is measuring the wrong window.
  if (IDLE_MS > 0 && round < ROUNDS) await new Promise((r) => setTimeout(r, IDLE_MS));
}

await client.stop();

const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ?? 'unknown';
const row = {
  date: new Date().toISOString().slice(0, 10),
  git_sha: sha,
  rounds: ROUNDS,
  idleMs: IDLE_MS,
  soakSeconds: Math.round((Date.now() - SOAK_STARTED) / 1000),
  calls: calls.length,
  answered: calls.filter((c) => c.answered).length,
  linkDrops,
  advertised: advertised.length,
  // `connected` is not "a session existed once" — by here one provably did, or waitForSession would
  // have exited. It is whether the link was still up at the end. Passing a bare `true` made a soak
  // whose transport died report PASS, which is the exact misattribution rule 4 exists to prevent.
  attribution: attributeOutcome({ connected: transportHeld, transportAliveThroughout: transportHeld }),
  perTool: summarise(calls),
};

const baseline = lastRow();
const { failures, warnings, inconclusive } = gateSoak(row, baseline);

console.log('\n=== PROFILE ===');
for (const tool of row.perTool) {
  console.log(
    `   ${tool.failureRate > 0 ? '❌' : '✅'} ${tool.name.padEnd(24)} ` +
      `${String(tool.calls).padStart(4)} calls  ${(tool.failureRate * 100).toFixed(1).padStart(5)}% fail  ` +
      `p50 ${String(tool.p50).padStart(5)}ms  p95 ${String(tool.p95).padStart(5)}ms`,
  );
}
console.log(
  `\n   answered ${String(row.answered)}/${String(row.calls)} · link drops ${String(row.linkDrops)} · ` +
    `${String(row.attribution.outcome)} — ${String(row.attribution.because)}`,
);
for (const warning of warnings) console.log(`   ⚠  ${warning}`);

if (RECORD) {
  appendFileSync(HISTORY, `${JSON.stringify(row)}\n`);
  writeFileSync(PROFILE, renderProfile(row));
  console.log(`\n   recorded → bench/soak-history.jsonl, bench/TOOL-PROFILE.md`);
}

if (inconclusive) {
  console.log('\n⚠  INCONCLUSIVE — the transport did not stay up, so nothing is claimed about the product.\n');
  process.exit(0);
}
if (failures.length > 0) {
  console.error(`\n❌ soak gate FAILED:\n${failures.map((f) => `   - ${f}`).join('\n')}\n`);
  process.exit(1);
}
console.log('\n✅ soak gate passed\n');
