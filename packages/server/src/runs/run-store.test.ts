import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asRunId, RunReadError, type ReticleVerificationRun } from '@reticlehq/core';
import { buildVerificationRun, type VerificationRunInput } from './build-verification-run.js';
import { RunStore } from './run-store.js';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';
import { RunAgentKind, RunFramework, RunProfile, RunTrigger } from '@reticlehq/core';

const baseInput = (runId: string): VerificationRunInput => ({
  runId,
  durationMs: 100,
  profile: RunProfile.DEV,
  project: { name: 'demo', framework: RunFramework.REACT },
  agent: { id: 'a', kind: RunAgentKind.CODING_AGENT },
  trigger: { kind: RunTrigger.EDIT },
  changedFiles: [],
  flows: [],
  checks: [],
  risks: [],
  evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
});

const make = (runId: string, at: number): ReticleVerificationRun =>
  buildVerificationRun(baseInput(runId), () => at);

/**
 * A BOUND, not a measurement. The retention test writes five runs sequentially through the real
 * filesystem, and each write is an atomic publish — a temp file plus a rename — so the cost is two
 * syscalls per iteration rather than the five the loop counts.
 */
const RUN_WRITE_TIMEOUT_MS = 30_000;

describe('RunStore — temp-dir filesystem, never touches the repo', () => {
  let root: string;
  let fs: FileSystemPort;
  let store: RunStore;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-runs-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
    store = new RunStore(fs, root);
  });

  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  /**
   * The write is the thing people wait on; the notification must never be able to break it.
   */
  it('notifies AFTER the run is readable, so a listener never races the rename', async () => {
    let onDiskWhenNotified: boolean | undefined;
    const notified = new RunStore(fs, root, {
      // Checked SYNCHRONOUSLY inside the callback: the whole claim is that a listener woken here can
      // already read the run, and asserting after the write returns would prove nothing about order.
      onWrote: () => {
        onDiskWhenNotified = existsSync(join(root, 'runs', 'run-notify.json'));
      },
    });
    await notified.write(make('run-notify', 1000));
    expect(onDiskWhenNotified).toBe(true);
    const read = await notified.read(asRunId('run-notify'));
    expect(read.ok).toBe(true);
  });

  it('a listener that throws does not fail the durable write', async () => {
    const notified = new RunStore(fs, root, {
      onWrote: () => {
        throw new Error('sync is offline');
      },
    });
    await expect(notified.write(make('run-throwing', 1000))).resolves.toBeUndefined();
    const read = await notified.read(asRunId('run-throwing'));
    expect(read.ok).toBe(true);
  });

  it('writes then reads a run round-trip', async () => {
    const run = make('run-1', 1000);
    await store.write(run);
    const read = await store.read(asRunId('run-1'));
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.run.runId).toBe('run-1');
  });

  it('a missing run reads as MISSING (never throws)', async () => {
    const read = await store.read(asRunId('nope'));
    expect(read).toEqual({ ok: false, reason: RunReadError.MISSING });
  });

  it('a path-traversal runId is refused as MISSING', async () => {
    const read = await store.read(asRunId('../escape'));
    expect(read).toEqual({ ok: false, reason: RunReadError.MISSING });
  });

  it('lists run ids and picks the latest by createdAt', async () => {
    await store.write(make('run-a', 1000));
    await store.write(make('run-b', 3000));
    await store.write(make('run-c', 2000));
    const ids = await store.list();
    expect(ids.sort()).toEqual(['run-a', 'run-b', 'run-c']);
    const latest = await store.latest();
    expect(latest?.runId).toBe('run-b');
  });

  it('latest is undefined when no runs exist', async () => {
    expect(await store.latest()).toBeUndefined();
  });

  it('latestTwo returns [previous, current] oldest-first, undefined with fewer than two', async () => {
    expect(await store.latestTwo()).toBeUndefined();
    await store.write(make('run-a', 1000));
    expect(await store.latestTwo()).toBeUndefined();
    await store.write(make('run-b', 3000));
    await store.write(make('run-c', 2000));
    const pair = await store.latestTwo();
    expect(pair?.map((r) => r.runId)).toEqual(['run-c', 'run-b']); // 2000 then 3000
  });

  it('refuses to write a run whose runId is a path-traversal value', async () => {
    const evil = make('../../etc/evil', 1000);
    await expect(store.write(evil)).rejects.toThrow(/unsafe runId/);
  });

  it(
    'prunes oldest runs beyond the retention cap, keeping the newest',
    async () => {
      const capped = new RunStore(fs, root, { retention: 3, slack: 1 });
      for (let i = 1; i <= 5; i += 1) await capped.write(make(`run-${i}`, i * 1000));
      const ids = (await capped.list()).sort();
      expect(ids).toEqual(['run-3', 'run-4', 'run-5']); // oldest two pruned
    },
    RUN_WRITE_TIMEOUT_MS,
  );

  it('leaves no .tmp file after a write (atomic publish)', async () => {
    await store.write(make('run-x', 1));
    const entries = await readdir(join(root, 'runs'));
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
    expect(entries).toContain('run-x.json');
  });
});
