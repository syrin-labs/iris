import { describe, expect, it } from 'vitest';
import {
  asRunId,
  ReplayStatus,
  RiskSurface,
  RunAgentKind,
  RunChangeKind,
  RunFlowStatus,
  RunFramework,
  RunProfile,
  RunTrigger,
  VerdictStatus,
  VerifyPhase,
  type FlowReplayResult,
  type VerifyProgressEvent,
} from '@reticlehq/core';
import { ReticleRunner, type RunnerPort, type VerifyOptions } from './reticle-runner.js';

const replay = (
  name: string,
  status: ReplayStatus,
  extra?: Partial<FlowReplayResult>,
): FlowReplayResult => ({
  name,
  status,
  steps: [],
  ...extra,
});

/** A fake port: a fixed flow→replay map, a monotonic clock, and a counter-based run id. No CDP. */
function fakePort(replays: Record<string, FlowReplayResult>, names: string[]): RunnerPort {
  const map = new Map(Object.entries(replays));
  let t = 1000;
  let n = 0;
  return {
    listFlows: () => Promise.resolve(names),
    replayFlow: (name) => {
      const r = map.get(name);
      return r === undefined
        ? Promise.reject(new Error(`no fake replay for ${name}`))
        : Promise.resolve(r);
    },
    now: () => (t += 1),
    newRunId: () => asRunId(`run-${(n += 1)}`),
  };
}

const opts: Omit<VerifyOptions, 'names'> = {
  project: { name: 'demo', framework: RunFramework.REACT },
  agent: { id: 'pipeline', kind: RunAgentKind.OEM_PIPELINE },
  trigger: { kind: RunTrigger.OEM },
  profile: RunProfile.PROD_PREVIEW,
};

describe('ReticleRunner.verify', () => {
  it('replays the named flows and assembles a PARTIAL verdict when one fails', async () => {
    const port = fakePort(
      {
        login: replay('login', ReplayStatus.OK),
        checkout: replay('checkout', ReplayStatus.ERROR, {
          error: { code: 'e', message: 'POST /api/order 500' },
        }),
      },
      [],
    );
    const run = await new ReticleRunner(port).verify({ ...opts, names: ['login', 'checkout'] });

    expect(run.flows.map((f) => f.status)).toEqual([RunFlowStatus.PASS, RunFlowStatus.FAIL]);
    expect(run.flows[1]?.failureReason).toBe('POST /api/order 500');
    expect(run.verdict.status).toBe(VerdictStatus.PARTIAL);
    expect(run.runId).toBe('run-1');
    expect(run.profile).toBe(RunProfile.PROD_PREVIEW);
    expect(run.repair).toBeUndefined(); // prod-preview redacts dev-only fix instructions
    expect(run.durationMs).toBeGreaterThan(0);
  });

  it('surfaces repair packets for failed flows under the dev profile', async () => {
    const port = fakePort(
      {
        checkout: replay('checkout', ReplayStatus.ERROR, { error: { code: 'e', message: 'boom' } }),
      },
      [],
    );
    const run = await new ReticleRunner(port).verify({
      ...opts,
      profile: RunProfile.DEV,
      names: ['checkout'],
    });
    expect(run.repair?.failurePackets).toHaveLength(1);
    expect(run.repair?.failurePackets[0]?.flow).toBe('checkout');
  });

  it('verifies every saved flow when names are omitted', async () => {
    const port = fakePort({ a: replay('a', ReplayStatus.OK), b: replay('b', ReplayStatus.OK) }, [
      'a',
      'b',
    ]);
    const run = await new ReticleRunner(port).verify(opts);

    expect(run.flows).toHaveLength(2);
    expect(run.verdict.status).toBe(VerdictStatus.PASS);
  });

  it('an empty suite produces a PASS with no flows', async () => {
    const run = await new ReticleRunner(fakePort({}, [])).verify(opts);
    expect(run.flows).toHaveLength(0);
    expect(run.verdict.status).toBe(VerdictStatus.PASS);
  });

  it('a gated risk surface fails the verdict even when every flow passes', async () => {
    const port = fakePort({ checkout: replay('checkout', ReplayStatus.OK) }, []);
    const run = await new ReticleRunner(port).verify({
      ...opts,
      names: ['checkout'],
      changedFiles: [{ path: 'src/checkout/PayButton.tsx', changeKind: RunChangeKind.MODIFIED }],
      policy: { requiresConfirmation: [RiskSurface.PAYMENT] },
    });
    expect(run.flows[0]?.status).toBe(RunFlowStatus.PASS);
    expect(run.risks.some((r) => r.surface === RiskSurface.PAYMENT && r.gated)).toBe(true);
    expect(run.verdict.status).toBe(VerdictStatus.FAIL);
    expect(run.verdict.blockingRisks).toBe(1);
    expect(run.changedFiles[0]?.risk).toContain(RiskSurface.PAYMENT);
  });
});

/**
 * Narration for a run in flight.
 *
 * A verification is silent for its whole duration — the artifact only exists at the end — so from
 * outside, a run that is working and a run that has died look identical. That ambiguity is what left
 * somebody watching a dashboard for fifteen minutes.
 *
 * The property worth protecting is not that events are emitted. It is that they can NEVER affect the
 * run: this is a reporter, and a reporter that can fail the thing it reports on is worse than no
 * reporter at all.
 */
describe('ReticleRunner.verify progress', () => {
  const collect = async (names: string[]): Promise<VerifyProgressEvent[]> => {
    const port = fakePort(
      {
        login: replay('login', ReplayStatus.OK),
        checkout: replay('checkout', ReplayStatus.ERROR, {
          error: { code: 'e', message: 'boom' },
        }),
      },
      names,
    );
    const seen: VerifyProgressEvent[] = [];
    await new ReticleRunner(port).verify({ ...opts, onProgress: (e) => seen.push(e) });
    return seen;
  };

  /* "Step 3" without "of 12" does not answer the question somebody watching is actually asking. */
  it('announces the suite size before replaying anything', async () => {
    const seen = await collect(['login', 'checkout']);
    const first = seen[0];
    expect(first?.phase).toBe(VerifyPhase.FLOWS_FOUND);
    expect(first?.total).toBe(2);
  });

  it('brackets every flow with a start and a finish, in order', async () => {
    const seen = await collect(['login', 'checkout']);
    const flowEvents = seen.filter(
      (e) => e.phase === VerifyPhase.FLOW_STARTED || e.phase === VerifyPhase.FLOW_FINISHED,
    );
    expect(flowEvents.map((e) => [e.phase, e.name])).toEqual([
      [VerifyPhase.FLOW_STARTED, 'login'],
      [VerifyPhase.FLOW_FINISHED, 'login'],
      [VerifyPhase.FLOW_STARTED, 'checkout'],
      [VerifyPhase.FLOW_FINISHED, 'checkout'],
    ]);
  });

  it('numbers each flow against the total, so a watcher can see how far along it is', async () => {
    const seen = await collect(['login', 'checkout']);
    const started = seen.filter((e) => e.phase === VerifyPhase.FLOW_STARTED);
    expect(started.map((e) => [e.index, e.total])).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });

  /* A convenience for colouring a row mid-run. The verdict still comes from the graded artifact. */
  it('says whether each flow replayed cleanly', async () => {
    const seen = await collect(['login', 'checkout']);
    const finished = seen.filter((e) => e.phase === VerifyPhase.FLOW_FINISHED);
    expect(finished.map((e) => [e.name, e.ok])).toEqual([
      ['login', true],
      ['checkout', false],
    ]);
  });

  it('says when the flows are done and the artifact is being graded', async () => {
    const seen = await collect(['login']);
    expect(seen.at(-1)?.phase).toBe(VerifyPhase.GRADING);
  });

  it('stamps every event from the injected clock, never a wall clock', async () => {
    const seen = await collect(['login']);
    expect(seen.every((e) => 'number' === typeof e.at && e.at > 0)).toBe(true);
  });

  /*
   * THE rule. A dashboard, a log or an editor is watching; none of them is worth failing a
   * verification for, and a reporter that can take the run down with it is a liability.
   */
  it('completes the run even when the listener throws on every event', async () => {
    const port = fakePort({ login: replay('login', ReplayStatus.OK) }, ['login']);
    const run = await new ReticleRunner(port).verify({
      ...opts,
      onProgress: () => {
        throw new Error('listener exploded');
      },
    });
    expect(run.verdict.status).toBe(VerdictStatus.PASS);
  });

  it('runs exactly as before when nobody is listening', async () => {
    const port = fakePort({ login: replay('login', ReplayStatus.OK) }, ['login']);
    const run = await new ReticleRunner(port).verify(opts);
    expect(run.verdict.status).toBe(VerdictStatus.PASS);
  });

  it('emits a suite size of zero rather than nothing when there are no flows', async () => {
    const seen = await collect([]);
    expect(seen.map((e) => e.phase)).toEqual([VerifyPhase.FLOWS_FOUND, VerifyPhase.GRADING]);
    expect(seen[0]?.total).toBe(0);
  });
});
