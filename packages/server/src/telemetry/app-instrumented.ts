/**
 * When an app carrying the SDK first reaches this daemon.
 *
 * This is the step the whole funnel turns on, and the one nothing could measure. Registering the MCP
 * server and instrumenting an app are separate acts, done by different commands, and the data says
 * almost everybody does the first and almost nobody does the second — but proving that required
 * inferring it from a window counter that resets on every flush, and which therefore reported fewer
 * instrumented users than there were users calling tools.
 *
 * Once per daemon run, on the FIRST app connect only. A page that reloads, or an app that opens five
 * tabs, must not read as five instrumented installs — the question is "did this install ever get an
 * app wired", and it has one answer per run.
 *
 * Names, never values: whether `init` had been run and whether an agent was attached — never the
 * project path, the URL, or anything from the page. The stack is deliberately NOT repeated here;
 * `project_profiled` already carries it on the same daemon run, so the two join on sessionId.
 */

import { TelemetryEventKind } from '@reticlehq/core';
import { getTelemetry } from './telemetry.js';

let reported = false;
/** Set at daemon start so the first connect can report how long the install sat un-instrumented. */
let daemonStartedAt: number | undefined;

export function markInstrumentationClock(now: number): void {
  daemonStartedAt = now;
  reported = false;
}

interface InstrumentationFacts {
  /** Whether this project has a projectId stamped — i.e. `init` has run here. */
  initialized: boolean;
  /**
   * Whether an MCP client was attached when the app arrived.
   *
   * Both halves present is the only state in which Reticle can do anything, and it is worth being
   * able to see the two orders apart: an app that connects with no agent attached is a person
   * setting up, while an agent that has been waiting is a session about to do work.
   */
  agentAttached: boolean;
}

/**
 * Report the first instrumented app of this daemon run. Best-effort and idempotent — a metric must
 * never be the reason a session fails to register.
 */
export function reportAppInstrumented(
  facts: InstrumentationFacts,
  now: () => number = () => Date.now(),
): void {
  if (reported) return;
  reported = true;
  try {
    void getTelemetry().emit(TelemetryEventKind.APP_INSTRUMENTED, {
      instrumentation: {
        initialized: facts.initialized,
        agentAttached: facts.agentAttached,
        // How long the daemon ran before an app showed up. Large values are the interesting ones:
        // Reticle was up, the agent had the tools, and nothing was wired for that whole time.
        msToFirstApp: daemonStartedAt === undefined ? 0 : Math.max(0, now() - daemonStartedAt),
      },
    });
  } catch {
    /* never let a metric interfere with a page connecting */
  }
}

/**
 * Has an app connected to this daemon run at all?
 *
 * The same flag `reportAppInstrumented` uses for idempotency, read from outside. The stall check
 * needs exactly this question and must not answer it from a window counter, which resets on every
 * flush and would then report a long-instrumented daemon as freshly stalled.
 */
export function appEverConnected(): boolean {
  return reported;
}

/** Tests only. */
export function resetAppInstrumented(): void {
  reported = false;
  daemonStartedAt = undefined;
}
