import type { InstrumentationGap } from '@reticlehq/core';

/**
 * Of the controls this session drove, how many could Reticle fully observe?
 *
 * The first honest denominator this product has ever had. `reticle_verify{action:"coverage"}`
 * already answers "which controls did you not drive"; this answers the question underneath it —
 * *of the ones you did drive, how many could the app actually answer for?* A high untouched-count is
 * work remaining for the agent. A low observability is work remaining in the APP, and no amount of
 * driving closes it.
 *
 * ## Two things it deliberately refuses to do
 *
 * **It does not report a percentage for an empty run.** 0/0 rendered as 100% is the most flattering
 * possible reading of no evidence at all, and a coverage number that starts perfect is one nobody
 * believes the first time it drops.
 *
 * **It does not count app-level gaps against a control.** An unregistered store or an unsignalled
 * route is missing from the application, not from a button. Attributing it to whichever control
 * happened to be driven would put the number on the wrong thing and make it move for reasons the
 * agent cannot act on. Those gaps are reported alongside, not divided into.
 */

interface Observability {
  /** Distinct controls driven this session. */
  driven: number;
  /** How many of them Reticle could fully observe. */
  observable: number;
  /** Rounded percentage. OMITTED when nothing was driven — see above. */
  percent?: number;
}

export function observabilityOf(
  // Iterable, not an array: the session holds these as a Set, and making the caller spread it would
  // be a conversion that exists only to satisfy a signature.
  drivenRefs: Iterable<string>,
  gaps: readonly InstrumentationGap[],
): Observability {
  const driven = new Set(drivenRefs);
  const impaired = new Set<string>();
  for (const gap of gaps) {
    // App-level gaps carry no ref, and a gap on a control this session never drove is about some
    // earlier route — neither belongs in a ratio over what WAS driven.
    if (gap.ref !== undefined && driven.has(gap.ref)) impaired.add(gap.ref);
  }
  const observable = driven.size - impaired.size;
  if (0 === driven.size) return { driven: 0, observable: 0 };
  return { driven: driven.size, observable, percent: Math.round((observable / driven.size) * 100) };
}

/**
 * The floor under the number, shipped with it rather than after it.
 *
 * A coverage figure with no downgrade check is a figure that gets gamed, and we would be the ones
 * teaching agents to game it: the cheapest way to stop a gap firing is to stop asserting the thing
 * that revealed it. The same reasoning already runs for flow assertions in `assertion-tiers-store`,
 * where a flow that passes more weakly than it used to is a finding rather than a pass.
 *
 * Returns undefined — not a false — when there is nothing honest to compare. A first run has no
 * best to fall from, and a run that drove almost nothing is evidence of a short session rather than
 * of a regression.
 */

/** Below this, a run is too small for its ratio to mean anything. */
const MIN_DRIVEN_TO_COMPARE = 3;

interface CoverageRegression {
  was: number;
  now: number;
}

export function coverageRegressed(
  best: { percent: number } | undefined,
  current: Observability,
): CoverageRegression | undefined {
  if (best === undefined) return undefined;
  if (current.percent === undefined) return undefined;
  if (current.driven < MIN_DRIVEN_TO_COMPARE) return undefined;
  return current.percent < best.percent ? { was: best.percent, now: current.percent } : undefined;
}
