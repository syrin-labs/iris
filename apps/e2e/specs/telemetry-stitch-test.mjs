// Does what HAPPENED and what was REPORTED agree? Driven end to end, on the wire.
//
// `telemetry-events-test` proves each event kind can be SENT. This proves the events describe a real
// session correctly — which is a different question, and the one every telemetry defect found so far
// has lived in:
//
//   - `verification_completed` fired only when a suite PASSED, so a failing CI verify — the most
//     valuable event the product can produce — was invisible, while `bug_found` fired on the same
//     red. Bugs with no verification to divide them by.
//   - an EMPTY suite reported "all 0 flows pass" and counted itself as a passing verification.
//   - `route-rendered-nothing` fired on every React navigation that reconciled in place, so correct
//     greens came back `verified: "no"` and each emitted a bug_found. Four bugs, one real.
//   - the periodic flush emitted `daemon_stopped` while the daemon was running, so sessions
//     double-counted, and the seen-bug-kinds memory was cleared with it, so repeats re-counted.
//
// None of those could fail a unit test, and none would fail `telemetry-events-test` either. They all
// fail here, because here the numbers have to match a session someone actually ran.
//
// Drives the shared bench app, captures every event on a local endpoint, and ends with a CLEAN
// SHUTDOWN so the session summary is exercised too — the summary is emitted on a path that
// `process.exit` used to kill.
import path from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from '../../../bench/harness/mcp-client.mjs';
import { waitForSession } from '../wait-for-session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// The battery's bench-app dials :4400 (see run-ci.sh), so a spec that needs a session must use it.
const PORT = process.env.STITCH_PORT ?? '4400';
const CAPTURE_PORT = Number(process.env.STITCH_CAPTURE_PORT ?? 9973);
const APP = process.env.STITCH_APP_URL ?? 'http://localhost:4310/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

const events = [];
const capture = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      for (const e of parsed.batch ?? [parsed]) events.push(e);
    } catch {
      events.push({ event: '__unparseable__' });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":1}');
  });
});
await new Promise((r) => capture.listen(CAPTURE_PORT, r));

console.log('\n=== TELEMETRY STITCH: a real session, and the events that describe it ===');

// The daemon runs from a TEMP project, for two independent reasons:
//   1. telemetry is disabled by CWD inside a Reticle checkout (isReticleSourceCheckout) and no env
//      var overrides that — a spec run from ROOT captures nothing and passes vacuously;
//   2. it gives the run an empty .reticle/flows, so "a suite with no flows" is a real state here
//      rather than the 45 flows this repo has committed.
const PROJECT = mkdtempSync(path.join(tmpdir(), 'reticle-stitch-'));
process.chdir(PROJECT);
const CLI = path.join(ROOT, 'packages', 'server', 'dist', 'cli.js');

// Stop whatever daemon a previous spec left on this port FIRST. Telemetry configuration belongs to
// the process that starts the daemon, so attaching to an inherited one (which the battery's earlier
// specs start with RETICLE_TELEMETRY=0) would capture nothing and the spec would pass vacuously.
// The browser reconnects to the replacement on the same port.
spawnSync('node', [CLI, 'stop', '--port', PORT, '--quiet'], { cwd: PROJECT });
await sleep(1000);

const client = new McpStdioClient(
  'node',
  [CLI, 'mcp', '--port', PORT, '--drive', APP],
  {
    RETICLE_PORT: PORT,
    RETICLE_ADVERTISE_ALL_TOOLS: '1',
    // Telemetry is force-ENABLED and pointed at the local capture server. The daemon disables itself
    // inside a Reticle checkout (isReticleSourceCheckout), which is exactly right for a contributor
    // and exactly wrong for this spec, so the override is explicit.
    RETICLE_TELEMETRY: '1',
    RETICLE_TELEMETRY_URL: `http://localhost:${CAPTURE_PORT}`,
    RETICLE_TELEMETRY_KEY: 'stitch-test-key',
  },
);
await client.start();

/**
 * The surface advertises 18 of 48 tools, so a name this spec drives may not be callable directly —
 * `reticle_annotate` is one, and the refusal for it is a protocol error the helper used to hand
 * back as data. Nothing checked it, so the annotation silently never happened and the flow three
 * calls later graded assertion-free: a spec failing on the grade, three steps from the refusal that
 * caused it. Retrying through `reticle_run` is not a workaround — it is the documented call for an
 * unadvertised tool, and it is the hop the agent following this same loop has to make.
 */
const NOT_ADVERTISED = 'is not advertised under this tool profile';

const rawCall = async (name, args) => {
  const r = await client.request('tools/call', { name, arguments: args }, 60_000);
  const text = (r?.content ?? []).map((c) => c.text ?? '').join('\n');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const call = async (name, args = {}) => {
  try {
    return await rawCall(name, args);
  } catch (e) {
    const message = String(e?.message ?? e);
    if (message.includes(NOT_ADVERTISED)) {
      try {
        return await rawCall('reticle_run', { tool: name, args });
      } catch (viaRun) {
        return { PROTO: String(viaRun?.message ?? viaRun) };
      }
    }
    return { PROTO: message };
  }
};

// The DRIVEN app, not `sessions[0]`: bench-app self-assigns a per-tab id, so the only way to
// recognise it is the URL it is serving from. Taking the first session handed back a stray tab from
// another app and every assertion below then ran against the wrong page.
const [driven] = await waitForSession(
  async () => (await call('reticle_sessions'))?.sessions ?? [],
  (s) => String(s?.url ?? '').startsWith(APP),
  { what: `the driven app on ${APP}` },
);
const S = { sessionId: driven.sessionId ?? driven.id };
chk('a session is connected', S.sessionId !== undefined, S.sessionId ?? 'none');

const q = async (t) => (await call('reticle_query', { ...S, testid: t }))?.elements?.[0]?.ref;
if (!(await q('nav-overview'))) {
  const si = (await call('reticle_query', { ...S, role: 'button', name: 'Sign in' }))?.elements?.[0]
    ?.ref;
  if (si) {
    await call('reticle_act_and_wait', { ...S, ref: si, action: 'click', timeout_ms: 4000 });
    await sleep(1500);
  }
}

// 1. A consequence that really happens. An ordinary SPA navigation must come back VERIFIED — this is
//    the case `route-rendered-nothing` used to call a false green on every React app.
const green = await call('reticle_act_and_wait', {
  ...S,
  ref: await q('nav-deployments'),
  action: 'click',
  until: { kind: 'route', pathname: '/deployments' },
  timeout_ms: 5000,
});
chk(
  'an ordinary navigation that worked is reported as VERIFIED',
  green?.verified === 'yes' && green?.verdict?.pass === true,
  `verified=${green?.verified} because=${String(green?.because).slice(0, 90)}`,
);

// 2. A consequence that cannot happen: one verification AND one bug.
const red = await call('reticle_act_and_wait', {
  ...S,
  ref: await q('nav-overview'),
  action: 'click',
  until: { kind: 'signal', name: 'never-fires-in-this-app' },
  timeout_ms: 4000,
});
chk(
  'a consequence that never held is reported as NOT verified',
  red?.verified === 'no' && red?.verdict?.pass === false,
  `verified=${red?.verified}`,
);

// 3. The suite gate with nothing saved yet. An empty suite verified nothing and must not pass.
const empty = await call('reticle_verify', { action: 'flows', ...S });
chk(
  'a suite with no flows does NOT report pass',
  // `!== 'pass'` alone would also be satisfied by `undefined` — i.e. by the tool never answering.
  typeof empty?.status === 'string' && empty.status !== 'pass',
  `status=${empty?.status} summary=${String(empty?.summary).slice(0, 70)}`,
);

// 4. record -> annotate -> save -> replay -> verify, the loop the docs tell agents to run.
const FLOW = 'stitch-probe';
await call('reticle_record', { ...S, action: 'start', recordingName: FLOW });
await call('reticle_act_and_wait', {
  ...S,
  ref: await q('nav-deployments'),
  action: 'click',
  until: { kind: 'route', pathname: '/deployments' },
  timeout_ms: 5000,
});
const annotated = await call('reticle_annotate', { flow: FLOW, kind: 'assert-signal', name: 'nav:changed' });
chk(
  'the annotation attaches to the recorded step',
  annotated?.ok === true && annotated?.target === 'step',
  JSON.stringify(annotated ?? {}).slice(0, 200),
);
await call('reticle_record', { ...S, action: 'stop', recordingName: FLOW });
const saved = await call('reticle_flow_save', { ...S, flowName: FLOW });
chk(
  'the recorded flow grades as asserted',
  saved?.assertions?.grade === 'asserted',
  JSON.stringify(saved?.assertions ?? saved).slice(0, 300),
);
// Replay honours the FlowFile contract now: a tab that is not on the flow's startPath is
// hard-navigated there before step 1. The recording above ended on /deployments, and a full-page
// load resets bench-app's deliberately in-memory auth back to the Login screen — where step 1's
// anchor cannot exist. This spec is about telemetry, not wrong-page recovery (the
// flow-startpath-navigate unit tests own that), so return to the start route in-SPA before each
// replay: arrival is then a no-op and the signed-in session survives.
const backToStart = async () =>
  call('reticle_act_and_wait', {
    ...S,
    ref: await q('nav-overview'),
    action: 'click',
    until: { kind: 'route', pathname: '/overview' },
    timeout_ms: 5000,
  });
await backToStart();
const replay = await call('reticle_flow_replay', { ...S, flowName: FLOW });
chk('and replays green', replay?.status === 'ok', `status=${replay?.status}`);
await backToStart();
const suite = await call('reticle_verify', { action: 'flows', ...S });
chk(
  'and the suite now passes, with a flow in it',
  suite?.status === 'pass' && suite?.total >= 1,
  `status=${suite?.status} total=${suite?.total}`,
);

// 5. Clean shutdown — the session summary rides out on this path.
await sleep(1500);
spawnSync('node', [CLI, 'stop', '--port', PORT, '--quiet'], { cwd: PROJECT });
await sleep(3000);

// ── Now: do the events describe what just happened? ────────────────────────────────────────────
const kindsOf = (name) => events.filter((e) => e.event === name);
const prop = (e, k) => e?.properties?.[k];

const verifications = kindsOf('verification_completed');
const bugs = kindsOf('bug_found');
console.log(
  `\n   events: ${JSON.stringify(Object.fromEntries(events.map((e) => [e.event, events.filter((x) => x.event === e.event).length])))}`,
);

chk(
  'every verdict produced a verification_completed',
  verifications.length >= 4,
  `${verifications.length} verifications for 4+ verdicts`,
);
chk(
  'a FAILING verdict is counted as a verification, not dropped',
  verifications.some((e) => prop(e, 'verification_passed') === false),
  verifications.map((e) => `${prop(e, 'verification_via')}:${prop(e, 'verification_passed')}`).join(' '),
);
chk(
  'the EMPTY suite did not emit a passing verification',
  !verifications.some(
    (e) =>
      prop(e, 'verification_via') === 'reticle_verify' &&
      prop(e, 'verification_passed') === true &&
      prop(e, 'verification_durationMs') === 0,
  ),
  verifications.map((e) => `${prop(e, 'verification_via')}:${prop(e, 'verification_passed')}`).join(' '),
);
// The spec drives via --drive with the battery's default (headless), so every verification here must
// say so. Without this, "verifications run" is one number covering unattended CI, a human watching an
// agent, and the SDK in somebody's own dev server.
chk(
  'each verification records HOW the browser got there',
  verifications.length > 0 && verifications.every((e) => prop(e, 'verification_browser') === 'headless'),
  verifications.map((e) => prop(e, 'verification_browser')).join(' '),
);
chk(
  'exactly the real failure produced a bug_found',
  bugs.length === 1,
  `${bugs.length} bug(s): ${bugs.map((e) => prop(e, 'bug_kind')).join(',')}`,
);

// The session summary: emitted on the clean-shutdown path, and it must carry the work, not zeroes.
const summaries = kindsOf('daemon_stopped');
const final = summaries.find((e) => prop(e, 'session_final') === true);
chk('the daemon reported a FINAL session summary', final !== undefined, `${summaries.length} summary event(s)`);
chk(
  'the summary carries the session it actually ran',
  Number(prop(final, 'session_toolCalls')) > 0 &&
    Number(prop(final, 'session_verifications')) > 0 &&
    Number(prop(final, 'session_busyMs')) > 0,
  `toolCalls=${prop(final, 'session_toolCalls')} verifications=${prop(final, 'session_verifications')} bugs=${prop(final, 'session_bugsFound')} busyMs=${prop(final, 'session_busyMs')}`,
);
chk(
  'a periodic flush is NOT reported as a daemon exit',
  summaries.length > 0 && summaries.every((e) => prop(e, 'session_final') === true),
  'daemon_stopped means stopped; session_progress is the flush',
);
chk(
  'the summary and the discrete events agree on the bug count',
  Number(prop(final, 'session_bugsFound')) === bugs.length,
  `summary=${prop(final, 'session_bugsFound')} events=${bugs.length}`,
);

capture.close();
console.log(`\n${fail === 0 ? '✅ TELEMETRY STITCH VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
