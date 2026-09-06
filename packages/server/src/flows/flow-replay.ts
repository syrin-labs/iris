import { span } from '../trace.js';
import { routePathOf } from '../events/predicate-route.js';
import {
  AnchorKind,
  DriftReason,
  EventType,
  ReticleCommand,
  QueryBy,
  type CommandResult,
  type Drift,
  type FlowAnchor,
  type FlowFile,
  type FlowStep,
  type FlowStepResult,
  type FlowExpect,
  type ReticleEvent,
  type QueryEmptyHint,
  PredicateKind,
} from '@reticlehq/core';
import type { EvalResult, Predicate } from '../events/predicate.js';
import { asRecord, asString } from '../tools/tools-helpers.js';
import { replayActionArgs, ambiguousTestidNote, queryRefs } from './replay.js';
import {
  degradedStepResult,
  isDegradedAnchor,
  runComponentStep,
  runRoleStep,
  runSequenceStep,
} from './flow-step-runners.js';
import { successToPredicate } from './flow-success.js';
import { ReticleTool } from '../tools/tool-names.js';

/**
 * The session surface flow-replay needs: QUERY to re-resolve a testid anchor against the live
 * DOM, ACT to run the step, and the event/onEvent pair so a signal anchor can wait on a predicate
 * (via the injected waitForPredicate). Mirrors PredicateSession so the same fake drives both.
 */
export interface FlowReplaySession {
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  /**
   * Attribution window around each replayed step. Optional so a minimal test double still satisfies the
   * interface, but a real session MUST supply it: without a window the step's own effects carry no
   * actionId, and Session.pushEvent classifies an unattributed ref-bearing event as ambient background
   * churn. A 15-step flow can therefore teach the settle oracle to ignore every region the app reacts
   * in — and this is the CI path, so the result is a green suite over an app that is still working.
   */
  beginAction?(tool: string, args: Record<string, unknown>): void;
  finishAction?(error?: string, settled?: boolean, settleMs?: number): void;
  eventsSince(cursor: number): ReticleEvent[];
  onEvent(listener: (event: ReticleEvent) => void): () => void;
  /** Buffer clock (ms since connect) — required by the predicate engine's `settled` check. */
  elapsed(): number;
}

/**
 * The injected predicate-waiter (the real waitForPredicate) — reused, never reimplemented.
 * `since` is the event-time floor (default 0 = whole buffer): pass the cursor captured before a
 * replay so the success oracle can't be satisfied by a stale signal from a prior replay/run.
 */
export type WaitForSignal = (
  session: FlowReplaySession,
  predicate: Predicate,
  timeoutMs: number,
  since?: number,
) => Promise<EvalResult>;

/**
 * A single ASCII-ish edit distance (case-insensitive). Small inputs (testids), so O(n*m) is fine.
 * Exported so the heal proposal layer derives its confidence from the SAME distance used to
 * pick `nearest` — no second, divergent heuristic enters the trust boundary.
 */
export function editDistance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const rows = s.length + 1;
  const cols = t.length + 1;
  const prev = new Array<number>(cols);
  const curr = new Array<number>(cols);
  for (let j = 0; j < cols; j++) prev[j] = j;
  for (let i = 1; i < rows; i++) {
    curr[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j < cols; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[cols - 1] ?? 0;
}

/**
 * The closest present testid to a missing one, by case-insensitive edit distance, ties broken
 * by shortest length then lexically. Returns null only when nothing is present — so a drift
 * record always names a fix when one exists ("whose fault is it": here is the closest survivor).
 */
export function nearestTestid(missing: string, present: string[]): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of present) {
    const distance = editDistance(missing, candidate);
    if (
      distance < bestDistance ||
      (distance === bestDistance && best !== null && candidate.length < best.length) ||
      (distance === bestDistance &&
        best !== null &&
        candidate.length === best.length &&
        candidate < best)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Bounded settle for anchor re-resolution. A testid step queries the live DOM for the anchor; if a
 * render is still in flight (post-login route swap, modal mount, list paint) the element exists but
 * isn't painted yet, and a single QUERY would read zero and FALSELY drift. We re-query a few times
 * with a short delay before concluding the anchor is gone — a real regression (renamed/removed
 * testid) stays missing across every attempt, so this removes flakiness without masking breaks.
 */
const ANCHOR_SETTLE_ATTEMPTS = 8;
const ANCHOR_SETTLE_DELAY_MS = 150;
/**
 * The budget that actually governs, in wall-clock milliseconds.
 *
 * Attempts were the bound, and on an event-chatty page that collapsed. `settleTick` ends on EITHER
 * an event OR the tick, so a page emitting continuously (API calls, a large form render, CSS
 * transition start/end pairs) burned all eight attempts in **224–758ms measured** — a budget
 * documented as 1.2s, spent in a fifth of it, before a newly routed page had mounted its controls.
 * Cross-route replays drifted `testid_not_found` at 278ms while the same flow passed on a quiet page.
 *
 * An event arriving is evidence the page is still working. It should EXTEND the wait, not spend it.
 * So the deadline decides when to give up, and the attempt cap below survives only as a backstop
 * against a pathological storm spinning this loop hot.
 */
const ANCHOR_SETTLE_BUDGET_MS = ANCHOR_SETTLE_ATTEMPTS * ANCHOR_SETTLE_DELAY_MS;
/** Backstop only. Generous on purpose: the deadline is the real bound, this just prevents a spin. */
const ANCHOR_SETTLE_MAX_ATTEMPTS = 40;

/** Injected sleeper so tests drive replay with a no-op clock; production waits on a real timer. */
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Extract the live element refs + the zero-match near-miss hint from a QUERY command result. */
function readQuery(result: CommandResult): { refs: string[]; hint?: QueryEmptyHint } {
  const refs = queryRefs(result);
  if (!result.ok) return { refs };
  const payload = asRecord(result.result);
  const rawHint = payload['hint'];
  if ('object' === typeof rawHint && rawHint !== null) {
    const hint = asRecord(rawHint);
    const present = Array.isArray(hint['presentTestids'])
      ? hint['presentTestids'].filter((t): t is string => 'string' === typeof t)
      : [];
    return {
      refs,
      hint: {
        route: asString(hint['route']) ?? '',
        presentTestids: present,
        presentRegions: [],
        knownEmptyState: true === hint['knownEmptyState'],
      },
    };
  }
  return { refs };
}

/**
 * True when ≥2 present testids tie at the minimum edit distance to the missing one — `nearest` is
 * then an arbitrary lexical-tiebreak pick, so auto-healing would be a coin-flip between candidates.
 * Such a drift is surfaced (with a nearest) but never auto-healed.
 */
export function nearestIsAmbiguous(missing: string, present: string[]): boolean {
  if (present.length < 2) return false;
  let min = Number.POSITIVE_INFINITY;
  let count = 0;
  for (const candidate of present) {
    const distance = editDistance(missing, candidate);
    if (distance < min) {
      min = distance;
      count = 1;
    } else if (distance === min) {
      count += 1;
    }
  }
  return count >= 2;
}

/** Build the legible-drift record for a testid anchor that resolved to zero live elements. */
export function testidDrift(value: string, hint: QueryEmptyHint | undefined): Drift {
  const present = hint?.presentTestids ?? [];
  const drift: Drift = {
    reasonKind: DriftReason.TESTID_NOT_FOUND,
    reason: `testid "${value}" not found`,
    anchor: value,
    nearest: nearestTestid(value, present),
  };
  if (nearestIsAmbiguous(value, present)) drift.ambiguous = true;
  return drift;
}

/**
 * Build the drift for a step whose `expect.element` testid was absent after the action ran.
 *
 * Deliberately not `testidDrift`: that one means "this step's anchor is gone", and reusing it here
 * put the assertion's target in the result's `anchor` field — the field documented as the value the
 * step is bound to. A caller then reads `testid_not_found` naming something that was never the
 * step's locator and goes hunting for a rename, while the truth is the step ran and its
 * consequence did not hold.
 */
export function expectElementDrift(value: string, hint: QueryEmptyHint | undefined): Drift {
  const present = hint?.presentTestids ?? [];
  const drift: Drift = {
    reasonKind: DriftReason.EXPECT_ELEMENT_NOT_FOUND,
    reason: `expect.element testid "${value}" not present after the action`,
    anchor: value,
    nearest: nearestTestid(value, present),
  };
  if (nearestIsAmbiguous(value, present)) drift.ambiguous = true;
  return drift;
}

/**
 * Re-resolve any QUERY against the live DOM, tolerating an in-flight render: QUERY, and while it
 * returns zero refs, sleep and retry up to ANCHOR_SETTLE_ATTEMPTS. Returns as soon as refs appear,
 * so a present anchor costs one query; a genuinely missing one costs the full (bounded) settle and
 * then drifts. The last result's near-miss hint is returned for the drift record.
 */

/**
 * One wait between anchor attempts: the fixed tick, or the next DOM event — whichever comes first.
 *
 * An element mounting IS a mutation, and the session already streams those, so sleeping out the rest
 * of a 150ms tick after the thing has already appeared is pure latency. Measured on next-app-router:
 * a single `flow.step` span was 1079ms around nine QUERY round-trips of 1–2ms each — the cost was
 * entirely the sleeping, and four such steps made up 4.3s of that app's 7.6s.
 *
 * It can only resolve the wait EARLIER, never end the loop earlier: the attempt budget above is
 * untouched, so a genuinely missing anchor still spends the full settle before it drifts. An early
 * "not found" would be a false drift, which is the failure this loop exists to prevent.
 */
async function settleTick(session: FlowReplaySession, sleep: Sleep): Promise<void> {
  let unsubscribe: (() => void) | undefined;
  try {
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      unsubscribe = session.onEvent(finish);
      void sleep(ANCHOR_SETTLE_DELAY_MS).then(finish);
    });
  } finally {
    unsubscribe?.();
  }
}

export async function resolveQuery(
  session: FlowReplaySession,
  queryArgs: Record<string, unknown>,
  sleep: Sleep,
  now: () => number = Date.now,
): Promise<{ refs: string[]; hint?: QueryEmptyHint }> {
  let last = readQuery(await session.command(ReticleCommand.QUERY, queryArgs));
  const deadline = now() + ANCHOR_SETTLE_BUDGET_MS;
  for (
    let attempt = 1;
    0 === last.refs.length && now() < deadline && attempt < ANCHOR_SETTLE_MAX_ATTEMPTS;
    attempt += 1
  ) {
    await settleTick(session, sleep);
    last = readQuery(await session.command(ReticleCommand.QUERY, queryArgs));
  }
  return last;
}

/** Re-resolve a testid anchor. */
function resolveTestid(
  session: FlowReplaySession,
  value: string,
  sleep: Sleep,
): Promise<{ refs: string[]; hint?: QueryEmptyHint }> {
  return resolveQuery(session, { by: QueryBy.TESTID, value }, sleep);
}

/**
 * The route (pathname) currently in effect — the page a step runs on. Reads the latest ROUTE_CHANGE
 * from the whole event buffer; mirrors the predicate engine's route field order (pathname → to).
 * Returns undefined when no route has been observed (e.g. a fake session) so `page` stays optional.
 */
function currentRoute(session: FlowReplaySession): string | undefined {
  const routes = session.eventsSince(0).filter((e) => e.type === EventType.ROUTE_CHANGE);
  const last = routes.at(-1);
  if (last === undefined) return undefined;
  const data = last.data ?? {};
  // The ROUTER's path. This field answers "which page did this step run on", and the document
  // pathname is `/` on every page of a hash-routed app — so a whole desktop replay reported `/` for
  // every step. Sixth place the same reading was wrong; see routePathOf.
  const pathname = asString(data['pathname']) ?? asString(data['to']);
  if (pathname === undefined || 0 === pathname.length) return undefined;
  const routed = routePathOf(pathname, asString(data['hash']) ?? '');
  return routed.length > 0 ? routed : undefined;
}

/** Pathname only (drop origin + query) so a net URL stays terse in the journey. */
function trimUrl(url: string): string {
  try {
    return new URL(url, 'http://x').pathname;
  } catch {
    return url.length > 60 ? `${url.slice(0, 59)}…` : url;
  }
}

/**
 * A compact "what happened after this step" summary from the post-action event window — the
 * journey's consequence column ("→ /deployments", "signal modal:opened", "GET /api/x 500"). Notable
 * events only (route / domain signal / network / console error), terse and capped to stay token-cheap.
 */
function summarizeConsequence(events: ReticleEvent[]): string | undefined {
  const parts: string[] = [];
  const lastRoute = events.filter((e) => e.type === EventType.ROUTE_CHANGE).at(-1);
  if (lastRoute !== undefined) {
    const data = lastRoute.data ?? {};
    const to = asString(data['pathname']) ?? asString(data['to']);
    if (to !== undefined && to.length > 0) parts.push(`→ ${to}`);
  }
  const signals = new Set<string>();
  for (const e of events) {
    if (e.type !== EventType.SIGNAL) continue;
    const name = asString((e.data ?? {})['name']);
    if (name !== undefined) signals.add(name);
  }
  for (const name of [...signals].slice(0, 2)) parts.push(`signal ${name}`);
  for (const n of events.filter((e) => e.type === EventType.NET_REQUEST).slice(0, 2)) {
    const data = n.data ?? {};
    const method = asString(data['method']) ?? 'GET';
    const path = trimUrl(asString(data['url']) ?? '');
    const status = 'number' === typeof data['status'] ? ` ${data['status']}` : '';
    parts.push(`${method} ${path}${status}`.trim());
  }
  const errors = events.filter(
    (e) => e.type === EventType.CONSOLE_ERROR || e.type === EventType.ERROR_UNCAUGHT,
  ).length;
  if (errors > 0) parts.push(`${errors} console error${errors > 1 ? 's' : ''}`);
  return parts.length > 0 ? parts.join('; ') : undefined;
}

/** A compact, legible label for a component auto-anchor (component@file:line, or its best part). */
export function componentLabel(
  anchor: Extract<FlowAnchor, { kind: typeof AnchorKind.COMPONENT }>,
): string {
  if (anchor.source !== undefined) {
    const base = anchor.source.file.split('/').pop() ?? anchor.source.file;
    const loc = `${base}:${anchor.source.line}`;
    return anchor.component !== undefined ? `${anchor.component}@${loc}` : loc;
  }
  return anchor.component ?? anchor.name ?? anchor.role ?? 'component';
}

/** The value of a step's primary anchor, for labelling the result row. */
export function anchorLabel(anchor: FlowAnchor): string {
  if (anchor.kind === AnchorKind.TESTID) return anchor.value;
  if (anchor.kind === AnchorKind.SIGNAL) return anchor.name;
  if (anchor.kind === AnchorKind.COMPONENT) return componentLabel(anchor);
  return anchor.name ?? anchor.role;
}

/** QUERY args for a component auto-anchor — source (precise) + component name (coarse) as given. */
export function componentQueryArgs(
  anchor: Extract<FlowAnchor, { kind: typeof AnchorKind.COMPONENT }>,
): Record<string, unknown> {
  const args: Record<string, unknown> = { by: QueryBy.COMPONENT };
  if (anchor.component !== undefined) args['component'] = anchor.component;
  if (anchor.source !== undefined) args['source'] = anchor.source;
  return args;
}

/** Run one testid-anchored step: re-resolve via QUERY, then ACT on the live ref, else drift. */
async function runTestidStep(
  session: FlowReplaySession,
  step: FlowStep,
  index: number,
  value: string,
  dynamic: ReadonlySet<string>,
  confirmDangerous: boolean,
  sleep: Sleep,
): Promise<FlowStepResult> {
  const { refs, hint } = await resolveTestid(session, value, sleep);
  if (0 === refs.length) {
    return {
      step: index,
      tool: step.tool,
      anchor: value,
      ok: false,
      drift: testidDrift(value, hint),
    };
  }
  const ref = refs[0] ?? '';
  const note = refs.length > 1 ? ambiguousTestidNote(value) : undefined;
  session.beginAction?.(ReticleTool.FLOW_REPLAY, { ref, action: step.action ?? '' });
  let act;
  try {
    act = await session.command(ReticleCommand.ACT, {
      ref,
      action: step.action ?? '',
      // `value` is the anchor's own name — the field this step types into — so a redacted fill can
      // be supplied from RETICLE_SECRET_<FIELD> without the flow carrying the secret.
      args: replayActionArgs(step.args, confirmDangerous, value),
    });
  } finally {
    session.finishAction?.();
  }
  const result: FlowStepResult = { step: index, tool: step.tool, anchor: value, ok: act.ok };
  if (!act.ok) {
    result.error = act.error ?? 'command failed';
    if (note !== undefined) result.note = note;
    return result;
  }
  // assert the step's expect.element testid is present AFTER the action —
  // unless that testid was marked DYNAMIC (the LLM-output case), in which case its presence/content
  // is NOT asserted (only the action ran). The skip is scoped strictly to the dynamic set.
  const expectTestid = step.expect?.element?.testid;
  if (expectTestid !== undefined && !dynamic.has(expectTestid)) {
    const expectRefs = await resolveTestid(session, expectTestid, sleep);
    if (0 === expectRefs.refs.length) {
      return {
        step: index,
        tool: step.tool,
        // The step's OWN anchor, not the expectation's target. Replay stops at the first drift, so
        // this result is the only thing the caller sees about why the run ended — naming the
        // assertion here reads as "step N's locator drifted" and hides that the action did run.
        anchor: value,
        ok: false,
        drift: expectElementDrift(expectTestid, expectRefs.hint),
      };
    }
  }
  if (note !== undefined) result.note = note;
  return result;
}

/**
 * After a step's anchor resolves and its action runs, its `expect` is EVALUATED — every kind of it.
 *
 * For a long time only `expect.state` was, so a recorded `expect.signal` or `expect.net` was written
 * to disk and read by nothing while `flow_save` graded the flow "asserted". Driven end to end over
 * MCP: annotate a step with a signal that never fires, save (grade "asserted"), replay -> status
 * "ok". A green that cannot go red, inside the feature whose job is catching exactly that.
 *
 * It compiles through the SAME `successToPredicate` the flow-level `success` has always used, so
 * there is one definition of what an expect means and the step form cannot drift from it again.
 * Turning this on makes previously-green flows go red. That is the point — they were green because
 * nothing was looking.
 */
async function assertStepExpect(
  session: FlowReplaySession,
  expect: NonNullable<FlowStep['expect']>,
  dynamic: ReadonlySet<string>,
  waitForSignal: WaitForSignal,
  timeoutMs: number,
  since: number,
): Promise<Drift | undefined> {
  // A testid is already asserted against the live DOM by the step runner. A role/name locator is
  // not that path — stripping every element made a recorded `until` by button name a no-op, so a
  // flow that proved the control at capture time could not go red when it was gone.
  const consequences: FlowExpect = { ...expect };
  if (undefined !== consequences.element?.testid) {
    delete consequences.element;
  }
  const predicate = successToPredicate(consequences, dynamic);
  if (predicate === undefined) return undefined;
  const verdict = await waitForSignal(session, predicate, timeoutMs, since);
  if (verdict.pass) return undefined;
  return {
    // The store case keeps its own kind because heal and the run report branch on it; everything
    // else is a consequence that did not hold, and the reason carries observed-vs-expected.
    reasonKind:
      expect.state !== undefined ? DriftReason.STATE_MISMATCH : DriftReason.SIGNAL_NOT_OBSERVED,
    reason: verdict.failureReason ?? "the step's declared consequence did not hold",
    anchor: expectLabel(expect),
    nearest: null,
  };
}

/** Name the thing that was asserted, for the drift's `anchor` column. */
function expectLabel(expect: NonNullable<FlowStep['expect']>): string {
  if (expect.signal !== undefined) return `signal:${expect.signal}`;
  if (expect.net !== undefined) return `net:${expect.net.urlContains ?? expect.net.method ?? '*'}`;
  if (expect.state !== undefined) return `state:${expect.state.path}`;
  if (expect.console !== undefined) return `console:${expect.console.level ?? '*'}`;
  if (undefined !== expect.element) {
    return expect.element.testid ?? expect.element.name ?? expect.element.role ?? 'element';
  }
  return 'expect';
}

/** Run one signal-anchored step: wait for the signal predicate, else drift (no nearest for signals). */
async function runSignalStep(
  session: FlowReplaySession,
  step: FlowStep,
  index: number,
  name: string,
  waitForSignal: WaitForSignal,
  signalTimeoutMs: number,
  since: number,
): Promise<FlowStepResult> {
  // Scope to THIS replay's floor, not the whole buffer.
  //
  // A signal step is a pure wait — the signal is fired by the PRECEDING act step — so a per-step floor
  // would miss it (false negative). But the default whole-buffer read (since=0) was too loose in the
  // one place it matters most: reticle_flow_verify replays every saved flow back-to-back in ONE
  // session, so a signal an EARLIER flow emitted (`auth:granted`, `nav:changed`) sat in the buffer and
  // satisfied a LATER flow's signal step even when that flow's own action never fired it — a
  // cross-flow false green on the exact suite-verify path the regression-cost claim rests on. The
  // replay-start floor excludes prior flows/runs while still seeing this run's adjacent-step signal.
  const verdict = await waitForSignal(
    session,
    { kind: PredicateKind.SIGNAL, name },
    signalTimeoutMs,
    since,
  );
  if (verdict.pass) return { step: index, tool: step.tool, anchor: name, ok: true };
  return {
    step: index,
    tool: step.tool,
    anchor: name,
    ok: false,
    drift: {
      reasonKind: DriftReason.SIGNAL_NOT_OBSERVED,
      reason: `signal "${name}" not observed`,
      anchor: name,
      nearest: null,
    },
  };
}

/**
 * Replay a loaded flow by RE-RESOLVING every step's semantic anchor against the live DOM — never
 * a stale ref. A testid anchor is re-found by reticle_query; a signal anchor waits on a predicate.
 * On the first anchor MISS the step carries legible drift and replay STOPS, returning the partial
 * results. This is the "whose fault is it" contract, not a blind "command failed".
 */
export async function replayFlow(
  session: FlowReplaySession,
  flow: FlowFile,
  waitForSignal: WaitForSignal,
  signalTimeoutMs: number,
  confirmDangerous = false,
  sleep: Sleep = realSleep,
): Promise<FlowStepResult[]> {
  const results: FlowStepResult[] = [];
  // testids whose region is LLM-dynamic — their expect-presence is NOT asserted.
  const dynamic = new Set<string>(
    (flow.dynamic ?? [])
      .filter((a) => a.kind === AnchorKind.TESTID)
      .map((a) => (a.kind === AnchorKind.TESTID ? a.value : '')),
  );
  // Floor for signal steps: signals that fire during THIS replay, never a prior flow/run in the same
  // session. Captured once, before any step, so a back-to-back suite verify cannot cross-satisfy.
  const replayFloor = session.elapsed();
  let index = 0;
  for (const step of flow.steps) {
    const label = anchorLabel(step.anchor);
    // The page this step runs on (the journey's "which page") — captured before the action.
    const page = currentRoute(session);
    // Event-time floor so the consequence reflects only THIS step's aftermath, not prior steps'.
    const cursorBefore = session.elapsed();
    const subSteps = step.steps;
    // Traced per step, so a slow replay says WHICH step and which anchor kind spent the time. The
    // per-step `durationMs` below is what the agent gets back; this is what a developer profiling
    // the replay engine gets, nested under the tool call with the browser round-trips beneath it.
    const result: FlowStepResult = await span(
      'flow.step',
      { index, anchor: step.anchor.kind, label },
      async () => {
        if (isDegradedAnchor(step.anchor)) {
          // Never QUERY the sentinel — it marks "no anchor was determined", not an element to find.
          return degradedStepResult(step, index, label);
        }
        if (subSteps !== undefined && subSteps.length > 0) {
          return runSequenceStep(session, step, index, subSteps, confirmDangerous, sleep);
        }
        if (step.anchor.kind === AnchorKind.SIGNAL) {
          return runSignalStep(
            session,
            step,
            index,
            label,
            waitForSignal,
            signalTimeoutMs,
            replayFloor,
          );
        }
        if (step.anchor.kind === AnchorKind.COMPONENT) {
          return runComponentStep(session, step, index, step.anchor, confirmDangerous, sleep);
        }
        if (step.anchor.kind === AnchorKind.ROLE && step.anchor.name !== undefined) {
          // A NAMED role anchor addresses one element. The nameless one is the degraded placeholder
          // and keeps its old path, where it fails legibly rather than querying a role as a testid.
          return runRoleStep(session, step, index, step.anchor, confirmDangerous, sleep);
        }
        return runTestidStep(session, step, index, label, dynamic, confirmDangerous, sleep);
      },
    );
    // Once the anchor resolved and the action ran, the step's own expect is evaluated — signal, net,
    // console and store truth alike — deterministically, in the same cheap replay loop, with no LLM.
    const stepExpect = step.expect;
    if (result.ok && result.drift === undefined && stepExpect !== undefined) {
      const expectDrift = await assertStepExpect(
        session,
        stepExpect,
        dynamic,
        waitForSignal,
        signalTimeoutMs,
        cursorBefore,
      );
      if (expectDrift !== undefined) {
        result.ok = false;
        result.drift = expectDrift;
      }
    }
    if (page !== undefined) result.page = page;
    const consequence = summarizeConsequence(
      session.eventsSince(cursorBefore).filter((e) => e.t >= cursorBefore),
    );
    if (consequence !== undefined) result.consequence = consequence;
    // Per-step wall time from the session's injected clock (dispatch → here, post-settle). Only set when
    // the clock actually advanced, so a fixed-clock fake reads durationMs-free (additive, non-breaking).
    const durationMs = session.elapsed() - cursorBefore;
    if (durationMs > 0) result.durationMs = durationMs;
    results.push(result);
    if (result.drift !== undefined || !result.ok) break;
    index += 1;
  }
  return results;
}
