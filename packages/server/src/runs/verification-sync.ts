/**
 * Turn an MCP verification (a `reticle_flow_verify` suite run) into a first-class ReticleVerificationRun:
 * assemble the artifact from the already-computed replays, persist it to .reticle/runs/ (so
 * `reticle_run_export` and CI can read it), and — when logged in (cloud creds set) — best-effort push it
 * to the cloud's `POST /v1/runs` so the team's dashboard Runs tab shows what the agent just verified.
 *
 * This is the artifact tier that maps to the dashboard's "Runs" (the OEM/CI-consumable verdict); the
 * lighter per-flow RunRecord that feeds regression memory is synced separately in flow-replay-run.ts.
 * Both are best-effort + opt-in: no creds → the artifact still lands on disk, nothing leaves the machine.
 */
import { mcpClientIdentity } from '../mcp/client-identity.js';
import {
  RunAgentKind,
  RunFramework,
  RunProfile,
  RunTrigger,
  type FlowReplayResult,
  type ReticleVerificationRun,
} from '@reticlehq/core';
import { homedir } from 'node:os';
import { buildVerificationRun, type VerificationRunInput } from './build-verification-run.js';
import { mapReplayToFlowResult } from './replay-mapping.js';
import { defaultRunId } from './runner-port.js';
import { RunStore } from './run-store.js';
import { cloudFetch, syncRunToCloud, SyncOutcome } from '../cloud/cloud-sync.js';
import { resolveProjectCloud } from '../cloud/cloud-config.js';
import { log } from '../log.js';
import type { ToolDeps } from '../tools/tools.js';

/** A replay plus the wall-clock time it took — the shape the verify handler already collects. */
/** The author of record when no MCP peer introduced itself — a CLI run, or a client that skipped the handshake. */
const RETICLE_MCP_AGENT_ID = 'reticle-mcp';

export interface TimedReplay {
  replay: FlowReplayResult;
  durationMs: number;
}

/** Assemble the ReticleVerificationRun artifact for a verify suite (pure — no IO). */
function assembleRun(
  deps: ToolDeps,
  timed: TimedReplay[],
  projectId: string | undefined,
): ReticleVerificationRun {
  const flows = timed.map((t) => mapReplayToFlowResult(t.replay, t.durationMs));
  const input: VerificationRunInput = {
    runId: defaultRunId(),
    durationMs: flows.reduce((sum, f) => sum + f.durationMs, 0),
    profile: RunProfile.DEV,
    project: { name: projectId ?? 'reticle', framework: RunFramework.OTHER },
    /*
     * WHICH agent drove this, not merely THAT one did.
     *
     * This was hardcoded to 'reticle-mcp', so every run in every workspace claimed the same author.
     * A dashboard built on it could say "an agent verified this" and never "Claude Code verified
     * this, Cursor broke it" — which is the question a team actually has once more than one agent
     * touches the repo. The name is the client's own claim from the MCP handshake; a plain CLI run
     * with no MCP peer keeps the old id, because inventing a vendor there would be worse than
     * admitting we do not know.
     */
    agent: {
      id: mcpClientIdentity().name ?? RETICLE_MCP_AGENT_ID,
      kind: RunAgentKind.CODING_AGENT,
    },
    trigger: { kind: RunTrigger.MANUAL },
    changedFiles: [],
    flows,
    checks: [],
    risks: [],
    evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
  };
  return buildVerificationRun(input, () => deps.now());
}

/**
 * Persist the suite's run artifact and best-effort mirror it to the cloud. Never throws into the verify
 * tool — a disk or network failure is logged and swallowed so the verdict the agent asked for is
 * unaffected. Returns the runId (for logging/tests); undefined if nothing was produced (empty suite).
 */
export async function persistAndSyncVerificationRun(
  deps: ToolDeps,
  timed: TimedReplay[],
  projectId: string | undefined,
): Promise<string | undefined> {
  if (0 === timed.length) return undefined;
  let run: ReticleVerificationRun;
  try {
    run = assembleRun(deps, timed, projectId);
    await new RunStore(deps.fs, deps.reticleRoot).write(run);
  } catch (error) {
    log('verification-run-persist-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  // Per-project cloud: only push when THIS project has cloud attached AND its policy allows runs.
  const cloud = await resolveProjectCloud(deps.fs, deps.reticleRoot, homedir(), process.env);
  if (null === cloud.config || !cloud.policy.runs) return run.runId; // not attached / runs disabled → local only
  const result = await syncRunToCloud(run, cloud.config, cloudFetch);
  if (result.outcome !== SyncOutcome.SYNCED) {
    log('cloud-run-sync-failed', { runId: run.runId, status: result.status, error: result.error });
  }
  // The run is up; its CONTEXT is not. Nudged rather than pushed inline, so the counters and flows
  // ride the ordinary cycle (with its cursor and its overlap guard) instead of growing a second,
  // subtly different upload path here.
  deps.onRunPersisted?.();
  return run.runId;
}
