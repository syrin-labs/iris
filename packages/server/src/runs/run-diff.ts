import type { ReticleVerificationRun, RunFlowResult } from '@reticlehq/core';

/** A per-flow change between two runs. Only flows with a meaningful change are reported. */
interface FlowDelta {
  name: string;
  beforeMs: number;
  afterMs: number;
  durationDeltaMs: number;
  durationDeltaPct: number;
  beforeStatus: string;
  afterStatus: string;
  statusChanged: boolean;
  /** Slower past the noise floor, or a status change — worth the agent's attention. */
  regressed: boolean;
}

export interface RunDiff {
  flows: FlowDelta[];
  newFlows: string[];
  removedFlows: string[];
  verdictChange?: { from: string; to: string };
  headline: string;
}

/** Below this percent, a duration change is noise (machine jitter), not a regression. */
const DEFAULT_NOISE_FLOOR_PCT = 10;

function pct(before: number, delta: number): number {
  return before > 0 ? Math.round((delta / before) * 100) : 0;
}

function byName(flows: readonly RunFlowResult[]): Map<string, RunFlowResult> {
  return new Map(flows.map((f) => [f.name, f]));
}

function headlineFor(diff: Omit<RunDiff, 'headline'>): string {
  const parts: string[] = [];
  const regressions = diff.flows.filter((f) => f.regressed);
  if (regressions.length > 0) {
    const worst = regressions[0];
    parts.push(
      `${String(regressions.length)} regression${1 === regressions.length ? '' : 's'} (worst: ${worst?.name ?? ''} ${String(worst?.durationDeltaPct ?? 0)}%)`,
    );
  }
  if (diff.newFlows.length > 0) parts.push(`+${String(diff.newFlows.length)} flow`);
  if (diff.removedFlows.length > 0) parts.push(`-${String(diff.removedFlows.length)} flow`);
  if (diff.verdictChange !== undefined) {
    parts.push(`verdict ${diff.verdictChange.from}→${diff.verdictChange.to}`);
  }
  return 0 === parts.length ? 'no significant change between runs' : parts.join(', ');
}

/**
 * Compare two verification runs — the concrete answer to "what changed between run A and B". Flow
 * durations are diffed with a noise floor (jitter below it is ignored); status changes and new/removed
 * flows are always surfaced. Deterministic and pure; flows are matched by name. Per-step deltas + net/
 * console diffs land once runs persist per-step detail.
 */
export function diffRuns(
  before: ReticleVerificationRun,
  after: ReticleVerificationRun,
  noiseFloorPct: number = DEFAULT_NOISE_FLOOR_PCT,
): RunDiff {
  const beforeFlows = byName(before.flows);
  const afterFlows = byName(after.flows);
  const flows: FlowDelta[] = [];
  const newFlows: string[] = [];

  for (const [name, af] of afterFlows) {
    const bf = beforeFlows.get(name);
    if (bf === undefined) {
      newFlows.push(name);
      continue;
    }
    const durationDeltaMs = af.durationMs - bf.durationMs;
    const durationDeltaPct = pct(bf.durationMs, durationDeltaMs);
    const statusChanged = bf.status !== af.status;
    if (!statusChanged && Math.abs(durationDeltaPct) < noiseFloorPct) continue; // noise
    flows.push({
      name,
      beforeMs: bf.durationMs,
      afterMs: af.durationMs,
      durationDeltaMs,
      durationDeltaPct,
      beforeStatus: bf.status,
      afterStatus: af.status,
      statusChanged,
      regressed: statusChanged || durationDeltaPct >= noiseFloorPct,
    });
  }

  const removedFlows = [...beforeFlows.keys()].filter((name) => !afterFlows.has(name));
  flows.sort((a, b) => b.durationDeltaPct - a.durationDeltaPct);

  const base: Omit<RunDiff, 'headline'> = {
    flows,
    newFlows,
    removedFlows,
    ...(before.verdict.status === after.verdict.status
      ? {}
      : { verdictChange: { from: before.verdict.status, to: after.verdict.status } }),
  };
  return { ...base, headline: headlineFor(base) };
}
