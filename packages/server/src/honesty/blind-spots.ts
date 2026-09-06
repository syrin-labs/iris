/**
 * Blind-spot register — the never-silent statement of what the layer CANNOT see. Closed shadow roots,
 * cross-origin iframes, and virtualized-unmounted rows are documented limits; a result that touched one
 * says so (`coverage: partial — 2 cross-origin frames unobserved`) instead of implying it saw everything.
 * Pure formatting over the counted blind spots the observers report.
 */

// The kind enum lives in core (it crosses the wire in a BLIND_SPOT event); re-exported here so existing
// honesty-side imports keep working.
export { BlindSpotKind } from '@reticlehq/core';
import {
  AppRuntime,
  BlindSpotKind,
  EventType,
  PredicateKind,
  ReticleEnv,
  TRANSPORT_LIMITS,
  isDesktopBlindSpot,
  type ReticleEvent,
} from '@reticlehq/core';

interface BlindSpot {
  kind: BlindSpotKind;
  count: number;
}

/**
 * Whether the observation window saw everything it was asked about.
 *
 * NOT core's VerdictStatus, which happens to spell one of its values 'partial' too: that one grades
 * a verification RUN (some flows passed, some failed), this one grades what could be OBSERVED. Two
 * meanings behind one string is exactly how a comparison ends up reading the wrong field, so they
 * stay separate vocabularies.
 */
export const Coverage = {
  FULL: 'full',
  PARTIAL: 'partial',
} as const;
export type Coverage = (typeof Coverage)[keyof typeof Coverage];

interface CoverageStatement {
  coverage: Coverage;
  /** Present only when partial — the human/agent-legible list of what went unobserved. */
  note?: string;
  spots: BlindSpot[];
}

const LABEL: Record<BlindSpotKind, (n: number) => string> = {
  [BlindSpotKind.CLOSED_SHADOW_ROOT]: (n) =>
    `${String(n)} closed shadow root${1 === n ? '' : 's'} unobserved`,
  [BlindSpotKind.CROSS_ORIGIN_IFRAME]: (n) =>
    `${String(n)} cross-origin frame${1 === n ? '' : 's'} unobserved`,
  // The DOM of these frames IS observed; only their network is not. Saying so precisely matters — a
  // flat "unobserved" would discard a real capability and push agents back to guessing.
  [BlindSpotKind.UNINSTRUMENTED_FRAME]: (n) =>
    `${String(n)} same-origin frame${1 === n ? '' : 's'} observed for DOM but not network — requests they make are invisible`,
  [BlindSpotKind.VIRTUALIZED_UNMOUNTED]: (n) =>
    `${String(n)} virtualized unmounted row${1 === n ? '' : 's'} unobserved`,
  // Not "some rows we could not see" — the events never reached the observer, so this window is a
  // SAMPLE of what the app did. Phrased as a caveat on what the whole result MEANS.
  // Names a NUMBER, not a variable. "Raise it for a busy app" leaves the reader to invent a value,
  // and the one who reported this had to guess before finding one that worked. The default was
  // raised in the same change, so a page still hitting the cap after that is genuinely unusual and
  // deserves a concrete next value rather than an adjective.
  [BlindSpotKind.RATE_LIMITED]: (n) =>
    `${String(n)} event${1 === n ? '' : 's'} dropped by the bridge rate cap, so this window is SAMPLED. Set ${ReticleEnv.MAX_MESSAGES_PER_SECOND}=${String(TRANSPORT_LIMITS.MAX_MESSAGES_PER_SECOND * 5)} and restart the daemon, then re-run this drive`,
  // Not a count of things — a single fact about the page. Phrased so the coverage line reads as a
  // caveat on what the network view MEANS, not as a tally.
  // A count of unverifiable ACTIONS, not of things we failed to look at. The distinction matters:
  // nothing here was missed, there was simply never a verdict to observe, and no amount of extra
  // instrumentation would produce one.
  [BlindSpotKind.VERDICTLESS_SEND]: (n) =>
    `${String(n)} one-way IPC send${1 === n ? '' : 's'} dispatched with NO verdict — the renderer never learns whether the main process handled ${1 === n ? 'it' : 'them'}, so this cannot be confirmed from the page`,
  // Not a tally — a fact about the app's wiring, phrased as what the EMPTY state channel means. An
  // agent reading `stateDiffs: []` otherwise reads "the app changed no state", which is a claim
  // nothing here can support. Names the one-line fix, because the reader is the one who can apply it.
  [BlindSpotKind.UNWATCHED_STATE]: () =>
    'no subscribable store is registered, so NO state change is observed — an empty stateDiffs here means unwatched, not unchanged (register the store itself in your reticle-dev module: registerStore(name, store), not a getter)',
  [BlindSpotKind.WRAPPED_NETWORK]: () =>
    'fetch was already wrapped before Reticle, so recorded requests may differ from what was sent',
  // A fact about the app's wiring, not a tally. Says what a network view WITHOUT ipc:// records
  // MEANS, because that state here is indistinguishable from "this app made no backend calls" —
  // and that reading is the false green: every IPC call went unseen and every `assert { net }` over
  // them is vacuous. Document-initiated loads ARE seen since subresource observation (#447), so
  // the note names the missing half instead of claiming the whole view is blind.
  [BlindSpotKind.UNOBSERVED_IPC]: () =>
    "this Electron renderer has no Reticle preload, so NO ipcRenderer.invoke is observed; document-initiated loads may still appear, so a view with no ipc:// records means unseen IPC, not none (add require('@reticlehq/electron/preload') to your preload)",
};

/**
 * Blind spots that IMPEACH the capture, as opposed to bounding what it covers.
 *
 * The distinction decides whether a verdict is downgraded to UNKNOWN or merely carries a caveat, and
 * conflating them breaks the tool in one direction or the other:
 *
 *  - **Impeaching**: events were DROPPED, so the window itself is a sample and any claim over it may
 *    be a false negative. Nothing observed can be trusted to be complete.
 *  - **Bounding**: a region is structurally unobservable — a cross-origin frame, a closed shadow
 *    root, the 9,970 virtualized rows that were never rendered. What WAS observed is completely and
 *    correctly observed; there is simply a boundary, and it is usually permanent.
 *
 * Treating the second kind as impeaching made every verdict on any virtualized list UNKNOWN — which
 * is most data-heavy software, permanently. A tool that answers "unknown" to everything is as
 * useless as one that answers "yes" to everything, and it is the same failure: a verdict that does
 * not depend on the evidence.
 */
export function impeachesCapture(kind: BlindSpotKind): boolean {
  return kind === BlindSpotKind.RATE_LIMITED;
}

/** Compose the coverage statement. `full` (no note) when nothing was unobserved. */
export function buildCoverageStatement(spots: readonly BlindSpot[]): CoverageStatement {
  const present = spots.filter((s) => s.count > 0);
  if (0 === present.length) return { coverage: Coverage.FULL, spots: [] };
  // Each label carries its own ending. Appending a blanket " unobserved" here produced
  // "...may differ from what was sent unobserved" for the wrapped-network caveat, which is a
  // sentence rather than a count — and the same dangle appeared the moment a second prose-shaped
  // spot (rate-limited sampling) was added.
  // A kind this daemon does not know about still has to READ as a blind spot. An SDK newer than the
  // daemon can report one, and `LABEL[kind](count)` threw a TypeError on the verdict path when it
  // did — turning "there is something I could not see" into a crashed assert, which is worse than
  // either the caveat or the silence. Unknown kinds degrade to their own name.
  const label = (s: BlindSpot): string =>
    'function' === typeof LABEL[s.kind] ? LABEL[s.kind](s.count) : `${s.kind} (${String(s.count)})`;
  const note = `${Coverage.PARTIAL} — ${present.map(label).join(', ')}`;
  return { coverage: Coverage.PARTIAL, note, spots: present };
}

/**
 * Reduce a window's BLIND_SPOT events to one spot per kind — the LATEST reported count wins (the sensor
 * emits only on change, so the last value is the live count). This is how a result's coverage is derived
 * from what the SDK observed during the action, with no extra round-trip.
 */
export function blindSpotsFromEvents(events: readonly ReticleEvent[]): BlindSpot[] {
  const latest = new Map<BlindSpotKind, number>();
  for (const e of events) {
    if (e.type !== EventType.BLIND_SPOT) continue;
    const kind = e.data['kind'];
    const count = e.data['count'];
    if ('string' === typeof kind && 'number' === typeof count) {
      latest.set(kind as BlindSpotKind, count);
    }
  }
  return [...latest].map(([kind, count]) => ({ kind, count }));
}

/**
 * Drop Electron-only coverage rows unless this session is actually an Electron renderer.
 *
 * The kinds live in the same vocabulary as "no store registered", so listing whatever is present
 * reported a Vite + React tab as an un-instrumented Electron renderer. The session already knows
 * the runtime (PAGE_HEALTH). Unknown runtime (older SDK) keeps the rows — dropping them would hide
 * a real missing-preload warning.
 */
export function spotsForRuntime(
  spots: readonly BlindSpot[],
  runtime: string | undefined,
): BlindSpot[] {
  if (runtime === undefined || AppRuntime.ELECTRON === runtime) return [...spots];
  return spots.filter((spot) => !isDesktopBlindSpot(spot.kind));
}

/**
 * Blind spots from the session's remembered LEVEL state rather than from a window of events.
 *
 * The SDK emits BLIND_SPOT only when the count changes, so a page that mounted cross-origin frames at
 * load announces them once and is silent thereafter. Deriving coverage from one act's window then
 * reports "full" for a page a third of which is unobservable — and the act tool's own description
 * tells harnesses to gate on that block. Ask the session what is true now instead of inferring it
 * from what happened to be said recently.
 *
 * `runtime` gates Electron-only kinds (see `spotsForRuntime`) so a web session cannot inherit them
 * from the coverage vocabulary.
 */
export function blindSpotsFromState(
  state: Readonly<Record<string, number>>,
  runtime?: string,
): BlindSpot[] {
  const spots = Object.entries(state).map(([kind, count]) => ({
    kind: kind as BlindSpotKind,
    count,
  }));
  return spotsForRuntime(spots, runtime);
}

/**
 * Events the BROWSER's own transport queue threw away inside this window, or 0.
 *
 * `RATE_LIMITED` — the BRIDGE sampling because events arrived faster than its per-second cap — is
 * already the one blind spot that `impeachesCapture`, on the reasoning that a green over a window
 * you did not fully see "would only describe what was observed". `TRANSPORT_OVERFLOW` is the exact
 * same loss on the other side of the wire, and it was read in journal rollups and NOWHERE on the
 * verdict path. So the identical condition downgraded a verdict from one side of the socket and was
 * invisible from the other: a window that dropped 34 events graded `proved`, in a sentence whose own
 * words were "over a clean capture".
 *
 * `TRUNCATED` is deliberately NOT counted. It names the channel it capped (a DOM-mutation flood on
 * any busy page) and is routine churn; treating it as lost evidence would caveat every verdict on
 * every real app, and a caveat that is always present is one nobody reads. TRANSPORT_OVERFLOW is the
 * honest "arbitrary events are gone" marker — it cannot say which.
 */
function droppedByTransport(events: readonly ReticleEvent[]): number {
  let dropped = 0;
  for (const e of events) {
    if (e.type !== EventType.TRANSPORT_OVERFLOW) continue;
    const n = e.data['dropped'];
    dropped += 'number' === typeof n ? n : 0;
  }
  return dropped;
}

/**
 * The narrow slice of a predicate the absence-blind-spot check needs.
 *
 * Kept minimal to avoid pulling the full Predicate type (and its transitive deps) into the
 * honesty module. Anything that quacks like this works.
 */
interface AbsencePredicate {
  kind: string;
  absent?: boolean;
  query?: { scope?: unknown };
  predicate?: AbsencePredicate;
}

/**
 * When an absence assertion targets a page with regions Reticle cannot observe, "the element is
 * absent" means only "it is absent in what I CAN see". Returns a note when that distinction
 * matters, undefined otherwise.
 *
 * Fires on three blind-spot kinds:
 *   - CROSS_ORIGIN_IFRAME (only when the predicate is scoped to a frame region)
 *   - VIRTUALIZED_UNMOUNTED — a row that was never rendered could hold the element
 *   - CLOSED_SHADOW_ROOT — a subtree Reticle cannot see into
 */
export function absenceBlindSpotNote(
  predicate: AbsencePredicate,
  spots: readonly BlindSpot[],
): string | undefined {
  // `not(element)` is the third spelling of an absence assertion — the `not` wrapper IS the
  // negation, so the inner predicate will not carry `absent: true`. Unwrap and synthesize it.
  // `not(element { absent: true })` is a double negative — presence — and a positive match is
  // not threatened by an unobservable region.
  if (PredicateKind.NOT === predicate.kind && predicate.predicate !== undefined) {
    if (PredicateKind.ELEMENT === predicate.predicate.kind) {
      if (true === predicate.predicate.absent) return undefined;
      return absenceBlindSpotNote({ ...predicate.predicate, absent: true }, spots);
    }
    return undefined;
  }
  if (PredicateKind.ELEMENT !== predicate.kind || true !== predicate.absent) return undefined;

  const relevant = spots.filter(
    (spot) =>
      spot.count > 0 &&
      (spot.kind === BlindSpotKind.CROSS_ORIGIN_IFRAME
        ? undefined !== predicate.query?.scope
        : spot.kind === BlindSpotKind.VIRTUALIZED_UNMOUNTED ||
          spot.kind === BlindSpotKind.CLOSED_SHADOW_ROOT),
  );
  if (0 === relevant.length) return undefined;

  const statement = buildCoverageStatement(relevant);
  return `the absence assertion targeted a region Reticle could not observe (${statement.note ?? 'partial coverage'}), so a passing DOM check cannot prove absence`;
}

/** The impeaching note for a transport gap, or undefined when the window was intact. */
export function transportGapNote(events: readonly ReticleEvent[]): string | undefined {
  const dropped = droppedByTransport(events);
  return 0 === dropped
    ? undefined
    : `the browser dropped ${String(dropped)} event(s) in this window (transport queue overflow), so events that would have contradicted this may never have arrived`;
}

/**
 * Is the state channel dark?
 *
 * Nothing subscribed means NO state change is observed, so an empty `stateDiffs` is a statement
 * about Reticle rather than about the app. Derived here, once, because two callers now need it —
 * the act path's causal summary and the instrumentation-gap surface — and a second spelling of this
 * predicate would eventually disagree with the first about what "unwatched" means.
 */
export function isStateUnwatched(spots: readonly BlindSpot[]): boolean {
  return spots.some((spot) => spot.kind === BlindSpotKind.UNWATCHED_STATE && spot.count > 0);
}

/**
 * Does a passing verdict on this predicate REST on the window being complete?
 *
 * Only an absence claim does. A positive assertion that passed found its evidence, and events aged
 * out elsewhere in the buffer do not unmake it. An absence claim concluded "nothing is there" — and
 * the thing the buffer dropped is precisely the disproof, so "absent" degrades to "absent in what I
 * still hold".
 *
 * The distinction is not optional. Scarce-loss is recorded for AGE eviction too, so `lostSince(0)`
 * is true on any session older than the 60s cutoff; impeaching every verdict over a caller-chosen
 * window would make `unknown` the answer to everything, which this repo has already paid for once.
 */
export function restsOnCompleteWindow(predicate: {
  kind: string;
  absent?: boolean;
  count?: number;
  predicate?: unknown;
}): boolean {
  if (PredicateKind.NOT === predicate.kind) return true;
  // An exact cardinality of ZERO is the third spelling of an absence claim, and reading only
  // `absent` missed it: `{ kind: "net", urlContains: "/api/auth/sign-in", count: 0 }` says "this
  // request was never made", and the call the buffer evicted is precisely the disproof. It was
  // graded `yes` over a window known to have lost scarce evidence — the exact false green the two
  // clauses above exist to prevent, reached by the one spelling they did not cover (#668).
  //
  // Only zero. `count: 2` asserts calls were MADE and found them; events aged out elsewhere in the
  // buffer do not unmake a positive finding, which is the same reason a plain presence assertion is
  // left alone here.
  if (0 === predicate.count) return true;
  return true === predicate.absent;
}
