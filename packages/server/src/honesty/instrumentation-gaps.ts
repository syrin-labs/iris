import {
  InstrumentationGapKind,
  dedupeGaps,
  instrumentationGap,
  type InstrumentationGap,
} from '@reticlehq/core';

/**
 * The gaps ONE action revealed, derived from facts the act path already holds.
 *
 * Pure, and deliberately fed by primitives rather than by the action result: every fact below is
 * already computed for other reasons — `actedSource` for the red-verdict file:line, `stateUnwatched`
 * because an empty `stateDiffs` would otherwise read as "the app changed nothing", the signal count
 * and route movement for the causal summary. Nothing here costs a new observation. The gap surface
 * is a second reading of evidence Reticle was already collecting and then discarding.
 *
 * ## Each kind carries its OWN gate
 *
 * The rule is that a gap fires only when the verdict came back weaker because of it — and "weaker"
 * is different per kind, so a single global flag would be a lie in both directions:
 *
 *  - a missing source mapping costs nothing on a PASS. The act path already says so in as many
 *    words: on green nobody needs the file:line and it is noise. It costs a great deal on a red,
 *    where it is the first thing the agent wants;
 *  - a missing store costs nothing unless the caller ASKED about state;
 *  - a silent mutation costs nothing if the app proved the outcome some other way.
 *
 * Encoding the gates per kind is what keeps this from degenerating into a linter that fires on every
 * uninstrumented control on the page. That surface would be ignored within a day, and it would take
 * the true positives with it.
 */

export interface ActionInstrumentationFacts {
  /** Did the verdict pass? Several gates turn on this, in different directions. */
  pass: boolean;
  /** True when the outcome was positively PROVED rather than inferred. */
  proved?: boolean;
  /**
   * The `file:line` of the element this verdict is about, when the build plugin stamped one.
   *
   * Was a boolean, on the reasoning that the gap only needed to know WHETHER the agent could be
   * pointed at code. That was true while the only gap reading it was the one that fires when the
   * pointer is missing. It stopped being true the moment a gap wanted to CARRY the pointer: a gap is
   * read back later, out of the ledger, by which time its `ref` is very likely dead, and a boolean
   * cannot be turned back into a location. Both callers already hold this as a formatted string.
   */
  source?: string | undefined;
  /** The ref that was driven, for the report. */
  ref?: string | undefined;
  /** Did the caller's predicate ask about registered state? */
  stateAsked: boolean;
  /** True when the session has no store registered to read. */
  stateUnwatched: boolean;
  /**
   * Did the app declare any capabilities at all?
   *
   * Undefined means NOT KNOWN, and not-known must never become an accusation — callers that predate
   * this field keep their behaviour rather than start reporting a gap they cannot substantiate.
   */
  hasCapabilities?: boolean | undefined;
  /** Did the DOM move in this action's window? */
  domMutated: boolean;
  /** How many app signals fired in the window. */
  signalsFired: number;
  /** Did the route change in this action's window? */
  routeChanged: boolean;
  /** Did anything signal that route change? */
  routeSignalFired: boolean;
  /**
   * Did a code change land since the last verdict with nothing declaring what it was for?
   *
   * Arrives already decided, because the decision needs the intent ledger and this stays pure. Its
   * gate — and the reasoning that keeps it from becoming a nag — lives in `isChangeUndeclared`, and
   * that is the only place allowed to answer it.
   */
  changeUndeclared?: boolean;
  /**
   * How many intents the ledger still holds undischarged. Undefined when nothing consulted it.
   *
   * A count rather than a boolean because the message names the number: "one thing still unproved"
   * and "four things still unproved" are different situations for an agent deciding whether it is
   * finished, and a bare flag makes them read the same.
   */
  openIntentCount?: number;
  /**
   * How long the OLDEST open intent has been owed, in ms.
   *
   * A count alone cannot tell "you declared this a minute ago and have not proved it yet" from
   * "this project has owed eighteen things since last week". Only the first is actionable on the
   * result being read, and a number that is always large is a number people learn to skip — which
   * is exactly how an honest gap gets filtered out along with the noise.
   */
  oldestOpenIntentAgeMs?: number;
}

export function gapsForAction(facts: ActionInstrumentationFacts): InstrumentationGap[] {
  const gaps: InstrumentationGap[] = [];

  // A red verdict names the control and cannot name the line that renders it. That is the round trip
  // the agent is about to spend, and the one a build plugin removes permanently.
  if (!facts.pass && facts.source === undefined) {
    gaps.push(
      instrumentationGap(
        InstrumentationGapKind.NO_SOURCE_MAPPING,
        'the control that was driven carries no source mapping',
        'this verdict can name the control but not the file and line that render it, so finding the code is a separate search',
        { ...(facts.ref === undefined ? {} : { ref: facts.ref }) },
      ),
    );
  }

  // Asked about state, and there is no state channel to answer from. Deliberately UNLOCATED: a store
  // is registered once at app setup, nowhere near the control that was driven, and nothing in this
  // window knows where that setup lives. Borrowing the acted line would send the agent to a file
  // that cannot hold the fix — worse than no pointer, because it costs the trip as well.
  // An app that declared NOTHING is told once, without having to be asked.
  //
  // The rule below fires only when an assertion about state could not be answered, which is correct
  // for that gap and leaves the common case silent: an app whose capabilities file registers
  // nothing drives fine, produces verdicts, and never mentions being under-instrumented — unless
  // the agent happens to ask about state, which an agent with no reason to suspect a problem will
  // not do. The session has known the answer the whole time and no verdict ever consulted it.
  //
  // Reported as the same kind, because it is the same missing thing seen from the other side, and
  // guarded so the two conditions cannot report it twice.
  //
  // BOTH arms require `stateUnwatched`, which is the store registry. Keying the first on
  // `hasCapabilities` alone made this fire on apps whose store IS registered and readable: an app
  // that calls `registerStore()` without `registerCapabilities()` has no declaration and a perfectly
  // good store, and got a gap saying "no state can be read from it" in the same response that
  // carried `reticle_state { found: true }`, a populated `stateDiffs`, and `statePathsChanged`
  // naming the store (#700). A gap contradicted by its own response tells the agent to redo work it
  // has already done, and teaches it to distrust the whole block.
  //
  // The kind is NO_STORE_REGISTERED and every sentence it carries is about stores, so the store
  // registry is what it must be keyed on. An undeclared-capabilities app with a working store is a
  // different observation, and if it is worth reporting it needs its own kind and its own words.
  if (facts.stateUnwatched && (false === facts.hasCapabilities || facts.stateAsked)) {
    // Same missing thing, two ways of meeting it — and the sentence has to say which. Describing an
    // assertion about state to an agent that made no such assertion is a false explanation, and a
    // gap nobody can act on is worse than no gap: it costs the trip and teaches the wrong lesson.
    const declaredNothing = false === facts.hasCapabilities;
    gaps.push(
      instrumentationGap(
        InstrumentationGapKind.NO_STORE_REGISTERED,
        declaredNothing
          ? 'this app declared no capabilities at all, so no state can be read from it'
          : 'no store is registered, and this assertion was about state',
        declaredNothing
          ? 'every verdict here rests on what the DOM happens to show, and reticle_state will stay empty however many flows are driven'
          : 'the assertion could not be answered from the deterministic channel and had to fall back to what the DOM happens to show',
      ),
    );
  }

  // The app moved and said nothing, and Reticle could not prove the outcome another way.
  if (facts.domMutated && 0 === facts.signalsFired && true !== facts.proved) {
    gaps.push(
      instrumentationGap(
        InstrumentationGapKind.NO_SIGNAL_ON_MUTATION,
        'the DOM changed and no signal fired for it',
        'the outcome had to be inferred from the DOM instead of read from the app asserting its own success, which is the strongest evidence available',
        // The one gap here that can be LOCATED. It is about the element that was driven, and that
        // element is exactly what `source` describes — so the pointer is a fact, not a guess. It
        // also outlives the `ref` beside it, which is what makes this gap still actionable when
        // coverage reads it back long after the page has re-rendered.
        {
          ...(facts.ref === undefined ? {} : { ref: facts.ref }),
          ...(facts.source === undefined ? {} : { source: facts.source }),
        },
      ),
    );
  }

  // Also unlocated, for the same reason: the remedy is a router adapter wired app-wide, not a line
  // at the control that happened to trigger this navigation.
  if (facts.routeChanged && !facts.routeSignalFired) {
    gaps.push(
      instrumentationGap(
        InstrumentationGapKind.NO_ROUTE_SIGNAL,
        'the route changed and nothing signalled it',
        'route consequences cannot be asserted on this app, so a navigation can only be checked by what rendered afterwards',
      ),
    );
  }

  // The one gap here that is not about the app. Deliberately UNLOCATED and deliberately generic: the
  // only honest thing to report is that the intent is absent. Naming the file that changed, or the
  // control that was driven, would invite the reader to treat a guess as the declaration — and a
  // guessed intent reads as the developer's own words, which is strictly worse than honest absence.
  if (true === facts.changeUndeclared) {
    gaps.push(
      instrumentationGap(
        InstrumentationGapKind.UNDECLARED_CHANGE,
        'code changed since the last verdict and no intent says what the change was for',
        'this verdict can only check the app against itself, so a green here means "nothing visibly broke" rather than "the change did what it was meant to"',
      ),
    );
  }

  /**
   * Say how old the debt is, when it is old enough to change what the reader should do.
   *
   * The ledger is a PROJECT's, deliberately — "what does this still owe" outlives one session. But an
   * intent declared minutes ago and one abandoned last week produce the same sentence, and the second
   * one is not about the work in front of you. Naming the age separates them without weakening the
   * gap, and without pretending a stale backlog is this verdict's fault.
   */
  const DAY_MS = 86_400_000;

  function describeIntentAge(ageMs: number | undefined): string {
    if (ageMs === undefined || ageMs < DAY_MS) return '';
    const days = Math.floor(ageMs / DAY_MS);
    return ` (the oldest for ${String(days)} day${1 === days ? '' : 's'} — a backlog this old is probably not what this run is about; retire them or prove them)`;
  }

  // A green that does not settle what the run OWES.
  //
  // The mirror of `changeUndeclared` above, and the more expensive half: that fires when nothing was
  // declared, this when something was and no verdict ever proved it. Measured on the bench fixture —
  // an agent drew SEVEN green verdicts and reported FIXED on a form that still accepted a
  // whitespace-only service, quoting its own patch as the evidence. Every verdict was honestly
  // green; none of them was about the thing claimed, and nothing in the result said so.
  //
  // Only on a PASS: a failing verdict proved nothing and already says that, so adding this would be
  // two sentences for one fact. It downgrades nothing either — the assertion did hold — it just
  // names the debt on the result the agent is already reading, while it is deciding if it is done.
  // `proved`, not `pass`, because a bare `{ settled }` wait scores the predicate true while proving
  // nothing — the verdict comes back `no-fault`, and keying on `pass` attached "this verdict passed"
  // to a result whose own `because` says it is not verification.
  const owed = facts.openIntentCount ?? 0;
  if (facts.pass && true === facts.proved && 0 < owed) {
    gaps.push(
      instrumentationGap(
        InstrumentationGapKind.INTENT_UNDISCHARGED,
        `this verdict passed, and ${String(owed)} declared intent(s) are still unproved${describeIntentAge(facts.oldestOpenIntentAgeMs)}`,
        'a green settles what it asserted, not what the run set out to do — reporting done here rests on the change looking right rather than on anything having checked it',
      ),
    );
  }

  return dedupeGaps(gaps);
}
