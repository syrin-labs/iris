#!/usr/bin/env node
// Does an agent that has LOST ITS CONTEXT still verify correctly?
//
//   ANTHROPIC_API_KEY=sk-... node bench/harness/long-horizon.mjs --app http://localhost:4319/
//
// Every claim this project makes about long-running agents has been unevidenced, because no
// regime in the repo runs long enough to lose anything. `soak.mjs` holds a connection for 39
// seconds over six read-only tools. `stress-tiers.mjs` varies DOM size, `leak-stress.mjs` varies
// session count, `multi-agent-throughput.mjs` varies concurrency. None of them varies the one axis
// the claim is about: how much the agent still remembers.
//
// `bench/raw/long-horizon-bench.json` exists and cannot be reproduced — no script produces it, so
// it is a number with no method behind it. This file is the method.
//
// WHAT COMPACTION IS HERE: the harness owns the message array, so it can do exactly what a client
// does when the window fills — drop the earlier turns and keep going. That is not a simulation of
// compaction, it IS compaction, performed by the same mechanism and at a chosen point so the two
// arms lose the same thing.
//
// THE TWO ARMS:
//   remembers  — history intact, the control
//   compacted  — history truncated to the last exchange at the halfway turn
//
// What is measured after the cut: does it still reach a verdict, is the verdict right, how many
// calls does it spend rediscovering what it already knew, and does it re-derive state by driving
// the app again rather than asking for it.
//
// Reports NOT MEASURED and exits 0 without a key. It never fabricates a number.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './mcp-line-client.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'bench', 'raw', 'long-horizon.json');

/** Read the key from the environment or the repo `.env`, so a local run needs no export. */
function apiKey() {
  if (process.env['ANTHROPIC_API_KEY'] !== undefined) return process.env['ANTHROPIC_API_KEY'];
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return undefined;
  const m = /^ANTHROPIC_API_KEY\s*=\s*(.+)$/m.exec(readFileSync(envFile, 'utf8'));
  return m?.[1]?.trim().replace(/^["']|["']$/g, '');
}

const KEY = apiKey();
const MODEL = process.env['BENCH_MODEL'] ?? 'claude-haiku-4-5-20251001';
const argv = process.argv.slice(2);
const flag = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const APP = flag('--app', 'http://localhost:4319/');
const PORT = Number(flag('--port', '4460'));
const TURNS = Number(flag('--turns', '14'));
/**
 * The turn the history is cut at.
 *
 * Deliberately EARLY, not halfway. The first working run cut at turn 7 of 14 and the agent reached
 * its verdict in 4 — so the cut never fired, `callsAfterCut` was 0, and the regime reported two
 * arms that had both simply done the task. A compaction experiment where compaction never happens
 * is not a null result, it is no experiment, and it reads exactly like a null result.
 *
 * Turn 2 is after the agent has snapshotted and acted at least once, so there is real state to
 * lose, and before any plausible verdict.
 */
const CUT_AT = Number(flag('--cut-at', '2'));

if (KEY === undefined) {
  console.log(
    JSON.stringify(
      {
        regime: 'long-horizon',
        status: 'NOT MEASURED',
        reason:
          'ANTHROPIC_API_KEY is not set and .env does not carry one. This regime needs a real model choosing its own calls; without one there is nothing to measure and nothing will be invented.',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const SYSTEM = [
  'You are a verification agent driving a real running web app through Reticle tools.',
  'Work through the task step by step. When you are confident, end your final message with',
  'exactly "VERDICT: PASS" or "VERDICT: FAIL".',
  'A result may carry `verify_next`. If it does, it tells you the next call worth making.',
].join(' ');

/**
 * A task long enough to build state worth losing, on the bench app's login flow.
 *
 * Deliberately multi-part: a single click would finish before the cut and measure nothing.
 */
const TASK = [
  'Verify the login form on this app rejects bad credentials.',
  'Look at the page, fill the email and password fields with obviously wrong values,',
  'submit, and confirm the app actually reports the failure to the user.',
  'Do not report success unless you have a verdict that says so.',
].join(' ');

async function callAnthropic(messages, tools) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM, tools, messages }),
  });
  if (!r.ok) throw new Error(`anthropic ${String(r.status)}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

/** MCP tool defs in the shape the Messages API wants. */
const toAnthropicTools = (tools) =>
  tools.map((t) => ({
    name: t.name,
    description: String(t.description ?? '').slice(0, 1024),
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
  }));

/**
 * Run one arm.
 *
 * `compact` cuts the history at `CUT_AT` to the last exchange only, which is what a client does
 * when the window fills. The system prompt and the original task survive, because those survive a
 * real compaction too — what is lost is the middle: which refs were minted, what was already
 * driven, what was already proved.
 */
async function runArm(compact) {
  const client = connect({ cli: join(ROOT, 'packages/server/dist/cli.js'), port: PORT, cwd: ROOT });
  await client.init();
  const tools = toAnthropicTools((await client.listTools()).result?.tools ?? []);

  // Refuse to run against a dead environment. The first attempt at this regime ran with no daemon
  // listening: every tool call errored, the model gave up after one turn, and the harness printed
  // a complete-looking report of zeros — `verdict: NONE`, `rediscoveryCalls: 0` — that could be
  // read as a finding about compaction. It was a finding about nothing being switched on. A
  // measurement that cannot distinguish "no effect" from "no experiment" is worse than no number.
  const probe = await client.call('reticle_sessions', {}, 20000);
  const probeText = String(probe.result?.content?.[0]?.text ?? '');
  if (!probeText.includes('"sessionId"')) {
    client.close();
    throw new Error(
      `no live session before the ${compact ? 'compacted' : 'remembers'} arm — the app or the ` +
        `daemon is not up, so this arm would measure the environment rather than the agent. ` +
        `Start both and re-run. Probe said: ${probeText.slice(0, 200)}`,
    );
  }

  const messages = [{ role: 'user', content: TASK }];
  const calls = [];
  let cut = false;
  let verdict = '';
  let inTok = 0;
  let outTok = 0;

  for (let turn = 0; turn < TURNS; turn++) {
    if (compact && turn === CUT_AT && messages.length > 1) {
      // Collapse to the task plus a note that the middle is gone.
      //
      // The first attempt kept "the task and the last exchange" by splicing out the middle, which
      // produced an INVALID conversation: a `tool_result` whose matching `tool_use` had just been
      // removed, and the API rejected it outright. A real compaction never does that — it replaces
      // the middle with a summary and leaves a valid boundary.
      //
      // This is the worst honest case rather than the typical one: a real client usually carries a
      // summary of what was learned, and this carries none. It measures recovery from total loss,
      // which is the floor. A summary-carrying variant is a separate arm, not a tweak to this one.
      messages.length = 0;
      messages.push({
        role: 'user',
        content: `${TASK}\n\n[Your earlier turns in this session were compacted away. You have already started this task against a live app. Re-establish what you need before concluding.]`,
      });
      cut = true;
    }
    const resp = await callAnthropic(messages, tools);
    inTok += resp.usage?.input_tokens ?? 0;
    outTok += resp.usage?.output_tokens ?? 0;
    messages.push({ role: 'assistant', content: resp.content });

    const text = (resp.content ?? [])
      .filter((c) => 'text' === c.type)
      .map((c) => c.text)
      .join(' ');
    if (/VERDICT:\s*(PASS|FAIL)/i.test(text)) {
      verdict = /VERDICT:\s*PASS/i.test(text) ? 'PASS' : 'FAIL';
      break;
    }

    const uses = (resp.content ?? []).filter((c) => 'tool_use' === c.type);
    if (0 === uses.length) break;

    const results = [];
    for (const u of uses) {
      calls.push({ turn, tool: u.name, afterCut: cut });
      const r = await client.call(u.name, u.input ?? {}, 45000);
      const body = String(r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r));
      results.push({ type: 'tool_result', tool_use_id: u.id, content: body.slice(0, 4000) });
    }
    messages.push({ role: 'user', content: results });
  }

  client.close();
  const after = calls.filter((c) => c.afterCut);
  return {
    arm: compact ? 'compacted' : 'remembers',
    verdict: '' === verdict ? 'NONE' : verdict,
    turns: new Set(calls.map((c) => c.turn)).size,
    calls: calls.length,
    callsAfterCut: after.length,
    // Rediscovery: re-reading the page after the cut is the agent rebuilding what it had. A high
    // count here is the cost compaction imposes, and the number a memory tool has to move.
    rediscoveryCalls: after.filter((c) => /snapshot|query|sessions/.test(c.tool)).length,
    // Did it ask the run's own memory instead of re-driving the app?
    usedContext: after.some((c) => /context/.test(c.tool)),
    tokens: { input: inTok, output: outTok },
  };
}

const rows = [];
for (const compact of [false, true]) rows.push(await runArm(compact));

// The manipulation has to have HAPPENED. If the compacted arm finished before the cut, there is
// nothing to compare and saying so is the only honest output — see CUT_AT.
const compacted = rows.find((r) => 'compacted' === r.arm);
if (compacted !== undefined && 0 === compacted.callsAfterCut) {
  const dud = {
    regime: 'long-horizon',
    status: 'NOT MEASURED',
    reason:
      `the compacted arm reached its verdict in ${String(compacted.turns)} turns, before the cut at ` +
      `turn ${String(CUT_AT)}, so no history was ever lost and the two arms ran the same experiment. ` +
      `Lower --cut-at or give the task more to do.`,
    arms: rows,
  };
  writeFileSync(OUT, `${JSON.stringify(dud, null, 2)}\n`);
  console.log(JSON.stringify(dud, null, 2));
  process.exit(0);
}

const report = {
  regime: 'long-horizon',
  model: MODEL,
  turns: TURNS,
  cutAt: CUT_AT,
  app: APP,
  // The expected answer: the app DOES report the failure, so a correct agent says PASS.
  expected: 'PASS',
  arms: rows,
};
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
