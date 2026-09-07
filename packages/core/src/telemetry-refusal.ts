/**
 * Refusals — why a tool could not do what was asked, and the row that reports one.
 *
 * Split out of telemetry.ts at the 1000-line cap, alongside telemetry-feedback.ts which was split
 * for the same reason. The seam is real: telemetry.ts is the session wire, and this is the refusal
 * vocabulary that `error-recovery.ts` is graded against. `NoSessionReason` lives in its own module
 * again, because it refines exactly one member of the enum below.
 */

import { z } from 'zod';
import { NoSessionReason } from './no-session-reason.js';

/**
 * WHY a tool could not do what was asked.
 *
 * Derived from the refusal paths that actually exist rather than invented: every member below is a
 * bucket over `error-recovery.ts`'s recovery table, which is the single place a thrown message is
 * turned into a next action. That table is the vocabulary; this is its coarse grouping, and a new
 * entry there cannot compile without being classified here.
 *
 * The five that matter belong to four different owners, which is the whole reason for splitting
 * them: `no_session` is the install's second half never happening, `bad_args` is the agent's own
 * call, `not_ready` is the environment, and `no_match` / `unsupported` are the app and our own
 * capability surface. One undifferentiated "the agent stopped" number cannot be acted on by anyone.
 */
export const RefusalReason = {
  /** There was no app to reach: nothing connected, no session by that id, or several with none named. */
  NO_SESSION: 'no_session',
  /** The target did not exist: a stale ref, a missing baseline, an option value the select has not got. */
  NO_MATCH: 'no_match',
  /** Reticle refuses to pretend: a rich-text surface, a disabled field, a destructive control. */
  UNSUPPORTED: 'unsupported',
  /** The call did not match the schema, or named a value our own validators reject. */
  BAD_ARGS: 'bad_args',
  /** Nothing is wrong with the call; the world is not ready — a throttled tab, a timeout, no browser. */
  NOT_READY: 'not_ready',
  /** A refusal this list does not name. A classifier that cannot say "I don't know" lies instead. */
  OTHER: 'other',
} as const;
export type RefusalReason = (typeof RefusalReason)[keyof typeof RefusalReason];

/** One tool call that could not be served. */
export const ToolRefusalSchema = z.object({
  /** Which tool. A name from our own fixed namespace, never app data. */
  tool: z.string().min(1).max(64),
  reason: z.nativeEnum(RefusalReason),
  /**
   * For `no_session` only: WHICH no-session situation, from core's closed `NoSessionReason`.
   *
   * Rides the refusal rather than the profile because this is where the diagnosis is actually
   * COMPUTED - `project_profiled` fires once at daemon start, before any tool call has failed, so
   * it cannot carry a reason that does not exist yet. Absent on every other refusal reason.
   */
  noSessionReason: z.nativeEnum(NoSessionReason).optional(),
  /**
   * TRUE when the call immediately before this one was the SAME tool, also refused.
   *
   * Reported on the RETRY rather than on the first refusal, because the first refusal has to be sent
   * at the moment it happens: deferring it until the next call is known would lose it entirely for
   * the agent that gives up, and that agent is the whole population this event exists to describe.
   * So count `retried: true` for retries; the ratio against all refusals is whether our diagnosis
   * gets anybody unstuck.
   */
  retried: z.boolean(),
});
export type ToolRefusal = z.infer<typeof ToolRefusalSchema>;
