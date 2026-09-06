import { describe, expect, it } from 'vitest';
import { UNSCRIPTABLE_TAB_RECOMMENDATION } from '@reticlehq/core';
import type { CommandResult } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import type { Session, SessionInfo, SessionManager } from './session.js';
import { createFakeSession } from './fake-session.js';

const SESSION_URL = 'http://localhost:5173/app';

/** A minimal fake Session whose health/throttled are configurable per test. */
function fakeSession(throttled: boolean): Session {
  const command = (): Promise<CommandResult> =>
    Promise.resolve({
      kind: 'command_result',
      id: 'c',
      ok: true,
      result: { dispatched: true, settled: true },
    });
  const health = throttled
    ? {
        lastSeenMs: 0,
        throttled: true,
        focused: false,
        recommendation: UNSCRIPTABLE_TAB_RECOMMENDATION,
      }
    : { lastSeenMs: 0, throttled: false, focused: true };
  const stub = createFakeSession(
    {
      elapsed: () => 0,
      command,
      health: () => health,
      bufferHealth: () => ({ total: 0, dropped: 0 }),
      throttled: () => throttled,
    },
    { url: SESSION_URL },
  );
  return stub;
}

function fakeDeps(throttled: boolean, listRows: SessionInfo[]): ToolDeps {
  const session = fakeSession(throttled);
  const sessions: Partial<SessionManager> = {
    resolve: () => session,
    list: () => listRows,
  };
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
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

interface HealthBlock {
  session?: { recommendation?: string };
}

const healthyRow: SessionInfo = {
  sessionId: 'h',
  url: SESSION_URL,
  title: 'Healthy',
  adapters: [],
  hasCapabilities: false,
  lastSeenMs: 0,
  hidden: false,
  focused: true,
  throttled: false,
};

const throttledRow: SessionInfo = {
  sessionId: 't',
  url: SESSION_URL,
  title: 'Throttled',
  adapters: [],
  hasCapabilities: false,
  lastSeenMs: 99_999,
  hidden: true,
  focused: false,
  throttled: true,
  recommendation: UNSCRIPTABLE_TAB_RECOMMENDATION,
};

describe('tool results carry the recommendation', () => {
  it('act result surfaces the recommendation for a throttled tab', async () => {
    const res = (await tool(ReticleTool.ACT).handler(fakeDeps(true, []), {
      ref: 'e1',
      action: 'click',
    })) as HealthBlock;
    expect(res.session?.recommendation).toBe(UNSCRIPTABLE_TAB_RECOMMENDATION);
    expect(res.session?.recommendation).toContain('reticle drive');
  });

  it('act result has no recommendation for a healthy tab', async () => {
    const res = (await tool(ReticleTool.ACT).handler(fakeDeps(false, []), {
      ref: 'e1',
      action: 'click',
    })) as HealthBlock;
    // Nominal session → the whole health block is omitted (healthy conveys nothing actionable).
    expect(res.session).toBeUndefined();
  });

  it('assert result surfaces the recommendation', async () => {
    const res = (await tool(ReticleTool.ASSERT).handler(fakeDeps(true, []), {
      predicate: { kind: 'console', level: 'error', absent: true },
    })) as HealthBlock;
    expect(res.session?.recommendation).toBe(UNSCRIPTABLE_TAB_RECOMMENDATION);
  });

  it('sessions list carries per-row recommendation for an un-scriptable tab', async () => {
    const res = (await tool(ReticleTool.SESSIONS).handler(fakeDeps(false, [throttledRow]), {})) as {
      sessions: SessionInfo[];
    };
    expect(res.sessions[0]?.recommendation).toBe(UNSCRIPTABLE_TAB_RECOMMENDATION);
  });

  it('sessions list omits recommendation for healthy rows', async () => {
    const res = (await tool(ReticleTool.SESSIONS).handler(fakeDeps(false, [healthyRow]), {})) as {
      sessions: SessionInfo[];
    };
    const row = res.sessions[0];
    expect(row !== undefined && 'recommendation' in row).toBe(false);
  });

  // status-honesty audit: every page-driving/observing tool carries session health.

  it('act_sequence result surfaces the recommendation for a throttled tab', async () => {
    const res = (await tool(ReticleTool.ACT_SEQUENCE).handler(fakeDeps(true, []), {
      steps: [{ ref: 'e1', action: 'click' }],
    })) as HealthBlock;
    expect(res.session?.recommendation).toBe(UNSCRIPTABLE_TAB_RECOMMENDATION);
  });

  it('observe result surfaces the recommendation for a throttled tab', async () => {
    const res = (await tool(ReticleTool.OBSERVE).handler(fakeDeps(true, []), {})) as HealthBlock;
    expect(res.session?.recommendation).toBe(UNSCRIPTABLE_TAB_RECOMMENDATION);
  });

  it('wait_for result surfaces the recommendation for a throttled tab', async () => {
    const res = (await tool(ReticleTool.WAIT_FOR).handler(fakeDeps(true, []), {
      predicate: { kind: 'console', level: 'error', absent: true },
      timeout_ms: 0,
    })) as HealthBlock;
    expect(res.session?.recommendation).toBe(UNSCRIPTABLE_TAB_RECOMMENDATION);
  });
});
