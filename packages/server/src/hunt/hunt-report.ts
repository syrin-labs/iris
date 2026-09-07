/**
 * Aggregate many crawl runs into the one number the core claim needs.
 *
 * Detection already exists: `reticle_crawl` drives every reachable control and reports contradictions
 * — two channels disagreeing about the same click. It found `swallowed-500-login` and, separately,
 * `ui-advanced-request-failed` on a control whose assertion was green, neither of them planted.
 *
 * What was missing is the arithmetic that turns those into evidence. The claim worth making is not
 * "Reticle can find bugs"; it is:
 *
 *   "Run over N already-merged, already-green changes, it found X real bugs their own tests
 *    certified as passing."
 *
 * That needs no control arm, which is why it is the cheapest credible proof available: the
 * counterfactual is already established, because those changes SHIPPED. An A/B is the second study,
 * and this tells you where to point it.
 *
 * Pure functions over already-collected reports — the driving is `reticle_crawl`'s job, and running
 * it across a commit range is a shell loop. This is only the part that must not be done by eye.
 */

/** The contradiction kinds — cross-channel disagreement, as opposed to a single-channel fault. */
const CONTRADICTION_KINDS: readonly string[] = [
  'ui-advanced-request-failed',
  'signal-contradicted',
  'response-ignored',
  'duplicate-request',
  'request-never-settled',
  'failure-misattributed',
];

export interface HuntAnomaly {
  kind: string;
  ref?: string;
  desc?: string;
  detail?: string;
}

/** One crawl over one checkout. `label` is whatever identifies it — a commit sha, a PR number. */
export interface HuntRun {
  label: string;
  anomalies: readonly HuntAnomaly[];
  /** Controls actually driven. A run that drove nothing proves nothing and is reported separately. */
  stepsRun?: number;
}

interface HuntSummary {
  runs: number;
  /** Runs that actually drove at least one control. The denominator that can honestly be quoted. */
  runsWithCoverage: number;
  /** Runs where at least one CONTRADICTION was found — the headline numerator. */
  runsWithContradictions: number;
  contradictions: number;
  /** Single-channel faults (console errors, failed requests, dead controls). Context, not the claim. */
  singleChannelFaults: number;
  byKind: Record<string, number>;
  /** Labels with contradictions, so each one can be confirmed by hand before it is counted. */
  flagged: string[];
  headline: string;
}

const isContradiction = (kind: string): boolean => CONTRADICTION_KINDS.includes(kind);

export function summarizeHunt(runs: readonly HuntRun[]): HuntSummary {
  const byKind: Record<string, number> = {};
  const flagged: string[] = [];
  let contradictions = 0;
  let singleChannelFaults = 0;
  let runsWithCoverage = 0;

  for (const run of runs) {
    // A run that drove nothing is not evidence of cleanliness. Counting it in the denominator would
    // dilute the rate with checkouts where the app never even came up — the arithmetic equivalent of
    // reporting a green because no test ran.
    if ((run.stepsRun ?? 0) > 0) runsWithCoverage += 1;

    let flaggedThisRun = false;
    for (const anomaly of run.anomalies) {
      byKind[anomaly.kind] = (byKind[anomaly.kind] ?? 0) + 1;
      if (isContradiction(anomaly.kind)) {
        contradictions += 1;
        flaggedThisRun = true;
      } else {
        singleChannelFaults += 1;
      }
    }
    if (flaggedThisRun) flagged.push(run.label);
  }

  return {
    runs: runs.length,
    runsWithCoverage,
    runsWithContradictions: flagged.length,
    contradictions,
    singleChannelFaults,
    byKind,
    flagged,
    headline: buildHeadline(runsWithCoverage, flagged.length, contradictions),
  };
}

/**
 * The sentence that goes in front of someone, phrased so it cannot overstate itself.
 *
 * It counts CHECKOUTS with a finding rather than raw findings, because one broken control clicked
 * five times is one bug and five anomalies. It also says "candidate": every flag still has to be
 * confirmed by hand before it is a bug, and a number that skips that step is the kind of evidence
 * this project exists to distrust.
 */
function buildHeadline(withCoverage: number, flaggedRuns: number, contradictions: number): string {
  if (0 === withCoverage) {
    return 'no run drove a single control — nothing was measured, which is not the same as nothing being wrong';
  }
  if (0 === flaggedRuns) {
    return `${String(withCoverage)} merged changes crawled, no cross-channel contradictions found — confirm coverage was real before reading this as clean`;
  }
  return `${String(flaggedRuns)} of ${String(withCoverage)} merged, already-green changes carried a candidate false green (${String(contradictions)} contradictions) — each needs manual confirmation before it is counted`;
}
