import { z } from 'zod';
import { ProjectReadError, RunStatus, type RunRecord } from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { countSchema } from '../tools/numeric-bounds.js';
import { sessionIdShape } from '../tools/tool-kit.js';
import { asNumber, asString } from '../tools/tools-helpers.js';
import {
  cloudFetch,
  fetchProjectRegressionFromCloud,
  resolveCloudConfig,
} from '../cloud/cloud-sync.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';
import { RunStore } from '../runs/run-store.js';
import {
  diffRuns as diffVerificationRuns,
  type RunDiff as VerificationRunDiff,
} from '../runs/run-diff.js';

/** The diff between the two most-recent runs for a name — the "did it behave like last time?" answer. */
interface RunDiff {
  statusChanged: boolean;
  previousStatus: RunStatus;
  currentStatus: RunStatus;
  regressed: boolean;
  consoleErrorsDelta?: number;
  driftStepsDelta?: number;
}

const REGRESSION_STATUSES: ReadonlySet<RunStatus> = new Set([
  RunStatus.FAIL,
  RunStatus.DRIFT,
  RunStatus.ERROR,
]);

function diffRuns(previous: RunRecord, current: RunRecord): RunDiff {
  const consoleErrorsDelta = numericDelta(
    previous.evidence?.consoleErrors,
    current.evidence?.consoleErrors,
  );
  const driftStepsDelta = numericDelta(previous.evidence?.driftSteps, current.evidence?.driftSteps);
  return {
    statusChanged: previous.status !== current.status,
    previousStatus: previous.status,
    currentStatus: current.status,
    // Regressed = current is a non-pass outcome that the previous run was not.
    regressed: REGRESSION_STATUSES.has(current.status) && !REGRESSION_STATUSES.has(previous.status),
    ...(consoleErrorsDelta !== undefined ? { consoleErrorsDelta } : {}),
    ...(driftStepsDelta !== undefined ? { driftStepsDelta } : {}),
  };
}

function numericDelta(before: number | undefined, after: number | undefined): number | undefined {
  if (before === undefined && after === undefined) return undefined;
  return (after ?? 0) - (before ?? 0);
}

/**
 * Pull the team's server-side regression memory when logged in. This is what keeps a context-lost or
 * brand-new agent (whose local project.json may be empty) oriented: the same reticle_project call folds in
 * "what's broken vs before" from the cloud. Absent creds / unreachable → undefined (agent stays local).
 */
async function cloudRegression(deps: ToolDeps, sessionId: string | undefined): Promise<unknown> {
  const config = resolveCloudConfig(process.env);
  if (null === config) return undefined;
  let projectId: string | undefined;
  try {
    projectId = deps.sessions.resolve(sessionId).projectId;
  } catch {
    projectId = undefined;
  }
  const report = await fetchProjectRegressionFromCloud(config, projectId, cloudFetch);
  return report ?? undefined;
}

/** The two most-recent runs for `name`, oldest-first, or undefined if there are fewer than two. */
/** Runs returned when the caller does not ask for a specific count. */
const DEFAULT_RUN_LIMIT = 25;

function lastTwoFor(runs: RunRecord[], name: string): [RunRecord, RunRecord] | undefined {
  const matching = runs.filter((r) => r.name === name);
  const n = matching.length;
  if (n < 2) return undefined;
  const previous = matching[n - 2];
  const current = matching[n - 1];
  if (previous === undefined || current === undefined) return undefined;
  return [previous, current];
}

/**
 * The cross-run memory tools. `reticle_project` reads .reticle/project.json (optionally
 * scoped to a name, with a diff-vs-last summary); `reticle_run_record` explicitly records an outcome
 * (the manual companion to the auto-record on reticle_flow_replay). Both keep the agent's "did this
 * behave like last run?" question answerable without re-deriving it from raw observations.
 */

/**
 * The per-flow diff between the two most-recent verification ARTIFACTS (.reticle/runs), or undefined when
 * fewer than two exist. Never throws — a missing/unreadable artifact must not break reading run history.
 */
async function lastTwoRunArtifacts(deps: ToolDeps): Promise<VerificationRunDiff | undefined> {
  try {
    const pair = await new RunStore(deps.fs, deps.reticleRoot).latestTwo();
    return pair === undefined ? undefined : diffVerificationRuns(pair[0], pair[1]);
  } catch {
    return undefined;
  }
}

export const PROJECT_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.PROJECT,
    description:
      'Read cross-run history from .reticle/project.json — the memory of how past runs behaved. With { name } it also returns the last run for that flow plus a diff-vs-last summary (status change, regressed flag, consoleErrors/driftSteps deltas) so you can answer "did it behave like last time?". `diff` is the lightweight status/console/drift delta vs the previous run of that NAME; `runDiff` is the per-flow duration/status delta between the two most-recent full verification artifacts ("step 3: 412ms -> 987ms (+140%), +2 requests"). When logged in to Reticle, also returns `cloud`: the team\'s server-side regression report (broken/changed flows vs before) — the durable memory a fresh or context-lost agent can rely on even when local history is empty. Returns { runs, learned?, lastRun?, diff?, runDiff?, cloud? } or { error, reason, cloud? }.',
    inputSchema: {
      name: z.string().optional().describe('Filter runs by this name. Omit to return all runs.'),
      limit: countSchema
        .optional()
        .describe(
          'Most-recent N runs to return. Defaults to 25 — the full history is unbounded and grows with every run (measured at ~20KB / ~5,000 tokens on a modest project), which is a large slice of an agent context for data it mostly does not read. `totalRuns` always reports the true count, so a cap is never silent.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      runs: z.array(z.unknown()),
      totalRuns: z
        .number()
        .optional()
        .describe(
          'How many runs exist in total. Compare against runs.length to see if it was capped.',
        ),
      diff: z.unknown().optional(),
      runDiff: z.unknown().optional(),
      cloud: z.unknown().optional(),
    },
    handler: async (deps: ToolDeps, args) => {
      const cloud = await cloudRegression(deps, asString(args['sessionId']));
      const withCloud = <T extends object>(obj: T): T =>
        cloud === undefined ? obj : { ...obj, cloud };
      const read = await deps.project.read();
      if (!read.ok) {
        return withCloud({
          error:
            read.reason === ProjectReadError.MISSING
              ? 'no .reticle/project.json yet — run a flow (reticle_flow_replay) or reticle_run_record first'
              : '.reticle/project.json is malformed — it will self-heal on the next recorded run',
          reason: read.reason,
        });
      }
      const name = asString(args['name']);
      // The most recent N, in the order they happened. The history is append-only and unbounded —
      // measured at ~20KB (~5,000 tokens) across 176 runs on this repo — and an agent asking "how
      // did this behave before" wants the recent past, not every run ever recorded. `totalRuns`
      // travels with it so the cap is never silent, per the repo's no-silent-caps rule.
      //
      // Order is left alone deliberately. Reversing to newest-first was tried and reverted: it read
      // better but broke an existing contract for no reason the bound required, and a caller relying
      // on chronological order would have been silently handed the reverse.
      const cap = asNumber(args['limit']) ?? DEFAULT_RUN_LIMIT;
      const recent = (runs: RunRecord[]): RunRecord[] => runs.slice(-cap);
      if (name === undefined) {
        return withCloud({
          runs: recent(read.file.runs),
          totalRuns: read.file.runs.length,
          learned: read.file.learned,
        });
      }
      const lastRun = await deps.project.lastRun(name);
      const pair = lastTwoFor(read.file.runs, name);
      //: the RICH run diff (per-flow duration deltas past a noise floor, status changes, new/removed
      // flows, verdict change) over the last two verification ARTIFACTS. That lives alongside — not
      // instead of — the lightweight RunRecord diff above: `diff` answers "did this named run behave like
      // last time?" from project.json, while `runDiff` answers "what changed between the last two full
      // verification runs?" from .reticle/runs. Best-effort: no artifacts simply means no runDiff.
      const runDiff = await lastTwoRunArtifacts(deps);
      const forName = read.file.runs.filter((r) => r.name === name);
      return withCloud({
        runs: recent(forName),
        totalRuns: forName.length,
        learned: read.file.learned,
        lastRun,
        ...(pair !== undefined ? { diff: diffRuns(pair[0], pair[1]) } : {}),
        ...(runDiff === undefined ? {} : { runDiff }),
      });
    },
  },
];
