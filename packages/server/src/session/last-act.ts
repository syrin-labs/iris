/**
 * What the most recent action was, kept so a LATER tool call can judge the window it opened.
 *
 * Reticle's act and observe tools are separate calls by design — act returns a cursor immediately and
 * the agent decides when to look. That split means the tool doing the judging holds none of the facts
 * the tool doing the acting measured, and every honesty check that needs both has to bridge the gap
 * somewhere. This is that somewhere.
 *
 *  - **cursor** — the evaluation floor for wait_for/assert, so a signal buffered BEFORE the act can
 *    never fake a later pass.
 *  - **source** — where the acted control is written, for failures that have no element left to point
 *    at because the action unmounted it.
 *  - **action + mutatedWithin** — what was done and how much changed inside the target. Without these
 *    the "this click did nothing" check is unreachable on the ordinary act-then-observe flow: an
 *    empty-window test is a statement about the PAGE, and no real app has a quiet page.
 */
interface ActEffect {
  action?: string | undefined;
  /**
   * The ref the action dispatched against. Recorded so the verdict nudge can suggest a call about
   * the element the agent actually touched, rather than a worked example from a document. Written
   * on the SAME success path as `action`, so a refused act leaves neither.
   */
  ref?: string | undefined;
  /** DOM mutations inside the acted element's own subtree. Undefined means nobody measured. */
  mutatedWithin?: number | undefined;
}

export class LastAct {
  #cursor: number | undefined;
  /** The cursor of the most recent navigation, kept apart from an act's so neither overwrites it. */
  #navigated: number | undefined;
  #source: string | undefined;
  #effect: ActEffect | undefined;

  /**
   * Record an action that ACTUALLY DISPATCHED — cursor and effect together, never one without the
   * other.
   *
   * It used to be two setters called BEFORE the ref was resolved, so a refused act (stale ref, a
   * disabled control, a paused page) left a cursor and an empty effect standing. The next observe
   * saw a cursor inside its window, asked for the effect, found `mutatedWithin: undefined` over a
   * quiet window and reported "the click was dispatched and the page settled … the target does not
   * react" — about a click nobody dispatched, blaming a control that was fine, on exactly the
   * re-query-and-retry path the stale-ref message sends the agent down.
   *
   * Marking only on the success path is what makes that unrepeatable: a failure mode added later
   * cannot forget to clean up state that was never written.
   */
  markActed(
    cursor: number,
    action: string | undefined,
    mutatedWithin: number | undefined,
    ref?: string,
  ): void {
    this.#cursor = cursor;
    this.#effect = { action, mutatedWithin, ...(ref === undefined ? {} : { ref }) };
  }

  /**
   * A navigation — by URL or by reload — moves the floor without being an act.
   *
   * Reported from the field: an agent reloaded the page, restarted its API, then asserted four
   * strings that were on the screen. Every clause passed and the verdict came back `contradicted`,
   * citing hundreds of failed requests, every one against a resource that no longer existed. The
   * failures were real once; they belonged to the document the reload destroyed.
   *
   * The floor was set only by act, act_sequence and act_and_wait, so navigating left it where it was
   * — or unset, which the caller reads as "judge the whole session". `queryEvents` is journal-backed,
   * so the whole session is durable history that outlives the page. A navigation has to move this or
   * every rule reading the window inherits evidence from a page that is gone.
   *
   * Deliberately NOT `markActed`: a navigation records no act effect. The "this click did nothing"
   * check reads an action with no measured mutation, and a reload written there would be accused of
   * being a dead click.
   */
  markNavigated(cursor: number): void {
    this.#navigated = cursor;
  }

  /**
   * The evaluation floor: the most recent thing that changed the page, whichever kind it was.
   *
   * `Math.max` rather than last-writer-wins, because the two are recorded by different tools and
   * their order is the agent's, not ours: an act then a reload must floor at the reload, and a reload
   * then an act must floor at the act. Either one going backwards would re-admit the evidence this
   * exists to exclude.
   */
  cursor(): number | undefined {
    if (this.#cursor === undefined) return this.#navigated;
    if (this.#navigated === undefined) return this.#cursor;
    return Math.max(this.#cursor, this.#navigated);
  }

  markSource(source: string | undefined): void {
    this.#source = source;
  }

  source(): string | undefined {
    return this.#source;
  }

  /** Empty when nothing has acted — callers then fall back to checks that need no action context. */
  effect(): ActEffect {
    return this.#effect ?? {};
  }
}
