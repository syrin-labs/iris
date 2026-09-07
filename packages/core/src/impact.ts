import { z } from 'zod';

/**
 * The impact record: what Reticle has actually done for this user, and what that is worth.
 *
 * Everything here is derived from calls that really happened - the dispatch chokepoint counts them
 * - and is stored locally. Two kinds of number live in this file and they are NOT interchangeable:
 *
 *   MEASURED  - counted from real calls (tokens returned, verdicts, defects, sessions, minutes).
 *   ESTIMATED - a comparison against a run that did not happen (tokens/minutes SAVED). Every one of
 *               these carries the baseline it is measured against, because a saving without its
 *               denominator is not a claim, it is a slogan - and this project has already been
 *               bitten by publishing one ("2574x cheaper" compares against an LLM re-drive, not a
 *               compiled suite).
 *
 * The UI must render the two differently and must never present an estimate as a count.
 */

/** Storage + wire version for the impact record. Bump on any breaking shape change. */
export const IMPACT_SCHEMA_VERSION = 1;

/** How many daily buckets a store keeps - enough for a month's chart plus a fortnight of slack. */
export const IMPACT_DAILY_BUCKETS = 45;

/** Counts of things that actually happened. Every field is a tally, never an estimate. */
export const ImpactCountsSchema = z.object({
  /** Session-bound tool calls that reached a handler. */
  calls: z.number().int().nonnegative(),
  /** Calls that produced a verdict (act_and_wait / assert). */
  verdicts: z.number().int().nonnegative(),
  /** Verdicts that came back verified:"yes". */
  passed: z.number().int().nonnegative(),
  /** Verdicts that came back verified:"no" - a defect the agent would otherwise have called done. */
  failed: z.number().int().nonnegative(),
  /** Verdicts Reticle could not decide. Shown, not hidden: an unknown is not a pass. */
  unknown: z.number().int().nonnegative(),
  /** Refusals - a drive Reticle declined rather than faking. */
  refusals: z.number().int().nonnegative(),
  /** Notes a human pinned to the page. */
  marks: z.number().int().nonnegative(),
  /** Distinct sessions seen. */
  sessions: z.number().int().nonnegative(),
  /** Tokens Reticle returned to the agent (estimated per call at ~4 chars/token, then summed). */
  tokensReturned: z.number().int().nonnegative(),
  /** Wall-clock milliseconds spent inside tool calls. */
  drivingMs: z.number().int().nonnegative(),
});
export type ImpactCounts = z.infer<typeof ImpactCountsSchema>;

/** One day's slice of the same counters, keyed by ISO date, for the chart. */
export const ImpactDaySchema = z.object({
  /** YYYY-MM-DD, local to the machine that recorded it. */
  date: z.string(),
  counts: ImpactCountsSchema,
});
export type ImpactDay = z.infer<typeof ImpactDaySchema>;

/** Bests worth beating. Gamification, entirely local. */
export const ImpactRecordsSchema = z.object({
  /** Longest single session, in ms. */
  longestRunMs: z.number().int().nonnegative(),
  /** Most verdicts in one day. */
  bestVerdictDay: z.number().int().nonnegative(),
  /** Most defects caught in one day. */
  bestDefectDay: z.number().int().nonnegative(),
  /** Consecutive days with at least one verdict, up to and including today. */
  streakDays: z.number().int().nonnegative(),
  /** Longest such streak ever. */
  bestStreakDays: z.number().int().nonnegative(),
});
export type ImpactRecords = z.infer<typeof ImpactRecordsSchema>;

/**
 * A saving, with the comparison that produced it.
 *
 * `basis` names what the number is measured AGAINST, in the user's own words, and it is rendered
 * next to the figure. No basis, no number.
 */
export const ImpactEstimateSchema = z.object({
  value: z.number().nonnegative(),
  basis: z.string(),
});
export type ImpactEstimate = z.infer<typeof ImpactEstimateSchema>;

export const ImpactSavingsSchema = z.object({
  /** Tokens not spent, vs looking at the app the way an agent without Reticle has to. */
  tokens: ImpactEstimateSchema,
  /** Minutes not spent, vs the re-prompt cycle a false green costs. */
  minutes: ImpactEstimateSchema,
});
export type ImpactSavings = z.infer<typeof ImpactSavingsSchema>;

/**
 * How many recent defects a scope remembers.
 *
 * Small on purpose. `counts.failed` already says HOW MANY defects there have been; this list exists
 * so the HUD can say WHICH ONES, and a panel in the corner of somebody's app is not a triage queue.
 * Ten is enough to recognise what is currently broken and short enough that the record stays a
 * counters file rather than becoming a log.
 */
export const IMPACT_DEFECT_LIMIT = 10;

/**
 * One defect, as the HUD shows it.
 *
 * Recorded at the moment a verdict comes back verified:"no" - so it is a thing that actually failed
 * a declared consequence, never a heuristic read of the page afterwards.
 */
export const ImpactDefectSchema = z.object({
  /** When it was caught (epoch ms). */
  at: z.number().int().nonnegative(),
  /** One line naming what failed, in the words the verdict used. */
  title: z.string(),
  /** Why it failed, when the verdict said. */
  detail: z.string().optional(),
  /** `file:line` of the element that was acted on, so the reader can go straight there. */
  source: z.string().optional(),
});
export type ImpactDefect = z.infer<typeof ImpactDefectSchema>;

/** One scope of the record: this project, or everything on this machine. */
export const ImpactScopeSchema = z.object({
  counts: ImpactCountsSchema,
  days: z.array(ImpactDaySchema),
  records: ImpactRecordsSchema,
  savings: ImpactSavingsSchema,
  /** When this scope first recorded anything (epoch ms). */
  since: z.number().int().nonnegative(),
  /**
   * The most recent defects, newest first. Defaulted rather than required: a record written by an
   * older build has no such field, and a counters file that fails to parse loses the whole history.
   */
  defects: z.array(ImpactDefectSchema).default([]),
});
export type ImpactScope = z.infer<typeof ImpactScopeSchema>;

/** What the HUD receives: this project, and the machine-wide total. */
export const ImpactSnapshotSchema = z.object({
  schemaVersion: z.number().int().positive(),
  project: ImpactScopeSchema,
  global: ImpactScopeSchema,
  /** Project name, for the report's title row. */
  projectName: z.string().optional(),
  /**
   * Where the full, triageable list of these defects lives - present only when this project is
   * linked to a Reticle Cloud workspace. Absent is the normal case and the HUD simply shows its
   * short list without a link: the free tool is complete on its own.
   */
  dashboardUrl: z.string().optional(),
});
export type ImpactSnapshot = z.infer<typeof ImpactSnapshotSchema>;

/** Empty counters - the starting point for a fresh store and the identity for merges. */
export function emptyImpactCounts(): ImpactCounts {
  return {
    calls: 0,
    verdicts: 0,
    passed: 0,
    failed: 0,
    unknown: 0,
    refusals: 0,
    marks: 0,
    sessions: 0,
    tokensReturned: 0,
    drivingMs: 0,
  };
}

export function emptyImpactRecords(): ImpactRecords {
  return {
    longestRunMs: 0,
    bestVerdictDay: 0,
    bestDefectDay: 0,
    streakDays: 0,
    bestStreakDays: 0,
  };
}

/** Add one delta into a running total. Pure; the store owns persistence. */
export function addImpactCounts(base: ImpactCounts, delta: Partial<ImpactCounts>): ImpactCounts {
  const out = { ...base };
  for (const key of Object.keys(out) as (keyof ImpactCounts)[]) {
    out[key] = out[key] + (delta[key] ?? 0);
  }
  return out;
}
