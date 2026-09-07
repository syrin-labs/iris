/**
 * `reticle_act_sequence` must be aimable. Passing sessionId is the documented escape hatch when a
 * stale human tab and a fresh lease are both connected. Ignoring it (or only reading it at the top
 * level while the agent put it on a step, the way `reticle_act` takes it) sends the sequence to the
 * wrong tab, and the miss reads as a stale ref.
 */
import { describe, expect, it } from 'vitest';
import { LastAct } from '../session/last-act.js';
import { SessionState } from '@reticlehq/core';
import type { CommandResult } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import type { Session, SessionManager } from '../session/session.js';
import { sessionIdFromArgs, spentRefFromArgs } from './tools-helpers.js';
import { runTool } from './invoke-tool.js';

const ROOT = '/tmp/reticle-act-sequence-session/.reticle';

function fakeSession(id: string, acts: string[]): Session {
  const command = (name: string): Promise<CommandResult> => {
    if ('act' === name) acts.push(id);
    return Promise.resolve({
      kind: 'command_result',
      id: 'c',
      ok: true,
      result: { dispatched: true, settled: true, settleReason: null },
    });
  };
  const stub: Partial<Session> = {
    id,
    url: `http://localhost:5173/${id}`,
    elapsed: () => 0,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    command,
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
    takeSessionLease: () => undefined,
    ageWarning: () => undefined,
  };
  return stub as Session;
}

function fakeDeps(lease: Session, human: Session, resolveCalls: (string | undefined)[]): ToolDeps {
  const sessions: Partial<SessionManager> = {
    resolve: (id?: string) => {
      resolveCalls.push(id);
      if (id === undefined) return human;
      if (id === lease.id) return lease;
      if (id === human.id) return human;
      throw new Error(`no connected session with id '${id}'`);
    },
    list: () =>
      [lease, human].map((s) => ({ sessionId: s.id, url: s.url })) as ReturnType<
        SessionManager['list']
      >,
  };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(createNodeFileSystem(), ROOT, { now: () => 0 }),
    project: new ProjectStore(createNodeFileSystem(), ROOT, { now: () => 0 }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    reticleRoot: ROOT,
    now: () => 0,
  };
}

function sequenceTool() {
  const found = TOOLS.find((t) => t.name === ReticleTool.ACT_SEQUENCE);
  if (found === undefined) throw new Error('no reticle_act_sequence tool');
  return found;
}

const STEPS = [
  { ref: 'e1', action: 'fill', args: { value: 'a@b.com' } },
  { ref: 'e2', action: 'click' },
];

describe('sessionIdFromArgs', () => {
  it('prefers a top-level sessionId', () => {
    expect(sessionIdFromArgs({ sessionId: 'lease-1', steps: [{ sessionId: 'other' }] })).toBe(
      'lease-1',
    );
  });

  it('lifts a sessionId off the steps when the top level omitted it', () => {
    expect(
      sessionIdFromArgs({ steps: [{ ref: 'e1', action: 'fill', sessionId: 'lease-1' }] }),
    ).toBe('lease-1');
  });

  it('refuses mixed step sessionIds rather than picking one', () => {
    expect(() =>
      sessionIdFromArgs({
        steps: [
          { ref: 'e1', sessionId: 'lease-1' },
          { ref: 'e2', sessionId: 'tab-old' },
        ],
      }),
    ).toThrow(/lease-1/);
  });
});

describe('spentRefFromArgs', () => {
  it('reads the first sequence step when there is no top-level ref', () => {
    expect(spentRefFromArgs({ steps: [{ ref: 'e12', action: 'fill' }] })).toBe('e12');
  });
});

describe('reticle_act_sequence honours sessionId', () => {
  it('drives the named lease, not the auto-selected human tab', async () => {
    const leaseActs: string[] = [];
    const humanActs: string[] = [];
    const resolveCalls: (string | undefined)[] = [];
    const lease = fakeSession('lease-1', leaseActs);
    const human = fakeSession('tab-old', humanActs);
    const result = (await sequenceTool().handler(fakeDeps(lease, human, resolveCalls), {
      sessionId: 'lease-1',
      steps: STEPS,
    })) as { dispatched?: boolean };
    expect(resolveCalls[0]).toBe('lease-1');
    expect(leaseActs).toHaveLength(2);
    expect(humanActs).toHaveLength(0);
    expect(result.dispatched).toBe(true);
  });

  it('lifts sessionId off a step, the shape equivalent to one reticle_act', async () => {
    const leaseActs: string[] = [];
    const humanActs: string[] = [];
    const resolveCalls: (string | undefined)[] = [];
    const lease = fakeSession('lease-1', leaseActs);
    const human = fakeSession('tab-old', humanActs);
    await sequenceTool().handler(fakeDeps(lease, human, resolveCalls), {
      steps: STEPS.map((step) => ({ ...step, sessionId: 'lease-1' })),
    });
    expect(resolveCalls[0]).toBe('lease-1');
    expect(leaseActs).toHaveLength(2);
    expect(humanActs).toHaveLength(0);
  });

  it('names the session, not the ref, when the id does not resolve', async () => {
    const leaseActs: string[] = [];
    const humanActs: string[] = [];
    const resolveCalls: (string | undefined)[] = [];
    const lease = fakeSession('lease-1', leaseActs);
    const human = fakeSession('tab-old', humanActs);
    await expect(
      sequenceTool().handler(fakeDeps(lease, human, resolveCalls), {
        sessionId: 'ghost',
        steps: STEPS,
      }),
    ).rejects.toThrow(/ghost/);
    expect(leaseActs).toHaveLength(0);
    expect(humanActs).toHaveLength(0);
  });

  it('through runTool, a step-level sessionId still aims the call', async () => {
    const leaseActs: string[] = [];
    const humanActs: string[] = [];
    const resolveCalls: (string | undefined)[] = [];
    const lease = fakeSession('lease-1', leaseActs);
    const human = fakeSession('tab-old', humanActs);
    await runTool(sequenceTool(), fakeDeps(lease, human, resolveCalls), {
      steps: STEPS.map((step) => ({ ...step, sessionId: 'lease-1' })),
    });
    expect(resolveCalls[0]).toBe('lease-1');
    expect(leaseActs.length).toBeGreaterThan(0);
    expect(humanActs).toHaveLength(0);
  });
});
