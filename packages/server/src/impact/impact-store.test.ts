import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMPACT_DEFECT_LIMIT, emptyImpactCounts } from '@reticlehq/core';
import { ImpactStore, applyDelta, isoDay, readScope } from './impact-store.js';

const DAY = 86_400_000;

function scopeAt(now: number) {
  return readScope(join(mkdtempSync(join(tmpdir(), 'impact-')), 'missing.json'), now);
}

describe('the impact record', () => {
  it('starts empty and survives a missing file', () => {
    const scope = scopeAt(1000);
    expect(scope.counts).toEqual(emptyImpactCounts());
    expect(scope.days).toEqual([]);
    expect(scope.since).toBe(1000);
  });

  it('folds a delta into totals and today', () => {
    const now = Date.parse('2026-08-20T10:00:00');
    const after = applyDelta(scopeAt(now), { calls: 1, verdicts: 1, passed: 1 }, now);
    expect(after.counts.verdicts).toBe(1);
    expect(after.days).toHaveLength(1);
    expect(after.days[0]?.date).toBe(isoDay(now));
    expect(after.days[0]?.counts.passed).toBe(1);
  });

  /**
   * A saving is a comparison, so it may never be reported without the run it is compared against.
   * The number is allowed to change; a number with no stated basis is not.
   */
  it('always states what a saving is measured against', () => {
    const now = Date.parse('2026-08-20T10:00:00');
    const after = applyDelta(scopeAt(now), { verdicts: 3, failed: 1, tokensReturned: 400 }, now);
    expect(after.savings.tokens.value).toBeGreaterThan(0);
    expect(after.savings.tokens.basis.length).toBeGreaterThan(10);
    expect(after.savings.minutes.basis).toContain('defect');
  });

  it('counts a streak only over consecutive days', () => {
    const day1 = Date.parse('2026-08-18T10:00:00');
    let scope = applyDelta(scopeAt(day1), { verdicts: 1 }, day1);
    expect(scope.records.streakDays).toBe(1);
    scope = applyDelta(scope, { verdicts: 1 }, day1 + DAY);
    expect(scope.records.streakDays, 'the next day continues it').toBe(2);
    scope = applyDelta(scope, { verdicts: 1 }, day1 + DAY * 4);
    expect(scope.records.streakDays, 'a gap starts over').toBe(1);
    expect(scope.records.bestStreakDays, 'the best is remembered').toBe(2);
  });

  it('writes both scopes atomically and reads them back', () => {
    const root = mkdtempSync(join(tmpdir(), 'impact-project-'));
    const store = new ImpactStore({
      reticleRoot: join(root, '.reticle'),
      projectName: 'demo',
      now: () => 5_000,
    });
    store.record({ calls: 2, verdicts: 1, failed: 1, tokensReturned: 120, drivingMs: 900 });
    store.flush();
    const onDisk: unknown = JSON.parse(readFileSync(join(root, '.reticle', 'impact.json'), 'utf8'));
    expect((onDisk as { counts: { calls: number } }).counts.calls).toBe(2);
    expect(store.snapshot().projectName).toBe('demo');
    expect(store.snapshot().project.counts.failed).toBe(1);
  });
});

/**
 * Both entry points open the record, or the HUD is handed nothing on connect.
 *
 * `start` and `startDaemon` each wire their own world, and only one of them had the line - so in
 * the process that actually serves people, the record was opened lazily by the first TOOL call.
 * A tab that connected before then was pushed nothing, and the report said "nothing recorded yet"
 * over a file with history in it. This is the cheap structural check that both keep the line.
 */
describe('the daemon opens the impact record at startup', () => {
  it('is initialised by both server entry points', () => {
    const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const startBody = src.slice(
      src.indexOf('export async function start('),
      src.indexOf('export async function startDaemon('),
    );
    const daemonBody = src.slice(src.indexOf('export async function startDaemon('));
    expect(startBody, '`start` opens the record').toContain('initImpact(');
    expect(daemonBody, '`startDaemon` opens the record - this is the one that serves').toContain(
      'initImpact(',
    );
  });
});

/**
 * "Longest run" is the longest SESSION, not the longest tool call.
 *
 * It used to be fed each call's own duration, so the report's superlative was a few hundred
 * milliseconds however long the agent actually worked - a number that could never mean what its
 * label said.
 */
describe('the longest-run record', () => {
  it('takes a session lifetime and ignores per-call durations', () => {
    const now = Date.parse('2026-08-20T10:00:00');
    let scope = applyDelta(scopeAt(now), { calls: 1, drivingMs: 480 }, now);
    expect(scope.records.longestRunMs, 'one click is not a run').toBe(0);
    scope = applyDelta(scope, { calls: 1 }, now, { runMs: 742_000 });
    expect(scope.records.longestRunMs).toBe(742_000);
    scope = applyDelta(scope, { calls: 1 }, now, { runMs: 9_000 });
    expect(scope.records.longestRunMs, 'a shorter run does not beat the record').toBe(742_000);
  });
});

/**
 * The short list of what broke.
 *
 * `counts.failed` says how many; this says which. The invariants that matter are that it stays
 * SHORT (a counters file must not become a log), stays CURRENT (newest first, or after a week it is
 * a list about the past), and that a record written by an older build still parses — a defect list
 * is not worth losing somebody's whole history over.
 */
describe('the defect list', () => {
  const defect = (title: string, at = 1) => ({ at, title });

  it('remembers what broke, not just that something did', () => {
    const now = Date.parse('2026-08-20T10:00:00');
    const scope = applyDelta(scopeAt(now), { calls: 1, verdicts: 1, failed: 1 }, now, {
      defect: defect('Sign In'),
    });
    expect(scope.counts.failed).toBe(1);
    expect(scope.defects.map((d) => d.title)).toEqual(['Sign In']);
  });

  it('keeps the newest first, so the list is what is broken NOW', () => {
    const now = Date.parse('2026-08-20T10:00:00');
    let scope = scopeAt(now);
    for (const title of ['first', 'second', 'third']) {
      scope = applyDelta(scope, { failed: 1 }, now, { defect: defect(title) });
    }
    expect(scope.defects.map((d) => d.title)).toEqual(['third', 'second', 'first']);
  });

  it('stays bounded, however long the session runs', () => {
    const now = Date.parse('2026-08-20T10:00:00');
    let scope = scopeAt(now);
    for (let i = 0; i < 50; i += 1) {
      scope = applyDelta(scope, { failed: 1 }, now, { defect: defect(`d${String(i)}`) });
    }
    expect(scope.defects).toHaveLength(IMPACT_DEFECT_LIMIT);
    expect(scope.defects[0]?.title, 'newest survives the cap').toBe('d49');
    expect(scope.counts.failed, 'the COUNT is not capped — only the list is').toBe(50);
  });

  it('leaves the list alone on a call that caught nothing', () => {
    const now = Date.parse('2026-08-20T10:00:00');
    const withOne = applyDelta(scopeAt(now), { failed: 1 }, now, { defect: defect('Sign In') });
    const after = applyDelta(withOne, { calls: 1, passed: 1, verdicts: 1 }, now);
    expect(after.defects.map((d) => d.title)).toEqual(['Sign In']);
  });

  it('reads a record written before defects existed, rather than discarding it', () => {
    // The whole point of defaulting the field: an older impact.json is somebody's history, and a
    // parse failure here would silently reset their streak, their records and their totals.
    const dir = mkdtempSync(join(tmpdir(), 'impact-old-'));
    const path = join(dir, 'impact.json');
    writeFileSync(
      path,
      JSON.stringify({
        counts: { ...emptyImpactCounts(), calls: 7, failed: 2 },
        days: [],
        records: {
          longestRunMs: 5,
          bestVerdictDay: 1,
          bestDefectDay: 1,
          streakDays: 3,
          bestStreakDays: 3,
        },
        savings: { tokens: { value: 1, basis: 'b' }, minutes: { value: 1, basis: 'b' } },
        since: 10,
      }),
      'utf8',
    );
    const scope = readScope(path, 999);
    expect(scope.counts.calls, 'the old history survived').toBe(7);
    expect(scope.records.streakDays).toBe(3);
    expect(scope.defects).toEqual([]);
  });
});

/** The HUD's link to the dashboard: present only when `reticle link` recorded one. */
describe('the dashboard link', () => {
  it('is absent for a project that is not linked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'impact-nolink-'));
    expect(new ImpactStore({ reticleRoot: dir }).snapshot().dashboardUrl).toBeUndefined();
  });

  it('is read from the link file `reticle link` writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'impact-link-'));
    writeFileSync(
      join(dir, 'cloud.json'),
      JSON.stringify({
        projectId: 'web',
        url: 'https://api.test',
        dashboardUrl: 'https://console.test/issues?project=web',
      }),
      'utf8',
    );
    expect(new ImpactStore({ reticleRoot: dir }).snapshot().dashboardUrl).toBe(
      'https://console.test/issues?project=web',
    );
  });

  it('is absent — not crashed — when the link file is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'impact-bad-'));
    writeFileSync(join(dir, 'cloud.json'), '{not json', 'utf8');
    expect(new ImpactStore({ reticleRoot: dir }).snapshot().dashboardUrl).toBeUndefined();
  });
});
