import { z } from 'zod';

/**
 * Flake ledger. Trust in the red is the product; one unexplained flake a week kills it. A flow that
 * fails intermittently at UNCHANGED code is flaky, not a real regression — it must be quarantined
 * (excluded from gate-blocking) and surfaced for repair, never silently blocking. The caller accrues an
 * outcome ONLY for unchanged-code replays (a fail after a code change is a legitimate red, not flake).
 */

const FlakeRecordSchema = z.object({
  runs: z.number().int().min(0),
  fails: z.number().int().min(0),
});
type FlakeRecord = z.infer<typeof FlakeRecordSchema>;

/** Per-flow map (flow name → record). */
export type FlakeLedger = Record<string, FlakeRecord>;

export const FlakeFileSchema = z.object({
  version: z.literal(1),
  flows: z.record(FlakeRecordSchema),
});

/** Minimum unchanged-code replays before flakiness can be judged (too few = noise). */
const DEFAULT_MIN_FLAKE_RUNS = 5;

export function emptyRecord(): FlakeRecord {
  return { runs: 0, fails: 0 };
}

/** Accrue one unchanged-code replay outcome. */
export function recordOutcome(record: FlakeRecord, passed: boolean): FlakeRecord {
  return { runs: record.runs + 1, fails: record.fails + (passed ? 0 : 1) };
}

/**
 * Flaky = enough unchanged-code runs, and it has BOTH passed and failed (intermittent). A flow that
 * always fails is a real red; one that always passes is healthy; only the mix is flake.
 */
export function isFlaky(record: FlakeRecord, minRuns: number = DEFAULT_MIN_FLAKE_RUNS): boolean {
  return record.runs >= minRuns && record.fails > 0 && record.fails < record.runs;
}

/** Observed intermittent-failure rate (0 when too few runs to judge). */
export function flakeRate(record: FlakeRecord): number {
  return 0 === record.runs ? 0 : record.fails / record.runs;
}
