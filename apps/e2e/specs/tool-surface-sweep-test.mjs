// Call EVERY shipped tool the way an agent calls it — over MCP stdio, against a running app.
//
// This spec exists because four defects shipped past every other gate, and all four were invisible
// to the way the rest of this repo tests. Unit tests call handlers directly. The other e2e specs
// call `TOOLS.find(...).handler(...)` directly too. Both skip the MCP layer entirely — and the MCP
// layer is where tool schemas are ENFORCED, where errors are classified, and where the provider an
// agent actually gets is assembled. Testing under it cannot see any of that.
//
// What it caught, running once by hand:
//   1. `reticle_verify_change` returned a payload its own outputSchema rejected, so the MCP layer
//      answered -32602 for the two COMMONEST paths ("no files given", "nothing covers this").
//   2. `reticle_viewport` / `reticle_network_mock` refused with `no-cdp-provider` under
//      `reticle drive` — the provider that flag creates lacked both methods — while recommending
//      `reticle drive` as the fix, which is what the caller had already done.
//   3. A stale ref after a re-render was classified "not one Reticle recognizes… may be a defect in
//      Reticle", inviting a bug report for the most ordinary thing that follows a click.
//   4. Reticle's own argument-validation errors were classified the same way.
//
// So it does NOT assert "everything returns ok" — several tools correctly refuse. It asserts the
// four properties whose absence produced those bugs:
//   - every advertised tool is CALLABLE (no protocol error, no schema violation);
//   - a refusal is RECOGNIZED (carries a reason/code or a recovery), never an unknown defect;
//   - no response tells the agent its own bad call may be a Reticle bug;
//   - the tools that require a driven browser actually work when one is driven.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpStdioClient } from '../../../bench/harness/mcp-client.mjs';
import { waitForSession } from '../wait-for-session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = process.env.RETICLE_PORT ?? '4400';
const APP = process.env.SWEEP_APP_URL ?? 'http://localhost:4310/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

// The phrase attached to errors Reticle does not recognize. Seeing it for a condition Reticle
// itself authored is the bug, so the spec looks for it by value rather than by vibes.
const FEEDBACK_ASK_MARKER = 'not one Reticle recognizes';

/** The meta-tool that reaches every name the surface does not advertise. */
const RUN_TOOL = 'reticle_run';

/**
 * What the EXTENDED surface advertises. Not "every tool": the surface is deliberately capped so one
 * server cannot exhaust an editor's shared tool budget (Cursor allows 40 in total). Asserting a
 * floor of 40 here outlived that change by a whole release and failed the battery on the cap
 * working as designed.
 */
// Derived, not restated. This was a hardcoded 28 with a comment promising it was "kept in step
// with surface-sizes.test.ts", which is the same promise that file makes about every other copy of
// the number: it is the single source and everything else points at it. A fifth copy living out
// here could only be kept in step by remembering, and adding `reticle_intent` is exactly the moment
// nobody does. The unit gate cannot see this file, so the drift surfaced eight minutes into the
// battery instead of in the fast gate.
//
// Reading it from the built server keeps the check meaningful: the assertion below is still that a
// REAL MCP connection advertises the surface, and it is now impossible for it to disagree with the
// surface for the boring reason.
const { TOOL_SURFACE } = await import(pathToFileURL(path.join(ROOT, 'packages/server/dist/tools/tool-surface.js')).href);
const { advertisedTools } = await import(pathToFileURL(path.join(ROOT, 'packages/server/dist/mcp/mcp.js')).href);
const EXTENDED_SURFACE_SIZE = advertisedTools(TOOL_SURFACE.ALL).length;

const client = new McpStdioClient(
  'node',
  ['packages/server/dist/cli.js', 'mcp', '--port', PORT, '--drive', APP],
  { RETICLE_PORT: PORT, RETICLE_ADVERTISE_ALL_TOOLS: '1', RETICLE_TELEMETRY: '0' },
);

/**
 * Call a tool and classify the response the way an AGENT has to classify it.
 *
 * `callTool` throws on `isError`, which conflates two very different things: a tool that refused for
 * a reason, and a tool that is broken. So this uses the raw request and keeps the envelope.
 */
/**
 * The session every call below means. The bridge is shared, so a stray tab in the developer's own
 * browser is a SECOND session and every unaddressed tool call then comes back "multiple sessions
 * connected" — a sweep of the whole surface failing on the harness, not the surface. Set once the
 * driven app has actually connected, and only ever added to tools that DECLARE a sessionId: the MCP
 * layer rejects unknown argument keys, so blanket-injecting it would refuse half the surface.
 */
let DRIVEN;
const TAKES_SESSION = new Set();

/**
 * The names this daemon advertises directly. Everything else in the registry is reached through
 * `reticle_run`, which is the SUPPORTED call for it and not a workaround: editors budget MCP tools
 * as a count shared across every connected server, so the surface is capped at 30 of 48 and the
 * rest stay one call away. This spec sweeps the whole REGISTRY, so it has to make the same hop an
 * agent makes — calling an unadvertised name directly is refused by design, and a sweep that reads
 * that refusal as a broken tool is measuring the cap instead of the surface.
 */
const ADVERTISED = new Set();

async function callRaw(name, args) {
  try {
    const withSession =
      DRIVEN === undefined || !TAKES_SESSION.has(name) ? args : { sessionId: DRIVEN, ...args };
    // Route through reticle_run exactly when the name is not advertised. `reticle_run` itself is
    // always advertised — it is the tool that makes the rest reachable.
    const viaRun = 0 < ADVERTISED.size && !ADVERTISED.has(name) && RUN_TOOL !== name;
    const result = viaRun
      ? await client.request(
          'tools/call',
          { name: RUN_TOOL, arguments: { tool: name, args: withSession } },
          60_000,
        )
      : await client.request('tools/call', { name, arguments: withSession }, 60_000);
    const text = (result?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { ok: true, isError: result?.isError === true, text, parsed };
  } catch (error) {
    // A transport-level rejection is the -32602 class: the tool could not be called at all.
    return { ok: false, isError: true, text: String(error.message), parsed: undefined };
  }
}

const calls = [];
const record = async (name, args = {}) => {
  const r = await callRaw(name, args);
  calls.push({ name, ...r });
  return r.parsed;
};

await client.start();

console.log('\n=== TOOL SURFACE: every shipped tool, over real MCP ===');

const advertised = await client.listTools();
chk(
  'the MCP server advertises the extended tool surface',
  advertised.length === EXTENDED_SURFACE_SIZE,
  `${advertised.length} tools`,
);
for (const tool of advertised) {
  ADVERTISED.add(tool.name);
  if (tool.inputSchema?.properties?.sessionId !== undefined) TAKES_SESSION.add(tool.name);
}

// The UNADVERTISED tools declare a sessionId too, and their schemas are not in `tools/list` — only
// the catalog has them. Without this the sweep drove them unaddressed, and with the bench-app tab
// plus a lease open, every one came back "multiple sessions connected": the sweep failing on the
// harness rather than on the surface, and intermittently, depending on how many tabs happened to be
// live. Ask the catalog for the whole registry and take sessionId from where it is actually written
// down.
const catalogList = await callRaw('reticle_tools', {});
const allNames = (catalogList?.parsed?.tools ?? []).map((t) => t.name).filter(Boolean);
if (0 < allNames.length) {
  const catalog = await callRaw('reticle_tools', { names: allNames });
  for (const tool of catalog?.parsed?.tools ?? []) {
    if ((tool.params ?? []).some((p) => p.name === 'sessionId')) TAKES_SESSION.add(tool.name);
  }
}

// The driven browser has to load the app and its SDK has to dial the bridge before anything is real.
// bench-app self-assigns a per-tab id, so it is recognised by the URL it is serving from.
const [driven] = await waitForSession(
  async () => {
    const r = await callRaw('reticle_sessions', {});
    return r.parsed?.sessions ?? [];
  },
  (s) => String(s?.url ?? '').startsWith(APP),
  { what: `the driven app on ${APP}` },
);
DRIVEN = driven.sessionId ?? driven.id;

// ── the read-only surface ─────────────────────────────────────────────────────────────────────
await record('reticle_sessions');
await record('reticle_capabilities');
await record('reticle_snapshot');
const q = await record('reticle_query', { by: 'role', value: 'button' });
const ref = q?.elements?.[0]?.ref;
chk('a ref resolves, so the acting tools have something real to drive', typeof ref === 'string', String(ref));
if (ref !== undefined) await record('reticle_inspect', { ref });
for (const name of [
  'reticle_explore',
  'reticle_domain',
  'reticle_project',
  'reticle_console',
  'reticle_animations',
  'reticle_network',
  'reticle_state',
  'reticle_reconcile',
  'reticle_run_export',
  'reticle_contract_save',
]) {
  await record(name);
}
// Merged onto reticle_verify. Swept by ACTION so the sweep still covers each capability rather
// than quietly dropping three of them when their names went away.
for (const action of ['coverage', 'affected', 'change']) {
  await record('reticle_verify', { action });
}
await record('reticle_storage', { area: 'local' });
await record('reticle_observe', { window_ms: 1000 });
await record('reticle_baseline', { action: 'list' });
await record('reticle_flow', { action: 'list' });

// ── acting: re-query between actions, because a re-render invalidates refs ────────────────────
if (ref !== undefined) {
  await record('reticle_act', { ref, action: 'click' });
  const again = await record('reticle_query', { by: 'role', value: 'button' });
  const fresh = again?.elements?.[0]?.ref;
  if (fresh !== undefined) {
    await record('reticle_act_and_wait', {
      ref: fresh,
      action: 'click',
      until: { kind: 'text', contains: 'a' },
      timeout_ms: 3000,
    });
    const third = await record('reticle_query', { by: 'role', value: 'button' });
    const last = third?.elements?.[0]?.ref;
    if (last !== undefined) await record('reticle_act_sequence', { steps: [{ ref: last, action: 'click' }] });
  }
}
await record('reticle_wait_for', { predicate: { kind: 'text', contains: 'a' }, timeout_ms: 3000 });
await record('reticle_assert', { predicate: { kind: 'text', contains: 'a' } });
await record('reticle_scroll_to', { by: 'role', value: 'button' });

// ── the driven-browser tools ──────────────────────────────────────────────────────────────────
await record('reticle_screenshot', { name: 'tool-surface-sweep' });
await record('reticle_visual_diff', { baseline: 'tool-surface-sweep' });
const viewport = await record('reticle_viewport', { width: 1024, height: 768 });
const mockOn = await record('reticle_network_mock', {
  mocks: [{ urlContains: '/api/never-called', status: 503, body: '{}' }],
});
await record('reticle_network_mock', { clear: true });

// A driven browser IS attached — screenshot proves it. These two looked for methods the driven
// provider did not implement, so they refused while pointing the caller at the flag they had used.
chk(
  'reticle_viewport applies when a browser is actually being driven',
  viewport?.applied === true,
  JSON.stringify(viewport ?? {}).slice(0, 90),
);
chk(
  'reticle_network_mock applies when a browser is actually being driven',
  mockOn?.applied === true,
  JSON.stringify(mockOn ?? {}).slice(0, 90),
);

// ── stateful ──────────────────────────────────────────────────────────────────────────────────
await record('reticle_clock', { freeze: true });
await record('reticle_clock', { reset: true });
await record('reticle_navigate', { reload: true });
await sleep(2500);
await record('reticle_annotate', { kind: 'intent', text: 'sweep' });
await record('reticle_record', { action: 'start', recordingName: 'sweep' });
await record('reticle_record', { action: 'stop', recordingName: 'sweep' });
await record('reticle_replay', { recordingName: 'sweep', confirmDangerous: true });
await record('reticle_flow_save', { flowName: 'sweep-flow' });
await record('reticle_flow_save_recorded', { flowName: 'sweep-flow-recorded' });
await record('reticle_flow_replay', { flowName: 'sweep-flow', confirmDangerous: true });
await record('reticle_verify', { action: 'flows', names: ['sweep-flow'] });
await record('reticle_flow_heal', { flowName: 'sweep-flow' });
await record('reticle_verify', { action: 'crawl', maxSteps: 2, confirmDangerous: true });
await record('reticle_verify', { action: 'nav_smoke', maxLinks: 2, confirmDangerous: true });
await record('reticle_session', { action: 'yield', mode: 'waiting' });

// A deliberately STALE ref: click something that re-renders, then reuse the ref from before it.
//
// This has to be PROVOKED. An earlier draft of this spec re-queried between every action, so it
// never produced a stale ref at all — and the check below passed with the recovery rule deleted,
// protecting nothing. The condition a check exists for must actually occur in the run.
if (ref !== undefined) {
  const stale = await callRaw('reticle_act', { ref, action: 'click' });
  calls.push({ name: 'reticle_act (deliberately stale ref)', ...stale });
  const isStale = stale.text.includes('no longer resolves');
  chk(
    'a stale ref is answered with a recovery, not "this may be a Reticle defect"',
    !isStale || (stale.text.includes('recovery') && !stale.text.includes(FEEDBACK_ASK_MARKER)),
    stale.text.slice(0, 120),
  );
}

// A deliberately invalid call: the tool must say what it wanted, and must NOT suggest the caller
// found a Reticle bug. This is the exact shape that was misclassified on all three fixture apps.
const badCall = await callRaw('reticle_lease', { action: 'acquire' });
calls.push({ name: 'reticle_lease (deliberately invalid)', ...badCall });

// ── the four properties ───────────────────────────────────────────────────────────────────────

// 1. No tool may fail to be CALLABLE.
//
//    An output-schema violation does NOT arrive as a transport rejection — it comes back as an
//    ordinary successful JSON-RPC result carrying isError:true and the text "Output validation
//    error". The first draft of this spec checked only for a rejection and therefore PASSED against
//    the reverted bug, which is how the check got fixed: by reverting the fix and watching the gate
//    stay green. INPUT validation errors are excluded on purpose — those are the caller's fault, and
//    one is provoked deliberately below.
const SCHEMA_VIOLATION = 'Output validation error';
const uncallable = calls.filter((c) => c.ok === false || c.text.includes(SCHEMA_VIOLATION));
chk(
  'every tool is callable — no protocol error, no output-schema violation',
  uncallable.length === 0,
  uncallable.map((c) => `${c.name}: ${c.text.slice(0, 90)}`).join(' | ') || `${calls.length} calls`,
);

// 2. A refusal must be actionable. `ok:false` with neither a reason/code nor a recovery is a
//    dead end: the agent learns something went wrong and nothing about what to do.
const muteRefusals = calls.filter((c) => {
  const p = c.parsed;
  if (p === undefined || p.ok !== false) return false;
  return (
    p.reason === undefined && p.code === undefined && p.recovery === undefined && p.error === undefined
  );
});
chk(
  'every refusal names a reason, a code or a recovery',
  muteRefusals.length === 0,
  muteRefusals.map((c) => c.name).join(', ') || 'all refusals actionable',
);

// 3. Nothing may tell the agent that its own bad call, or an ordinary post-action condition, might
//    be a defect in Reticle. That ask belongs to genuinely unknown failures only.
const wronglyBlamed = calls.filter((c) => c.text.includes(FEEDBACK_ASK_MARKER));
chk(
  'no recognized condition is reported as a possible Reticle defect',
  wronglyBlamed.length === 0,
  wronglyBlamed.map((c) => c.name).join(', ') || 'none',
);

// 4. The deliberately invalid call is recognized AND actionable.
chk(
  'an invalid call is answered with what it wanted, not a bug-report ask',
  badCall.text.includes('recovery') && !badCall.text.includes(FEEDBACK_ASK_MARKER),
  badCall.text.slice(0, 120),
);

console.log(`\n   (${calls.length} tool calls made over MCP stdio)`);

await client.stop();
// `reticle mcp` proxies to a daemon that outlives this process; leave the port as we found it or the
// next spec inherits a bridge it did not start.
const { spawnSync } = await import('node:child_process');
spawnSync('node', ['packages/server/dist/cli.js', 'stop', '--port', PORT, '--quiet'], { cwd: ROOT });

console.log(`\n${fail === 0 ? '✅ TOOL SURFACE VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
