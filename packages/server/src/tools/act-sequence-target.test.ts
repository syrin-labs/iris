/**
 * Sequence steps must resolve `target` the same way `reticle_act` does.
 *
 * A step `{ target: { label: "Email" }, action: "fill" }` used to dispatch with no ref. The
 * browser then threw `ref '' no longer resolves to an element`, which reads as a stale-ref
 * problem rather than an unsupported locator — and the caller went looking for a re-render.
 */
import { describe, expect, it } from 'vitest';
import { LastAct } from '../session/last-act.js';
import { SessionState } from '@reticlehq/core';
import type { CommandResult, ReticleEvent } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools.js';
import { asString } from './tools-helpers.js';
import { ReticleTool } from './tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import type { Session, SessionManager } from '../session/session.js';

interface ActCall {
  name: string;
  args: Record<string, unknown>;
}

function sessionThatResolvesTargets(matches: Record<string, { ref: string }[]>): {
  session: Session;
  calls: ActCall[];
} {
  const calls: ActCall[] = [];
  const command = (name: string, args: Record<string, unknown>): Promise<CommandResult> => {
    calls.push({ name, args });
    if ('query' === name) {
      const key = asString(args['value']) ?? '';
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: { elements: matches[key] ?? [] },
      });
    }
    if ('act' === name) {
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: {
          ref: args['ref'],
          action: args['action'],
          dispatched: true,
          settled: true,
          settleReason: null,
        },
      });
    }
    return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
  };
  const noEvents: ReticleEvent[] = [];
  const stub: Partial<Session> = {
    id: 'demo',
    url: 'http://localhost:5173/app',
    elapsed: () => 1000,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    command,
    queryEvents: () => Promise.resolve(noEvents),
    eventsSince: () => noEvents,
    bufferHealth: () => ({ total: 0, dropped: 0 }),
    lostSince: () => false,
    blindSpots: () => ({}),
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
  };
  return { session: stub as Session, calls };
}

function fakeDeps(session: Session): ToolDeps {
  const sessions: Partial<SessionManager> = { resolve: () => session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(createNodeFileSystem(), '/tmp/reticle-test/.reticle', { now: () => 0 }),
    project: new ProjectStore(createNodeFileSystem(), '/tmp/reticle-test/.reticle', {
      now: () => 0,
    }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    reticleRoot: '/tmp/reticle-test/.reticle',
    now: () => 0,
  };
}

function tool(name: string) {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no ${name} tool`);
  return found;
}

interface SequenceResult {
  dispatched: boolean;
  completed: number;
  stalled_at?: number;
  steps?: { ref?: string; action?: string; dispatched?: boolean | null; error?: string }[];
}

describe('act_sequence steps that name a target', () => {
  it('resolves target to a ref before dispatch, instead of sending an empty ref', async () => {
    const { session, calls } = sessionThatResolvesTargets({
      Email: [{ ref: 'e12' }],
    });

    const result = (await tool(ReticleTool.ACT_SEQUENCE).handler(fakeDeps(session), {
      steps: [{ target: { label: 'Email' }, action: 'fill', args: { value: 'a@b.com' } }],
    })) as SequenceResult;

    expect(result.completed).toBe(1);
    expect(result.dispatched).toBe(true);
    const act = calls.find((c) => 'act' === c.name);
    expect(act?.args['ref'], 'must dispatch the resolved ref, not an empty one').toBe('e12');
    expect(act?.args['ref']).not.toBe('');
    expect(act?.args).not.toHaveProperty('target');
  });

  it('does not blame a stale ref when the step used target', async () => {
    const { session, calls } = sessionThatResolvesTargets({
      Email: [{ ref: 'e12' }],
    });

    await tool(ReticleTool.ACT_SEQUENCE).handler(fakeDeps(session), {
      steps: [{ target: { label: 'Email' }, action: 'fill' }],
    });

    const act = calls.find((c) => 'act' === c.name);
    expect(asString(act?.args['ref'])).toBe('e12');
  });

  it('refuses a missed target as a locator miss, not a stale empty ref', async () => {
    const { session, calls } = sessionThatResolvesTargets({});

    const result = (await tool(ReticleTool.ACT_SEQUENCE).handler(fakeDeps(session), {
      steps: [{ target: { label: 'Email' }, action: 'fill' }],
    })) as SequenceResult;

    expect(result.dispatched).toBe(false);
    expect(result.stalled_at).toBe(0);
    expect(result.steps?.[0]?.error).toMatch(/target matched no element/);
    expect(result.steps?.[0]?.error).not.toMatch(/no longer resolves/);
    expect(
      calls.some((c) => 'act' === c.name),
      'must not dispatch against a missing locator',
    ).toBe(false);
  });
});
