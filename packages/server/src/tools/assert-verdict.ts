import { CaptureLoss, PredicateKind } from '@reticlehq/core';
import { gapsForAction } from '../honesty/instrumentation-gaps.js';
import { noteSessionGaps } from '../honesty/gap-ledger.js';
import { declaresState } from '../events/predicate-asks.js';
import { isStateUnwatched } from '../honesty/blind-spots.js';
import type { InstrumentationGap, JournalVerdictEffect } from '@reticlehq/core';
import type { Predicate } from '../events/predicate.js';
import type { Session } from '../session/session.js';
import { findContradictions, type Contradiction } from '../events/contradictions.js';
import { declaredExpectations, declaresBodyIndependentChannel } from '../events/declared.js';
import {
  absenceBlindSpotNote,
  blindSpotsFromState,
  buildCoverageStatement,
  restsOnCompleteWindow,
  Coverage,
  impeachesCapture,
  transportGapNote,
} from '../honesty/blind-spots.js';
import { buildHonestyBlock } from '../honesty/honesty.js';
import { hasAcceptedWrite } from '../honesty/accepted-write.js';
import { unreadWriteLabels } from '../honesty/unread-outcome.js';
import { decideVerified } from '../honesty/verified.js';
import { describeWaitTarget, namedNetIsInFlight } from '../honesty/unsettled.js';
import { inFlightRequestLabels, repeatedRequestLabels } from './settle-in-flight.js';
import { gradeOfPredicate } from './assert-grade.js';
import { assertSource } from './assert-source.js';

/**
 * The honesty verdict for a plain `reticle_assert`.
 *
 * This is the single field an agent reads, and it was missing from the most-used verdict path.
 * `act_and_wait` has always returned it; `reticle_assert` returned a bare `pass: true`.
 *
 * Measured on a shipments console: a dispatch answered 202 Accepted, the row rendered "dispatched"
 * optimistically, an assert taken right after the click returned `pass: true` with no caveat, and the
 * server reverted the write to "held" 1.2s later. The 202 machinery that exists precisely to report
 * that as `verified: "unknown"` was never reached, because the tool an agent actually calls did not
 * consult it. Asserting a moment earlier — while the POST was still open — is the same story with a
 * different name: `request-never-settled`, also unreported.
 */
export async function assertVerdict(
  session: Session,
  predicate: Predicate,
  pass: boolean,
  /**
   * What the oracle actually looked at. The only thing this verdict is entitled to point at — see
   * `assertSource`, which reads the matched element descriptors' own `file:line`.
   */
  evidence: unknown,
  since: number,
  /** Set when the assertion was never evaluated — see honesty/verified.ts. */
  inconclusive?: string,
  /**
   * Set when the tab went away mid-wait, so the assertion was never OBSERVED. `reticle_assert` and
   * `reticle_wait_for` reach the same disconnect path as the act tools, and a verdict that blames
   * the app for a lost connection is no more honest on this route than on that one.
   */
  observationLost?: boolean,
  /**
   * Set when code changed since the last verdict with nothing declaring what it was for. Decided by
   * `isChangeUndeclared` at the call site, which is the only place that can reach the intent ledger —
   * this path takes a session and no `deps`.
   */
  changeUndeclared?: boolean,
): Promise<{
  decision: Record<string, unknown>;
  contradictions: Contradiction[];
  coverage: Record<string, unknown>;
  gaps: InstrumentationGap[];
  /**
   * The bounded verdict, in the SAME shape `act_and_wait` writes into its journal action — so the
   * journal holds one verdict shape rather than two and the run fold that reads it needs no second
   * case. Built here because this is the one place that holds the typed decision and the predicate.
   */
  verdictEffect: JournalVerdictEffect;
}> {
  // Scope caveat, stated because it is a real limitation and not a bug: blind spots are tracked per
  // SESSION, not per assertion window, so a cross-origin iframe seen once marks every later verdict
  // in that session partial — including ones about a region it cannot affect. That errs toward
  // over-warning, which is the correct direction here: the failure this guards against is a green
  // that implies coverage it never had, and a needless caveat costs the agent a sentence.
  const spots = blindSpotsFromState(session.blindSpots(), session.runtime);
  const statement = buildCoverageStatement(spots);
  const absenceBlindSpot = absenceBlindSpotNote(predicate, spots);
  // Omitted entirely when coverage is full, so an intact page pays nothing and the field's PRESENCE
  // is the warning.
  const coverage =
    Coverage.PARTIAL === statement.coverage
      ? {
          coverage: statement.note ?? Coverage.PARTIAL,
          coverage_spots: statement.spots.map((sp) => ({ kind: sp.kind, count: sp.count })),
        }
      : {};
  const windowEvents = await session.queryEvents({ since });
  // Everything before the window, passed as LEARNING material only. A scale error disagrees with a
  // value the API stated earlier in the session, which an action-scoped window can never contain —
  // measured live, `observe` over a wide window reported `unit-mismatch` while `assert` on the same
  // session reported none. Attribution is unchanged: findings still come only from windowEvents.
  const prior =
    since > 0 ? (await session.queryEvents({ since: 0 })).filter((e) => e.t < since) : [];
  // The last act, when it falls inside the window being judged. Without it `duplicate-request` counted
  // `method + url` across whatever window the caller asked for, so two legitimate separate saves to one
  // endpoint were reported as a double submit — the instrument accusing the app of something nobody
  // could show it did. An assert taken over a window that predates the act attributes nothing, and the
  // rule then stays quiet.
  const actCursor = session.lastAct.cursor();
  // The same declaration the act path reads. `reticle_assert` is the other half of the verdict
  // surface, and an error path declared here deserves the same answer it gets there — a fix that
  // lived only on the act path would leave the sibling caller broken.
  const declared = declaredExpectations(predicate);
  const contradictions = findContradictions(windowEvents, {
    prior,
    currentDocumentId: session.currentDocumentId,
    currentEditEpoch: session.currentEditEpoch,
    appOrigin: session.url,
    expectedFailures: declared.netFailures,
    renderProved: pass && declared.rendersContent,
    ...(actCursor !== undefined && actCursor >= since ? { actionSince: actCursor } : {}),
  });
  // Only a spot that IMPEACHES the capture downgrades a general verdict. Structural boundaries are
  // reported as coverage; the narrower absence exception is computed separately above.
  const impeaching = buildCoverageStatement(spots.filter((sp) => impeachesCapture(sp.kind)));
  // A gap in the WINDOW, as opposed to a standing limit of the page. Both mean the same thing to the
  // rule — part of what happened was not seen — so both belong in `blindSpots`, which is the only
  // input `decideVerified` reads for that.
  const gap = transportGapNote(windowEvents);
  const impeachingNotes = [impeaching.note, gap].filter((n): n is string => n !== undefined);
  const outcomePending = hasAcceptedWrite(windowEvents);
  const outcomeUnread = unreadWriteLabels(windowEvents);
  const stillInFlight = inFlightRequestLabels(windowEvents);
  const decision = decideVerified({
    pass,
    // Same rule as the act path: the caller named a consequence, so a settlement-only finding must
    // not override it. A fix that lived on one half of the verdict surface would leave the other
    // half broken, and this is the tool agents call most.
    declaredConsequence: predicate.kind !== PredicateKind.SETTLED,
    ...(declaresBodyIndependentChannel(predicate) ? { independentOfBody: true } : {}),
    ...(inconclusive === undefined ? {} : { inconclusive }),
    ...(true === observationLost ? { observationLost: true } : {}),
    ...(absenceBlindSpot === undefined ? {} : { absenceBlindSpot }),
    ...(namedNetIsInFlight(predicate, stillInFlight) ? { namedRequestInFlight: true } : {}),
    honesty: buildHonestyBlock({
      grade: gradeOfPredicate(predicate),
      attribution: 'window',
      // Did the buffer evict SCARCE evidence belonging to this window, AND does a green here rest on
      // the window being complete. assert never consulted the buffer at all, on the reasoning that it
      // "observes an already-open window" — but eviction happens on push regardless of who opened the
      // window, so `{ console, absent: true }` returned `yes` over a window whose evidence was gone,
      // which is absence of evidence read as evidence of absence.
      //
      // The second half of the condition is not a refinement, it is what keeps this usable. Scarce
      // loss is recorded for AGE eviction too, so `lostSince(0)` is true on any session past the 60s
      // cutoff, and assert takes a caller-chosen `since` that is often 0. Impeaching every verdict
      // over a wide window would make `unknown` the answer to everything — the failure this repo has
      // already paid for once, when `unclean_capture` became the dominant cause of `unknown` in the
      // field. The act path needs no such guard: its cursor is the action's own.
      truncated: session.lostSince(since) && restsOnCompleteWindow(predicate),
      coveragePartial: Coverage.PARTIAL === statement.coverage,
      ...(statement.note === undefined ? {} : { coverageNote: statement.note }),
      ...(0 === impeachingNotes.length ? {} : { blindSpots: impeachingNotes }),
      // Which loss, as an enum, beside the prose.
      losses: [
        ...(session.lostSince(since) && restsOnCompleteWindow(predicate)
          ? [CaptureLoss.BUFFER_LOSS]
          : []),
        ...(gap === undefined ? [] : [CaptureLoss.TRANSPORT_GAP]),
        ...(impeaching.note === undefined ? [] : [CaptureLoss.BLIND_SPOT]),
      ],
    }),
    contradictions,
    ...(outcomePending ? { outcomePending } : {}),
    ...(outcomeUnread.length > 0 ? { outcomeUnread } : {}),
    // Same detail the act path supplies: this route reaches UNSETTLED through an absence-derived
    // contradiction, and "the window closed before the app finished" is no more actionable here.
    unsettled: {
      waitedFor: describeWaitTarget(predicate),
      stillInFlight,
      repeated: repeatedRequestLabels(windowEvents),
    },
  });
  // The same rule the act path uses, fed by what THIS path knows. An assertion drives nothing, so
  // only two of the four gates can fire here: a red with no remembered source to point at, and a
  // state assertion against an app that registers no store.
  const gaps = gapsForAction({
    pass,
    ...(changeUndeclared === undefined ? {} : { changeUndeclared }),
    source: session.lastAct.source(),
    stateAsked: declaresState(predicate),
    stateUnwatched: isStateUnwatched(spots),
    // What the app DECLARED, so an under-instrumented one is told without having to be asked.
    hasCapabilities: session.hasCapabilities,
    domMutated: false,
    signalsFired: 0,
    routeChanged: false,
    routeSignalFired: false,
  });
  noteSessionGaps(session, gaps);
  // The one file:line this verdict is entitled to: its own evidence, or — for a failure with no DOM
  // clause to point at — the control last driven. Returned so the RESPONSE can echo the same value
  // the journal keeps; one verdict must never carry two different pointers.
  const source = assertSource({
    predicate,
    evidence,
    pass,
    lastActSource: session.lastAct.source(),
  });
  return {
    decision: decision as unknown as Record<string, unknown>,
    contradictions,
    coverage,
    gaps,
    verdictEffect: {
      claim: describeWaitTarget(predicate),
      verified: decision.verified,
      ...(source === undefined ? {} : { source }),
    },
  };
}
