/**
 * What Reticle could not see, and the one change that would let it.
 *
 * Reticle answers "could I see it?" — and answers it honestly: an unobservable channel downgrades a
 * verdict rather than passing it. That is a safety property and it is why a green verdict here means
 * something. What it has never answered is the other half: **what would I need in order to see it?**
 *
 * The difference matters because of who is driving. The decision-maker is an agent, and an agent
 * cannot be relied on to remember to instrument an app — nobody can. But an agent WILL act on a cost
 * it is paying right now, if it is handed the file, the line, and the change. So an absence in the
 * app stops being a silent weakness in the verdict and becomes a piece of work, at the moment the
 * agent is trying to finish.
 *
 * ## The rule that keeps this from becoming noise
 *
 * A gap is reported ONLY when a verdict came back weaker than it would otherwise have been, BECAUSE
 * of an absence in the app. Never as a survey of everything uninstrumented on the page.
 *
 * A gap nobody hit is a backlog, not a finding, and this product does not need another surface
 * producing findings nobody reads. The test for whether a gap belongs here is: *did this absence
 * change the answer the agent just got?* If not, it does not fire.
 */

/**
 * The kinds of absence that can weaken a verdict. Most name a capability the app did not provide;
 * `UNDECLARED_CHANGE` names one the agent did not, and is here because it costs a verdict the same.
 */
export const InstrumentationGapKind = {
  /**
   * An element was driven and carries no source mapping, so no `file:line` can be reported for it.
   *
   * The cheapest gap to close and the one with the widest blast radius: source mapping is what turns
   * "a control did not react" into "this control, at this line, did not react".
   */
  NO_SOURCE_MAPPING: 'no-source-mapping',
  /** A `state` predicate ran and the app registers no store, so the deterministic channel is absent. */
  NO_STORE_REGISTERED: 'no-store-registered',
  /**
   * An action changed the DOM and no signal fired for it.
   *
   * The app moved and did not say so, which means the strongest evidence class Reticle has — the app
   * asserting its own success — is unavailable for this action, and every verdict about it has to
   * fall back to inference from the DOM.
   */
  NO_SIGNAL_ON_MUTATION: 'no-signal-on-mutation',
  /** The route changed and no route signal fired, so route consequences cannot be asserted. */
  NO_ROUTE_SIGNAL: 'no-route-signal',
  /** A control was driven that the declared capability contract does not mention. */
  UNDECLARED_CONTROL: 'undeclared-control',
  /**
   * A flow cannot name a control with a stable testid, so the proposal is to add one.
   *
   * Honesty does not emit this on a verdict today — a missing testid is not itself a weaker
   * channel the way a missing signal is. Oracles do, when they can locate the control. It
   * belongs in this vocabulary so `reticle_domain` and a later honesty emit cannot disagree
   * about the name of the same absence.
   */
  MISSING_TESTID: 'missing-testid',
  /**
   * Code changed, and this verdict is the first one taken since — with nothing declaring what the
   * change was supposed to make true.
   *
   * The odd one out here, and deliberately so: every other kind names something the APP did not
   * provide, and this one names something the AGENT did not say. It belongs beside them because it
   * has the same effect on a verdict. A change with no declared intent can only be checked against
   * itself, so a green means "nothing visibly broke" and gets read as "the change worked" — which is
   * the definition of a false green, and the one absence no amount of instrumentation can close.
   *
   * It is never derived from the diff, the file name or the test name. A guessed intent reads as the
   * developer's own words and an agent will act on it, which is strictly worse than honest absence.
   */
  UNDECLARED_CHANGE: 'undeclared-change',
  /**
   * A verdict PASSED and the ledger still holds intents nothing has proved.
   *
   * The mirror of `UNDECLARED_CHANGE`, and the more expensive half. That one fires when NOTHING was
   * declared; this fires when something was and no verdict ever settled it — which reads identically
   * to done from inside the run, because every verdict the agent drew came back green.
   *
   * Measured on the bench fixture: an agent fixed a form guard, drove the app, and drew SEVEN green
   * verdicts, then reported FIXED. The form still accepted a whitespace-only service. Its closing
   * words quoted its own patch as the evidence — seven verdicts about other things, and a conclusion
   * read off the diff. No rule could see it: the change WAS declared, so `UNDECLARED_CHANGE` stayed
   * silent, and each individual verdict was honestly green.
   *
   * A green does not settle what the run still owes, and only the ledger knows the difference. This
   * is not a failure — the assertion held — so it downgrades nothing; it names the debt on the
   * result the agent is already reading, at the moment it is deciding whether it is finished.
   */
  INTENT_UNDISCHARGED: 'intent-undischarged',
  /**
   * A flow was saved and nothing says what it is for.
   *
   * The second kind here that names something the AGENT did not say rather than something the app
   * did not provide, and it costs the same. A saved flow is a regression test that runs for months:
   * when it eventually goes red, the report can name the step that broke and nothing else, so the
   * reader has to reconstruct the goal from the steps before they can judge whether the failure
   * matters. An intent turns that report into a sentence about what stopped being true.
   *
   * Never derived from the flow name, the step names or the assertions, for the reason
   * `UNDECLARED_CHANGE` gives: a guessed goal reads as the author's own words and somebody will act
   * on it. Absence stays honest.
   */
  NO_FLOW_INTENT: 'no-flow-intent',
} as const;
export type InstrumentationGapKind =
  (typeof InstrumentationGapKind)[keyof typeof InstrumentationGapKind];

export interface InstrumentationGap {
  kind: InstrumentationGapKind;
  /** What could not be seen, in the agent's terms. */
  missing: string;
  /** Why it weakened THIS verdict — the cost being paid right now, not a general principle. */
  cost: string;
  /** The single change that would close it. */
  fix: string;
  /** `file:line` when source mapping is present. Absent is itself usually the gap. */
  source?: string;
  /** The control the gap is about, when it is about one. */
  ref?: string;
}

/**
 * The remedy for a kind, as one line an agent can act on without reading a doc.
 *
 * Held here rather than at each emit site so that a kind cannot be reported with a fix that has
 * drifted from it — the same reason `tierOfFinding` derives from the kind in one place. An emit site
 * supplies the specifics (which ref, which store); the vocabulary supplies the remedy.
 */
const GAP_FIX: Readonly<Record<InstrumentationGapKind, string>> = {
  [InstrumentationGapKind.NO_SOURCE_MAPPING]:
    'add the Reticle build plugin (@reticlehq/vite-plugin, @reticlehq/next, or the babel plugin) so elements carry data-reticle-source',
  [InstrumentationGapKind.NO_STORE_REGISTERED]:
    'register the store with reticle.registerStore(name, getState) so state can be read directly instead of inferred from the DOM',
  [InstrumentationGapKind.NO_SIGNAL_ON_MUTATION]:
    'fire reticle.signal(name, data) where this state is committed — commitAndSignal binds the two so they cannot drift',
  [InstrumentationGapKind.NO_ROUTE_SIGNAL]:
    'let the Reticle router adapter observe navigation, or fire reticle.signal on route commit',
  [InstrumentationGapKind.UNDECLARED_CONTROL]:
    'add this control to reticle.describe() so the capability contract matches what the app actually exposes',
  [InstrumentationGapKind.MISSING_TESTID]:
    'add data-testid="..." on this control so the flow can name it after a refactor',
  [InstrumentationGapKind.UNDECLARED_CHANGE]:
    'declare it with reticle_intent { action: "declare", intents: [{ id, statement }] } — the statement is prose, in your own words: which user does what, and what should become true',
  [InstrumentationGapKind.INTENT_UNDISCHARGED]:
    'draw a verdict whose `until` asserts the intent itself, then it discharges — or call reticle_run({ tool: "reticle_context" }) to see exactly what is still owed',
  [InstrumentationGapKind.NO_FLOW_INTENT]:
    'save it again with intent: "<which user does what, and what should become true>" — prose, in your own words — or set intentId to an intent already in the ledger',
};

/** The one-line remedy for a gap kind. */
export function fixForGap(kind: InstrumentationGapKind): string {
  return GAP_FIX[kind];
}

/**
 * Build a gap, with its remedy attached.
 *
 * `missing` and `cost` are the caller's — only the emit site knows which control, which store, and
 * what the verdict would otherwise have said. `fix` never is.
 */
export function instrumentationGap(
  kind: InstrumentationGapKind,
  missing: string,
  cost: string,
  detail?: { source?: string; ref?: string },
): InstrumentationGap {
  return {
    kind,
    missing,
    cost,
    fix: fixForGap(kind),
    ...(detail?.source === undefined ? {} : { source: detail.source }),
    ...(detail?.ref === undefined ? {} : { ref: detail.ref }),
  };
}

/**
 * Collapse gaps that say the same thing.
 *
 * An `act_sequence` over eight unmapped controls is ONE missing build plugin, not eight findings. A
 * list that scales with the page rather than with the number of distinct things to fix is the exact
 * shape that trains an agent to stop reading these.
 *
 * Deduped on kind plus the specific thing named, so two different unregistered stores stay two gaps
 * while one store hit twice stays one.
 */
export function dedupeGaps(gaps: readonly InstrumentationGap[]): InstrumentationGap[] {
  const seen = new Set<string>();
  const out: InstrumentationGap[] = [];
  for (const gap of gaps) {
    const key = `${gap.kind} ${gap.missing}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(gap);
  }
  return out;
}
