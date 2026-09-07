/**
 * What a verification run is DOING, while it is still doing it.
 *
 * ## Why this crosses a boundary at all
 *
 * A verification takes tens of seconds to minutes: a browser launches, flows replay one at a time
 * against a live app, and the artifact only exists at the end. Everything watching from outside —
 * a dashboard, a CI log, an editor — sees nothing until it finishes, so a run that is working and a
 * run that has died look identical for the whole of its duration. Somebody watching a hosted
 * dashboard sat on that ambiguity for fifteen minutes.
 *
 * These events are the narration. They are DERIVED from work that is already happening, never a
 * second source of truth: the run artifact remains the only record of what was proved, and nothing
 * here is ever graded, stored as evidence, or allowed to influence a verdict.
 *
 * ## The rules that keep it honest
 *
 *   - **A reporter must never fail a run.** Emitting is best-effort at every layer; a listener that
 *     throws, or a network that is down, changes nothing about the verification or its exit code.
 *   - **Progress is not proof.** `flow_finished` carries `ok` so a watcher can colour a row, and
 *     that is a convenience for a human reading a list — the verdict is computed from the artifact,
 *     which is graded, and never from this.
 *   - **`total` is known before the loop starts**, because "step 3" without "of 12" tells a reader
 *     nothing about whether to keep waiting, which is the entire question they are asking.
 */
import { z } from 'zod';

/** The phases a run passes through, in the order they occur. */
export const VerifyPhase = {
  /** Opening the bridge connection. Fast, and the first thing that can fail. */
  CONNECTING: 'connecting',
  /** Connected, waiting for the app to attach a session. This is where a dead dev server shows up. */
  WAITING_FOR_APP: 'waiting_for_app',
  /** The suite is known. Carries `total`, which is what makes every later step legible. */
  FLOWS_FOUND: 'flows_found',
  /** One flow is replaying now. Carries its name and index. */
  FLOW_STARTED: 'flow_started',
  /** That flow is done. Carries `ok` — a convenience for a watcher, never a verdict. */
  FLOW_FINISHED: 'flow_finished',
  /** Every flow has run; the artifact is being assembled and graded. */
  GRADING: 'grading',
  /** The run reached the dashboard. The last thing anybody watching is waiting for. */
  PUSHED: 'pushed',
} as const;
export type VerifyPhase = (typeof VerifyPhase)[keyof typeof VerifyPhase];

/**
 * A flow name is user-supplied and unbounded, and this string is rendered in somebody's dashboard.
 * Bounded here rather than at the reader, so no consumer has to remember to truncate it.
 */
export const VERIFY_PROGRESS_NAME_MAX = 120;

/** How many events a receiver keeps for one run. A walk nobody can scroll is not more honest. */
export const VERIFY_PROGRESS_MAX_EVENTS = 200;

export const verifyProgressEventSchema = z.object({
  phase: z.enum([
    VerifyPhase.CONNECTING,
    VerifyPhase.WAITING_FOR_APP,
    VerifyPhase.FLOWS_FOUND,
    VerifyPhase.FLOW_STARTED,
    VerifyPhase.FLOW_FINISHED,
    VerifyPhase.GRADING,
    VerifyPhase.PUSHED,
  ]),
  /** 0-based position in the suite. Absent on phases that are not about one flow. */
  index: z.number().int().nonnegative().optional(),
  /** How many flows the run will replay. Present from `flows_found` onwards. */
  total: z.number().int().nonnegative().optional(),
  /** The flow being replayed. Absent on phases that are not about one flow. */
  name: z.string().max(VERIFY_PROGRESS_NAME_MAX).optional(),
  /** Did that flow replay cleanly? A convenience for rendering, never a verdict. */
  ok: z.boolean().optional(),
  /** When the emitter saw it, from the injected clock — never `Date.now()` in logic. */
  at: z.number().int().nonnegative(),
});
export type VerifyProgressEvent = z.infer<typeof verifyProgressEventSchema>;

/** The batch shape a run posts. Batched because one request per flow is a request per flow. */
export const verifyProgressBatchSchema = z.object({
  runId: z.string().min(1).max(200),
  events: z.array(verifyProgressEventSchema).max(VERIFY_PROGRESS_MAX_EVENTS),
});
export type VerifyProgressBatch = z.infer<typeof verifyProgressBatchSchema>;

/** Truncate a user-supplied flow name to the wire bound, so a caller cannot overflow the schema. */
export const boundFlowName = (name: string): string =>
  name.length <= VERIFY_PROGRESS_NAME_MAX ? name : name.slice(0, VERIFY_PROGRESS_NAME_MAX);
