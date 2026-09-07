/**
 * Telemetry for the verification RUNNER — the path `reticle verify` and the HTTP verify surface take.
 *
 * This path does not go through `runTool`, so for a while it produced nothing at all: no timing, no
 * `verification_completed`, and — worst — no `bug_found`. Which meant every defect Reticle caught in
 * CI was invisible to the one number we intend to publish, on precisely the surface most likely to
 * run at scale and unattended. A metric that is blind to CI is not measuring the product.
 *
 * Reported from the assembled run rather than from inside the replay loop: the run artifact is the
 * finished, already-classified verdict, so this cannot double-count and does not need to understand
 * how a replay works.
 */
import {
  BugAttribution,
  BugSource,
  RunFlowStatus,
  TelemetryActor,
  TelemetryEventKind,
  VerdictStatus,
  type ReticleVerificationRun,
} from '@reticlehq/core';
import { getSessionMetrics } from './session-metrics.js';
import { getTelemetry } from './telemetry.js';

/** The tool name reported for this path, so CI runs are distinguishable from agent-driven ones. */
const VERIFY_SURFACE = 'reticle_verify';

/**
 * Report one completed verification run: the verdict, and one bug per failing flow.
 *
 * Best-effort and wrapped — a verification's exit code must never depend on whether a metric sent.
 */
export function reportRunTelemetry(run: ReticleVerificationRun): void {
  try {
    const failed = run.flows.filter((flow) => flow.status === RunFlowStatus.FAIL);
    const metrics = getSessionMetrics();
    metrics.recordVerification();

    void getTelemetry().emit(TelemetryEventKind.VERIFICATION_COMPLETED, {
      // A `reticle verify` was typed by a person or scheduled by their CI — either way it is not the
      // agent's own loop, which is the distinction `actor` exists to draw.
      actor: TelemetryActor.HUMAN,
      verification: {
        via: VERIFY_SURFACE,
        verified: run.verdict.status === VerdictStatus.PASS ? 'yes' : 'no',
        passed: run.verdict.status === VerdictStatus.PASS,
        // The runner replays saved flows; it does not evaluate a fresh assertion that could pass over
        // a contradiction, so this path cannot produce a false green and must not claim one.
        falseGreenCaught: false,
        durationMs: run.durationMs,
      },
    });

    for (const _flow of failed) {
      // Every failing flow in one run is a separate regression instance, but they share a kind — so
      // only the first is a distinct defect. A 40-flow suite failing wholesale is one regression to
      // fix far more often than it is forty.
      const first = metrics.recordBug('flow-regression');
      void getTelemetry().emit(TelemetryEventKind.BUG_FOUND, {
        actor: TelemetryActor.HUMAN,
        bug: {
          source: BugSource.REPLAY,
          kind: 'flow-regression',
          falseGreen: false,
          tool: VERIFY_SURFACE,
          repeat: !first,
          // A regression SOMEWHERE, and the row does not say where — the app changed, or a selector
          // strategy of ours did. `app` needs positive evidence; see bug-found.ts.
          attribution: BugAttribution.UNCLASSIFIED,
        },
      });
    }
  } catch {
    /* a verdict must never depend on a metric */
  }
}
