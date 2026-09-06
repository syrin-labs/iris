import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDaemonStartupCause } from './startup-failure.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readDaemonStartupCause', () => {
  it('returns the startup error recorded by the failed daemon', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-startup-cause-'));
    dirs.push(dir);
    const path = join(dir, 'daemon.log');
    const since = Date.parse('2026-09-06T15:00:00.000Z');
    writeFileSync(
      path,
      [
        JSON.stringify({
          t: '2026-09-06T15:00:00.100Z',
          event: 'reticle_daemon_start_failed',
          error: 'Chromium is not installed for Playwright. Run the pinned install command.',
        }),
        '',
      ].join('\n'),
    );

    expect(readDaemonStartupCause(path, since)).toBe(
      'Chromium is not installed for Playwright. Run the pinned install command.',
    );
  });

  it('does not surface a failure from an earlier daemon attempt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-startup-cause-'));
    dirs.push(dir);
    const path = join(dir, 'daemon.log');
    writeFileSync(
      path,
      `${JSON.stringify({
        t: '2026-09-06T14:59:59.999Z',
        event: 'reticle_daemon_start_failed',
        error: 'stale cause',
      })}\n`,
    );

    expect(readDaemonStartupCause(path, Date.parse('2026-09-06T15:00:00.000Z'))).toBeUndefined();
  });
});
