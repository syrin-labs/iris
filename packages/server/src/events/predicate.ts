import {
  ElementState,
  PredicateKind,
  ReticleCommand,
  THROTTLED_STARVED_NOTE,
  isSameDocument,
  type CommandResult,
  type ElementQuery,
  type ReticleEvent,
  type MatchResult,
} from '@reticlehq/core';

import { log } from '../log.js';
import { bindSpanContext } from '../trace.js';
import { selectPath, capDepth } from '../session/state-select.js';
import { describeTestidMiss } from './testid-near-miss.js';
import { describeSplitTextMiss } from './split-text-miss.js';
import { predicateToExpectedLinks } from '../capsule/predicate-to-links.js';
import type { ExpectedLink } from '../capsule/divergence.js';
import { isAmbient, ambientKeyOf, type AmbientCounts } from '../journal/ambient.js';
import { evalRoute } from './predicate-route.js';
import { describeSuperseded } from './observed-in-window.js';
import {
  PredicateSchema,
  matchValue,
  evalNet,
  evalConsole,
  evalAnimation,
  evalSignal,
  evalSettled,
  residualQueryChecks,
  satisfiesResiduals,
  describeResidual,
  type Predicate,
  type EvalResult,
} from './predicate-eval.js';

export { PredicateSchema, PredicateKind };
export type { Predicate, EvalResult };

/** The subset of Session the predicate engine needs — keeps it testable with a fake. */
export interface PredicateSession {
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  eventsSince(cursor: number): ReticleEvent[];
  onEvent(listener: (event: ReticleEvent) => void): () => void;
  /** Milliseconds since connect — the same clock that stamps event `t` (injected, testable). */
  elapsed(): number;
  /**
   * Where the app is RIGHT NOW — the session's live URL, kept current across SPA navigation.
   *
   * Read by the `route` predicate when the window holds no route change, which is the only way
   * "did the session survive a reload?" can be answered at all. Optional: a fake session that never
   * navigates simply omits it and route falls back to change-only, as before.
   */
  url?: string;
  /**
   * The document currently under observation, as the session derived it from its own event stream.
   *
   * Every oracle below that reads the window asks "what happened here", and a window is scoped by
   * time and by ring-buffer capacity and by nothing else — so it can still hold the traffic, console
   * output and signals of a page a full navigation or a reload has already thrown away. Answering a
   * predicate with one of those is true about the bytes and false about the world, in whichever
   * direction it lands: a stale event that satisfies the assertion is a false green, and one that
   * refutes it is a false red.
   *
   * Optional, and undefined means nobody could say which document is current — `isSameDocument`
   * treats absence as current on both sides, so the engine then behaves exactly as it did before this
   * existed. Named to match `Session.currentDocumentId`, which is what supplies it in production.
   */
  currentDocumentId?: string | undefined;
  /**
   * Learned per-ref ambient-churn counts (real-time regions that churn with no action driving them).
   * The settle oracle drops events on learned-ambient refs so a chat/ticker page can still go quiet.
   * Optional: a session without ambient learning simply omits it and settle behaves as before.
   */
  ambientCounts?(): AmbientCounts;
  /**
   * Subscribe to session disconnect. Returns an unsubscribe function. Optional: a session without
   * this hook (e.g. tests that never disconnect) simply leaves in-flight predicates until timeout.
   */
  onDisconnect?(listener: () => void): () => void;
  /**
   * True when the tab is hidden or stale enough that the browser is throttling it.
   * Optional: a fake that never throttles simply omits it.
   */
  throttled?(): boolean;
}

/**
 * A composite result that carries a child's "nobody could evaluate this" up to the verdict rule.
 *
 * `decideVerified` already treats `inconclusive` correctly and does it ahead of the failure clause,
 * so all a composite has to do is stop dropping the field on its way out. `pass` stays false because
 * nothing was proven; what changes is that the verdict reads UNKNOWN rather than blaming the app for
 * a clause the CALL under-specified.
 */
function unreadableComposite(child: EvalResult, evidence: unknown): EvalResult {
  const reason = child.inconclusive ?? 'a sub-predicate could not be evaluated';
  return { pass: false, failureReason: reason, inconclusive: reason, evidence };
}

async function matchOnce(
  session: PredicateSession,
  query: ElementQuery,
  state: ElementState | undefined,
): Promise<MatchResult> {
  const res = await session.command(ReticleCommand.MATCH, { query, state });
  if (!res.ok) return { matched: false, count: 0, elements: [] };
  return (res.result ?? { matched: false, count: 0, elements: [] }) as MatchResult;
}

async function evalElement(
  session: PredicateSession,
  query: ElementQuery,
  state: ElementState | undefined,
  absent: boolean,
  diagnose: boolean,
): Promise<EvalResult> {
  // Fields the browser's locator would have DROPPED, enforced back here — see residualQueryChecks.
  // Checked before the round-trip when nothing can enforce them: a predicate that cannot be evaluated
  // must say so rather than resolve to whatever the surviving half of it happened to match.
  const residual = residualQueryChecks(query);
  if (residual.unusable.length > 0) {
    const reason =
      `the element locator ignores ${residual.unusable.map((f) => `\`${f}\``).join(', ')} ` +
      `in ${JSON.stringify(query)} — it resolves by the first of by+value, component/source, role, ` +
      'text, label, placeholder, testid, alt that is present, and nothing here can check the rest. ' +
      'Assert them one locator at a time, or move the extra field into the locator';
    return { pass: false, failureReason: reason, inconclusive: reason };
  }
  let match = await matchOnce(session, query, state);
  const subject = JSON.stringify(query);
  // A residual narrows the SET; `count` is every match while `elements` is only the described prefix,
  // so a locator broad enough to be truncated cannot be narrowed honestly. Say so instead of guessing.
  if (residual.checks.length > 0 && match.count > match.elements.length) {
    const reason = `${String(match.count)} elements matched ${subject} and only ${String(match.elements.length)} were described, so ${residual.checks.map(([f]) => `\`${f}\``).join(', ')} could not be checked against all of them — narrow the locator`;
    return { pass: false, failureReason: reason, inconclusive: reason };
  }
  const kept = match.elements.filter((element) => satisfiesResiduals(element, residual.checks));
  // The locator found something and the dropped fields disagree with it. Reported separately from a
  // plain miss because the fixes are opposite: the element IS there, its value is not what was claimed.
  if (residual.checks.length > 0 && match.matched && 0 === kept.length && !absent) {
    const wanted = residual.checks.map(([f, want]) => `${f}=${JSON.stringify(want)}`).join(', ');
    return {
      pass: false,
      failureReason: `element matching ${subject} is present but ${wanted} does not hold`,
      observed: match.elements
        .map((element) => residual.checks.map(([f]) => describeResidual(element, f)).join(', '))
        .join('; '),
      expected: `an element matching ${subject} with ${wanted}`,
      assertion: `element.${residual.checks[0]?.[0] ?? 'residual'}`,
      evidence: match.elements,
    };
  }
  if (residual.checks.length > 0) {
    match = { ...match, matched: kept.length > 0, count: kept.length, elements: kept };
  }
  // A given-but-missing scope is handled ASYMMETRICALLY, because "absent" and "present" ask different
  // questions of a scope that no longer exists:
  //  - ABSENT: an element is trivially absent from a container that isn't there. This is also the
  //    everyday "wait for the #overlay/#spinner/#modal to disappear" pattern (scope the wait to the
  //    node being removed) — treating scopeMissing as a hard fail there burned the whole timeout and
  //    flipped a correct green to red. So scopeMissing satisfies an absence check.
  //  - PRESENT: you cannot confirm an element is present inside a scope that resolved to nothing, and
  //    silently widening to the whole page is the original false green. So scopeMissing FAILS presence
  //    (on the wait_for path this just keeps polling until the scope appears).
  if (absent) {
    if (true === match.scopeMissing) {
      return { pass: true, evidence: { absent: true, scopeMissing: true } };
    }
    return match.matched
      ? {
          pass: false,
          failureReason: `expected element to be absent but found ${String(match.count)}`,
          observed: `${String(match.count)} element(s) matching ${subject}`,
          expected: `no element matching ${subject}`,
          assertion: 'element.absent',
          evidence: match.elements,
        }
      : { pass: true, evidence: { absent: true } };
  }
  if (true === match.scopeMissing) {
    return {
      pass: false,
      failureReason: `scope resolved to no element — cannot confirm ${subject} is present`,
      observed: 'the requested scope is not on the page (unmounted or selector matched nothing)',
      expected: `an element matching ${subject} within an existing scope`,
      assertion: 'element.present',
      evidence: { scopeMissing: true },
    };
  }
  if (match.matched) return { pass: true, evidence: match.elements };

  // The near-miss diagnostic below costs one or two EXTRA MATCH round-trips. It only enriches a FAILED
  // verdict, and a wait loop's interim rechecks read nothing but `pass` — so on the poll path (diagnose
  // false) skip straight to the plain fail. Under an event flood a role+name element wait was firing
  // two live-DOM scans per recheck for a diagnostic no interim eval ever reads; the final timeout eval
  // still runs with diagnose=true and produces the full near-miss.
  if (!diagnose) {
    return {
      pass: false,
      failureReason: `no element matched ${subject}${state === undefined ? '' : ` in state '${state}'`}`,
      observed: 'no matching element on the page',
      expected: `an element matching ${subject}${state === undefined ? '' : ` in state '${state}'`}`,
      assertion: 'element.present',
    };
  }

  // Diagnostic near-miss: was it there but in the wrong state, or a similar element present?
  if (state !== undefined) {
    const relaxed = await matchOnce(session, query, undefined);
    if (relaxed.matched) {
      return {
        pass: false,
        failureReason: `element exists but not in state '${state}'`,
        observed: `element matching ${subject} is present, states: ${
          relaxed.elements[0]?.states.join(', ') ?? 'unknown'
        }`,
        expected: `element matching ${subject} in state '${state}'`,
        assertion: 'element.state',
        evidence: { nearMiss: relaxed.elements },
      };
    }
  }
  if (query.role !== undefined && query.name !== undefined) {
    const roleOnly = await matchOnce(session, { role: query.role }, state);
    if (roleOnly.matched) {
      return {
        pass: false,
        failureReason: `no '${query.role}' named '${query.name}'; saw: ${roleOnly.elements
          .map((e) => e.name)
          .filter((n) => n.length > 0)
          .join(', ')}`,
        observed: `${String(roleOnly.count)} '${query.role}' element(s), named: ${roleOnly.elements
          .map((e) => e.name)
          .filter((n) => n.length > 0)
          .join(', ')}`,
        expected: `a '${query.role}' named '${query.name}'`,
        assertion: 'element.role+name',
        evidence: { nearMiss: roleOnly.elements },
      };
    }
  }
  // The testid near-miss: name what IS here, so a typo is one step from fixed rather than a dead
  // end. reticle_query has always done this; the predicate path had no equivalent. See
  // testid-near-miss.ts.
  const present = match.hint?.presentTestids ?? [];
  const alsoHere =
    query.testid === undefined ? undefined : describeTestidMiss(query.testid, present);
  // A text miss where the string is on the page but split across children reads exactly like an
  // element that never rendered. Naming the container is the difference between a retry and a bug
  // report against working code. See split-text-miss.ts.
  const splitText = describeSplitTextMiss(match.hint?.splitText);
  const clause = splitText ?? (alsoHere === undefined || '' === alsoHere ? undefined : alsoHere);
  const suffix = clause === undefined ? '' : ` — ${clause}`;
  return {
    pass: false,
    failureReason: `no element matched ${subject}${state === undefined ? '' : ` in state '${state}'`}${suffix}`,
    observed: `no matching element on the page${suffix}`,
    expected: `an element matching ${subject}${state === undefined ? '' : ` in state '${state}'`}`,
    assertion: 'element.present',
    ...(present.length > 0 ? { evidence: { presentTestids: present } } : {}),
  };
}

/** The single element of a list, or undefined when there is not exactly one. */
function oneOf(names: readonly string[]): string | undefined {
  return 1 === names.length ? names[0] : undefined;
}

/**
 * `readState`'s truncation report, when the caps actually fired.
 *
 * Its PRESENCE is the warning — the field is omitted entirely on an intact read, which is what lets
 * "the list is short" stay distinguishable from "I shortened the list".
 */
function truncationOf(result: unknown): Record<string, unknown> | undefined {
  if ('object' !== typeof result || null === result) return undefined;
  const report = (result as { truncation?: unknown }).truncation;
  return 'object' === typeof report && null !== report
    ? (report as Record<string, unknown>)
    : undefined;
}

/** A scoped `readState` reply, narrowed to the shape `selectPath` would have produced. */
function asSelection(result: unknown): { found: boolean; value: unknown } | undefined {
  if ('object' !== typeof result || null === result) return undefined;
  const record = result as { found?: unknown; value?: unknown };
  return 'boolean' === typeof record.found
    ? { found: record.found, value: record.value }
    : undefined;
}

/**
 * A NAMED store needs no whole-store read. `reticle_state`'s scoped mode selects the path out of the
 * RAW store IN-PAGE and returns only it, so the assertion resolves in one round trip against a payload
 * the size of the value — not the store. The unnamed case below still needs the wide read, because
 * that is how it discovers WHICH store carries the path; only the named branch changes.
 *
 * A scoped read answers `found: false` for both "no such store" and "no such path", so the two are
 * kept distinct here using the `storeNames` list the reply always carries — otherwise the payload gets
 * cheaper while the message gets worse.
 */
async function evalStateNamed(
  session: PredicateSession,
  p: Extract<Predicate, { kind: typeof PredicateKind.STATE }>,
  storeName: string,
): Promise<EvalResult> {
  const scoped = await session.command(ReticleCommand.STATE_READ, {
    store: storeName,
    path: p.path,
  });
  if (!scoped.ok) {
    return {
      pass: false,
      failureReason: 'state read failed',
      observed: 'the store could not be read',
      expected: 'a readable registered store',
      assertion: 'state.unreadable',
    };
  }
  const reply = (scoped.result ?? {}) as {
    stores?: Record<string, unknown>;
    storeNames?: unknown;
    availableKeys?: unknown;
  };
  const names = Array.isArray(reply.storeNames) ? (reply.storeNames as string[]) : [];

  // Resolve the value. A CURRENT SDK honours the scoped read and answers `{ found, value }` selected
  // in-page — the whole point of this path. An OLDER SDK (version skew) or any transport that ignores
  // `path` answers the whole-store shape `{ stores }`; walk the path server-side there so the verdict
  // stays correct across SDK versions. The scoped win is simply unavailable on the old ones.
  const scopedSel = asSelection(scoped.result);
  const wholeStores = reply.stores;
  const scopedKeys = Array.isArray(reply.availableKeys)
    ? (reply.availableKeys as string[])
    : undefined;
  let selection: { found: boolean; value?: unknown; availableKeys?: string[] };
  if (scopedSel !== undefined) {
    selection =
      scopedKeys === undefined
        ? { found: scopedSel.found, value: scopedSel.value }
        : { found: scopedSel.found, value: scopedSel.value, availableKeys: scopedKeys };
  } else if (wholeStores !== undefined) {
    selection = selectPath(wholeStores[storeName], p.path);
  } else {
    selection = { found: false };
  }

  // "no store named X" and "X has no such path" both surface as found:false; keep them distinct using
  // the store list the reply carries, or the message regresses while the payload improves.
  const storeAbsent =
    wholeStores !== undefined
      ? !(storeName in wholeStores)
      : names.length > 0 && !names.includes(storeName);
  if (!selection.found && storeAbsent) {
    return {
      pass: false,
      failureReason: `no store named '${storeName}' is registered (${names.join(', ')})`,
      observed: `store '${storeName}' is not registered`,
      expected: `a registered store named '${storeName}'`,
      assertion: 'state.store-missing',
      evidence: { searchedStores: names },
    };
  }
  // A scoped sub-tree can itself be too big for the caps; a comparison against a value known to be
  // incomplete is an unanswered question, not a failure. Same rule the whole-store path applies.
  if (truncationOf(scoped.result) !== undefined) {
    const reason =
      `state '${p.path}' could not be read intact — the transport caps truncated it, so the ` +
      'value was never compared. Assert a narrower path, or a smaller field inside it';
    return { pass: false, failureReason: reason, inconclusive: reason };
  }
  if (!selection.found) {
    return {
      pass: false,
      failureReason: `state path '${p.path}' not found in store '${storeName}'`,
      observed: `no path '${p.path}' in store '${storeName}'`,
      expected: `store '${storeName}' to expose '${p.path}'`,
      assertion: 'state.path-missing',
      evidence: { availableKeys: selection.availableKeys },
    };
  }
  const want = p.equals === undefined ? '*' : p.equals;
  if (matchValue(selection.value, want)) {
    return {
      pass: true,
      evidence: { store: storeName, path: p.path, value: capDepth(selection.value, 1) },
    };
  }
  return {
    pass: false,
    failureReason: `state '${p.path}' is ${JSON.stringify(capDepth(selection.value, 0))}, expected ${JSON.stringify(want)}`,
    observed: `${p.path} = ${JSON.stringify(capDepth(selection.value, 0))}`,
    expected: `${p.path} = ${JSON.stringify(want)}`,
    assertion: 'state.equals',
    evidence: { store: storeName, path: p.path, value: capDepth(selection.value, 1) },
  };
}

async function evalState(
  session: PredicateSession,
  p: Extract<Predicate, { kind: typeof PredicateKind.STATE }>,
): Promise<EvalResult> {
  // Named store: one scoped read, no whole-store payload (issue #336).
  if (p.store !== undefined) return await evalStateNamed(session, p, p.store);
  const res = await session.command(ReticleCommand.STATE_READ, {});
  if (!res.ok) {
    return {
      pass: false,
      failureReason: 'state read failed',
      observed: 'the store could not be read',
      expected: 'a readable registered store',
      assertion: 'state.unreadable',
    };
  }
  const stores = ((res.result ?? {}) as { stores?: Record<string, unknown> }).stores ?? {};
  const names = Object.keys(stores);
  // Ambiguity is about the PATH, not the store count.
  //
  // Registering more than one store is normal — an app store, a query cache, and the render meter
  // Reticle registers itself — and asking "which of these three?" when only one of them HAS the
  // path is a question with one possible answer. It was costing a real verdict: a bench-app drive
  // asserting `{path:'view'}` returned `unknown` while the same response body carried the matching
  // `view` state diff. `unknown` is not a pass, so that is a verification that did not happen.
  //
  // So narrow to the stores that actually carry the path, and refuse only when THOSE collide.
  const candidates =
    p.store === undefined ? names.filter((n) => selectPath(stores[n], p.path).found) : [];
  const storeName = p.store ?? (1 === names.length ? names[0] : oneOf(candidates));
  if (storeName === undefined) {
    // With no store registered there is nothing to read, and with two stores that both carry the
    // path there is no way to pick — neither is a finding about the app, no assertion was evaluated,
    // so both are inconclusive rather than failed. See honesty/inconclusive.
    //
    // Zero candidates is the one case that is NOT a question: every registered store was searched
    // and none exposes the path, so the assertion cannot hold anywhere. That is the same verdict a
    // named store has always produced for a missing path, and it falls through to it below.
    if (0 === names.length) {
      const reason = 'no registered store to read state from';
      return { pass: false, failureReason: reason, inconclusive: reason };
    }
    if (candidates.length > 1) {
      // Names the stores that actually collide. Listing all of them made the reader weigh
      // candidates that could never have matched.
      const reason = `multiple stores (${candidates.join(', ')}) expose '${p.path}'; name one with \`store\``;
      return { pass: false, failureReason: reason, inconclusive: reason };
    }
    return {
      pass: false,
      failureReason: `state path '${p.path}' not found in any registered store (${names.join(', ')})`,
      observed: `no path '${p.path}' in ${names.join(', ')}`,
      expected: `some registered store to expose '${p.path}'`,
      assertion: 'state.path-missing',
      evidence: { searchedStores: names },
    };
  }
  let selection = selectPath(stores[storeName], p.path);
  // The whole-store read walks into a value the transport caps may already have mangled.
  //
  // `readState` has a SCOPED mode that selects the path out of the RAW store before sanitising, added
  // precisely so a large or deep path still resolves. This path was not using it, so a store with one
  // big collection in it truncated the small value sitting beside it, and the comparison then ran
  // against the literal string "[TRUNCATED]" and returned a confident `no`. Measured on the Atlas
  // fixture: a one-element array reported as a failed assertion while the same payload's state diffs
  // showed the assertion holding.
  //
  // Re-read only when a cap actually fired, so an intact read costs exactly what it did before.
  if (truncationOf(res.result) !== undefined) {
    const scoped = await session.command(ReticleCommand.STATE_READ, {
      store: storeName,
      path: p.path,
    });
    const result = scoped.ok ? scoped.result : undefined;
    const scopedTruncation = truncationOf(result);
    if (scopedTruncation !== undefined) {
      // Even the raw sub-tree was too big. Nothing here knows what the value IS, so nothing here can
      // say the assertion failed — that would be an accusation the evidence does not support.
      const reason =
        `state '${p.path}' could not be read intact — the transport caps truncated it, so the ` +
        'value was never compared. Assert a narrower path, or a smaller field inside it';
      return { pass: false, failureReason: reason, inconclusive: reason };
    }
    if (result !== undefined) {
      const scopedSelection = asSelection(result);
      if (scopedSelection !== undefined) selection = scopedSelection;
    }
  }
  if (!selection.found) {
    return {
      pass: false,
      failureReason: `state path '${p.path}' not found in store '${storeName}'`,
      observed: `no path '${p.path}' in store '${storeName}'`,
      expected: `store '${storeName}' to expose '${p.path}'`,
      assertion: 'state.path-missing',
      evidence: { availableKeys: selection.availableKeys },
    };
  }
  const want = p.equals === undefined ? '*' : p.equals;
  if (matchValue(selection.value, want)) {
    return {
      pass: true,
      evidence: { store: storeName, path: p.path, value: capDepth(selection.value, 1) },
    };
  }
  return {
    pass: false,
    failureReason: `state '${p.path}' is ${JSON.stringify(capDepth(selection.value, 0))}, expected ${JSON.stringify(want)}`,
    observed: `${p.path} = ${JSON.stringify(capDepth(selection.value, 0))}`,
    expected: `${p.path} = ${JSON.stringify(want)}`,
    assertion: 'state.equals',
    evidence: { store: storeName, path: p.path, value: capDepth(selection.value, 1) },
  };
}

/**
 * Oracles whose ONLY source of truth is the event window.
 *
 * Element, text and state read the page as it is right now, so supersession cannot reach them. Route
 * is the deliberate omission: it has a second source — where the app is at this moment — and a
 * reload is precisely the case it was given that fallback for, so emptying its window must not take
 * the answer away.
 */
const WINDOW_ONLY_KINDS: ReadonlySet<Predicate['kind']> = new Set([
  PredicateKind.NET,
  PredicateKind.CONSOLE,
  PredicateKind.ANIMATION,
  PredicateKind.SIGNAL,
  PredicateKind.SETTLED,
]);

/** Names the oracle that answered, in the same shape every other `assertion` here uses. */
const SUPERSEDED_ASSERTION = 'window.evidence-superseded';

/** The predicate's own event-time floor, if its kind carries one. */
function predicateSince(predicate: Predicate): number {
  return 'since' in predicate && 'number' === typeof predicate.since ? predicate.since : 0;
}

/**
 * A miss on a throttled tab is not a missing render. The browser has starved the tab, so a timeout
 * there may mean it never ran — which must not look like "the text is absent".
 *
 * Sets `inconclusive` only. The PROSE is already handled one layer up by
 * `annotateStarvedFailure` (session-health.ts), which suffixes the same fact onto the
 * failureReason so the concrete diagnosis still leads; writing it here as well would put the
 * sentence in every throttled failure twice. What was missing was never the sentence — it was the
 * FIELD an agent gates on, so a starved wait graded `assertion-failed` and sent somebody to fix
 * working code.
 *
 * Idempotent, and a more specific `inconclusive` (unreadable locator, superseded window) is never
 * overwritten.
 */
function annotateThrottledMiss(session: PredicateSession, result: EvalResult): EvalResult {
  if (result.pass) return result;
  if (true !== session.throttled?.()) return result;
  if (result.inconclusive !== undefined) return result;
  return { ...result, inconclusive: THROTTLED_STARVED_NOTE };
}

export async function evaluatePredicate(
  session: PredicateSession,
  predicate: Predicate,
  since = 0,
  diagnose = true,
): Promise<EvalResult> {
  return annotateThrottledMiss(
    session,
    await evaluatePredicateRaw(session, predicate, since, diagnose),
  );
}

async function evaluatePredicateRaw(
  session: PredicateSession,
  predicate: Predicate,
  since = 0,
  // Compute the (extra-round-trip) near-miss diagnostics on element failures. Default true so a
  // one-shot assert is fully diagnostic; the wait loop passes false on its interim polls (which read
  // only `pass`) and true on the final timeout eval, so a flood no longer pays for a diagnostic nobody
  // reads. Only element/text failures have a near-miss; everything else ignores this.
  diagnose = true,
): Promise<EvalResult> {
  // A predicate's own `since` is a TIGHTER event-time floor than the caller's — an agent that took
  // `since` from the act it just performed is scoping the assertion to that action's aftermath. It is
  // applied here, once, rather than in each eval: the floor means the same thing for every kind that
  // reads the event stream, and net/console re-applying it is a no-op.
  const raw = session.eventsSince(Math.max(since, predicateSince(predicate)));
  // Scoped ONCE, here, for the same reason the contradiction pass scopes at its own choke point:
  // reasoning about a dead page's evidence is a defect in every oracle below rather than in whichever
  // one happened to read it, and this is the single place they all take their window from.
  const events = raw.filter((e) => isSameDocument(e.documentId, session.currentDocumentId));
  const superseded = raw.length - events.length;
  // An empty window was always allowed to mean "it did not happen"; that reading is only unsafe once
  // supersession is what emptied it. Without this, dropping stale evidence would trade a wrong pass
  // for a wrong FAILURE — and a failure names a component and sends an agent to fix working code.
  // `inconclusive` is the established way to say "nothing was proven and nobody could have proven
  // it", and `decideVerified` already reads it as UNKNOWN ahead of the failure clause.
  if (superseded > 0 && 0 === events.length && WINDOW_ONLY_KINDS.has(predicate.kind)) {
    const reason = describeSuperseded('observations', superseded);
    return {
      pass: false,
      failureReason: reason,
      inconclusive: reason,
      observed: 'every observation in this window belongs to a document since replaced',
      expected: `evidence recorded under the document now on screen for ${predicate.kind}`,
      assertion: SUPERSEDED_ASSERTION,
    };
  }
  switch (predicate.kind) {
    case PredicateKind.ELEMENT:
      return evalElement(
        session,
        predicate.query,
        predicate.state,
        predicate.absent ?? false,
        diagnose,
      );
    case PredicateKind.TEXT:
      return evalElement(
        session,
        // `scope` passes straight through: the text predicate has always been an element query
        // with only `text` filled in, so scoping it needs the field, not a second code path.
        undefined === predicate.scope
          ? { text: predicate.contains }
          : { text: predicate.contains, scope: predicate.scope },
        true === predicate.visible ? ElementState.VISIBLE : undefined,
        predicate.absent ?? false,
        diagnose,
      );
    case PredicateKind.NET:
      return evalNet(events, predicate);
    case PredicateKind.ROUTE:
      return evalRoute(events, predicate, session.url);
    case PredicateKind.CONSOLE:
      return evalConsole(events, predicate);
    case PredicateKind.ANIMATION:
      return evalAnimation(events, predicate);
    case PredicateKind.SIGNAL:
      return evalSignal(events, predicate);
    case PredicateKind.STATE:
      return evalState(session, predicate);
    case PredicateKind.SETTLED: {
      // Drop events on learned-ambient regions (chat/ticker churn) before the settle check — by ref
      // alone, NOT by attribution: window-attribution ("happened during the action window") is a time
      // heuristic, never causation, so a chat message arriving mid-window must not hold settle open.
      const counts = session.ambientCounts?.();
      const settleEvents =
        counts === undefined ? events : events.filter((e) => !isAmbient(counts, ambientKeyOf(e)));
      return evalSettled(settleEvents, predicate, session.elapsed());
    }
    case PredicateKind.ALL_OF: {
      const results = await Promise.all(
        predicate.predicates.map((p) => evaluatePredicate(session, p, since, diagnose)),
      );
      // A clause that genuinely failed OUTRANKS one nobody could read. Softening a real failure to
      // UNKNOWN would hide the defect the agent came for, which is the more expensive of the two
      // mistakes; the reverse — grading an unreadable clause as a defect in the app — is the one
      // that was happening.
      const failed = results.find((r) => !r.pass && r.inconclusive === undefined);
      if (failed !== undefined) {
        return {
          pass: false,
          failureReason: failed.failureReason ?? 'a sub-predicate of allOf failed',
          // A conjunction is decided as soon as ONE clause is: nothing the others do later can
          // rescue it. This is what makes the early exit reach real calls, since an exact count is
          // usually asserted alongside the UI change it is meant to accompany.
          ...(true === failed.decided ? { decided: true } : {}),
          evidence: results,
        };
      }
      const unreadable = results.find((r) => r.inconclusive !== undefined);
      if (unreadable !== undefined) return unreadableComposite(unreadable, results);
      return { pass: true, evidence: results.map((r) => r.evidence) };
    }
    case PredicateKind.ANY_OF: {
      const results = await Promise.all(
        predicate.predicates.map((p) => evaluatePredicate(session, p, since, diagnose)),
      );
      const passed = results.find((r) => r.pass);
      if (passed !== undefined) return { pass: true, evidence: passed.evidence };
      // "No sub-predicate matched" is a claim anyOf is not entitled to make while one of them was
      // never read: the unreadable clause might have been the one that would have matched.
      const unreadable = results.find((r) => r.inconclusive !== undefined);
      if (unreadable !== undefined) return unreadableComposite(unreadable, results);
      return { pass: false, failureReason: 'no sub-predicate of anyOf matched', evidence: results };
    }
    case PredicateKind.NOT: {
      const inner = await evaluatePredicate(session, predicate.predicate, since, diagnose);
      // The sharpest case of the three, and the only one that produced a GREEN. `not` read the
      // child's `pass: false` as "the inner predicate did not hold" and passed — so an assertion
      // nobody could evaluate became a verdict of verified, manufactured out of a missing reading.
      // You cannot negate an answer nobody had.
      if (inner.inconclusive !== undefined) return unreadableComposite(inner, inner);
      // A green negation used to return a bare `{ pass: true }`, so the payload fell back to
      // whatever the caller had — every element matching the OUTER locator. Three clauses negating
      // three different names then produced byte-identical responses, which reads as a checker that
      // dropped the name rather than one that correctly found all three absent. The evidence is the
      // whole answer here: what was looked for, and that it was not there.
      return inner.pass
        ? { pass: false, failureReason: 'negated predicate unexpectedly held', evidence: inner }
        : { pass: true, evidence: { negated: predicate.predicate, held: false, saw: inner } };
    }
    default:
      return { pass: false, failureReason: 'unknown predicate' };
  }
}

/** Backstop poll cadence — guarantees a re-check even if no event fires (e.g. a `settled` wait). */
const POLL_INTERVAL_MS = 150;
/** Minimum gap between consecutive event-driven rechecks, so an event flood can't drive back-to-back
 *  DOM/STATE round-trips. Small enough that added pass-detection latency is negligible next to the
 *  poll cadence, large enough to collapse a per-frame event storm into a bounded recheck rate. */
const MIN_RECHECK_GAP_MS = 25;

/**
 * How long an exact-count predicate keeps watching AFTER it first reads true.
 *
 * A count only rises while a window is open, so "exactly N" is a statement about the END of one and
 * cannot be settled early — yet every wait here resolves the moment a check passes. Live, on a real
 * payments dashboard: a Refund confirm fired TWO POSTs 59 ms apart, and
 * `until: { kind:'net', method:'POST', urlContains:'/refund', count:1 }` returned
 * `pass: true, matched: 1`. Not a counting bug — `evalNet` counts occurrences correctly. The wait had
 * already stopped looking. So `count: 1` silently meant "at least 1", which is the assertion the
 * caller wrote `count` specifically to avoid, and the branch implementing it claims to catch "the
 * double-submit / useEffect-double-fire / retry-storm regression class".
 *
 * 300 ms is chosen against the measured defect: the observed double-submit gap was 59 ms, a React
 * double-effect fires within one commit, and a retry storm is faster still. It is a real ceiling, not
 * a proof — a duplicate arriving 400 ms later still passes. Widening it costs every exact-count
 * assertion that latency, so this trades an unbounded false green for a bounded one and says so.
 */
const COUNT_CONFIRM_MS = 300;

/**
 * Does this predicate assert an exact cardinality anywhere inside it?
 *
 * Only these hold after passing. A presence-only predicate ("at least one") IS satisfiable early and
 * must stay that way, or every ordinary wait pays the confirmation delay for nothing.
 */
function assertsExactCount(predicate: Predicate): boolean {
  if (PredicateKind.ALL_OF === predicate.kind || PredicateKind.ANY_OF === predicate.kind) {
    return predicate.predicates.some(assertsExactCount);
  }
  if (PredicateKind.NOT === predicate.kind) return assertsExactCount(predicate.predicate);
  // `signal` carries `count` for the same reason `net` does, and for the same defect: its schema
  // calls the double-fire "the defect no state-only oracle can see", because a handler wired twice
  // leaves the store in the right shape and a presence check green on both. Reading `net` alone
  // meant a signal count resolved on its first match, so `count: 1` silently meant "at least 1" on
  // the one channel able to see the bug. `evalSignal` counts correctly; the wait stopped early.
  return (
    (PredicateKind.NET === predicate.kind || PredicateKind.SIGNAL === predicate.kind) &&
    predicate.count !== undefined
  );
}

/**
 * Evaluate now, else wait for it to become true (on each event + a poll) until timeout. `since` is
 * the event-time floor (see evaluatePredicate) so a waiter cannot resolve on a stale buffered event.
 */
export function waitForPredicate(
  session: PredicateSession,
  predicate: Predicate,
  timeoutMs: number,
  since = 0,
): Promise<EvalResult> {
  return new Promise<EvalResult>((resolve) => {
    let done = false;
    const failed = (error: unknown): EvalResult => ({
      pass: false,
      failureReason: error instanceof Error ? error.message : String(error),
    });
    let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
    /** One-shot re-check timed to when a time-based predicate could first pass. See retryAfterMs. */
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    // An exact-count wait keeps watching after it first reads true — see COUNT_CONFIRM_MS.
    const holdsForCount = assertsExactCount(predicate);
    let confirming = false;
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;
    /** Report a wait that could not run, and END it — see guardedCheck. */
    const failWait = (error: unknown): void => {
      log('reticle_wait_failed', {
        predicate: predicate.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      finish({
        ...failed(error),
        failureReason:
          'the wait could not be evaluated and was ended rather than left pending: ' +
          (error instanceof Error ? error.message : String(error)),
      });
    };
    const finish = (result: EvalResult): void => {
      if (done) return;
      done = true;
      unsub();
      unsubDisconnect?.();
      clearInterval(interval);
      clearTimeout(timer);
      if (cooldownTimer !== undefined) clearTimeout(cooldownTimer);
      if (hintTimer !== undefined) clearTimeout(hintTimer);
      if (confirmTimer !== undefined) clearTimeout(confirmTimer);
      resolve(result);
    };
    // Coalesce re-checks: at most ONE evaluatePredicate is ever in flight (each can be a browser
    // MATCH/STATE_READ round-trip). Events that arrive while one is running set a single trailing
    // re-check instead of each firing their own command — otherwise a page emitting an event per
    // animation frame fans out hundreds of concurrent round-trips and collapses under backpressure.
    //
    // Beyond coalescing, PACE the trailing rechecks: without a gap the next eval fired the instant the
    // previous finished, so under an event flood one round-trip was permanently in flight (~184/sec at
    // 5ms RTT) — each a live-DOM scan on the app's main thread, the "the dashboard is janky while the
    // agent waits" case. The FIRST check on an idle loop still runs immediately (leading edge, so fast
    // detection is unchanged); only back-to-back rechecks under sustained load wait MIN_RECHECK_GAP_MS.
    let inFlight = false;
    let cooling = false;
    let pendingRecheck = false;
    const check = (): void => {
      if (done) return;
      if (inFlight || cooling) {
        pendingRecheck = true;
        return;
      }
      inFlight = true;
      // Interim poll: read only `pass`, so skip the extra near-miss round-trips (diagnose=false). The
      // final timeout eval below runs with full diagnostics.
      void evaluatePredicate(session, predicate, since, false)
        .then((r) => {
          if (!r.pass) {
            // Final already: stop rather than spend a budget that cannot change the answer. Only
            // where the evaluator could PROVE it (see EvalResult.decided) — an ordinary miss keeps
            // waiting, because "it has not happened yet" and "it will not happen" are the same
            // reading until the budget ends.
            if (true === r.decided) {
              finish(r);
              return;
            }
            // A time-based failure knows when it could stop being one — re-check THEN rather than on
            // the next blind tick. Without this, every `settled` wait paid up to a full poll interval
            // of dead time after the quiet window had already closed: measured at 566–627ms across
            // the fleet for a 500ms window, on the call an agent makes after almost every action.
            // Additive — the backstop interval below still runs, so a missed hint costs nothing.
            const hint = r.retryAfterMs;
            if ('number' === typeof hint && hint > 0 && hint < POLL_INTERVAL_MS) {
              clearTimeout(hintTimer);
              hintTimer = setTimeout(check, hint);
            }
            return;
          }
          // "Exactly N" cannot be concluded from a passing sample — the count can still rise. Hold,
          // re-evaluate WITH diagnostics, and let that second read be the verdict: if an N+1th
          // arrived in the meantime it now fails, carrying observed/expected rather than a bare no.
          if (!holdsForCount) {
            finish(r);
            return;
          }
          if (confirming) return;
          confirming = true;
          confirmTimer = setTimeout(() => {
            void evaluatePredicate(session, predicate, since)
              .then(finish)
              .catch((error: unknown) => {
                finish(failed(error));
              });
          }, COUNT_CONFIRM_MS);
        })
        .catch((error: unknown) => {
          finish(failed(error));
        })
        .finally(() => {
          inFlight = false;
          if (done) return;
          // Enter a short cooldown; process a coalesced recheck when it ends. The 150ms poll is the
          // backstop, so a missed trailing edge is caught within one interval regardless.
          cooling = true;
          cooldownTimer = setTimeout(() => {
            cooling = false;
            if (pendingRecheck && !done) {
              pendingRecheck = false;
              check();
            }
          }, MIN_RECHECK_GAP_MS);
        });
    };
    /**
     * Run a re-check so that NOTHING can leave this promise pending.
     *
     * `check` is fired from an event listener and an interval, neither of which is inside the
     * awaited chain. A synchronous throw there reached the process as an uncaughtException; a
     * rejection reached it as an unhandledRejection. Either way the wait never resolved and the tool
     * handler never returned — the agent sees a call that simply never comes back.
     *
     * This half covers the SYNCHRONOUS throw only. The rejection half is handled inside `check`, by
     * the `.catch` on its own promise chain — `check` returns void and voids the promise it starts,
     * so there is nothing to hand back here to await. Said explicitly because the obvious-looking
     * `if (result instanceof Promise) result.catch(…)` that used to sit here was dead code that read
     * like the rejection guard, and removing `check`'s own `.catch` as redundant would have restored
     * the exact hang this exists to prevent.
     *
     * That is the exact shape reported from a Plane (Next 14 + MobX) session, which tears the page
     * session down and rebuilds it on EVERY navigation, so a `{kind:"route"}` predicate always races
     * a teardown of the very session it is watching: `browser.command ok:true` for the click, and
     * then no `tool.handler` for that callId, ever.
     *
     * A wait that cannot evaluate is a FAILED wait, not an eternal one. It now says so and finishes.
     */
    const guardedCheck = (): void => {
      try {
        check();
      } catch (error) {
        failWait(error);
      }
    };
    // Bound to the CALL that started this wait. The listener fires from the WebSocket message
    // handler and the interval from the timer queue — neither is in the awaited chain, so without
    // this every re-check opened a new call at depth 0 and emitted a `browser.command` with no
    // `tool.handler`. Measured on one healthy run: 23 such orphans, which is precisely the
    // documented signature of a HUNG call. A diagnostic that fires on healthy runs is not one.
    const boundCheck = bindSpanContext(guardedCheck);
    const unsub = session.onEvent(() => {
      boundCheck();
    });
    const unsubDisconnect = session.onDisconnect?.(() => {
      // `observationLost` is what stops this being graded as an app defect. `pass: false` is still
      // correct — the consequence was not seen to hold — but on its own it reached the verdict rule
      // as ASSERTION_FAILED, so a reload mid-wait reported "the declared consequence did not hold"
      // against a healthy component, by file and line. The flag is structured rather than inferred
      // from this string, because every other `failureReason` here is prose about the APP.
      finish({ pass: false, failureReason: 'session disconnected', observationLost: true });
    });
    const interval = setInterval(boundCheck, POLL_INTERVAL_MS);
    const timer = setTimeout(() => {
      void evaluatePredicate(session, predicate, since)
        .then((r) => {
          // Spread the near-miss, do NOT hand-copy two fields. The oracle computes observed / expected
          // / assertion — the structured cause the repair literature ranks above prose — and the old
          // `{ pass, evidence, failureReason }` construction DISCARDED them on every timed-out wait and
          // assert. So the highest-value localization signal was computed and then thrown away exactly
          // on the failure path where it matters, no matter what the schema declared.
          finish(
            annotateThrottledMiss(session, {
              ...r,
              pass: false,
              failureReason: r.failureReason ?? 'timed out waiting for predicate',
            }),
          );
        })
        .catch((error: unknown) => {
          finish(failed(error));
        });
    }, timeoutMs);
    check();
  });
}

/**
 * The ExpectedLinks a GREEN verdict actually PROVED — not merely the ones it declared. Identical to
 * predicateToExpectedLinks except for `anyOf`: an OR greens on a SINGLE branch, so only the branch that
 * held may contribute its link. Grading a green anyOf off the declared links would let the honesty grade
 * claim a signal/net consequence that was only one of the options and never fired — and a `minGrade:net`
 * gate would then trust a verdict that proved nothing but presence. That is the exact false green the
 * grade exists to prevent, sitting inside the grade itself.
 *
 * Call ONLY on a green verdict: a leaf and every `allOf` branch are returned unconditionally because a
 * green top verdict guarantees they held (allOf needs all; a bare leaf IS the verdict). Only anyOf, where
 * green ⇏ this-branch-held, re-checks each branch and keeps the winners.
 */
export async function provenExpectedLinks(
  session: PredicateSession,
  predicate: Predicate,
  since = 0,
): Promise<ExpectedLink[]> {
  if (PredicateKind.ALL_OF === predicate.kind) {
    const per = await Promise.all(
      predicate.predicates.map((p) => provenExpectedLinks(session, p, since)),
    );
    return per.flat();
  }
  if (PredicateKind.ANY_OF === predicate.kind) {
    const per = await Promise.all(
      predicate.predicates.map(async (p) =>
        (await evaluatePredicate(session, p, since)).pass
          ? provenExpectedLinks(session, p, since)
          : [],
      ),
    );
    return per.flat();
  }
  return predicateToExpectedLinks(predicate);
}
