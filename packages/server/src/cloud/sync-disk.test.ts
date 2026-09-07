/**
 * The filesystem half. Two things here are easy to get wrong and expensive when they are:
 * a MERGE that is really an overwrite (which silently discards every earlier decision), and a read
 * that throws on a half-written file (which turns one bad flush into a broken sync).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import { diskSink, diskSource, readCloudIssues, readCloudState } from './sync-disk.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reticle-sync-'));
});

const write = (rel: string, value: unknown): void => {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf8');
};

describe('reading what is on disk', () => {
  it('finds run artifacts and keys them by their own id', () => {
    write(join(ReticleDir.RUNS_SUBDIR, 'a.json'), { runId: 'run-a', verdict: 'pass' });
    write(join(ReticleDir.RUNS_SUBDIR, 'b.json'), { runId: 'run-b' });
    expect(
      diskSource(root)
        .runs()
        .map((r) => r.runId)
        .sort(),
    ).toEqual(['run-a', 'run-b']);
  });

  it('drops a run artifact with no id rather than re-sending it forever', () => {
    // Without an id it cannot be diffed against the server's list, so it would upload every cycle.
    write(join(ReticleDir.RUNS_SUBDIR, 'nameless.json'), { verdict: 'pass' });
    expect(diskSource(root).runs()).toEqual([]);
  });

  it('finds flows one directory down, under the app’s own project id', () => {
    write(join(ReticleDir.FLOWS_SUBDIR, 'app-1', 'sign-in.json'), { name: 'sign-in' });
    write(join(ReticleDir.FLOWS_SUBDIR, 'app-2', 'checkout.json'), { name: 'checkout' });
    expect(diskSource(root).flows()).toHaveLength(2);
  });

  it('reads each derived record from its own file', () => {
    write(ReticleDir.IMPACT_FILE, { counts: { calls: 4 } });
    write(ReticleDir.FLAKE_FILE, { version: 1 });
    const src = diskSource(root);
    expect(src.derived('impact')).toEqual({ counts: { calls: 4 } });
    expect(src.derived('flake')).toEqual({ version: 1 });
    expect(src.derived('intent')).toBeUndefined();
  });

  it('treats a half-written file as absent instead of throwing', () => {
    // A process that died mid-flush must cost one unsynced record, not a crashed sync.
    writeFileSync(join(root, ReticleDir.IMPACT_FILE), '{"counts":', 'utf8');
    expect(diskSource(root).derived('impact')).toBeUndefined();
  });

  it('reads an empty everything on a repo that has never run Reticle', () => {
    const src = diskSource(root);
    expect(src.runs()).toEqual([]);
    expect(src.flows()).toEqual([]);
    expect(readCloudState(root)).toEqual({});
    expect(readCloudIssues(root)).toEqual({ triage: {} });
  });
});

describe('writing what came back', () => {
  it('MERGES decisions rather than replacing them', () => {
    /*
     * The defect this guards: a pull returns only what changed since the cursor. Overwriting would
     * drop every earlier decision the moment one new decision arrived — so a bug resolved last week
     * would quietly come back as untriaged.
     */
    const sink = diskSink(root);
    sink.writeIssues({ triage: { fp1: { status: 'resolved', flowName: 'a', title: 'A', at: 1 } } });
    sink.writeIssues({ triage: { fp2: { status: 'ignored', flowName: 'b', title: 'B', at: 2 } } });
    const held = readCloudIssues(root);
    expect(Object.keys(held.triage).sort()).toEqual(['fp1', 'fp2']);
    expect(held.triage['fp1']?.status).toBe('resolved');
  });

  it('lets a NEWER decision on the same defect win', () => {
    const sink = diskSink(root);
    sink.writeIssues({ triage: { fp1: { status: 'resolved', flowName: 'a', title: 'A', at: 1 } } });
    sink.writeIssues({ triage: { fp1: { status: 'open', flowName: 'a', title: 'A', at: 9 } } });
    expect(readCloudIssues(root).triage['fp1']?.status).toBe('open');
  });

  it('round-trips the cursor', () => {
    diskSink(root).writeState({ cursor: '5:fp1', lastPullAt: 42 });
    expect(readCloudState(root).cursor).toBe('5:fp1');
    expect(readCloudState(root).lastPullAt).toBe(42);
  });

  it('reads a corrupt state file as a fresh start rather than throwing', () => {
    writeFileSync(join(root, ReticleDir.CLOUD_STATE_FILE), 'not json at all', 'utf8');
    expect(readCloudState(root)).toEqual({});
  });

  it('reads a corrupt issues file as no decisions rather than throwing', () => {
    writeFileSync(join(root, ReticleDir.ISSUES_FILE), '{"triage":', 'utf8');
    expect(readCloudIssues(root)).toEqual({ triage: {} });
  });
});

/**
 * The subject stamped on the way OUT.
 *
 * The engine derives a record's subject from evidence the record already carries, and this is where
 * that derivation is applied to what the cloud receives — the server has no access to the binding
 * and would otherwise file everything it could not read as `unsorted`.
 *
 * Nothing covered it at all, on the path a customer's dashboard is actually built from. These exist
 * because the call CASTS `surface` down to `{ route, flow }` on its way into the ladder — a cast
 * that erases at runtime, so `surface.files` does still arrive, but which reads as though the file
 * rung were dropped here. It was mistaken for a live defect once already; the tests are what settle
 * which it is, and what will notice if the cast ever becomes a real omission.
 */
describe('the subject a record arrives with', () => {
  const intents = (records: Record<string, unknown>): void =>
    write(ReticleDir.INTENT_FILE, { version: 1, intents: records });

  const subjectOf = (id: string): unknown => {
    const payload = diskSource(root).derived('intent') as {
      intents: Record<string, { subject?: unknown }>;
    };
    return payload.intents[id]?.subject;
  };

  it('files a record by the FILE its verdict touched when nothing else places it', () => {
    intents({
      a: { statement: 's', surface: { files: ['src/features/checkout/total.ts'] } },
    });
    expect(subjectOf('a')).toBe('checkout');
  });

  it('still prefers the route, which outranks the file', () => {
    intents({
      a: { statement: 's', surface: { route: '/billing', files: ['src/features/auth/x.tsx'] } },
    });
    expect(subjectOf('a')).toBe('billing');
  });

  it('still prefers the flow, which outranks both', () => {
    intents({
      a: {
        statement: 's',
        surface: { flow: 'checkout-pay', route: '/billing', files: ['src/features/auth/x.tsx'] },
      },
    });
    expect(subjectOf('a')).toBe('checkout-pay');
  });

  it('leaves an explicit subject alone — an agent’s own choice outranks inference', () => {
    intents({ a: { statement: 's', subject: 'mine', surface: { route: '/billing' } } });
    expect(subjectOf('a')).toBe('mine');
  });

  it('falls back to unsorted when the evidence names nothing', () => {
    intents({ a: { statement: 's' } });
    expect(subjectOf('a')).toBe('unsorted');
  });
});
