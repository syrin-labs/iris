/**
 * ReticleRunner — the programmatic Replay/Verify API a host platform (OEM/design partner) or CI drives
 * from its own pipeline, with no MCP stdio and no human. It reuses the existing flow-replay machinery
 * and the verification-run assembler, returning a stable ReticleVerificationRun.
 *
 * Everything it needs from the live world is injected through RunnerPort, so the core orchestration is
 * fully testable without a CDP browser. The live adapter (wrapping ToolDeps: replayNamedFlow,
 * flows.list, the drive/CDP preview boot) and the token-guarded HTTP endpoint are thin layers built on
 * top of this — the orchestration and the verdict live here so the MCP path and the API produce the
 * same artifact byte-for-byte.
 */

import { reportRunTelemetry } from '../telemetry/run-telemetry.js';
import {
  boundFlowName,
  RunFlowStatus,
  VerifyPhase,
  type FlowReplayResult,
  type ReticleVerificationRun,
  type RunId,
  type VerifyProgressEvent,
} from '@reticlehq/core';
import { buildVerificationRun, type VerificationRunInput } from './build-verification-run.js';
import { mapReplayToFlowResult } from './replay-mapping.js';
import { buildRepairPackets } from './repair-prompt.js';
import {
  buildRisks,
  classifyChangedFiles,
  type ChangedFileInput,
  type RiskPolicy,
} from './risk-classify.js';

/** The live capabilities ReticleRunner needs. Injected so tests pass fakes (no CDP, no session). */
export interface RunnerPort {
  /** Saved flow names to verify when the caller doesn't pass an explicit subset. */
  listFlows(): Promise<string[]>;
  /** Replay one saved flow against the live/preview app, returning the existing replay contract. */
  replayFlow(name: string): Promise<FlowReplayResult>;
  /** Injected clock — the single time source (no Date.now in logic, rule 7). */
  now(): number;
  /** Injected run-id generator (no Math.random in logic) — the live adapter supplies a branded uuid. */
  newRunId(): RunId;
}

/**
 * Narration for a run in flight. Optional, and never load-bearing.
 *
 * A verification is silent for its whole duration, so anything watching from outside cannot tell a
 * run that is working from one that has died. This is the seam that makes the difference visible.
 * It reports what is HAPPENING; the artifact remains the only record of what was PROVED.
 */
export type VerifyProgressListener = (event: VerifyProgressEvent) => void;

/** Run metadata the caller supplies; flows + verdict are produced by verify. */
export interface VerifyOptions {
  names?: string[];
  project: VerificationRunInput['project'];
  agent: VerificationRunInput['agent'];
  trigger: VerificationRunInput['trigger'];
  profile: VerificationRunInput['profile'];
  /** The change set under test — classified into risk surfaces (auth/payment/db/…). */
  changedFiles?: ChangedFileInput[];
  /** Which touched surfaces block the verdict (require human confirmation). */
  policy?: RiskPolicy;
  /**
   * Called as each flow starts and finishes. Best-effort by contract: a listener that throws is
   * swallowed, because a REPORTER must never be able to fail the thing it is reporting on.
   */
  onProgress?: VerifyProgressListener;
}

export class ReticleRunner {
  readonly #port: RunnerPort;

  constructor(port: RunnerPort) {
    this.#port = port;
  }

  /**
   * Replay the named flows (or every saved flow), map each outcome into the artifact, and assemble a
   * verdict. Sequential by design — flows share the one live app and parallel replay would race the
   * DOM (the same reason reticle_flow_verify is sequential).
   */
  async verify(opts: VerifyOptions): Promise<ReticleVerificationRun> {
    const names = opts.names ?? (await this.#port.listFlows());
    /*
     * Emitting NEVER throws into the run. A dashboard, a log or an editor is watching, and none of
     * them is worth failing a verification for — so a listener that blows up is dropped here rather
     * than unwinding a suite somebody is waiting on.
     */
    const emit = (event: VerifyProgressEvent): void => {
      try {
        opts.onProgress?.(event);
      } catch {
        /* a reporter cannot fail the thing it reports on */
      }
    };
    const total = names.length;
    // Announced BEFORE the loop: "step 3" without "of 12" does not answer the only question a
    // person watching is actually asking, which is whether to keep waiting.
    emit({ phase: VerifyPhase.FLOWS_FOUND, total, at: this.#port.now() });

    const replays = [];
    const flows = [];
    for (const [index, name] of names.entries()) {
      const start = this.#port.now();
      emit({
        phase: VerifyPhase.FLOW_STARTED,
        index,
        total,
        name: boundFlowName(name),
        at: start,
      });
      const replay = await this.#port.replayFlow(name);
      replays.push(replay);
      const mapped = mapReplayToFlowResult(replay, this.#port.now() - start);
      flows.push(mapped);
      emit({
        phase: VerifyPhase.FLOW_FINISHED,
        index,
        total,
        name: boundFlowName(name),
        // A convenience for colouring a row while the run is live. The VERDICT is computed from the
        // graded artifact below and never from this.
        ok: mapped.status === RunFlowStatus.PASS,
        at: this.#port.now(),
      });
    }
    emit({ phase: VerifyPhase.GRADING, total, at: this.#port.now() });

    const changedFiles = classifyChangedFiles(opts.changedFiles ?? []);
    const risks = buildRisks(changedFiles, opts.policy);
    const failurePackets = buildRepairPackets(replays);

    const input: VerificationRunInput = {
      runId: this.#port.newRunId(),
      durationMs: flows.reduce((sum, f) => sum + f.durationMs, 0),
      profile: opts.profile,
      project: opts.project,
      agent: opts.agent,
      trigger: opts.trigger,
      changedFiles,
      flows,
      checks: [],
      risks,
      evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
      ...(failurePackets.length > 0 ? { repair: { failurePackets } } : {}),
    };
    const run = buildVerificationRun(input, () => this.#port.now());
    reportRunTelemetry(run);
    return run;
  }
}
