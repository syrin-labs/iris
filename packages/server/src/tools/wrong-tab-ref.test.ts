/**
 * The end of the reported loop: snapshot one tab, act without a sessionId, get accused of a stale ref.
 *
 * The rule itself is pinned in session/ref-provenance.test.ts. This pins the WIRING, which is where
 * the defect actually lived — the handler only ever learns that a ref missed, and answers that with
 * "the DOM re-rendered". Only the dispatch point knows both the tab the ref came out of and the tab
 * resolution went on to pick.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SessionState } from '@reticlehq/core';
import { ReticleTool } from './tool-names.js';
import { runTool } from './invoke-tool.js';
import { forgetRefProvenance } from '../session/ref-provenance.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import { BaselineStore } from '../project/baselines.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import type { ToolDef, ToolDeps } from './tools.js';
import type { Session, SessionManager } from '../session/session.js';

const ROOT = '/tmp/reticle-wrong-tab-test/.reticle';
const now = (): number => 0;

function session(id: string): Session {
  return {
    id,
    url: `http://localhost:5173/${id}`,
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    takeSessionLease: () => undefined,
    ageWarning: () => undefined,
  } as unknown as Session;
}

/** Two tabs of one project; `resolve` honours an explicit id and otherwise prefers the first. */
function deps(preferred: Session, others: Session[]): ToolDeps {
  const all = [preferred, ...others];
  const sessions: Partial<SessionManager> = {
    resolve: (id?: string) =>
      id === undefined ? preferred : (all.find((s) => s.id === id) ?? preferred),
    list: () =>
      all.map((s) => ({ sessionId: s.id, url: s.url })) as ReturnType<SessionManager['list']>,
  };
  const fs = createNodeFileSystem();
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(fs, ROOT, { now }),
    project: new ProjectStore(fs, ROOT, { now }),
    annotations: new AnnotationStore(),
    fs,
    reticleRoot: ROOT,
    now,
  };
}

const tool = (name: string, returns: unknown): ToolDef => ({
  name,
  description: '',
  inputSchema: {},
  handler: () => Promise.resolve(returns),
});

const tabA = session('sA');
const tabB = session('sB');

beforeEach(forgetRefProvenance);

describe('a ref spent in a tab it was not taken from', () => {
  it('is refused, naming both tabs, instead of being driven or blamed on the DOM', async () => {
    // Exactly the reported sequence: snapshot by id, then act with no sessionId while another tab
    // is the one auto-selection prefers.
    await runTool(tool(ReticleTool.SNAPSHOT, { ok: true }), deps(tabB, [tabA]), {
      sessionId: 'sA',
    });
    const r = (await runTool(tool(ReticleTool.ACT_AND_WAIT, { ok: true }), deps(tabB, [tabA]), {
      ref: 'e120005',
      action: 'click',
    })) as { error?: string };
    expect(r.error).toContain('sA');
    expect(r.error).toContain('sessionId');
    expect(r.error).not.toMatch(/stale/i);
  });

  it('leaves the ordinary drive alone — one tab looked at, the same tab acted on', async () => {
    await runTool(tool(ReticleTool.SNAPSHOT, { ok: true }), deps(tabA, [tabB]), {});
    const r = (await runTool(tool(ReticleTool.ACT_AND_WAIT, { ok: true }), deps(tabA, [tabB]), {
      ref: 'e5',
      action: 'click',
    })) as { error?: string; ok?: boolean };
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  /**
   * Sequence steps carry the refs, not a top-level `ref`. The same loop — snapshot one tab, drive
   * without a sessionId — used to skip the wrong-tab rule entirely and fail as a stale ref on
   * whichever tab auto-selection preferred.
   */
  it('refuses a sequence the same way, even though the refs live on the steps', async () => {
    await runTool(tool(ReticleTool.SNAPSHOT, { ok: true }), deps(tabB, [tabA]), {
      sessionId: 'sA',
    });
    const r = (await runTool(tool(ReticleTool.ACT_SEQUENCE, { ok: true }), deps(tabB, [tabA]), {
      steps: [{ ref: 'e120005', action: 'fill', args: { value: 'a' } }],
    })) as { error?: string };
    expect(r.error).toContain('sA');
    expect(r.error).toContain('sessionId');
    expect(r.error).not.toMatch(/stale/i);
  });

  it('a sequence that names the minting tab is driven, not refused', async () => {
    await runTool(tool(ReticleTool.SNAPSHOT, { ok: true }), deps(tabB, [tabA]), {
      sessionId: 'sA',
    });
    const r = (await runTool(tool(ReticleTool.ACT_SEQUENCE, { ok: true }), deps(tabB, [tabA]), {
      sessionId: 'sA',
      steps: [{ ref: 'e120005', action: 'fill', args: { value: 'a' } }],
    })) as { error?: string; ok?: boolean };
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
  });
});
