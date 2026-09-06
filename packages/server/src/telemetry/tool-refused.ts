/**
 * Reporting the calls Reticle could not serve.
 *
 * The refusal path is the largest thing this product does and the least measured one. It computes a
 * precise diagnosis — which of three no-session situations this is, that a ref went stale, that a
 * predicate did not parse — hands it to the agent as prose, and throws it away. So a user who
 * attaches an agent, hits a wall on the first call and never comes back emits nothing at all, and
 * the whole cohort is visible only as the gap between two other numbers. See issue #172.
 *
 * Emitted from `runTool`, which is the one place both dispatch paths cross, so a tool added later is
 * covered without anybody remembering to cover it.
 */
import {
  RefusalReason,
  TelemetryActor,
  TelemetryEventKind,
  type NoSessionReason,
} from '@reticlehq/core';
import { getTelemetry } from './telemetry.js';

/**
 * Refusal events one daemon run will send.
 *
 * Volume is part of this taxonomy's design — the per-tool-call event was removed for exactly this
 * reason — and a stuck agent retrying one failing call is the shape most likely to produce hundreds.
 * The cap means the bill cannot scale with the pathology while the SHAPE of it still arrives: the
 * first fifty carry the tool, the cause and the retry flag, and `consecutiveRepeats` on the session
 * summary already reports how long the loop ran.
 */
const MAX_REFUSALS_PER_SESSION = 50;

let sent = 0;
/**
 * The tool whose call refused immediately before this one, if the last call refused at all.
 *
 * This is what `retried` is computed from, and it is why the event is sent at the moment of the
 * refusal rather than held back until the next call reveals whether one came. Holding it back would
 * lose the event entirely for an agent that gives up — which is precisely the agent this exists to
 * describe — so the flag lands on the RETRY instead of on the first refusal.
 */
let lastRefusedTool: string | undefined;

/**
 * The no-session branch code for the refusal about to be reported, set by whoever threw it.
 *
 * `no_session` is the largest refusal cohort and on its own it is a set difference: nothing
 * connected, and no word on which of several opposite situations that was. The diagnosis that CAN
 * say is computed where the error is thrown, and the refusal is classified downstream from the
 * message, so the two never met (#615).
 *
 * Module-level and consumed once, like `lastRefusedTool` above and for the same reason: the
 * producer and the consumer are one hop apart on the same call, and threading a field through every
 * refusal path to carry it would touch a dozen call sites that have nothing to do with sessions.
 * Cleared on read so a later refusal cannot inherit a stale reason.
 */
let pendingNoSessionReason: NoSessionReason | undefined;

/** Record the branch code for the no-session error being thrown right now. */
export function notePendingNoSessionReason(reason: NoSessionReason | undefined): void {
  pendingNoSessionReason = reason;
}

/** A call that was served. Breaks the retry chain: what follows it is not a retry of anything. */
export function noteToolServed(): void {
  lastRefusedTool = undefined;
}

/** One refused call, reported with its cause and whether it was itself a retry. */
export function reportToolRefused(tool: string, reason: RefusalReason): void {
  const retried = lastRefusedTool === tool;
  lastRefusedTool = tool;
  // Read and clear whatever the throw left, whether or not this refusal can use it: a reason left
  // sitting would attach itself to an unrelated refusal later in the session.
  const noSessionReason = pendingNoSessionReason;
  pendingNoSessionReason = undefined;
  if (sent >= MAX_REFUSALS_PER_SESSION) return;
  sent += 1;
  void getTelemetry().emit(TelemetryEventKind.TOOL_REFUSED, {
    actor: TelemetryActor.AGENT,
    refusal: {
      tool,
      reason,
      retried,
      // Only where it means something. On any other refusal reason this field would be answering
      // a question nobody asked of it.
      ...(RefusalReason.NO_SESSION === reason && noSessionReason !== undefined
        ? { noSessionReason }
        : {}),
    },
  });
}

/** Tests only — the counters are process-lifetime, so each case has to start from zero. */
export function resetToolRefusals(): void {
  sent = 0;
  lastRefusedTool = undefined;
  pendingNoSessionReason = undefined;
}
