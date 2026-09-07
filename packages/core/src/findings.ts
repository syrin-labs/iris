/**
 * What a verification can FIND — the vocabulary of faults and contradictions shared by the crawl,
 * the contradiction hunter and the tools that report them. Split out of constants.ts to keep that
 * file under the size cap.
 */

/**
 * Cross-channel contradictions: two observation channels making INCOMPATIBLE claims about the same
 * action. This is the bug class a human structurally cannot see, because a human has one channel
 * open — the screen. The agent holds DOM, store, signals, console and network in one causally
 * ordered window and can notice they disagree.
 *
 * Every kind here describes a shipped-today false green: the run is green, the screen looks right,
 * and the app is wrong. Contrast `CrawlAnomalyKind`, whose members are all SINGLE-channel facts (an
 * error was logged; a request failed) — those are findable by reading one stream.
 */
export const ContradictionKind = {
  /** The screen moved forward while a request in the same window failed — the swallowed rejection. */
  UI_ADVANCED_REQUEST_FAILED: 'ui-advanced-request-failed',
  /** The app fired its own success signal while a request in the same window failed. Strongest form:
   *  the app did not merely look right, it explicitly ASSERTED success against its own evidence. */
  SIGNAL_CONTRADICTED: 'signal-contradicted',
  /** A write succeeded on the server and nothing on the client moved — the response went nowhere. */
  RESPONSE_IGNORED: 'response-ignored',
  /**
   * The app fired a success signal and NOTHING else in the window moved — no DOM, no store, no
   * route, no request. The only evidence that anything happened is the app's own claim.
   *
   * `DEAD_CONTROL` describes almost exactly this and deliberately excludes it: its definition is
   * "dispatched but the app did NOTHING (no DOM/net/route/signal)", so firing a signal was enough to
   * rescue a control that did nothing at all. That is the hole. An app whose signal is emitted from
   * the value it was ASKED for rather than the one it COMMITTED gets a verdict at signal grade —
   * the strongest we award — for a click that changed nothing. Measured on the bench fixture: a
   * modal that never opened came back `verified: "yes" / proved`.
   *
   * Absence-derived on purpose (see below). "Nothing corroborated it" is not "it did not happen":
   * a signal about genuinely non-visual state is legitimate. This downgrades the verdict to UNKNOWN
   * so the false green cannot stand, without asserting a fault nobody proved.
   */
  SIGNAL_WITHOUT_CONSEQUENCE: 'signal-without-consequence',
  /**
   * A write succeeded on the server and nothing moved in THIS document — because the page opened
   * another browsing context (an OAuth popup is the archetype) and the consequence lives there,
   * where an in-page SDK cannot follow. Reported instead of response-ignored, which would read as
   * "the client ignored the response" about a client that did no such thing.
   */
  CONSEQUENCE_ELSEWHERE: 'consequence-elsewhere',
  /** The same write fired more than once in one action — double-submit / retry storm. */
  DUPLICATE_REQUEST: 'duplicate-request',
  /**
   * Two reads of the same endpoint were in flight together and settled OUT OF ORDER, so the one the
   * user asked for first is the one that landed last — and the screen is showing it.
   *
   * The classic filter/search race. It needs no bug in either request: whichever query the server
   * happens to answer more slowly wins, so the UI shows data for a query the user has already
   * replaced. Every channel reports success — both requests are 200, the control shows the new
   * selection, the page settles — which is why it survives review and why `settled` cannot catch it.
   *
   * Detectable only from a request TIMELINE, which is why a screenshot or a DOM snapshot can never
   * see it: the evidence is the interleaving, and by the time anyone looks, the interleaving is gone.
   */
  STALE_RESPONSE_APPLIED: 'stale-response-applied',
  /**
   * A request returned 2xx and reported failure inside its BODY.
   *
   * The status line describes the transport, not the outcome. GraphQL returns 200 for every error it
   * has; a bulk endpoint returns 200 for the batch and puts per-item failures in the payload; a
   * gateway-normalised API returns 200 with `success: false`. Every channel above the body — status,
   * UI advance, settle — agrees with the optimistic reading, which is exactly why this survives.
   */
  PARTIAL_FAILURE_IN_OK_RESPONSE: 'partial-failure-in-ok-response',
  /**
   * A money value was sent back to the API at a different SCALE than the API stated it.
   *
   * Payment APIs speak minor units (paise, cents) as integers; a UI renders major units; writing the
   * rendered number back into the same field is a 100x error the server accepts and reports as
   * processed. Detectable only by holding the request timeline with bodies — the number sent is
   * exactly the number on the screen, so every other channel agrees it is correct.
   */
  UNIT_MISMATCH: 'unit-mismatch',
  /**
   * A write returned success and its OWN echo shows a field it was asked to set was not applied.
   *
   * Ordinary in real backends: a column missing from the UPDATE, a schema stripping unknown keys, a
   * PATCH honouring a subset, an enum falling back to a default. The status is 2xx, the body reports
   * no failure, the UI advanced, the page settled — so every channel except the payload agrees the
   * save worked, and the screen goes on showing the value the user typed rather than the value that
   * was stored. Measured on a preferences write that asked for `locale: fr` and echoed `locale: en`.
   */
  WRITE_FIELD_IGNORED: 'write-field-ignored',
  /** The UI advanced while a request was still in flight, so `settled` was reported over a live call. */
  REQUEST_NEVER_SETTLED: 'request-never-settled',
  /**
   * The SERVER faulted (5xx) and the app blamed the USER — "invalid credentials" for a broken
   * backend, "not permitted" for a crashed service. The user is told to fix something they cannot
   * fix, and the real fault is never reported. A support ticket that costs hours to trace back.
   */
  FAILURE_MISATTRIBUTED: 'failure-misattributed',
  /**
   * The action was dispatched and NOTHING happened — no DOM, no store, no route, no request, no
   * signal, no console line. The click landed on something that does not react.
   *
   * A contradiction rather than a warning because two channels disagree: the act layer reports
   * `dispatched: true, settled: true`, and every observation channel reports an empty window. The
   * settle half is the trap — a page that does nothing is quiet, and quiet is exactly what `settled`
   * tests for, so `until: { kind: 'settled' }` PASSES on a dead click and the verdict read
   * `verified: "yes", because: "no channel disagreeing"`. Measured on a real merchant dashboard by
   * clicking a `styled.div` that `reticle_query { by: 'text' }` had resolved instead of the button
   * beside it: zero events, store unchanged, green verdict.
   */
  ACTION_HAD_NO_EFFECT: 'action-had-no-effect',
  /**
   * The route changed and NOTHING was rendered for it — no content added, none removed, no request.
   * The URL says you arrived somewhere; the page is blank.
   *
   * This is the class every "did the control work" heuristic misses, because the control DID work:
   * it navigated. Measured on a real merchant dashboard with nine such links (Invoices, Route,
   * Subscriptions, QR Codes, Customers…), `reticle_crawl` drove all nine and reported
   * `deadControls: 0` — correctly, by its own definition, since a route change is activity.
   *
   * The discriminator came from executing both cases and comparing, not from reasoning: a working
   * nav emitted `domAdded: 1, network: 2`; a blank one emitted `domAdded: 0, domRemoved: 0,
   * network: 0` and left the page at an eighth the size. A real transition either fetches something
   * or renders something.
   *
   * MEASURED PRECISION, and the limit is real: 11 findings on that dashboard, 10 of them genuinely
   * blank destinations (verified by reading the DOM directly, not by asking Reticle), 1 false
   * positive. The false positive is instructive rather than fixable by tuning — a route whose view
   * is REVEALED from DOM that already existed emits `route.change` + `dom.attr` and nothing else,
   * which is byte-for-byte the window a blank destination emits. No event-only rule separates them.
   * Over-warning is the safe direction here (a false alarm costs a glance; a blank page shipped as
   * working does not), so it is reported with that ceiling stated rather than tuned into silence.
   */
  ROUTE_RENDERED_NOTHING: 'route-rendered-nothing',
  /**
   * Everything this window held belongs to a document that has SINCE been replaced.
   *
   * Not a disagreement between channels; a disagreement between the evidence and the clock. A window
   * is scoped by time and by ring-buffer capacity, so it can still hold the network calls, console
   * errors and signals of a page that a full navigation or a reload has already thrown away. Citing
   * one of those as the cause of an action taken now is true about the bytes and false about the
   * world — reported from the field with a failing request that named a database row which no longer
   * exists.
   *
   * Dropping that evidence is only half the fix. The other half is that its absence must not read as
   * "nothing happened", which would trade a wrong citation for a wrong all-clear, and an all-clear is
   * the more expensive of the two. This kind is what the engine says instead, and the distinction is
   * the whole user-visible point: an agent told its evidence was superseded knows to re-drive, and an
   * agent told the window was empty does not.
   */
  EVIDENCE_SUPERSEDED: 'evidence-superseded',
  /**
   * Everything this window held was observed BEFORE the last source edit landed in the page.
   *
   * The sibling of `EVIDENCE_SUPERSEDED`, for the loop an agent actually runs: verify, edit source,
   * verify again. A hot update replaces modules and re-renders inside the SAME document, so the
   * document id — the only thing that could previously say "this evidence is about a page that is
   * gone" — never moves, and observations of code the agent has already rewritten go on answering
   * for it in silence.
   *
   * Reported rather than EXCLUDED, and the difference from the document case is deliberate. A
   * navigation is total: it throws away the page, the refs, the in-flight requests and the state, so
   * nothing recorded under it is still about the world. An edit is not. Most modules, most of the
   * DOM, the whole network log and every console line survive a hot update, so most of what was
   * observed a second before it is still true a second after. Dropping that window would empty
   * verdicts that hold real findings, and an emptied window reads as "nothing happened" — the more
   * expensive of the two wrong answers, and the one this family of checks exists to prevent.
   *
   * So the evidence stays and the caveat is said out loud: absence-derived, because nothing here
   * claims the app is wrong. It downgrades a verdict to unknown, which is the honest reading of
   * "you changed the code and then looked only at what happened before you did".
   */
  EVIDENCE_PREDATES_EDIT: 'evidence-predates-edit',
} as const;
export type ContradictionKind = (typeof ContradictionKind)[keyof typeof ContradictionKind];

/**
 * Contradictions inferred from the ABSENCE of evidence in a window whose end Reticle itself chose.
 *
 * The distinction is not cosmetic — it decides whether Reticle is entitled to say an action FAILED.
 * The other kinds are things we positively observed: a request came back 500 while the UI advanced,
 * a signal fired carrying data that disagrees with the DOM, a written field echoed a different
 * value. Those are evidence AGAINST the action, and they must keep outranking a passing assertion,
 * because a green assertion sitting on top of a failed write is the entire bug class this product
 * exists to catch.
 *
 * These five are different. Each says "the thing I expected to see had not happened YET when I
 * stopped looking" — and the window closes the moment the predicate first passes, which on an app
 * that navigates optimistically is routinely before the network drains. Reproduced on the bench app:
 * `auth:granted` fired WITH matching data, application state changed, the token was stored, capture
 * integrity was clean and the honesty grade was `signal` — our strongest evidence class — and the
 * verdict was still `no`, because one POST had not settled. A timing observation overruled a
 * consequence observation, which inverts the grade hierarchy the verifier is built on.
 *
 * A false negative is not the mirror of a false positive here. A false positive stops an agent
 * early; a false NEGATIVE makes it redo work that already succeeded, or stop trusting the verdict
 * channel — and the verdict channel is the product. `bug.attribution` was deleted for exactly this
 * reason: every `attribution: 'app'` on `request-never-settled` turned out to be a misattribution.
 * We removed the field and left the verdict.
 *
 * So these downgrade a verdict to UNKNOWN rather than asserting NO. The finding is still reported in
 * `contradictions` either way — nothing is hidden, and an agent that wants to wait and re-check has
 * everything it needs to.
 */
export const ABSENCE_DERIVED_CONTRADICTIONS: ReadonlySet<ContradictionKind> = new Set([
  ContradictionKind.REQUEST_NEVER_SETTLED,
  ContradictionKind.RESPONSE_IGNORED,
  // The app said something happened and nothing corroborated it. That is an absence of agreement,
  // never proof the app is wrong — a signal about non-visual state has nothing to corroborate it by
  // construction. UNKNOWN removes the false green; NO would invent a fault.
  ContradictionKind.SIGNAL_WITHOUT_CONSEQUENCE,
  // The consequence is not missing, it is somewhere this document's SDK cannot look — a claim about
  // the reach of the observation, never a positive fault in the app.
  ContradictionKind.CONSEQUENCE_ELSEWHERE,
  ContradictionKind.ROUTE_RENDERED_NOTHING,
  ContradictionKind.ACTION_HAD_NO_EFFECT,
  ContradictionKind.DUPLICATE_REQUEST,
  // Absence in the strictest sense: the evidence that would have answered the question was thrown
  // away with the document it belonged to. Nothing here says the app is wrong, so it must downgrade
  // the verdict to UNKNOWN rather than assert NO — the same reasoning `unclean_capture` follows.
  ContradictionKind.EVIDENCE_SUPERSEDED,
  // Nothing here says the app is wrong either — only that the window predates the edit under test.
  ContradictionKind.EVIDENCE_PREDATES_EDIT,
]);

/** True when this kind was inferred from absence rather than positively observed. */
export function isAbsenceDerived(kind: string): boolean {
  return ABSENCE_DERIVED_CONTRADICTIONS.has(kind as ContradictionKind);
}

/**
 * How much authority a finding carries — the distinction above, said out loud on the finding itself.
 *
 * The rule already turns on this: an OBSERVED contradiction outranks a passing assertion and answers
 * `no`, an ABSENCE_DERIVED one downgrades to `unknown`. But the findings all arrive looking alike, so
 * an agent handed three of them cannot tell which one decided the verdict and which is a note about
 * when Reticle stopped looking. Two facts of very different strength, reported in one voice.
 */
export const FindingTier = {
  /**
   * Positively observed evidence AGAINST the action: a request came back 500 while the UI advanced, a
   * signal fired carrying data the DOM disagrees with, a written field echoed a different value.
   * Something happened, and it is incompatible with the action having worked.
   */
  OBSERVED: 'observed',
  /**
   * Inferred from something NOT having happened yet, in a window whose end Reticle chose. It may
   * become true a moment later. It is a statement about our timing at least as much as about the app.
   */
  ABSENCE_DERIVED: 'absence-derived',
} as const;
export type FindingTier = (typeof FindingTier)[keyof typeof FindingTier];

/**
 * The tier of a finding, DERIVED from its kind.
 *
 * Deliberately a lookup rather than a field an oracle sets. An oracle that stated its own tier would
 * be grading its own homework, and the one thing every author of a new rule is sure of is that their
 * finding is important. The kind decides, in one place, where the verdict rule already reads it.
 *
 * An unrecognised kind is OBSERVED, and that default is doing real work rather than being a fallback.
 * A rule registered by a consumer emits kinds deliberately absent from this vocabulary — that is what
 * keeps somebody's private finding names out of the free product — and those findings still have to
 * be tierable. OBSERVED is the honest answer: an unknown kind has made no claim about a window whose
 * end Reticle chose, so downgrading it would invent a caveat on its author's behalf.
 */
export function tierOfFinding(kind: string): FindingTier {
  return isAbsenceDerived(kind) ? FindingTier.ABSENCE_DERIVED : FindingTier.OBSERVED;
}

/**
 * HTTP methods that CHANGE server state. Several contradiction rules are restricted to these on
 * purpose: a GET that fires without moving the UI is a prefetch, but a POST that does is a lost
 * write. Narrowing to writes is what keeps the rules from crying wolf on ordinary reads.
 */
export const MUTATING_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE', 'IPC'];

export const CrawlAnomalyKind = {
  CONSOLE_ERROR: 'console-error', // the click logged a console.error / uncaught error
  FAILED_REQUEST: 'failed-request', // it fired a request that returned >= 400
  DEAD_CONTROL: 'dead-control', // it dispatched but the app did NOTHING (no DOM/net/route/signal)
} as const;
export type CrawlAnomalyKind = (typeof CrawlAnomalyKind)[keyof typeof CrawlAnomalyKind];
