/**
 * Verified-surface coverage — the buddy channel's honest answer to "is EVERYTHING working?". A green on
 * three flows says nothing about the twelve testids never exercised. This measures the declared surface
 * (contract testids/signals/flows) actually touched by passing verification, so "everything" is honest
 * about what everything means. Pure set math; the deviation report + gate carry the number.
 */

interface DeclaredSurface {
  testids: readonly string[];
  signals: readonly string[];
  flows: readonly string[];
}

interface CoverageDimension {
  total: number;
  covered: number;
  /**
   * Percent covered, rounded. PRESENT ONLY WHEN IT WAS MEASURED — absent when nothing is declared,
   * same rule as the honesty layer's `{ pct?: number; partial: boolean }`.
   *
   * This used to report 100 for an empty surface ("vacuously complete"), which made
   * `covered: 0, total: 0, pct: 100` — a contradiction the caller had to notice unaided, in output an
   * agent reads to decide whether its change is covered.
   */
  pct?: number;
  /** Declared-but-never-exercised members — what "everything" is silently missing. */
  uncovered: string[];
}

export interface Coverage {
  testids: CoverageDimension;
  signals: CoverageDimension;
  flows: CoverageDimension;
  /** Overall percent across all three dimensions combined; absent when nothing is declared. */
  overallPct?: number;
}

/** The gate's outcome when the project has recorded no flows at all — not a pass, and not a failure. */
export const NO_FLOWS = 'no_flows';

/**
 * What to do about it, since the empty state is otherwise indistinguishable from success.
 *
 * Names the TOOLS, not a `reticle record` CLI verb: this CLI does not dispatch one, and a suggestion
 * that errors is a second dead end on top of the first (see suggested-commands-exist.test.ts). Same
 * wording as the empty-suite verdict, which is the same situation reached from `reticle verify`.
 */
const NO_FLOWS_NOTE =
  'no flows recorded — nothing was checked. Record one with reticle_record { action: "start" }, then reticle_flow_save.';

/** The gate's flow-coverage line. `pct` and `outcome` are mutually exclusive by construction. */
interface FlowCoverageReport {
  covered: number;
  total: number;
  pct?: number;
  outcome?: typeof NO_FLOWS;
  note?: string;
}

/**
 * Report flow coverage so that an EMPTY suite cannot be read as a passing one.
 *
 * Same rule `buildSuiteVerdict` already applies to `reticle verify`, where zero flows reports
 * `unverifiable` rather than "all 0 flows pass": a green that cannot go red is not a pass. Callers
 * must treat a present `outcome` as not-passing.
 */
export function flowCoverageReport(flows: CoverageDimension): FlowCoverageReport {
  const { covered, total } = flows;
  if (0 === total) return { covered, total, outcome: NO_FLOWS, note: NO_FLOWS_NOTE };
  return { covered, total, ...(flows.pct === undefined ? {} : { pct: flows.pct }) };
}

function dimension(declared: readonly string[], exercised: ReadonlySet<string>): CoverageDimension {
  const uncovered = declared.filter((d) => !exercised.has(d));
  const covered = declared.length - uncovered.length;
  const base = { total: declared.length, covered, uncovered };
  if (0 === declared.length) return base;
  return { ...base, pct: Math.round((covered / declared.length) * 100) };
}

export function computeCoverage(declared: DeclaredSurface, exercised: DeclaredSurface): Coverage {
  const testids = dimension(declared.testids, new Set(exercised.testids));
  const signals = dimension(declared.signals, new Set(exercised.signals));
  const flows = dimension(declared.flows, new Set(exercised.flows));
  const total = testids.total + signals.total + flows.total;
  const covered = testids.covered + signals.covered + flows.covered;
  if (0 === total) return { testids, signals, flows };
  return { testids, signals, flows, overallPct: Math.round((covered / total) * 100) };
}
