import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asFlowName,
  ActionType,
  AnchorKind,
  DEGRADED_ANCHOR_ROLE,
  FLOW_FILE_VERSION,
  FlowErrorCode,
  FlowFileSchema,
  QueryBy,
} from '@reticlehq/core';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';
import { flowPath, reticleDirPaths } from '../project/reticle-dir.js';
import { anchorForStep, FlowStore, recordedStepToFlowStep } from './flows.js';
import type { CompiledProgram, RecordedStep } from './recordings.js';

const FROZEN = 1234;
const clock = { now: (): number => FROZEN };

function program(name: string, steps: RecordedStep[]): CompiledProgram {
  return { name, version: 1, steps };
}

/**
 * A BOUND, not a measurement — and the lightest of the six the IO-in-a-loop guard flags, which is
 * worth saying rather than leaving for the next reader to wonder about. Test 9's loop runs twice and
 * both saves are rejected on the name before anything is written, so the LOOP is not what costs
 * here. What costs is the block around it: every valid test round-trips a flow through a real temp
 * directory. The bound is cheap, generous, and cannot make a broken test pass; the alternative is a
 * file that only satisfies the guard by accident the day someone adds a third iteration that writes.
 */
const FLOW_ROUND_TRIP_TIMEOUT_MS = 30_000;

describe('FlowStore — temp-dir fs, never touches the repo', () => {
  let root: string;
  let fs: FileSystemPort;
  let store: FlowStore;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-flow-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
    store = new FlowStore(fs, root, clock);
  });

  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  // ---- VALID ----

  it('1: save then load round-trips a flow with a testid anchor', async () => {
    const p = program('f', [
      {
        tool: 'reticle_act',
        stable: true,
        args: { by: QueryBy.TESTID, value: 'chat-send', action: ActionType.CLICK, args: {} },
      },
    ]);
    const saved = await store.save(p);
    // toMatchObject, not toEqual: a save with no declared intent now also carries the `intentGap`
    // nudge, and these specs are about the summary's counts.
    expect(saved).toMatchObject({
      ok: true,
      value: { name: 'f', stepCount: 1, degraded: 0, empty: false },
    });
    const loaded = await store.load('f');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('expected ok');
    expect(loaded.value.version).toBe(FLOW_FILE_VERSION);
    expect(loaded.value.createdAt).toBe(FROZEN);
    expect(loaded.value.steps[0]?.anchor).toEqual({
      kind: AnchorKind.TESTID,
      value: 'chat-send',
    });
    expect(loaded.value.steps[0]?.degraded).toBeUndefined();
  });

  it('2: save preserves action + args through the anchor conversion', async () => {
    const p = program('f', [
      {
        tool: 'reticle_act',
        stable: true,
        args: { by: QueryBy.TESTID, value: 'name', action: ActionType.FILL, args: { value: 'x' } },
      },
    ]);
    await store.save(p);
    const loaded = await store.load('f');
    if (!loaded.ok) throw new Error('expected ok');
    expect(loaded.value.steps[0]?.action).toBe(ActionType.FILL);
    expect(loaded.value.steps[0]?.args).toEqual({ value: 'x' });
  });

  it('4: act_sequence with all-testid sub-steps round-trips, none degraded', async () => {
    const p = program('f', [
      {
        tool: 'reticle_act_sequence',
        stable: true,
        args: {
          steps: [
            { by: QueryBy.TESTID, value: 'a', action: ActionType.FILL, args: {} },
            { by: QueryBy.TESTID, value: 'b', action: ActionType.CLICK, args: {} },
          ],
        },
      },
    ]);
    const saved = await store.save(p);
    // toMatchObject, not toEqual: a save with no declared intent now also carries the `intentGap`
    // nudge, and these specs are about the summary's counts.
    expect(saved).toMatchObject({
      ok: true,
      value: { name: 'f', stepCount: 1, degraded: 0, empty: false },
    });
    const loaded = await store.load('f');
    if (!loaded.ok) throw new Error('expected ok');
    const top = loaded.value.steps[0];
    expect(top?.tool).toBe('reticle_act_sequence');
    expect(top?.steps).toHaveLength(2);
    expect(top?.steps?.[0]?.anchor.kind).toBe(AnchorKind.TESTID);
    expect(top?.steps?.[1]?.anchor.kind).toBe(AnchorKind.TESTID);
    expect(top?.degraded).toBeUndefined();
  });

  it('14: list returns saved flow names without extension, sorted', async () => {
    await store.save(program('b', []));
    await store.save(program('a', []));
    expect(await store.list()).toEqual(['a', 'b']);
  });

  it('15: list on an absent .reticle/flows dir returns [] (no throw)', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('16: createdAt comes from the injected clock, not wall time', async () => {
    const store999 = new FlowStore(fs, root, { now: () => 999 });
    await store999.save(program('f', []));
    const loaded = await store999.load('f');
    if (!loaded.ok) throw new Error('expected ok');
    expect(loaded.value.createdAt).toBe(999);
  });

  // ---- EDGE ----

  it('5: a ref-only step is recorded with a best-effort anchor + degraded:true (not dropped)', async () => {
    const p = program('f', [
      {
        tool: 'reticle_act',
        stable: false,
        args: { ref: 'e34', action: ActionType.CLICK, args: {} },
      },
    ]);
    const saved = await store.save(p);
    // toMatchObject, not toEqual: a save with no declared intent now also carries the `intentGap`
    // nudge, and these specs are about the summary's counts.
    expect(saved).toMatchObject({
      ok: true,
      value: { name: 'f', stepCount: 1, degraded: 1, empty: false },
    });
    const loaded = await store.load('f');
    if (!loaded.ok) throw new Error('expected ok');
    expect(loaded.value.steps).toHaveLength(1);
    expect(loaded.value.steps[0]?.degraded).toBe(true);
    expect(loaded.value.steps[0]?.anchor).toBeDefined();
    // NO eXX ref leaks into the file: the degraded anchor is a placeholder ROLE, never the ref.
    expect(loaded.value.steps[0]?.anchor).toEqual({
      kind: AnchorKind.ROLE,
      role: DEGRADED_ANCHOR_ROLE,
    });
    const raw = await readFile(flowPath(root, asFlowName('f')), 'utf8');
    expect(raw).not.toContain('e34');
  });

  it('5b: a degraded step with NO ref still round-trips (save→load symmetric, not corrupt-on-write)', async () => {
    const p = program('f', [
      { tool: 'reticle_act', stable: false, args: { action: ActionType.CLICK, args: {} } },
    ]);
    const saved = await store.save(p);
    expect(saved.ok).toBe(true);
    const loaded = await store.load('f');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('expected ok');
    expect(loaded.value.steps[0]?.degraded).toBe(true);
  });

  it('6: act_sequence with one degraded sub-step marks the parent degraded but keeps both', async () => {
    const p = program('f', [
      {
        tool: 'reticle_act_sequence',
        stable: false,
        args: {
          steps: [
            { by: QueryBy.TESTID, value: 'a', action: ActionType.FILL, args: {} },
            { ref: 'e9', action: ActionType.CLICK, args: {} },
          ],
        },
      },
    ]);
    await store.save(p);
    const loaded = await store.load('f');
    if (!loaded.ok) throw new Error('expected ok');
    const top = loaded.value.steps[0];
    expect(top?.degraded).toBe(true);
    expect(top?.steps).toHaveLength(2);
    expect(top?.steps?.[0]?.degraded).toBeUndefined();
    expect(top?.steps?.[1]?.degraded).toBe(true);
  });

  it('7: empty recording saves an empty-but-valid flow (the tested choice)', async () => {
    const saved = await store.save(program('f', []));
    // toMatchObject, not toEqual: a save with no declared intent now also carries the `intentGap`
    // nudge, and these specs are about the summary's counts.
    expect(saved).toMatchObject({
      ok: true,
      value: { name: 'f', stepCount: 0, degraded: 0, empty: true },
    });
    const loaded = await store.load('f');
    if (!loaded.ok) throw new Error('expected ok');
    expect(loaded.value.steps).toEqual([]);
    expect(() => FlowFileSchema.parse(loaded.value)).not.toThrow();
  });

  // ---- INVALID ----

  it('8: save rejects a path-traversal name, writes no file outside root', async () => {
    const saved = await store.save(program('../evil', []));
    expect(saved).toEqual({ ok: false, code: FlowErrorCode.INVALID_NAME });
    expect(await fs.exists(join(root, '..', 'evil.json'))).toBe(false);
  });

  it(
    '9: save rejects an absolute / slashed name',
    async () => {
      for (const name of ['a/b', '/etc/x']) {
        const saved = await store.save(program(name, []));
        expect(saved).toEqual({ ok: false, code: FlowErrorCode.INVALID_NAME });
      }
    },
    FLOW_ROUND_TRIP_TIMEOUT_MS,
  );

  it('10: load of a missing flow returns NOT_FOUND, not a throw', async () => {
    const loaded = await store.load('ghost');
    expect(loaded).toEqual({ ok: false, code: FlowErrorCode.NOT_FOUND });
  });

  it('11: load of a malformed JSON file returns PARSE_FAILED', async () => {
    await mkdir(reticleDirPaths(root).flows, { recursive: true });
    await writeFile(flowPath(root, asFlowName('bad')), '{not json', 'utf8');
    const loaded = await store.load('bad');
    expect(loaded).toMatchObject({ ok: false, code: FlowErrorCode.PARSE_FAILED });
  });

  it('12: load of a schema-invalid flow (wrong version) returns PARSE_FAILED', async () => {
    await mkdir(reticleDirPaths(root).flows, { recursive: true });
    await writeFile(
      flowPath(root, asFlowName('wrong')),
      JSON.stringify({ version: 99, name: 'wrong', createdAt: 1, steps: [] }),
      'utf8',
    );
    const loaded = await store.load('wrong');
    expect(loaded).toMatchObject({ ok: false, code: FlowErrorCode.PARSE_FAILED });
  });

  it('13: load rejects a traversal name before touching disk', async () => {
    let read = 0;
    const spyFs: FileSystemPort = { ...fs, readFile: (p) => (read++, fs.readFile(p)) };
    const spyStore = new FlowStore(spyFs, root, clock);
    const loaded = await spyStore.load('../../secret');
    expect(loaded).toEqual({ ok: false, code: FlowErrorCode.INVALID_NAME });
    expect(read).toBe(0);
  });
});

// ---- PURE UNIT (no fs) ----

describe('recordedStepToFlowStep (pure)', () => {
  it('17: maps a testid step purely (no degraded)', () => {
    const out = recordedStepToFlowStep({
      tool: 'reticle_act',
      stable: true,
      args: { by: QueryBy.TESTID, value: 'chat-send', action: ActionType.CLICK, args: {} },
    });
    expect(out.anchor).toEqual({ kind: AnchorKind.TESTID, value: 'chat-send' });
    expect(out.action).toBe(ActionType.CLICK);
    expect(out.degraded).toBeUndefined();
  });

  it('18: never returns undefined for an unstable step', () => {
    const out = recordedStepToFlowStep({
      tool: 'reticle_act',
      stable: false,
      args: { ref: 'e1', action: ActionType.CLICK, args: {} },
    });
    expect(out).toBeDefined();
    expect(out.degraded).toBe(true);
    // The ref is NOT persisted as a testid value — it's a placeholder ROLE anchor.
    expect(out.anchor).toEqual({ kind: AnchorKind.ROLE, role: DEGRADED_ANCHOR_ROLE });
  });

  it('maps a component (auto-anchor) step to a stable component anchor — not degraded', () => {
    const out = recordedStepToFlowStep({
      tool: 'reticle_act',
      stable: true,
      args: {
        by: QueryBy.COMPONENT,
        component: 'NewDeployButton',
        source: { file: 'src/Deployments.tsx', line: 107 },
        action: ActionType.CLICK,
        args: {},
      },
    });
    expect(out.degraded).toBeUndefined();
    expect(out.anchor).toEqual({
      kind: AnchorKind.COMPONENT,
      component: 'NewDeployButton',
      source: { file: 'src/Deployments.tsx', line: 107 },
    });
  });
});

describe('a role+name anchor is a real anchor, not a degraded placeholder', () => {
  /**
   * The vocabulary has always described `{ kind:'role', role, name }` as addressable, and nothing
   * ever produced one — the only ROLE anchor written to disk was the placeholder meaning "add a
   * data-testid". So a step the recorder anchored by accessible name had that name discarded here,
   * which is exactly the handle that separates one row's control from another's when a shared JSX
   * source location cannot.
   */
  it('keeps role and name, and does not mark the step degraded', () => {
    const { anchor, degraded } = anchorForStep({
      by: 'role',
      value: 'checkbox',
      name: 'select ATL-100001',
    });
    expect(degraded).toBe(false);
    expect(anchor).toEqual({ kind: AnchorKind.ROLE, role: 'checkbox', name: 'select ATL-100001' });
  });

  it('still degrades a NAMELESS role — it addresses nothing on its own', () => {
    const { anchor, degraded } = anchorForStep({ by: 'role', value: 'button' });
    expect(degraded).toBe(true);
    expect(anchor).toEqual({ kind: AnchorKind.ROLE, role: DEGRADED_ANCHOR_ROLE });
  });

  it('still prefers a testid when the step has one', () => {
    const { anchor } = anchorForStep({ by: 'testid', value: 'save', name: 'Save' });
    expect(anchor.kind).toBe(AnchorKind.TESTID);
  });
});
