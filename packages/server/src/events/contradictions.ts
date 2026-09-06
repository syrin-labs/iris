import {
  ContradictionKind,
  EventType,
  MUTATING_METHODS,
  isDevToolingUrl,
  isSameDocument,
  isThirdPartyUrl,
  isSameEditEpoch,
  urlForMatch,
  type ReticleEvent,
} from '@reticlehq/core';
import { describeSuperseded } from './observed-in-window.js';
import { findStaleResponses } from './stale-response.js';
import { findBodyFailures } from './body-failures.js';
import { findEchoMismatches } from './echo-mismatch.js';
import { findUnitMismatches } from './unit-mismatch.js';
import { asNumber, asString } from '../tools/tools-helpers.js';
import { matchesDeclaredFailure, type DeclaredNetFailure } from './declared.js';
import { runRegisteredFolds } from './contradiction-folds.js';

/**
 * The contradiction hunter.
 *
 * Every other check in Reticle reads ONE channel and asks "did something bad happen there?" — a
 * console error, a 500, a control that did nothing. A human can do that too, just slower.
 *
 * This asks a question a human structurally cannot: do the channels DISAGREE with each other? A
 * person watching an app has exactly one channel open — the screen. The agent holds the DOM, the
 * store, the app's own signals, the console and the network in one causally ordered window, so it
 * can catch the case where the screen says one thing and the network says the opposite.
 *
 * That gap is where false greens live. The archetype ships in both desktop demos: click Archive, the
 * row disappears, the status line reads "archived", and the IPC call rejected into a swallowed
 * `.catch()`. A screenshot agrees. A DOM assertion agrees. A human agrees. Only the disagreement
 * between channels reveals it.
 *
 * Pure: a window of events in, findings out. No session, no IO, no clock.
 */

export interface Contradiction {
  /**
   * Typed `string`, not `ContradictionKind`, because the vocabulary is open at the EDGE.
   *
   * `ContradictionKind` enumerates what THIS package's rules emit, and every one of them is still
   * checked against it — see `OwnContradiction`, which is what the folds below build. A rule
   * registered by a consumer emits kinds this package has never heard of and must not have to add
   * them here to be reportable: a shared enum is exactly how a consumer's private vocabulary ends up
   * shipped in the free product by accident.
   */
  kind: string;
  /** What one channel asserted — the optimistic half. */
  claim: string;
  /** What the other channel asserted — the half that contradicts it. */
  counter: string;
  /** Concrete evidence, so the agent can go straight to the call or the control. */
  detail: string;
}

/**
 * A contradiction emitted by one of THIS package's rules — the kind is closed.
 *
 * Widening `Contradiction.kind` to `string` for the consumer seam would otherwise have made every
 * emit site below accept a typo'd literal. This keeps them checked without closing the edge.
 */
export type OwnContradiction = Contradiction & { kind: ContradictionKind };

interface NetCall {
  method: string;
  url: string;
  /** Grader haystack — the raw request when redaction rewrote `url`. */
  matchUrl: string;
  status: number | undefined;
  /**
   * `undefined` means NO VERDICT — not failure.
   *
   * A one-way IPC `send` hands the message to the main process and returns; the renderer never learns
   * whether it was handled. The observer deliberately omits both `ok` and `status` rather than
   * manufacture a success nobody reported. Collapsing that to `false` here manufactured a FAILURE
   * nobody reported instead, which is the same sin pointing the other way: every fire-and-forget send
   * raised `ui-advanced-request-failed` against a UI that had done nothing wrong.
   */
  ok: boolean | undefined;
}

function netCall(e: ReticleEvent): NetCall {
  const status = asNumber(e.data['status']);
  return {
    method: (asString(e.data['method']) ?? '').toUpperCase(),
    url: asString(e.data['url']) ?? '',
    matchUrl: urlForMatch(e.data),
    status,
    // `ok` is authoritative when present (IPC sets it explicitly); status is the HTTP fallback.
    // Neither present = no verdict was ever reported, which stays undefined all the way through.
    ok:
      e.data['ok'] === undefined && status === undefined
        ? undefined
        : true === e.data['ok'] || (e.data['ok'] === undefined && (status ?? 0) < 400),
  };
}

/**
 * Did the user-visible application state move forward? DOM, store and route only — deliberately NOT
 * network, animation or signal. The question every rule below asks is "did the app act as if it
 * succeeded", and a request firing is not the app acting as if anything.
 */
function uiAdvanced(events: readonly ReticleEvent[]): boolean {
  return events.some(
    (e) =>
      e.type === EventType.DOM_ADDED ||
      e.type === EventType.DOM_REMOVED ||
      e.type === EventType.DOM_ATTR ||
      e.type === EventType.DOM_TEXT ||
      e.type === EventType.STATE_CHANGE ||
      e.type === EventType.ROUTE_CHANGE,
  );
}

function isMutating(call: NetCall): boolean {
  return MUTATING_METHODS.includes(call.method);
}

/**
 * State paths/values that read as the app recording a failure rather than hiding one.
 *
 * English-only, and knowingly so — this is the softest edge in the file. It is a fallback for when
 * the structural check below cannot decide, not the primary signal.
 */
const ACKNOWLEDGED = /error|fail|invalid|reject|denied|unable|could not|couldn't/i;

/**
 * Below this length an error string is too generic to be evidence — "no", "err", a bare code — and
 * could coincide with unrelated state text.
 */
const MIN_ECHOED_ERROR_LENGTH = 8;

/**
 * Wording that blames the USER — bad credentials, no permission, wrong input. Distinct from
 * ACKNOWLEDGED, which merely means "a failure was recorded": an app can honestly report a failure
 * ("server error, try again") without misattributing it.
 */
const BLAMES_USER = /denied|invalid|unauthor|forbidden|incorrect|wrong |not allowed|not permitted/i;

/** A server-fault status: the user cannot fix it and should never be asked to. */
const SERVER_FAULT_MIN = 500;

/**
 * Did the app record the failure in its OWN state — the layer the UI renders from?
 *
 * Without this, "the UI moved while a request failed" fires on correct code: a handler that catches
 * the rejection and renders "could not add" also moves the UI. Both look identical at the level of
 * "DOM changed + request failed"; what separates them is whether the app acknowledged the failure
 * anywhere, or silently proceeded as if it had succeeded.
 *
 * Deliberately NOT satisfied by a console error. `console.error` is invisible to the user, so an app
 * that logs and then shows success is still lying to whoever is looking at it — precisely the case
 * worth reporting.
 *
 * A heuristic, and the one soft edge in this file: an app that surfaces failure through a value this
 * pattern does not recognize will produce a finding a human must dismiss. That direction is the safe
 * one — a false alarm costs a glance, a missed false green ships.
 */
function failureAcknowledged(events: readonly ReticleEvent[]): boolean {
  // STRUCTURAL first, and language-independent: if the app put the failed call's OWN error text into
  // its state, it plainly knows the call failed — whatever language it says so in. The lexical
  // patterns below are English-only, so without this a German or Japanese app that surfaces its
  // failure perfectly well would be reported as hiding it.
  const errors = events
    .filter((e) => e.type === EventType.NET_REQUEST && e.data['ok'] !== true)
    .map((e) => asString(e.data['error']))
    .filter((text): text is string => text !== undefined && text.length >= MIN_ECHOED_ERROR_LENGTH);
  const echoesAnError = events.some((e) => {
    if (e.type !== EventType.STATE_CHANGE) return false;
    const value = asString(e.data['value']);
    return value !== undefined && errors.some((text) => value.includes(text));
  });
  if (echoesAnError) return true;

  return events.some((e) => {
    // A failure-shaped SIGNAL is an acknowledgement too. An app that fires `auth:denied` has plainly
    // not proceeded as if it succeeded, whatever its state paths happen to be named.
    if (e.type === EventType.SIGNAL) return ACKNOWLEDGED.test(asString(e.data['name']) ?? '');
    if (e.type !== EventType.STATE_CHANGE) return false;
    const path = asString(e.data['path']) ?? '';
    const value = e.data['value'];
    return ACKNOWLEDGED.test(path) || ('string' === typeof value && ACKNOWLEDGED.test(value));
  });
}

function describe(call: NetCall): string {
  return `${call.method} ${call.url}${call.status === undefined ? '' : ` → ${String(call.status)}`}`;
}

/**
 * Actions that are SUPPOSED to make something happen, so producing nothing is a finding.
 *
 * Deliberately narrow. `hover`, `focus` and `scrollIntoView` can legitimately move nothing, and
 * `fill`/`type` change an input's value without necessarily mutating the DOM tree — flagging those
 * would manufacture noise, which is the failure mode opposite to a false green and just as bad.
 */
const MUST_DO_SOMETHING = new Set(['click', 'dblclick', 'submit']);

/**
 * Whether NOTHING in this window is attributable to the action.
 *
 * Ambient churn is deliberately not counted as evidence the action worked — a background event
 * stream, a polling store, a perf sample and a scroll position all move on their own. What counts:
 *
 *  - a mutation inside the target's own subtree (what the target itself did),
 *  - a request (the action asked the server for something),
 *  - a navigation, or a dialog/live region appearing — the two ways a real reaction legitimately
 *    lands OUTSIDE the target, e.g. a modal portalled to the body.
 *
 * The last clause is what keeps this from manufacturing noise: a button that opens a modal mutates
 * nothing within itself, and must not be called dead.
 */
function didNothing(
  events: readonly ReticleEvent[],
  requests: readonly NetCall[],
  mutatedWithin: number | undefined,
): boolean {
  if (mutatedWithin === undefined) return 0 === events.length;
  if (mutatedWithin > 0 || requests.length > 0) return false;
  return !events.some(
    (e) => e.type === EventType.ROUTE_CHANGE || e.type === EventType.VISIBLE_SHOWN,
  );
}

export interface ContradictionOptions {
  /** The action that opened this window, when one did. Enables the no-effect check. */
  action?: string | undefined;
  /**
   * Events from BEFORE the window, used only to LEARN — never reported on. Some disagreements are
   * with something the API stated earlier in the session, which an action-scoped window cannot
   * contain. See `findUnitMismatches` for the measured case this exists for.
   */
  prior?: readonly ReticleEvent[] | undefined;
  /**
   * Event time at which the action that opened this window was dispatched — the attribution floor.
   *
   * `duplicate-request` claims "one user action was performed", and that claim is only sound over ONE
   * action's window. `reticle_observe` takes a caller-supplied window that can be arbitrarily wide, so
   * two legitimate separate saves to the same endpoint read as a double submit — and the finding then
   * sat on every verdict for that tab. Undefined means nothing attributed the window to an action, and
   * the rule stays silent rather than accusing an app of something nobody can show it did.
   *
   * ponytail: a NET_REQUEST is stamped when it COMPLETED, so a write dispatched before the action and
   * landing after it counts as inside. Keying on the matching NET_PENDING would fix that; it has not
   * been worth the second index.
   */
  actionSince?: number | undefined;
  /**
   * DOM mutations observed INSIDE the target's own subtree, as the act tool measured them.
   *
   * The no-effect check used to require a completely empty window, which is a statement about the
   * PAGE rather than about the action — and no real app has a quiet page. Measured on a shipments
   * console with a background event stream: clicking an inert heading produced `domMutatedWithin: 0`
   * and four ambient events (a scroll position, an unrelated store update, a perf sample), so the
   * window was not empty and the dead control went unreported. The user's framing of this is exact:
   * the DOM moving after an action is not evidence that the action moved it.
   *
   * Undefined means the caller did not measure it — the check then falls back to the empty-window
   * test, which is weaker but never wrong in the direction of a false accusation.
   */
  mutatedWithin?: number | undefined;
  /**
   * Requests the CALLER declared would fail, read off the oracle it wrote before acting.
   *
   * `ui-advanced-request-failed` cannot tell "the app swallowed the error and carried on" from "the
   * app rendered the error, which is the behaviour under test" — both are a moved DOM beside a
   * failed request. `failureAcknowledged` recovers the first from the app's own state, and an app
   * that renders its error straight into the DOM without touching a store defeats it.
   *
   * The declaration is the missing evidence, and it costs no new API: an agent verifying an error
   * path already writes `{ net, POST, /api/login, status: 500 }` into the predicate. Measured in the
   * field: every branch of a login error path (500, 401, 503) passed every declared clause and every
   * run still returned `verified: "no" / contradicted`, so error handling — empty states, offline
   * banners, 4xx/5xx messaging, lockouts — was the code least able to reach a green verdict and the
   * most worth verifying.
   *
   * Scoped as narrowly as it can be: it suppresses ONLY the heuristic rule that cannot see the
   * difference. A success signal fired over the declared failure still contradicts, and a server
   * fault blamed on the user is still misattributed — see the negative controls in
   * `contradictions.declared.test.ts`.
   */
  expectedFailures?: readonly DeclaredNetFailure[] | undefined;
  /**
   * The caller declared an on-screen consequence and it HELD in this window.
   *
   * `route-rendered-nothing` infers a blank destination from the absence of DOM events, and a
   * verdict that names it beside an element match — heading found, with its source file and line —
   * is a clause its own evidence disproves. Positive evidence outranks the absence it is inferred
   * from. Undefined/false leaves the rule exactly as it was, which is the case that catches a route
   * with no view.
   */
  renderProved?: boolean | undefined;
  /**
   * The document currently under observation, as the session derived it from its own event stream.
   *
   * Every rule below reasons about "the same window", and a window is scoped by time and by
   * ring-buffer capacity and by nothing else — so it can still hold the traffic of a page a full
   * navigation or a reload has already thrown away. Naming that traffic as the cause of an action
   * taken now is true about the bytes and false about the world.
   *
   * Undefined means nobody could say which document is current (an SDK too old to stamp one, a caller
   * with no session in hand), and the scoping then does nothing at all — `isSameDocument` treats
   * absence as current on both sides, so the engine behaves exactly as it did before this existed.
   */
  currentDocumentId?: string | undefined;
  /**
   * The edit epoch currently in force, as the session derived it from its own event stream.
   *
   * The edit-shaped half of `currentDocumentId`. A hot update replaces modules and re-renders inside
   * the SAME document, so the document id cannot see it and observations of code the agent has
   * already rewritten go on answering for it in silence.
   *
   * Undefined means nobody could say (an SDK too old to stamp one, a page with no hot-update channel,
   * a caller with no session in hand) and the scoping then does nothing at all — `isSameEditEpoch`
   * treats absence as current on both sides.
   */
  currentEditEpoch?: number | undefined;
  /**
   * The page under test, as the session last recorded it — the app's own origin, in URL form.
   *
   * The first-party/third-party axis. Every rule below asks "did the app disagree with itself", and
   * a failed analytics beacon is not the app: reported independently from several apps, any
   * analytics package installed was enough to grade a correct drive `contradicted`, and on one app
   * EVERY assertion came back that way forever, because it fires a branding call on page load. A
   * verdict field that answers "no" to everything has stopped being a verdict field.
   *
   * Third-party traffic is dropped here rather than reported at a lower severity, for the reason the
   * dev-tooling split is: the rules below would each have to learn to say it. The exclusion is never
   * silent — the URLs ride out in the same disclosure line the toolchain's do — and the calls
   * themselves are untouched in `reticle_network` and the event timeline.
   *
   * Undefined disables the axis, exactly as an undefined `currentDocumentId` disables the document
   * one: a caller that cannot say which page is under test gets the behaviour it had before this.
   */
  appOrigin?: string | undefined;
}

/** Net-shaped events — the only ones that carry a URL a dev-tooling channel could occupy. */
const NET_TYPES: ReadonlySet<EventType> = new Set([
  EventType.NET_PENDING,
  EventType.NET_REQUEST,
  EventType.NET_STREAM,
]);

/**
 * Hash-router paths put the route in the fragment (`#/settings`, `#!/home`). An in-page skip link
 * does not (`#main-content`, `#`, empty). The blank-destination rule must still see the former.
 */
function isInPageFragment(hash: string): boolean {
  if ('' === hash || '#' === hash) return true;
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  return !body.startsWith('/') && !body.startsWith('!');
}

function hrefAsUrl(value: string | undefined): URL | undefined {
  if (value === undefined || '' === value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Same origin + pathname + search, different in-page fragment — a skip link, not a new view.
 *
 * Returns false when `from`/`to` are missing, so older events without hrefs keep the existing rule.
 */
function isSameDocumentHashAnchor(event: ReticleEvent): boolean {
  if (event.type !== EventType.ROUTE_CHANGE) return false;
  const from = hrefAsUrl(asString(event.data['from']));
  const to = hrefAsUrl(asString(event.data['to']));
  if (from === undefined || to === undefined) return false;
  if (from.origin !== to.origin || from.pathname !== to.pathname || from.search !== to.search) {
    return false;
  }
  if (from.hash === to.hash) return false;
  return isInPageFragment(to.hash);
}

/**
 * Split the window into the app's traffic and the dev toolchain's own (see `DevToolingChannel`).
 *
 * NOTHING below may judge the toolchain. Reported from a real drive: a correct Next.js navigation
 * graded `verified: "no"` because the dev overlay was resolving a source map for an unrelated React
 * key warning, and that in-flight `POST /__nextjs_original-stack-frames` read as "the UI advanced
 * over a request that never settled". Every app that logs one dev warning got a false negative on
 * every action. The overlay's own 404s and duplicate fetches are the same story on other checks,
 * which is why the split happens ONCE here rather than in the one check that reported it.
 */
function splitForeignTraffic(
  events: readonly ReticleEvent[],
  appOrigin: string | undefined,
): {
  app: readonly ReticleEvent[];
  ignored: string[];
} {
  const ignored: string[] = [];
  const app = events.filter((e) => {
    if (!NET_TYPES.has(e.type)) return true;
    const url = asString(e.data['url']);
    // Somebody else's code, twice over: the toolchain's own channel, and any site that is not the
    // app under test. Neither can answer the question every rule below asks.
    if (!isDevToolingUrl(url) && !isThirdPartyUrl(url, appOrigin)) return true;
    if (url !== undefined && !ignored.includes(url)) ignored.push(url);
    return false;
  });
  return { app, ignored };
}

/**
 * Cross-channel contradictions in this window, with the edit-epoch caveat attached when it applies.
 *
 * Cross-epoch evidence is LABELLED rather than excluded, which is the opposite of what the document
 * scoping does, and the difference is the point. A navigation is total — it throws away the page,
 * the refs, the in-flight requests and the state — so nothing recorded before it is still about the
 * world, and dropping it is the only honest option. A hot update is not: most modules, most of the
 * DOM, the whole network log and every console line survive one, so most of what was observed a
 * second before an edit is still true a second after. Excluding it would empty windows that hold
 * real findings, and an emptied window reads as "nothing happened" — which is the more expensive of
 * the two wrong answers and the one this whole family of checks exists to prevent.
 *
 * So the findings stand and the caveat is said out loud, and only when it is unambiguous: EVERY
 * observation in the window predates the edit. One post-edit observation and the agent is already
 * looking at the code it wrote, so the label would be noise.
 */
/**
 * Below this, repeated writes are a BURST, whatever their spacing.
 *
 * A double submit is two clicks, or one click and a re-render: milliseconds apart. Nothing a human
 * or a StrictMode remount does lands on a quarter-second grid, so this is the floor under which
 * regularity means nothing.
 */
const POLL_MIN_INTERVAL_MS = 250;

/**
 * How far a gap may sit from the median and still count as the same cadence.
 *
 * Loose on purpose: a real poll drifts under load, and a `setInterval` competing with a busy main
 * thread is not metronomic. Tight enough that a burst followed by a late retry — the shape a double
 * submit plus a user's second attempt makes — is not read as a rhythm.
 */
const POLL_JITTER_RATIO = 0.4;

/**
 * Is this the same write on a steady interval, rather than the same write twice?
 *
 * THREE samples minimum, and that is the load-bearing part: two writes give one gap, and a single
 * gap cannot distinguish a cadence from a coincidence. Two writes stay a duplicate however far
 * apart they are, which is the classic double submit and every case this rule was written for.
 */
function isSteadyCadence(times: readonly number[]): boolean {
  if (times.length < 3) return false;
  const ordered = [...times].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < ordered.length; i += 1) gaps.push((ordered[i] ?? 0) - (ordered[i - 1] ?? 0));
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  if (median < POLL_MIN_INTERVAL_MS) return false;
  return gaps.every((gap) => Math.abs(gap - median) <= median * POLL_JITTER_RATIO);
}

export function findContradictions(
  allEvents: readonly ReticleEvent[],
  options: ContradictionOptions = {},
): Contradiction[] {
  const found = findWindowContradictions(allEvents, options);
  const predates =
    allEvents.length > 0 &&
    allEvents.every((e) => !isSameEditEpoch(e.editEpoch, options.currentEditEpoch));
  if (!predates) return found;
  // Prepended, not appended: the caveat governs how everything under it should be read, and it has
  // to survive the rules that return early with a single finding of their own.
  return [
    {
      kind: ContradictionKind.EVIDENCE_PREDATES_EDIT,
      claim: 'these observations describe the code as it is now',
      counter: 'every one of them was recorded before the last hot update landed in the page',
      detail:
        'the source changed and the page re-rendered after this evidence was captured, so it describes code that has since been replaced — nothing here is necessarily wrong, but nothing here has seen the edit either. Drive the app again to verify the current code',
    },
    ...found,
  ];
}

function findWindowContradictions(
  allEvents: readonly ReticleEvent[],
  options: ContradictionOptions,
): Contradiction[] {
  const found: OwnContradiction[] = [];
  const { app: allApp, ignored: ignoredForeign } = splitForeignTraffic(
    allEvents,
    options.appOrigin,
  );

  // ── Evidence belonging to a document that has since been replaced ───────────────────────────
  // Scoped ONCE, here, for the same reason the dev-tooling split is: every rule below asks "what
  // else was in this window", and answering that with a dead page's traffic is a defect in all of
  // them rather than in whichever one reported it. Applied after the dev-tooling split so the count
  // reported below is the app's own evidence and not the toolchain's noise.
  const scoped = allApp.filter((e) => isSameDocument(e.documentId, options.currentDocumentId));
  const superseded = allApp.length - scoped.length;
  // An empty window was always allowed to mean "nothing happened"; that reading is only unsafe once
  // supersession is what emptied it. Reported ALONE and before every rule below, because a window
  // with nothing left in it is exactly the shape `action-had-no-effect` fires on — so without this
  // the fix would have swapped a wrong citation for a wrong accusation.
  if (superseded > 0 && 0 === scoped.length) {
    return [
      {
        kind: ContradictionKind.EVIDENCE_SUPERSEDED,
        claim: 'this window holds observations that could answer for the action',
        counter: describeSuperseded('observations', superseded),
        detail:
          'a full navigation or a reload built a new document, and everything recorded here belongs to the old one — citing it would name requests, errors and state that no longer describe anything on screen',
      },
    ];
  }

  // ── Evidence that predates the action ───────────────────────────────────────────────────────
  // The attribution floor, and it is scoped ONCE here for the same reason the two filters above are:
  // a rule that reads "what else was in this window" and gets handed traffic from before the caller
  // acted is not refining its answer, it is answering about somebody else's action. Three rules
  // (`duplicate-request`, `signal-without-consequence`, `consequence-elsewhere`) each checked this
  // for themselves and the other six swept the whole window — which is how an assert with no `since`
  // came to be judged against everything that had ever happened in the tab.
  //
  // Undefined means nothing attributed the window to an action at all; the floor then does nothing,
  // and the consequence rules below decline to speak instead. See `advanced`.
  const floor = options.actionSince;
  const events = floor === undefined ? scoped : scoped.filter((e) => e.t >= floor);

  const settled = events.filter((e) => e.type === EventType.NET_REQUEST).map(netCall);

  // ── Overlapping reads that settled out of order ─────────────────────────────────────────────
  // Independent of any action, so it runs on every window: the race is a property of the timeline.
  found.push(...findStaleResponses(events));

  // ── A 2xx whose BODY says it failed ─────────────────────────────────────────────────────────
  // Needs body capture; silent without it, which is why the assert path also declares when bodies
  // were never recorded rather than letting an unread payload read as an empty one.
  found.push(...findBodyFailures(events));
  found.push(...findEchoMismatches(events, options.actionSince));

  // ── A money value written back at the wrong SCALE ───────────────────────────────────────────
  found.push(...findUnitMismatches(events, options.prior ?? []));

  // ── The action landed on something that does not react ──────────────────────────────────────
  // Checked first and returned alone: nothing is attributable to the action, so every rule below is
  // reasoning about someone else's events.
  const action = (options.action ?? '').toLowerCase();
  if (MUST_DO_SOMETHING.has(action) && didNothing(events, settled, options.mutatedWithin)) {
    const measured = options.mutatedWithin !== undefined;
    return [
      {
        kind: ContradictionKind.ACTION_HAD_NO_EFFECT,
        claim: `the ${action} was dispatched and the page settled`,
        counter: measured
          ? 'nothing changed inside the target, and no request, navigation or dialog followed — whatever else moved on the page was not this'
          : 'no channel observed anything at all — DOM, store, route, network, signal, console',
        detail:
          'the target does not react to this action (a non-interactive wrapper resolved instead of the control, a disabled handler, or a no-op) — settling proves only that the page was quiet, which a page that did nothing always is',
      },
    ];
  }
  const failed = settled.filter((c) => false === c.ok);
  // The failures NOBODY declared — see ContradictionOptions.expectedFailures. Only the heuristic
  // "the UI moved while a request failed" rule reads this; the sharp rules still read `failed`.
  const unexpected = failed.filter(
    (c) => !matchesDeclaredFailure(c, options.expectedFailures ?? []),
  );
  /**
   * Did the UI move — and is anybody entitled to say so?
   *
   * `undefined` is the third answer and the point of the tri-state: "the UI moved forward while a
   * request failed" is a claim about CAUSATION, and over a window nothing attributed to an action
   * the two halves merely co-occurred. A passive `reticle_assert` performs nothing, so ambient
   * traffic — a poll, a page-load bootstrap, a branding call — is not its consequence and must not
   * decide its verdict.
   *
   * Typed rather than gated with a boolean so it cannot be skipped: every rule that reasons from UI
   * movement has to answer `undefined` explicitly, including one added later. The rules that read
   * the app's OWN claims (a success signal over a failed call) or its payloads (a 2xx whose body
   * says it failed, a field echoed back wrong) are untouched — those are things the app said, not
   * consequences anybody inferred, and they are true whoever caused them.
   */
  const advanced: boolean | undefined = floor === undefined ? undefined : uiAdvanced(events);
  const signals = events
    .filter((e) => e.type === EventType.SIGNAL)
    .map((e) => asString(e.data['name']) ?? 'signal');

  // ── The route moved and nothing was rendered for it ─────────────────────────────────────────
  // A navigation that neither fetches nor renders arrived nowhere. Distinct from a dead control:
  // the control worked, the DESTINATION is empty — which is why every "did the click do something"
  // heuristic passes it, a route change being unambiguously something.
  const routeEvents = events.filter((e) => e.type === EventType.ROUTE_CHANGE);
  const routed = routeEvents.length > 0;
  // A skip link (`href="#main-content"`) is a same-document hash change. The observable
  // consequences are location.hash, focus, and scroll — not a DOM mutation. Treating it as a
  // blank destination made "did my skip link work" unanswerable. Hash-router paths (`#/invoices`)
  // still go through the rule: those ARE a new view.
  const hashAnchorOnly = routed && routeEvents.every(isSameDocumentHashAnchor);
  // `dom.text` counts as rendered, and it has to: React reconciles a destination IN PLACE far more
  // often than it adds nodes. Measured on three ordinary sidebar navigations of the bench app — every
  // one emitted { dom.attr:2, dom.text:2, render.commit, state.change } and ZERO dom.added/removed,
  // so all three were flagged as blank destinations, `verified` came back "no" on a correct green,
  // and a bug_found was emitted for a navigation that worked.
  //
  // Deliberately NOT `dom.attr`: the nav link marks itself active whether or not the destination
  // rendered, which is the true positive this rule exists for. Deliberately NOT `render.commit`
  // either: React commits a render for a component that returns null, which is one of the very bugs
  // named in `detail` below.
  const rendered = events.some(
    (e) =>
      e.type === EventType.DOM_ADDED ||
      e.type === EventType.DOM_REMOVED ||
      e.type === EventType.DOM_TEXT,
  );
  const fetched = events.some(
    (e) => e.type === EventType.NET_REQUEST || e.type === EventType.NET_PENDING,
  );
  if (routed && !hashAnchorOnly && !rendered && !fetched && true !== options.renderProved) {
    found.push({
      kind: ContradictionKind.ROUTE_RENDERED_NOTHING,
      claim: 'the app navigated to a new route',
      counter: 'nothing was rendered for it — no content added or removed, and no request made',
      detail:
        'the URL moved but the destination produced no content: a route with no view, a view that returned null, or data the page never asked for. A control that navigates always looks alive, so this is invisible to a dead-control check. Confirm by reading the page — a view revealed from DOM that already existed emits this same window',
    });
  }

  // ── The app claimed success while its own request failed ────────────────────────────────────
  // A signal is the sharper claim: the app did not merely LOOK right, it explicitly asserted
  // success. When both hold it is one fact, so only the sharper one is reported.
  // ── The server faulted and the app blamed the user ──────────────────────────────────────────
  // Checked BEFORE the success-claim rules, because it is the sharper reading of the same events:
  // the app did not claim success, it claimed the wrong failure. Telling someone their password is
  // wrong while the backend is down sends them to fix something they cannot fix.
  const serverFaults = settled.filter(
    (c) => false === c.ok && c.status !== undefined && c.status >= SERVER_FAULT_MIN,
  );
  const userBlame = [
    ...signals.filter((name) => BLAMES_USER.test(name)),
    ...events
      .filter((e) => e.type === EventType.STATE_CHANGE)
      .map((e) => asString(e.data['value']) ?? '')
      .filter((value) => BLAMES_USER.test(value)),
  ];
  const misattributed = serverFaults.length > 0 && userBlame.length > 0;
  if (misattributed) {
    found.push({
      kind: ContradictionKind.FAILURE_MISATTRIBUTED,
      claim: `the app told the user they were at fault (${userBlame.map((b) => `"${b}"`).join(', ')})`,
      counter:
        'the server returned a 5xx — the user cannot fix this and the real fault is unreported',
      detail: serverFaults.map(describe).join('; '),
    });
  }

  // A failure-shaped signal is not a success claim, so it must not be read as one: saying "the app
  // claimed success" about an app that plainly reported a failure is true in outline and wrong in
  // its reasoning, which is how a checker stops being believed.
  const successSignals = signals.filter((name) => !ACKNOWLEDGED.test(name));
  // An app that RETRACTED has not claimed success, whenever it fired the optimistic signal.
  //
  // The weaker UI rule below already consulted this and the sharper signal rule did not, so an app
  // that announced "ack:requested", met a 500, and then correctly emitted "ack:failed" and rolled the
  // row back was reported as explicitly asserting success — the strongest accusation this file makes,
  // against code doing exactly the right thing. On a fixture suite the scenario's FIXED twin produced
  // the same finding as the build that swallowed the failure, which makes the finding worthless on
  // the one measurement that scores precision.
  //
  // Ordering cannot decide this: an optimistic UI legitimately fires its success signal BEFORE the
  // response, so "the claim must follow the failure" would miss the real defect. What separates them
  // is not when the app spoke, it is whether it took it back.
  // WHAT failed decides this, not whether an action was attributed.
  //
  // The claim is a thing the app said, so the attribution floor does not apply to it — the flagship
  // false green is an app asserting success on a PASSIVE assert while its own write failed, and
  // requiring an action would lose exactly that. But the COUNTER was any failure in the window, and
  // that is the same window statement scoped out of every other rule here. Measured: two of the
  // three false positives surviving the first scoping pass were this rule.
  //
  // A success signal claims a CHANGE was made. A failed mutation is evidence against that claim; a
  // failed read is not. Background polls, prefetches and telemetry GETs fail constantly in healthy
  // apps and say nothing about whether a write landed. Structural, not a timing heuristic, and the
  // distinction was already encoded next door in `isMutating`.
  const failedWrites = failed.filter(isMutating);
  // The same scoping, for the same reason, one branch down. "The UI moved forward" is also a claim
  // that something CHANGED, and it was still reading ANY failure — so a first-party poll failing
  // during an action contradicted a verdict the action had genuinely earned. Measured on the
  // observation benchmark: one of two false positives across 47 cells, and the argument for it is
  // the paragraph above, which had simply not been carried down here.
  const unexpectedWrites = unexpected.filter(isMutating);
  if (failedWrites.length > 0 && successSignals.length > 0 && !failureAcknowledged(events)) {
    found.push({
      kind: ContradictionKind.SIGNAL_CONTRADICTED,
      claim: `the app fired ${successSignals.map((s) => `"${s}"`).join(', ')}`,
      counter: `${String(failedWrites.length)} write(s) in the same window failed`,
      detail: failedWrites.map(describe).join('; '),
    });
  } else if (
    unexpectedWrites.length > 0 &&
    true === advanced &&
    !misattributed &&
    !failureAcknowledged(events)
  ) {
    found.push({
      kind: ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
      claim: 'the UI moved forward (DOM/store/route changed)',
      counter: `${String(unexpectedWrites.length)} request(s) in the same window failed`,
      detail: unexpectedWrites.map(describe).join('; '),
    });
  }

  // ── A write succeeded and nothing on the client moved ───────────────────────────────────────
  // Writes only: a GET that changes nothing is a prefetch; a POST that changes nothing is a lost
  // write, a response parsed into the void, or a render that never happened.
  if (false === advanced) {
    const ignoredWrites = settled.filter((c) => true === c.ok && isMutating(c));
    if (ignoredWrites.length > 0) {
      // ...unless THIS document handed the consequence to another browsing context. An OAuth sign-in
      // posts, succeeds, and continues in a popup the in-page SDK cannot follow (#508): the original
      // tab legitimately never changes, and response-ignored would accuse it of ignoring a response
      // it handed off. The opened-context event flips the reading from "the client did nothing" to
      // "the client went where we cannot look". Scoped like every rule here to the attribution floor
      // (`options.actionSince`; the local below is declared later, for the window rules).
      const contextFloor = options.actionSince;
      const openedContext = events.some(
        (e) =>
          e.type === EventType.CONTEXT_OPENED && contextFloor !== undefined && e.t >= contextFloor,
      );
      found.push(
        openedContext
          ? {
              kind: ContradictionKind.CONSEQUENCE_ELSEWHERE,
              claim: `${String(ignoredWrites.length)} write(s) succeeded on the server`,
              counter:
                'this document never changed because the page opened another browsing context during this window (e.g. an OAuth popup), where the in-page SDK cannot observe the result',
              detail: ignoredWrites.map(describe).join('; '),
            }
          : {
              kind: ContradictionKind.RESPONSE_IGNORED,
              claim: `${String(ignoredWrites.length)} write(s) succeeded on the server`,
              counter: 'nothing on the client changed — no DOM, store or route movement',
              detail: ignoredWrites.map(describe).join('; '),
            },
      );
    }
  }

  // ── The app announced a consequence and nothing else moved ─────────────────────────────────
  // Scoped as tightly as the evidence allows, because this rule fires on the ABSENCE of everything
  // else and that is the easiest way to build a false positive.
  //
  // Only when the window is otherwise EMPTY: no DOM, no store, no route (`!advanced`) and no request
  // at all. A request means the app reached for something, and whether it settled, failed or was
  // ignored belongs to three other rules — firing here too would report one fact twice.
  //
  // `successSignals` reuses the failure-shaped filter above: an app that announced `deploy:failed`
  // is correctly reporting that nothing happened, and accusing it inverts the meaning of the one app
  // doing this right.
  //
  // And only for a window attributed to an ACTION. `reticle_assert` OBSERVES — there is no click
  // whose consequence should have corroborated anything, so an assert over a quiet window carrying
  // one signal is an ordinary read, not a claim nothing backs. Without this the rule reddened eight
  // existing tests that assert exactly that, which is the false-positive class this scoping exists
  // to prevent.
  if (
    options.actionSince !== undefined &&
    false === advanced &&
    0 === settled.length &&
    successSignals.length > 0
  ) {
    found.push({
      kind: ContradictionKind.SIGNAL_WITHOUT_CONSEQUENCE,
      claim: `the app fired ${successSignals.map((s) => `"${s}"`).join(', ')}`,
      counter:
        'nothing else in the window moved — no DOM, no store, no route, no request — so the only ' +
        'evidence that anything happened is the app saying so',
      detail:
        'a signal emitted from the value the app was ASKED for, rather than the one it committed, ' +
        'reads identically to one that worked',
    });
  }

  // ── The same write fired more than once, inside ONE action's window ─────────────────────────
  // Attribution is the whole rule here, not a refinement of it: counting `method + url` over whatever
  // window the caller handed in turns two legitimate separate saves into a double submit. See
  // ContradictionOptions.actionSince.
  //
  // A captured request body joins the identity. A command-bus API posts every mutation to one URL
  // and discriminates on a body field (`{"command":"study.stage.set"}` vs `{"command":"mesh.plan"}`),
  // so under URL alone each of those distinct writes read as a repeat of the first, and clean
  // verdicts degraded to unknown behind doubles that were never doubles. When no body was captured
  // (capture off, or a non-text body, which reports a type marker instead) there is nothing to
  // compare and the URL alone stands, as before; a window where only some calls carried bodies
  // compares nothing rather than guess.
  const actionSince = options.actionSince;
  if (actionSince !== undefined) {
    /**
     * When the window navigated, and therefore when a write stops belonging to the user's action.
     *
     * React StrictMode double-invokes a mount effect in development, so clicking a nav link lands
     * two identical writes inside the action's own window. Nothing scoped them out and they read as
     * a double submit — measured on the observation benchmark as one of two false positives.
     *
     * The route change is the structural tell, not a heuristic: the claim this rule makes is "one
     * user action was performed", and writes that follow a navigation belong to the mount of the
     * view navigated TO. A real double submit fires from the view it is already on, with nothing in
     * between — and one that navigates AFTER submitting is still counted, because the order is what
     * distinguishes them.
     */
    const navigatedAt = events.find(
      (e) => EventType.ROUTE_CHANGE === e.type && e.t >= actionSince,
    )?.t;
    const writeTimes = new Map<string, { label: string; times: number[] }>();
    for (const event of events) {
      if (event.type !== EventType.NET_REQUEST || event.t < actionSince) continue;
      if (navigatedAt !== undefined && event.t >= navigatedAt) continue;
      const call = netCall(event);
      if (!isMutating(call)) continue;
      const label = `${call.method} ${call.url}`;
      const body = asString(event.data['requestBody']);
      const key = body === undefined || 0 === body.length ? label : `${label} ${body}`;
      const entry = writeTimes.get(key) ?? { label, times: [] };
      entry.times.push(event.t);
      writeTimes.set(key, entry);
    }
    for (const [, { label, times }] of writeTimes) {
      if (times.length < 2) continue;
      // A steady cadence is a POLL, and a poll is not a double submit. An app that polls could not
      // produce a verdict at all: a camera scan loop POSTing until it acquires a lock had every
      // assertion that had already seen its consequence come back `unknown` behind writes that
      // were the app working correctly (#673).
      if (isSteadyCadence(times)) continue;
      found.push({
        kind: ContradictionKind.DUPLICATE_REQUEST,
        claim: 'one user action was performed',
        counter: `the same write fired ${String(times.length)} times`,
        detail: `${label} ×${String(times.length)}`,
      });
    }
  }

  // ── The UI advanced over a request that never came back ─────────────────────────────────────
  // Gated on the UI having moved: an in-flight request while the app is still visibly waiting is
  // just a slow request, not a contradiction. It becomes one when the app proceeded regardless —
  // which is also what makes a later `{ kind: "settled" }` assertion a false green.
  if (true === advanced) {
    const settledIds = new Set(
      events
        .filter((e) => e.type === EventType.NET_REQUEST)
        .map((e) => asString(e.data['id']))
        .filter((id): id is string => id !== undefined),
    );
    const inFlight = events
      .filter((e) => e.type === EventType.NET_PENDING)
      .map((e) => ({ id: asString(e.data['id']), call: netCall(e) }))
      .filter((p) => p.id === undefined || !settledIds.has(p.id));
    if (inFlight.length > 0) {
      found.push({
        kind: ContradictionKind.REQUEST_NEVER_SETTLED,
        claim: 'the UI moved forward and the action reported done',
        counter: `${String(inFlight.length)} request(s) were still in flight`,
        // The exclusion is never silent: if the toolchain's own traffic was dropped from this count,
        // the finding says which URLs, so an agent reading it can see what Reticle chose to ignore.
        detail: [
          inFlight.map((p) => describe(p.call)).join('; '),
          ...(0 === ignoredForeign.length
            ? []
            : [`ignored as dev tooling or third-party: ${ignoredForeign.join(', ')}`]),
        ].join(' — '),
      });
    }
  }

  // Consumer rules run LAST and over the same app-only window, so a service embedding this engine
  // adds to the verdict rather than forking the file that produces it.
  return [...found, ...runRegisteredFolds(events, options)];
}
