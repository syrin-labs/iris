// Layer A runner: observation-cost benchmark across all scenarios x all tools.
// For each scenario: (optionally) capture a clean baseline, inject the regression,
// run each tool's idiomatic recipe, measure every payload, grade detection by a
// fixed rule, revert. Any failed cell is recorded verdict="NOT MEASURED".
import { writeFileSync } from 'node:fs';
import { makeAdapter, NAV } from './adapters.mjs';
import { inject, revert, revertAll } from './inject.mjs';
import { isObservationRetryable } from './observation-retry.mjs';
import { BENCH_URL } from './ports.mjs';

// Never a port literal: ports.mjs is the one place the app, the daemon and every harness agree, and
// a literal here silently drove ANOTHER process's app when a second dev server took 4312 mid-run —
// the Reticle arm then measured nothing while the other tools kept scoring.
const URL = BENCH_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How long one (scenario x tool) cell may take before it is abandoned.
 *
 * A cell that never returns used to block the ENTIRE pass — no analysis.json, no partial results,
 * nothing. Observed twice in one day on `broken-form-validation`, both times stuck inside the
 * Playwright MCP cell with its browser still alive, once for 38 minutes before it was killed by hand.
 * A whole run's measurement was lost each time.
 *
 * Generous on purpose: the slowest healthy cell in the suite runs well under a minute, so this only
 * fires on a genuine hang and never on a slow machine. It is a BOUND, not a duration assertion — the
 * distinction this repo already enforces for tests.
 *
 * On expiry the cell lands in the existing catch, which records `NOT MEASURED` with the reason. That
 * is deliberate and must stay loud: a timeout that silently dropped the cell would recreate exactly
 * the coverage hole that anchor drift used to open, where the rate is computed over the survivors and
 * the headline stays perfect while coverage shrinks.
 */
const CELL_TIMEOUT_MS = Number(process.env.BENCH_CELL_TIMEOUT_MS ?? '240000');

class CellTimeout extends Error {}

/** Run one cell, rejecting if it outlives the budget. */
function withCellTimeout(run) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new CellTimeout(`cell exceeded ${String(CELL_TIMEOUT_MS)}ms and was abandoned`)),
      CELL_TIMEOUT_MS,
    );
    run().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
// Default: all three tools. Set BENCH_TOOLS=reticle (comma-separated) to re-measure one tool's column
// in isolation — the external tools' numbers are fixed, so an Reticle-only pass is enough to recompute VE.
const TOOLS = (process.env['BENCH_TOOLS'] ?? 'playwright,devtools,reticle').split(',');

/**
 * A contradiction was REPORTED.
 *
 * `contradictions` is omitted from a clean verdict, so its presence in the payload is the detector
 * having fired — whether or not the verdict itself went red. The tool surface says so in as many
 * words: "treat any entry as a finding even when the verdict is green". `verifiedReason` is matched
 * too so a shape change on either side cannot quietly turn every negative case green.
 */
const CONTRADICTION_RX = /"contradictions"\s*:\s*\[|"verifiedReason"\s*:\s*"contradicted"/;

/**
 * THE NEGATIVE-CASE GRADING RULE — one question, three vocabularies.
 *
 * The negative cases ask: *would an agent reading this tool's answer to "did my action work?"
 * conclude something is broken, when nothing is?* That question has to be asked of each tool's own
 * answer, and the tools answer in different words, so the rule is written per tool. What must NOT
 * differ is the standard, and the standard is taken from the POSITIVE cases in this same file —
 * because using two meanings of "detected" across the two halves of the grid is precisely how a
 * comparison lies.
 *
 * On `hidden-api-500` a tool scores a TRUE POSITIVE because a failed request APPEARS in the network
 * listing it hands the agent. Nobody claims Playwright "asserted a defect" there; it listed one, the
 * agent read the list, and we credited the detection. So on a negative case the same listing showing
 * the same shape of failure — this time caused by traffic the app is not answerable for — must cost
 * a FALSE POSITIVE. An undifferentiated listing buys the true positives and pays the false positives
 * with the same coin, and the point of these six scenarios is to make it pay.
 *
 *   Reticle       — answers with a VERDICT (`reticle_act_and_wait` / `reticle_assert`). It asserts
 *                   failure by publishing `contradictions` / `verifiedReason:"contradicted"`.
 *                   Graded by CONTRADICTION_RX.
 *   Playwright,   — publish no verdict, so their answer is the recipe an agent actually runs: act,
 *   DevTools        then look (adapters.mjs: proveByObservation → snapshot + network). They assert
 *                   failure by presenting an ambient request in a FAILED state inside that evidence,
 *                   with nothing marking it as not the action's. Graded by AMBIENT_FP_RX.
 *
 * Two rejected alternatives, and why:
 *   - Grading them with CONTRADICTION_RX. Reticle's verdict vocabulary appears in no other tool's
 *     output, so all six would be true negatives BY CONSTRUCTION and the external columns would look
 *     perfect without being measured at all.
 *   - Grading them on a broad error regex over raw output. "error" and "failed" occur in this
 *     fixture for reasons that have nothing to do with the scenario (a favicon 404, a refused
 *     WebSocket to a daemon these cells never start), so it would mark false positives that measure
 *     our own apparatus.
 *
 * The honest caveat, recorded here rather than in a report nobody reads: Reticle is graded on a
 * surface that ATTRIBUTES and the other two on surfaces that only LIST, because that is the
 * difference between the tools — one has an act-and-verify call and the others do not. Reticle read
 * off its own raw `reticle_network` listing would false-positive on the first-party cases exactly
 * like DevTools does. What is being measured is not "who sees less", it is whether the tool's best
 * answer to "did my action work" stays clean when the page is noisy.
 *
 * If Playwright or DevTools ever gains a way to say "this request was not your action's", this rule
 * must be revisited — presence would stop implying unattributed presence.
 */
const HAS_VERDICT_SURFACE = new Set(['reticle']);

/**
 * An AMBIENT request shown in a FAILED state, on one line of the evidence.
 *
 * Endpoint AND failure marker together, never either alone: the URL alone matches a request that
 * succeeded, and the marker alone matches the app's own legitimate traffic and the fixture's noise.
 * The three endpoints are the ones apps/bench-app/src/reticle-ambient.ts fires and nothing else
 * reaches. `Save failed` is the app's own alert (SavedItems.tsx) — if the action genuinely broke,
 * that is a real detection and must count as one, which is also what keeps this rule two-sided.
 *
 * Line shapes it must match:
 *   Playwright: `12. [GET] http://localhost:8787/api/broken/500 => [500] Internal Server Error`
 *   DevTools:   `reqid=198 POST https://collect.telemetry-vendor.invalid/collect [net::ERR_NAME_NOT_RESOLVED]`
 */
const AMBIENT_FP_RX =
  /^.*(?:telemetry-vendor\.invalid|tracker-network\.invalid|\/api\/broken\/500).*?(?:\[[45]\d\d\]|net::ERR_|\[failed\]).*$|Save failed/m;

// Each scenario: steps (run before observe), observe kind, grade mode + regex.
// mode 'present'  -> detected if rx matches evidence.
// mode 'absent'   -> detected if rx does NOT match evidence (expected thing is gone).
// mode 'baseline' -> capture clean evidence too; detected via countDelta or differs.
const SCENARIOS = [
  {
    id: 'hidden-api-500',
    regression: null,
    expectDetect: true,
    observe: 'network',
    steps: [
      { view: 'diagnostics' },
      { tap: { testid: 'fault-500', nameRe: /500 Server Error/, label: '500' } },
      { wait: 600 },
    ],
    mode: 'present',
    rx: /\b500\b/,
    signal: 'network request with status 500',
  },

  {
    id: 'wrong-status-404',
    regression: null,
    expectDetect: true,
    observe: 'network',
    steps: [
      { view: 'diagnostics' },
      { tap: { testid: 'fault-404', nameRe: /404 Not Found/, label: '404' } },
      { wait: 600 },
    ],
    mode: 'present',
    rx: /\b404\b/,
    signal: 'network request with status 404 (wrong status / missing resource)',
  },

  {
    id: 'cors-blocked',
    regression: null,
    expectDetect: true,
    observe: 'network',
    steps: [
      { view: 'diagnostics' },
      { tap: { testid: 'fault-cors', nameRe: /CORS blocked/, label: 'cors' } },
      { wait: 800 },
    ],
    mode: 'present',
    rx: /cors/i,
    signal: 'cross-origin request blocked (CORS) — fails or returns status 0',
  },

  {
    id: 'silent-dom-regression',
    regression: 'silent-dom-regression',
    expectDetect: true,
    observe: 'snapshot',
    steps: [{ view: 'overview' }, { wait: 300 }],
    mode: 'baseline',
    differs: true,
    signal: 'a KPI card silently removed (normalized snapshot must change)',
  },

  {
    id: 'route-transition-break',
    regression: 'route-transition-break',
    expectDetect: true,
    observe: 'snapshot',
    steps: [{ view: 'compose' }, { wait: 300 }],
    mode: 'absent',
    rx: /Generate|Compose a script|compose-prompt/i,
    signal: 'Compose view fails to render after nav',
  },

  {
    id: 'missing-modal',
    regression: 'missing-modal',
    expectDetect: true,
    observe: 'snapshot',
    steps: [
      { view: 'deployments' },
      { tap: { testid: 'new-deploy', nameRe: /New deploy/i, label: 'new-deploy' } },
      { wait: 300 },
    ],
    mode: 'absent',
    rx: /New deployment/i,
    signal: 'modal never opens',
  },

  {
    id: 'console-error-intact-ui',
    regression: null,
    expectDetect: true,
    observe: 'console',
    steps: [
      { view: 'diagnostics' },
      { tap: { testid: 'fault-buggy', nameRe: /buggy|chart|crash/i, label: 'buggy' } },
      { wait: 300 },
    ],
    mode: 'present',
    rx: /Render crash in <ChartWidget>/,
    signal: 'console.error on click',
  },

  {
    id: 'layout-shift',
    regression: 'layout-shift',
    expectDetect: true,
    observe: 'snapshot',
    steps: [{ view: 'overview' }, { wait: 300 }],
    mode: 'baseline',
    differs: true,
    signal: 'grid columns change (CLS) — a11y tree unchanged',
  },

  {
    id: 'broken-form-validation',
    regression: 'broken-form-validation',
    expectDetect: true,
    observe: 'snapshot',
    steps: [
      { view: 'deployments' },
      { tap: { testid: 'new-deploy', nameRe: /New deploy/i, label: 'new-deploy' } },
      { wait: 250 },
      { tap: { testid: 'deploy-submit', nameRe: /Deploy/, label: 'deploy-submit' } },
      { wait: 400 },
    ],
    mode: 'absent',
    rx: /New deployment/i,
    signal: 'empty submit accepted (modal closes / deploy fires)',
  },

  {
    id: 'cross-component-regression',
    regression: 'cross-component-regression',
    expectDetect: true,
    observe: 'snapshot',
    steps: [{ view: 'deployments' }, { wait: 300 }],
    skip: true,
    signal:
      'filter input no longer changes the table — requires reliable cross-tool table-state diffing (a typed-filter before/after row count). Deferred to Layer B agent-loop; NOT MEASURED in Layer A to avoid a per-tool counting heuristic that would bias the comparison.',
  },

  {
    id: 'network-timeout',
    regression: 'network-timeout',
    expectDetect: true,
    observe: 'network',
    steps: [
      { view: 'diagnostics' },
      { tap: { testid: 'fault-timeout', nameRe: /Timeout/, label: 'timeout' } },
      { wait: 1600 },
    ],
    mode: 'present',
    // Match the request's STATE, never its name. The endpoint is `/api/broken/timeout`, so the old
    // `/timeout/i` was satisfied by the URL string in every tool's network listing — the observation
    // could not fail. All three tools "detected" it at full confidence, in one of only ten
    // real-regression scenarios, and the free true-positive inflated every column including ours.
    //
    // None of these words can appear in the URL, so a match means the tool reported a request it
    // could see had not resolved. A tool whose network listing cannot express that now MISSES this
    // scenario, which is the honest result: an agent reading that listing could not tell either.
    rx: /\b(pending|in[-\s]?flight|unresolved|timed out|hung|no response)\b/i,
    signal: 'request to /api/broken/timeout still unresolved (the endpoint never responds)',
  },

  // ── NEGATIVE CASES: the correct answer is "nothing is wrong, the verdict stands" ────────────
  //
  // Ten of the scenarios above expect a detection and one does not, so precision was barely
  // measured: a detector that fired on absolutely everything scored 0.909 on this grid, and the
  // correctness defect reported most often from the field — a `contradicted` verdict citing traffic
  // the assertion never mentioned — could not move a single number here.
  //
  // These six are that missing denominator. Each one drives an action that GENUINELY SUCCEEDS while
  // the page carries traffic the user did not cause (`?ambient=…`, apps/bench-app/src/reticle-ambient.ts),
  // and each is a shape a naive detector fires on. `expectDetect: false` grades them through exactly
  // the same tp/tn/fp/fn arithmetic as everything above.
  //
  // They observe `verdict` rather than a listing, and every tool answers on the surface it actually
  // has: Reticle's verdict, and — for tools that publish none — the act-then-look evidence bundle an
  // agent really collects with them. The grading rule and the reasoning behind it are at the top of
  // this file (HAS_VERDICT_SURFACE / AMBIENT_FP_RX). They used to be pinned `tools: ['reticle']`,
  // which left Reticle scored on 17 cells and the others on 11 and made the headline comparison
  // invalid; a scenario now records NOT MEASURED only where a tool's evidence is structurally
  // incapable of producing the false positive (see `strictmode-duplicate-effect`).
  {
    id: 'third-party-beacon-fails',
    regression: null,
    expectDetect: false,
    ambient: 'beacon',
    observe: 'verdict',
    steps: [
      { view: 'saved-items' },
      { wait: 300 },
      {
        fill: {
          testid: 'saved-item-input',
          nameRe: /textbox "Item label/,
          value: 'beacon-negative',
        },
      },
    ],
    verdict: {
      testid: 'saved-item-submit',
      nameRe: /button "Save"/,
      until: { kind: 'signal', name: 'item:saved' },
    },
    mode: 'present',
    rx: CONTRADICTION_RX,
    signal:
      "NONE — the save succeeded; a failing third-party analytics beacon (collect.telemetry-vendor.invalid) is somebody else's server and cannot answer for this app. Any contradiction is a false positive",
  },

  {
    id: 'adblocked-third-party',
    regression: null,
    expectDetect: false,
    ambient: 'adblock',
    observe: 'verdict',
    steps: [
      { view: 'saved-items' },
      { wait: 300 },
      {
        fill: {
          testid: 'saved-item-input',
          nameRe: /textbox "Item label/,
          value: 'adblock-negative',
        },
      },
    ],
    verdict: {
      testid: 'saved-item-submit',
      nameRe: /button "Save"/,
      until: { kind: 'signal', name: 'item:saved' },
    },
    mode: 'present',
    rx: CONTRADICTION_RX,
    signal:
      'NONE — the save succeeded while an ad-blocked third-party pixel failed. Blocked vendor traffic is the ordinary state of the open web, not a defect in the app under test',
  },

  {
    id: 'first-party-pageload-burst',
    regression: null,
    expectDetect: false,
    ambient: 'pageload',
    observe: 'verdict',
    // A WHOLE-SESSION assert window (`since: 0`) — what an assert falls back to when the caller does
    // not narrow it. This is the shape behind the worst field report: an app that fires one call on
    // page load, and every assertion after it coming back contradicted forever.
    steps: [{ view: 'diagnostics' }, { wait: 400 }],
    verdict: { passive: true, since: 0, until: { kind: 'text', contains: 'Fault injection' } },
    mode: 'present',
    rx: CONTRADICTION_RX,
    signal:
      "NONE — a FIRST-party bootstrap failed once at page load, long before the action. It is the app's own traffic, so no origin test can exclude it; only the attribution floor can. Any contradiction is a false positive",
  },

  {
    id: 'first-party-poll-concurrent',
    regression: null,
    expectDetect: false,
    ambient: 'poll',
    observe: 'verdict',
    steps: [
      { view: 'saved-items' },
      { wait: 300 },
      {
        fill: { testid: 'saved-item-input', nameRe: /textbox "Item label/, value: 'poll-negative' },
      },
    ],
    verdict: {
      testid: 'saved-item-submit',
      nameRe: /button "Save"/,
      until: { kind: 'signal', name: 'item:saved' },
    },
    mode: 'present',
    rx: CONTRADICTION_RX,
    signal:
      'NONE — a FIRST-party background poll keeps failing DURING the action. Unrelated concurrent traffic, first-party and inside the window: neither the origin test nor the attribution floor can exclude it, so this is the hardest of the six and the one most likely to expose a real false positive',
  },

  {
    id: 'passive-assert-ambient-traffic',
    regression: null,
    expectDetect: false,
    ambient: 'poll',
    observe: 'verdict',
    // Diagnostics because its build-log stream keeps the DOM moving: a passive window with a still
    // page proves nothing, since "the UI advanced while a request failed" needs a UI that advanced.
    steps: [{ view: 'diagnostics' }, { wait: 1500 }],
    verdict: { passive: true, until: { kind: 'text', contains: 'Fault injection' } },
    mode: 'present',
    rx: CONTRADICTION_RX,
    signal:
      'NONE — a passive assertion performs nothing, so nothing in its window is its consequence. Ambient failures plus a ticking DOM are co-occurrence, not causation',
  },

  {
    id: 'strictmode-duplicate-effect',
    regression: null,
    expectDetect: false,
    ambient: 'strictdup',
    tools: ['reticle'],
    toolsReason:
      'the ambient shape here is a duplicate SUCCESS, not a failure. A listing tool can only show ' +
      'two identical 200s, and "two requests appeared" is not an assertion that anything is wrong ' +
      'under the rule at the top of this file — no positive scenario grades duplication either. So ' +
      'this cell cannot produce a false positive for a listing-only tool, and a case that cannot ' +
      'fail measures nothing: recorded NOT MEASURED rather than banked as a free true negative.',
    observe: 'verdict',
    // The ACTION is the navigation: StrictMode double-invokes the mount effect of the view being
    // navigated to, so both writes land inside the action's own window. Nothing scopes them out.
    steps: [{ wait: 300 }],
    verdict: {
      testid: 'nav-saved-items',
      nameRe: NAV['saved-items'].nameRe,
      until: { kind: 'text', contains: 'Saved items' },
      timeoutMs: 4000,
    },
    mode: 'present',
    rx: CONTRADICTION_RX,
    signal:
      'NONE — React StrictMode invokes a mount effect twice in dev. Two identical writes, one user action, and no defect: the second request exists because the framework asked for it',
  },

  {
    id: 'no-regression-control',
    regression: null,
    expectDetect: false,
    observe: 'snapshot',
    steps: [{ view: 'overview' }, { wait: 300 }],
    mode: 'present',
    rx: /\b(error|crash|failed|undefined)\b/i,
    signal: 'NONE — any detection is a false positive',
  },
];

async function runRecipe(adapter, steps, observe, verdictSpec) {
  const cycle = [];
  for (const s of steps) {
    if (s.view) cycle.push(await adapter.gotoView(s.view));
    else if (s.tap) cycle.push(await adapter.tap(s.tap));
    else if (s.fill) cycle.push(await adapter.fill(s.fill));
    else if (s.wait) await sleep(s.wait);
  }
  // A verdict is produced BY acting, not by looking afterwards — the act and the judgement are one
  // call, which is the whole point of the surface the negative cases exercise.
  const obs =
    'verdict' === observe ? await adapter.prove(verdictSpec) : await adapter.observe(observe);
  cycle.push(obs);
  return { cycle, obsText: obs.text ?? '', allText: cycle.map((c) => c.text ?? '').join('\n') };
}

// Strip volatile tokens so a snapshot diff reflects SEMANTIC structure, not noise.
// Without this, all three tools embed per-session junk (Reticle: session id/timestamps/cost;
// Playwright: a timestamped console-log filename + ref ids; DevTools: uids/msgids) that
// makes every snapshot byte-unique and produces false "differences".
function normalize(s) {
  return s
    .replace(/ref=e?\d+/g, 'ref=R')
    .replace(/\[ref=[^\]]*\]/g, '[ref]')
    .replace(/uid=\S+/g, 'uid=U')
    .replace(/msgid=\d+/g, 'msgid=M')
    .replace(/reqid=\S+/g, 'reqid=Q')
    .replace(/console-\d[\dT:.-]*Z[^\s]*/g, 'console-LOG')
    .replace(/Console:\s*\d+\s*errors?,\s*\d+\s*warnings?/gi, 'Console:N')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID')
    .replace(/"(lastSeenMs|opened_at|t|bytes|tokens)":\s*\d+/g, '"$1":N')
    .replace(/\d+/g, '#')
    .trim();
}

/**
 * What the verdict itself said, for the row's notes.
 *
 * A negative case is only a negative case if the action it drove actually SUCCEEDED. One whose
 * verdict came back `no` or `unknown` for an unrelated reason would still record `detected=false`
 * and still count as a true negative, while measuring nothing at all — the same shape of empty
 * green this whole harness exists to refuse. Recorded so a reader can see it rather than assume it.
 */
function verifiedField(text) {
  const m = text.match(/"verified"\s*:\s*"([a-z]+)"/);
  return m ? m[1] : 'absent';
}

function grade(sc, regr, baseline) {
  if (sc.skip) return { detected: null, detail: 'NOT MEASURED — see notes' };
  if ('present' === sc.mode) return sc.rx.test(regr.obsText);
  if ('absent' === sc.mode) return !sc.rx.test(regr.obsText);
  if ('baseline' === sc.mode) {
    if (sc.count) {
      const b = (baseline.obsText.match(sc.count) ?? []).length;
      const a = (regr.obsText.match(sc.count) ?? []).length;
      return { detected: a < b, detail: `baseline=${b} after=${a}` };
    }
    if (sc.differs) {
      const same = normalize(baseline.obsText) === normalize(regr.obsText);
      return {
        detected: !same,
        detail: same
          ? 'normalized snapshot IDENTICAL (change invisible to this observation)'
          : 'normalized snapshots differ (structural change visible)',
      };
    }
  }
  return false;
}

const rows = [];
// Optional scenario filter: one id, or a comma-separated list. The list form exists so the negative
// cases can be re-measured together without paying for the ten positive ones.
const which = process.argv[2];
const wanted = which ? which.split(',') : null;
const list = wanted ? SCENARIOS.filter((s) => wanted.includes(s.id)) : SCENARIOS;

/**
 * The URL a scenario drives.
 *
 * Ambient traffic is a property of the PAGE, not of a control the agent clicks — an analytics
 * snippet is in the document before the agent arrives. So it is switched on in the URL, exactly as
 * every other fixture knob in this app is (`?reticle-break=`, `?opaque=`, `?nosource=`), and a
 * scenario that asks for none drives the byte-identical URL it drove before.
 */
function scenarioUrl(sc) {
  if (sc.ambient === undefined) return URL;
  const u = new globalThis.URL(URL);
  u.searchParams.set('ambient', sc.ambient);
  return u.toString();
}

for (const sc of list) {
  for (const tool of TOOLS) {
    const t0 = Date.now();
    let row = {
      scenario: sc.id,
      tool,
      layer: 'A',
      token_input: null,
      token_output: null,
      total_tokens: null,
      tokens_o200k: null,
      chars: null,
      bytes: null,
      latency_ms: null,
      verdict: '',
      detected_issue: null,
      expected_detect: sc.expectDetect,
      confidence: 0,
      notes: '',
    };
    if (sc.skip) {
      row.verdict = 'NOT MEASURED';
      row.notes = sc.signal;
      rows.push(row);
      console.log(JSON.stringify({ s: row.scenario, t: tool, v: 'NOT MEASURED' }));
      continue;
    }
    // A scenario graded on a VERDICT can only be run against a tool that publishes one. Recorded as
    // NOT MEASURED rather than skipped silently, for the reason anchor drift is checked up front:
    // a cell that leaves the grid without saying so shrinks coverage while the headline holds.
    if (sc.tools !== undefined && !sc.tools.includes(tool)) {
      row.verdict = 'NOT MEASURED';
      row.notes =
        sc.toolsReason ??
        `graded on a verdict; ${tool} publishes none (measured tools: ${sc.tools.join(', ')})`;
      rows.push(row);
      console.log(JSON.stringify({ s: row.scenario, t: tool, v: 'NOT MEASURED' }));
      continue;
    }
    // Same scenario, graded in the vocabulary this tool answers in — see the rule at the top of the
    // file. A verdict-observed scenario is the only place the two differ: a tool with no verdict
    // surface answers with the act-then-look evidence bundle its adapter returns, and is graded on
    // whether that bundle presents ambient traffic as the action's own failure.
    const gradesOnVerdict = 'verdict' !== sc.observe || HAS_VERDICT_SURFACE.has(tool);
    const eff = gradesOnVerdict ? sc : { ...sc, rx: AMBIENT_FP_RX };
    // Held outside the cell so an ABANDONED cell can still be torn down: on timeout the inner
    // `stop()` never runs, and without this each hang would leak a browser for the rest of the pass.
    let openAdapter = null;
    // Playwright MCP initialize and browser_click time out under CI load. Recording those as
    // NOT MEASURED shrinks coverage and trips the gate while every rate stays 1.0. Replay-detect
    // already retries a flaky baseline; one retry here is the same rule. A missing tool still misses.
    let attempt = 0;
    const maxAttempts = 2;
    while (attempt < maxAttempts) {
      attempt += 1;
      openAdapter = null;
      try {
        await withCellTimeout(async () => {
          let baseline = null;
          // baseline scenarios: clean capture first
          if ('baseline' === sc.mode) {
            const a0 = makeAdapter(tool, scenarioUrl(sc));
            openAdapter = a0;
            await a0.start();
            await a0.login();
            baseline = await runRecipe(a0, eff.steps, eff.observe, eff.verdict);
            if (sc.differsAfterFilter) {
              // type a filter and re-observe to compare effect on the table
              if (tool !== 'devtools') {
                try {
                  await a0.clickTestid('filter-search');
                } catch {
                  /* */
                }
              }
            }
            await a0.stop();
            openAdapter = null;
          }
          if (sc.regression) inject(sc.regression);
          await sleep(400); // let vite HMR apply
          const a = makeAdapter(tool, scenarioUrl(sc));
          openAdapter = a;
          await a.start();
          await a.login();
          const regr = await runRecipe(a, eff.steps, eff.observe, eff.verdict);
          await a.stop();
          openAdapter = null;
          if (sc.regression) revert(sc.regression);

          const g = grade(eff, regr, baseline);
          const detected = 'object' === typeof g ? g.detected : g;
          const detail = 'object' === typeof g ? g.detail : '';
          const cycleTokens = regr.cycle.reduce((n, c) => n + (c.tokens_o200k ?? 0), 0);
          const cycleChars = regr.cycle.reduce((n, c) => n + (c.chars ?? 0), 0);
          const cycleBytes = regr.cycle.reduce((n, c) => n + (c.bytes ?? 0), 0);
          row = {
            ...row,
            tokens_o200k: cycleTokens,
            chars: cycleChars,
            bytes: cycleBytes,
            latency_ms: Date.now() - t0,
            verdict: detected ? 'ISSUE DETECTED' : 'NO ISSUE FOUND',
            detected_issue: detected,
            confidence: detected === sc.expectDetect ? 1 : 0,
            notes: `obs=${gradesOnVerdict ? sc.observe : 'evidence(act+snapshot+network)'}; signal=${sc.signal}; ${detail}; ${'verdict' === sc.observe && gradesOnVerdict ? `verified=${verifiedField(regr.obsText)}; ` : ''}calls=${regr.cycle.map((c) => c.call).join('>')}`,
            _obsTokens: regr.cycle.at(-1)?.tokens_o200k ?? null,
          };
        });
        break;
      } catch (e) {
        // Best-effort: an abandoned cell leaves its browser up, and 36 cells of leaked Chrome would
        // starve the rest of the pass. Never let a teardown failure mask the original error.
        if (openAdapter !== null) {
          try {
            await openAdapter.stop();
          } catch {
            /* already gone */
          }
        }
        if (sc.regression) {
          try {
            revert(sc.regression);
          } catch {
            /* */
          }
        }
        if (attempt < maxAttempts && isObservationRetryable(e)) {
          console.log(
            JSON.stringify({
              s: sc.id,
              t: tool,
              v: 'RETRY',
              n: String(e).slice(0, 90),
            }),
          );
          continue;
        }
        row.verdict = 'NOT MEASURED';
        row.notes = `error: ${String(e).slice(0, 200)}`;
      }
    }
    rows.push(row);
    console.log(
      JSON.stringify({
        s: row.scenario,
        t: row.tool,
        det: row.detected_issue,
        exp: row.expected_detect,
        tok: row.tokens_o200k,
        ms: row.latency_ms,
        v: row.verdict,
        n: row.notes.slice(0, 90),
      }),
    );
  }
}
revertAll();
writeFileSync('bench/raw/observation-results.json', JSON.stringify(rows, null, 2));
console.log(`\nwrote ${rows.length} rows`);
process.exit(0);
