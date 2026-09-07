/**
 * A REFUSED act must leave no act state behind.
 *
 * Field-reproduced: reticle_act with a stale ref threw ("ref 'e999999' no longer resolves"), and the
 * next reticle_observe over the SAME quiet window then reported an `action-had-no-effect`
 * contradiction — claiming "the click was dispatched and the page settled" about a click that was
 * never dispatched, and blaming a control that is fine. The act tools marked the cursor and the
 * effect BEFORE resolving the ref, and nothing cleared them on the failure path.
 *
 * The documented recovery for a stale ref is re-query and retry; being told the control is dead in
 * between is worse than noise.
 */
import { describe, expect, it } from 'vitest';
import { LastAct } from '../session/last-act.js';
import { SessionState } from '@reticlehq/core';
import type { CommandResult, ReticleEvent } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import type { Session, SessionManager } from '../session/session.js';

const STALE_REF_ERROR = "ref 'e999999' no longer resolves to an element";
const ACT_HAD_NO_EFFECT = 'action-had-no-effect';

interface Options {
  /** When set, the browser refuses the ACT command with this error. */
  actError?: string;
}

function fakeSession(options: Options): Session {
  const command = (name: string): Promise<CommandResult> => {
    if (('act' === name || 'act_sequence' === name) && options.actError !== undefined) {
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: false,
        error: options.actError,
      });
    }
    return Promise.resolve({
      kind: 'command_result',
      id: 'c',
      ok: true,
      // A dispatched click into a quiet page: the real no-effect case the check exists for.
      result: { dispatched: true, settled: true, effect: { domMutatedWithin: 0 } },
    });
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
  return stub as Session;
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

async function observe(deps: ToolDeps): Promise<{ contradictions?: { kind: string }[] }> {
  return (await tool(ReticleTool.OBSERVE).handler(deps, { since: 0 })) as {
    contradictions?: { kind: string }[];
  };
}

describe('a refused act leaves no act state behind', () => {
  it('reticle_act: a refused act does not make the next observe invent a dead control', async () => {
    const session = fakeSession({ actError: STALE_REF_ERROR });
    const deps = fakeDeps(session);

    await expect(
      tool(ReticleTool.ACT).handler(deps, { ref: 'e999999', action: 'click' }),
    ).rejects.toThrow(STALE_REF_ERROR);

    expect(session.lastAct.cursor()).toBeUndefined();
    expect(session.lastAct.effect()).toEqual({});
    expect((await observe(deps)).contradictions).toBeUndefined();
  });

  it('reticle_act_and_wait: same — a refused act marks nothing', async () => {
    const session = fakeSession({ actError: STALE_REF_ERROR });
    const deps = fakeDeps(session);

    await expect(
      tool(ReticleTool.ACT_AND_WAIT).handler(deps, {
        ref: 'e999999',
        action: 'click',
        timeout_ms: 0,
      }),
    ).rejects.toThrow(STALE_REF_ERROR);

    expect(session.lastAct.cursor()).toBeUndefined();
    expect(session.lastAct.effect()).toEqual({});
    expect((await observe(deps)).contradictions).toBeUndefined();
  });

  it('reticle_act_sequence: same — a refused sequence marks nothing', async () => {
    const session = fakeSession({ actError: 'step failed' });
    const deps = fakeDeps(session);

    const result = (await tool(ReticleTool.ACT_SEQUENCE).handler(deps, {
      steps: [{ ref: 'e999999', action: 'click' }],
    })) as { completed: number; stalled_at?: number };

    expect(result.completed).toBe(0);
    expect(result.stalled_at).toBe(0);
    expect(session.lastAct.cursor()).toBeUndefined();
    expect((await observe(deps)).contradictions).toBeUndefined();
  });
});

describe('a SUCCESSFUL act still marks the cursor and effect', () => {
  it('reticle_act: a dispatched click into a quiet page is still reported as no-effect', async () => {
    const session = fakeSession({});
    const deps = fakeDeps(session);

    await tool(ReticleTool.ACT).handler(deps, { ref: 'e1', action: 'click' });

    expect(session.lastAct.cursor()).toBe(1000);
    // `ref` joins the effect so the verdict nudge can suggest a call about the element that was
    // actually touched, rather than a worked example. Written on the same success path as `action`.
    expect(session.lastAct.effect()).toEqual({ action: 'click', mutatedWithin: 0, ref: 'e1' });
    const kinds = ((await observe(deps)).contradictions ?? []).map((c) => c.kind);
    expect(kinds).toContain(ACT_HAD_NO_EFFECT);
  });

  it('reticle_act_and_wait: reports the no-effect contradiction for its own action', async () => {
    const session = fakeSession({});
    const deps = fakeDeps(session);

    const res = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, {
      ref: 'e1',
      action: 'click',
      timeout_ms: 0,
    })) as { contradictions?: { kind: string }[] };

    expect(session.lastAct.cursor()).toBe(1000);
    expect((res.contradictions ?? []).map((c) => c.kind)).toContain(ACT_HAD_NO_EFFECT);
  });
});
