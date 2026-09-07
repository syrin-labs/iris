import { describe, expect, it, vi } from 'vitest';
import { LastAct } from '../session/last-act.js';
import { ActionWarning, InputMode, InputModeReason, SessionState } from '@reticlehq/core';
import type { CommandResult } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import { boxCenter, type ElementBox, type RealInputProvider } from './real-input.js';
import type { Session, SessionManager } from '../session/session.js';
import type { BrowserPool } from '../pool/browser-pool.js';
import { HOVER_NEEDS_POINTER_MSG } from '../tools/real-input-attempt.js';

const SESSION_URL = 'http://localhost:5173/app';
const SOURCE_BOX: ElementBox = { x: 0, y: 0, width: 200, height: 100 };
const TARGET_BOX: ElementBox = { x: 400, y: 200, width: 40, height: 20 };

interface FakeSessionState {
  actCalls: number;
  inspectRefs: string[];
  inspectName?: string;
  /** When set, INSPECT for this ref returns no box (stale ref). */
  staleRef?: string;
  /** When set, INSPECT returns a zero-area box for this ref. */
  zeroAreaRef?: string;
}

function fakeSession(state: FakeSessionState): Session {
  const command = (name: string, args: Record<string, unknown> = {}): Promise<CommandResult> => {
    if ('inspect' === name) {
      const ref = 'string' === typeof args['ref'] ? args['ref'] : '';
      state.inspectRefs.push(ref);
      if (ref === state.staleRef) {
        return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
      }
      if (ref === state.zeroAreaRef) {
        return Promise.resolve({
          kind: 'command_result',
          id: 'c',
          ok: true,
          result: { box: { x: 5, y: 5, width: 0, height: 0 } },
        });
      }
      const box = 'eTarget' === ref ? TARGET_BOX : SOURCE_BOX;
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: { box, ...(state.inspectName === undefined ? {} : { name: state.inspectName }) },
      });
    }
    if ('act' === name) {
      state.actCalls += 1;
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: { dispatched: true, settled: true },
      });
    }
    return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
  };
  const stub: Partial<Session> = {
    id: 'demo',
    url: SESSION_URL,
    elapsed: () => 0,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    command,
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    // Live-control: a clean active session — no pause short-circuit, no piggyback.
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
  };
  return stub as Session;
}

function fakeDeps(provider: RealInputProvider | undefined, state: FakeSessionState): ToolDeps {
  const session = fakeSession(state);
  const sessions: Partial<SessionManager> = { resolve: () => session };
  const deps: ToolDeps = {
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
  if (provider !== undefined) deps.realInput = provider;
  return deps;
}

interface RecordingProvider extends RealInputProvider {
  calls: {
    action: string;
    box: ElementBox;
    center: { cx: number; cy: number };
    toBox?: ElementBox;
  }[];
}

function makeProvider(available: boolean, options: { throws?: boolean } = {}): RecordingProvider {
  const calls: RecordingProvider['calls'] = [];
  return {
    calls,
    isAvailableFor: () => Promise.resolve(available),
    perform: (_url, action, box, args) => {
      if (true === options.throws) return Promise.reject(new Error('cdp gone'));
      const center = boxCenter(box);
      const call: RecordingProvider['calls'][number] = { action, box, center };
      if (args.toBox !== undefined) call.toBox = args.toBox;
      calls.push(call);
      return Promise.resolve({ performed: true, center });
    },
  };
}

function actTool() {
  const tool = TOOLS.find((t) => t.name === ReticleTool.ACT);
  if (tool === undefined) throw new Error('no reticle_act tool');
  return tool;
}

interface ActResult {
  inputMode: string;
  inputModeReason?: string;
  warning?: string;
  result: unknown;
}

async function runAct(deps: ToolDeps, args: Record<string, unknown>): Promise<ActResult> {
  return (await actTool().handler(deps, args)) as ActResult;
}

describe('reticle_act real-input routing', () => {
  it('runs a click on the synthetic path by default even with a provider available', async () => {
    // "Don't click, run the code": the occlusion-honest synthetic path is the default for clicks.
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), { ref: 'e1', action: 'click' });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.SYNTHETIC_CLICK_PREFERRED);
    expect(provider.calls).toHaveLength(0); // no native gesture
    expect(state.actCalls).toBe(1); // synthetic ACT sent
  });

  it('routes a native:true click to real input (trusted-click opt-in)', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), {
      ref: 'e1',
      action: 'click',
      args: { native: true },
    });

    expect(res.inputMode).toBe(InputMode.REAL);
    expect(provider.calls).toHaveLength(1);
    expect(state.actCalls).toBe(0); // synthetic ACT never sent
    expect(provider.calls[0]?.center).toEqual({ cx: 100, cy: 50 });
  });

  it('blocks a destructive native click until explicitly confirmed', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = {
      actCalls: 0,
      inspectRefs: [],
      inspectName: 'Delete account',
    };
    await expect(
      runAct(fakeDeps(provider, state), {
        ref: 'e1',
        action: 'click',
        args: { native: true },
      }),
    ).rejects.toThrow(/confirmDangerous/);
    expect(provider.calls).toHaveLength(0);

    await runAct(fakeDeps(provider, state), {
      ref: 'e1',
      action: 'click',
      args: { native: true, confirmDangerous: true },
    });
    expect(provider.calls).toHaveLength(1);
  });

  it('routes hover to real input with the hover action', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), { ref: 'e1', action: 'hover' });

    expect(res.inputMode).toBe(InputMode.REAL);
    expect(provider.calls[0]?.action).toBe('hover');
    expect(state.actCalls).toBe(0);
  });

  /**
   * The false-success this product exists to catch: a synthetic mouseover reports dispatched and
   * settled while CSS :hover never applies. Same shape as a coordinate-less drag reporting done.
   * Hover without a real pointer must refuse, not fall through to the in-page dispatch.
   */
  it('refuses hover when no real pointer is available, rather than reporting synthetic dispatch as done', async () => {
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    await expect(
      runAct(fakeDeps(undefined, state), { ref: 'e1', action: 'hover' }),
    ).rejects.toThrow(HOVER_NEEDS_POINTER_MSG);
    expect(state.actCalls).toBe(0);
  });

  it('hovers a leased tab through the pool when no real-input provider is configured', async () => {
    const hoverLease = vi.fn(() => Promise.resolve(true));
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const deps = fakeDeps(undefined, state);
    deps.pool = { hoverLease } as unknown as BrowserPool;
    const res = await runAct(deps, { ref: 'e1', action: 'hover' });

    expect(res.inputMode).toBe(InputMode.REAL);
    expect(hoverLease).toHaveBeenCalledWith('demo', 100, 50);
    expect(state.actCalls).toBe(0);
  });

  it('prefers a configured real-input provider over the pool for hover', async () => {
    const provider = makeProvider(true);
    const hoverLease = vi.fn(() => Promise.resolve(true));
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const deps = fakeDeps(provider, state);
    deps.pool = { hoverLease } as unknown as BrowserPool;
    const res = await runAct(deps, { ref: 'e1', action: 'hover' });

    expect(res.inputMode).toBe(InputMode.REAL);
    expect(provider.calls).toHaveLength(1);
    expect(hoverLease).not.toHaveBeenCalled();
  });

  it('hovers through the pool when the real-input provider throws', async () => {
    const provider = makeProvider(true, { throws: true });
    const hoverLease = vi.fn(() => Promise.resolve(true));
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const deps = fakeDeps(provider, state);
    deps.pool = { hoverLease } as unknown as BrowserPool;
    const res = await runAct(deps, { ref: 'e1', action: 'hover' });

    expect(res.inputMode).toBe(InputMode.REAL);
    expect(hoverLease).toHaveBeenCalledWith('demo', 100, 50);
    expect(state.actCalls).toBe(0);
  });

  it('refuses hover when the provider throws and no lease pointer is available', async () => {
    const provider = makeProvider(true, { throws: true });
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    await expect(runAct(fakeDeps(provider, state), { ref: 'e1', action: 'hover' })).rejects.toThrow(
      HOVER_NEEDS_POINTER_MSG,
    );
    expect(state.actCalls).toBe(0);
  });

  it('refuses hover when the pool cannot drive a pointer on this session', async () => {
    const hoverLease = vi.fn(() => Promise.resolve(false));
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const deps = fakeDeps(undefined, state);
    deps.pool = { hoverLease } as unknown as BrowserPool;
    await expect(runAct(deps, { ref: 'e1', action: 'hover' })).rejects.toThrow(
      HOVER_NEEDS_POINTER_MSG,
    );
    expect(state.actCalls).toBe(0);
  });

  it('falls back to synthetic when the provider has no matching page', async () => {
    const provider = makeProvider(false);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    // native:true so we exercise the native pipeline (correlation check), not the click default.
    const res = await runAct(fakeDeps(provider, state), {
      ref: 'e1',
      action: 'click',
      args: { native: true },
    });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.PAGE_NOT_CORRELATED);
    expect(provider.calls).toHaveLength(0);
    expect(state.actCalls).toBe(1);
  });

  it('uses synthetic, and stays SILENT, when no provider is configured and none was asked for', async () => {
    // Deliberately no reason. Without a provider every action is synthetic, and reticle_act is the
    // most-called tool in the product — a reason on all of them is noise, not information.
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(undefined, state), { ref: 'e1', action: 'click' });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBeUndefined();
    expect(state.actCalls).toBe(1);
  });

  /**
   * Reported from the field: on a session with `realInputAvailable:false`, `native:true` came back
   * `inputMode:"synthetic"` with no reason and no warning, and the agent could not tell "your
   * request was honoured" from "this session will never do that". It spent the rest of the task
   * probing `realInputAvailable` by hand. The tool description promises the opposite in as many
   * words: "inputModeReason explains any real→synthetic choice so it is never silent."
   *
   * Silence stays the default (the test above). Asking explicitly is what earns an answer.
   */
  it('explains itself when native:true is asked for and no provider exists', async () => {
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(undefined, state), {
      ref: 'e1',
      action: 'click',
      args: { native: true },
    });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.NOT_CONFIGURED);
    expect(state.actCalls).toBe(1);
  });

  it('keeps fill synthetic even with a provider present', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), {
      ref: 'e1',
      action: 'fill',
      args: { value: 'hi' },
    });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.NOT_POINTER);
    expect(provider.calls).toHaveLength(0);
    expect(state.actCalls).toBe(1);
  });

  it('falls back to synthetic for a drag without a toRef', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), { ref: 'e1', action: 'drag', args: {} });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.DRAG_TARGET_UNRESOLVED);
    expect(provider.calls).toHaveLength(0);
    expect(state.actCalls).toBe(1);
  });

  it('drives a real drag, resolving both source and target boxes', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), {
      ref: 'e1',
      action: 'drag',
      args: { toRef: 'eTarget' },
    });

    expect(res.inputMode).toBe(InputMode.REAL);
    expect(state.inspectRefs).toEqual(['e1', 'eTarget']);
    expect(provider.calls[0]?.toBox).toEqual(TARGET_BOX);
    expect(provider.calls[0]?.center).toEqual(boxCenter(SOURCE_BOX));
  });

  it('falls back to synthetic when the ref is stale (no box)', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [], staleRef: 'e1' };
    const res = await runAct(fakeDeps(provider, state), {
      ref: 'e1',
      action: 'click',
      args: { native: true },
    });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.ELEMENT_NOT_LOCATABLE);
    expect(provider.calls).toHaveLength(0);
    expect(state.actCalls).toBe(1);
  });

  it('falls back to synthetic for a zero-area box', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [], zeroAreaRef: 'e1' };
    const res = await runAct(fakeDeps(provider, state), {
      ref: 'e1',
      action: 'click',
      args: { native: true },
    });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.ELEMENT_NOT_LOCATABLE);
    expect(provider.calls).toHaveLength(0);
    expect(state.actCalls).toBe(1);
  });

  it('falls back to synthetic and warns when perform throws', async () => {
    const provider = makeProvider(true, { throws: true });
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    const res = await runAct(fakeDeps(provider, state), {
      ref: 'e1',
      action: 'click',
      args: { native: true },
    });

    expect(res.inputMode).toBe(InputMode.SYNTHETIC);
    expect(res.inputModeReason).toBe(InputModeReason.PROVIDER_ERROR);
    expect(res.warning).toBe(ActionWarning.REAL_INPUT_FELL_BACK);
    expect(state.actCalls).toBe(1);
  });

  it('computes the perform center from the SDK-resolved box', async () => {
    const provider = makeProvider(true);
    const state: FakeSessionState = { actCalls: 0, inspectRefs: [] };
    await runAct(fakeDeps(provider, state), { ref: 'e1', action: 'click', args: { native: true } });

    expect(provider.calls[0]?.center).toEqual(boxCenter(provider.calls[0]?.box ?? SOURCE_BOX));
  });
});
