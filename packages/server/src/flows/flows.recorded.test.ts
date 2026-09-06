import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActionType,
  AnchorKind,
  EventType,
  FLOW_FILE_VERSION,
  FlowErrorCode,
  RecordedSaveError,
  type CommandResult,
  type FlowFile,
  type ReticleEvent,
} from '@reticlehq/core';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';
import { FlowStore } from './flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from './annotation-store.js';
import { FLOW_TOOLS } from './flow-tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { RecordingStore } from './recordings.js';
import type { Session, SessionManager } from '../session/session.js';
import type { ToolDeps } from '../tools/tools.js';

const FROZEN = 1234;
const clock = { now: (): number => FROZEN };

function flowFile(name: string, steps: FlowFile['steps']): FlowFile {
  return { version: FLOW_FILE_VERSION, name, createdAt: FROZEN, steps };
}

function clickStep(testid: string): FlowFile['steps'][number] {
  return {
    tool: ReticleTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value: testid },
    action: ActionType.CLICK,
    args: {},
  };
}

function recordedEvent(name: string, flow: FlowFile): ReticleEvent {
  return { t: 1, type: EventType.FLOW_RECORDED, sessionId: 's', data: { name, flow } };
}

describe('FlowStore.saveFlow — temp-dir fs', () => {
  let root: string;
  let fs: FileSystemPort;
  let store: FlowStore;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-recorded-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
    store = new FlowStore(fs, root, clock);
  });

  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  it('saveFlow writes a valid FlowFile and round-trips via load', async () => {
    const flow = flowFile('checkout', [clickStep('pay'), clickStep('confirm')]);
    const saved = await store.saveFlow(flow);
    // toMatchObject, not toEqual: a save with no declared intent now also carries the `intentGap`
    // nudge, and these specs are about the summary's counts.
    expect(saved).toMatchObject({
      ok: true,
      value: { name: 'checkout', stepCount: 2, degraded: 0, empty: false },
    });
    const loaded = await store.load('checkout');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('expected ok');
    expect(loaded.value.steps).toHaveLength(2);
    expect(loaded.value.steps[0]?.anchor).toEqual({ kind: AnchorKind.TESTID, value: 'pay' });
  });

  it('saveFlow rejects an unsafe name (no file written)', async () => {
    const flow = flowFile('../escape', [clickStep('pay')]);
    const saved = await store.saveFlow(flow);
    expect(saved).toEqual({ ok: false, code: FlowErrorCode.INVALID_NAME });
    expect(await store.list()).toEqual([]);
  });

  it('saveFlow of a flow with an unrecognized expect key is rejected, naming the key', async () => {
    // `allOf` is a SUPPORTED spelling — a saved step may carry the same grammar act_and_wait
    // writes — so the unrecognized key here is a typo of a real one, which is the case that used to
    // be stripped in silence and replay green having proven nothing.
    const malformed = {
      version: FLOW_FILE_VERSION,
      name: 'checkout',
      createdAt: FROZEN,
      steps: [{ ...clickStep('pay'), expect: { signal: 'x', signl: 'typo' } }],
    };
    const saved = await store.saveFlow(malformed as FlowFile);
    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.code).toBe(FlowErrorCode.PARSE_FAILED);
    expect(saved.detail ?? '').toContain('signl');
    expect(await store.list()).toEqual([]);
  });

  it('saveFlow of an empty-steps flow → empty:true, still written', async () => {
    const flow = flowFile('empty', []);
    const saved = await store.saveFlow(flow);
    // toMatchObject, not toEqual: a save with no declared intent now also carries the `intentGap`
    // nudge, and these specs are about the summary's counts.
    expect(saved).toMatchObject({
      ok: true,
      value: { name: 'empty', stepCount: 0, degraded: 0, empty: true },
    });
    expect(await store.list()).toEqual(['empty']);
  });
});

// ---- reticle_flow_save_recorded handler ----

function fakeDeps(store: FlowStore, events: ReticleEvent[], projectId?: string): ToolDeps {
  const command = (): Promise<CommandResult> =>
    Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
  const session: Partial<Session> = { id: 'demo', projectId, command, eventsSince: () => events };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: store,
    project: new ProjectStore(createNodeFileSystem(), '/virtual/.reticle', { now: () => FROZEN }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    reticleRoot: '/virtual/.reticle',
    now: () => FROZEN,
  };
}

function recordedTool() {
  const t = FLOW_TOOLS.find((x) => x.name === ReticleTool.FLOW_SAVE_RECORDED);
  if (t === undefined) throw new Error('no reticle_flow_save_recorded tool');
  return t;
}

describe('reticle_flow_save_recorded handler', () => {
  let root: string;
  let store: FlowStore;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-recorded-tool-'));
    root = join(dir, '.reticle');
    store = new FlowStore(createNodeFileSystem(), root, clock);
  });

  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  it('reads the LAST FLOW_RECORDED event and persists it', async () => {
    const first = recordedEvent('first', flowFile('first', [clickStep('a')]));
    const last = recordedEvent('second', flowFile('second', [clickStep('b'), clickStep('c')]));
    const deps = fakeDeps(store, [first, last]);
    const res = (await recordedTool().handler(deps, {})) as { name: string; stepCount: number };
    expect(res.name).toBe('second');
    expect(res.stepCount).toBe(2);
    expect(await store.list()).toEqual(['second']);
  });

  it("stamps the saved flow with the session's projectId (scopes it to this app)", async () => {
    const ev = recordedEvent('scoped', flowFile('scoped', [clickStep('a')]));
    const deps = fakeDeps(store, [ev], 'demo-app-abc123');
    await recordedTool().handler(deps, {});
    const loaded = await store.load('scoped', 'demo-app-abc123');
    expect(loaded.ok && loaded.value.projectId).toBe('demo-app-abc123');
  });

  it('leaves projectId unset when the session has none (legacy/global back-compat)', async () => {
    const ev = recordedEvent('global', flowFile('global', [clickStep('a')]));
    await recordedTool().handler(fakeDeps(store, [ev]), {});
    const loaded = await store.load('global');
    expect(loaded.ok && loaded.value.projectId).toBeUndefined();
  });

  it('no FLOW_RECORDED in the buffer → { code: NO_RECORDED_FLOW }, nothing written', async () => {
    const deps = fakeDeps(store, []);
    const res = (await recordedTool().handler(deps, {})) as { code: string };
    expect(res.code).toBe(RecordedSaveError.NO_RECORDED_FLOW);
    expect(await store.list()).toEqual([]);
  });

  it('malformed FLOW_RECORDED data → NO_RECORDED_FLOW (never throws)', async () => {
    const bad: ReticleEvent = {
      t: 1,
      type: EventType.FLOW_RECORDED,
      sessionId: 's',
      data: { name: 'x', flow: { not: 'a flow' } },
    };
    const deps = fakeDeps(store, [bad]);
    const res = (await recordedTool().handler(deps, {})) as { code: string };
    expect(res.code).toBe(RecordedSaveError.NO_RECORDED_FLOW);
    expect(await store.list()).toEqual([]);
  });

  it('name arg overrides the recorded flow name', async () => {
    const ev = recordedEvent('original', flowFile('original', [clickStep('a')]));
    const deps = fakeDeps(store, [ev]);
    const res = (await recordedTool().handler(deps, { flowName: 'renamed' })) as {
      name: string;
    };
    expect(res.name).toBe('renamed');
    expect(await store.list()).toEqual(['renamed']);
  });
});
