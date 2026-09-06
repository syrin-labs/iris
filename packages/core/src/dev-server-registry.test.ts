import { describe, expect, it } from 'vitest';
import {
  devServerRegistryFileName,
  devServerRegistryPort,
  devServersForProject,
  DevServerEntrySchema,
  liveDevServers,
} from './dev-server-registry.js';

const entry = (port: number, pid: number, extra: Record<string, unknown> = {}) => ({
  port,
  pid,
  root: '/repo/apps/web',
  url: `http://localhost:${String(port)}/`,
  sdkVersion: '2.13.0',
  startedAt: 1000,
  ...extra,
});

describe('dev server registry filenames', () => {
  it('round-trips a port', () => {
    expect(devServerRegistryPort(devServerRegistryFileName(5173))).toBe(5173);
  });

  it('rejects names that are not registry entries', () => {
    expect(devServerRegistryPort('daemon-4400.json')).toBeNull();
    expect(devServerRegistryPort('devserver-.json')).toBeNull();
    expect(devServerRegistryPort('devserver-abc.json')).toBeNull();
    expect(devServerRegistryPort('devserver-5173.txt')).toBeNull();
  });

  /**
   * The daemon's own entries sit in the same directory. Reading one as a dev server would report a
   * daemon as an instrumented app, which is the exact false green this signal exists to prevent.
   */
  it('does not collide with the daemon registry', () => {
    expect(devServerRegistryPort('daemon-5173.json')).toBeNull();
  });
});

describe('DevServerEntrySchema', () => {
  it('accepts an entry with no projectId — an app can run before init names it', () => {
    expect(DevServerEntrySchema.safeParse(entry(5173, 10)).success).toBe(true);
  });

  it('rejects an entry missing the fields the diagnosis reads', () => {
    const { url: _dropped, ...noUrl } = entry(5173, 10);
    expect(DevServerEntrySchema.safeParse(noUrl).success).toBe(false);
  });

  /**
   * An unresolvable SDK version must be ABSENT, never empty: the only reader of this field is a
   * skew diagnosis, and `''` would be reported as a version rather than as "not known".
   */
  it('accepts a missing sdkVersion but rejects an empty one', () => {
    const { sdkVersion: _none, ...absent } = entry(5173, 10);
    expect(DevServerEntrySchema.safeParse(absent).success).toBe(true);
    expect(DevServerEntrySchema.safeParse(entry(5173, 10, { sdkVersion: '' })).success).toBe(false);
  });
});

describe('liveDevServers', () => {
  /**
   * A dev server that was killed leaves its file behind — nothing runs on exit after a SIGKILL. A
   * stale entry read as live is worse than no entry: it says the app is running and instrumented
   * while the port is dead, and sends the reader looking at their browser.
   */
  it('drops entries whose process is gone', () => {
    const alive = (pid: number): boolean => 10 === pid;
    expect(liveDevServers([entry(5173, 10), entry(3000, 11)], alive).map((e) => e.port)).toEqual([
      5173,
    ]);
  });

  it('sorts by port so two frontends list in a stable order', () => {
    const entries = [entry(5173, 10), entry(3000, 11)];
    expect(liveDevServers(entries, () => true).map((e) => e.port)).toEqual([3000, 5173]);
  });

  it('is empty, not throwing, when nothing is running', () => {
    expect(liveDevServers([], () => true)).toEqual([]);
  });
});

describe('devServersForProject', () => {
  const a = { ...entry(5173, 10), root: '/repo/apps/web', projectId: 'web-1' };
  const b = { ...entry(3000, 11), root: '/repo/apps/admin', projectId: 'admin-2' };

  it('matches on projectId', () => {
    expect(devServersForProject([a, b], { projectId: 'web-1' })).toEqual([a]);
  });

  it('matches the directory being set up', () => {
    expect(devServersForProject([a, b], { root: '/repo/apps/admin' })).toEqual([b]);
  });

  /** `init` at a monorepo root is setting up the apps underneath it — those genuinely are its apps. */
  it('matches every app under a monorepo root', () => {
    expect(devServersForProject([a, b], { root: '/repo' })).toEqual([a, b]);
  });

  /**
   * The defect this function exists for: unscoped, `init` for one app reported another app's dev
   * server as "your dev server" and handed over its URL.
   */
  it('excludes an unrelated project', () => {
    expect(devServersForProject([b], { projectId: 'web-1', root: '/repo/apps/web' })).toEqual([]);
  });

  it('is not fooled by a shared path prefix', () => {
    const sibling = { ...entry(4000, 12), root: '/repo/apps/web-legacy', projectId: 'legacy-3' };
    expect(devServersForProject([sibling], { root: '/repo/apps/web' })).toEqual([]);
  });

  /** Nothing to scope BY must match nothing — never everything, which is the failure being fixed. */
  it('matches nothing when neither projectId nor root is known', () => {
    expect(devServersForProject([a, b], {})).toEqual([]);
  });
});
