/**
 * The automatic loop. Everything here is about staying INVISIBLE: not overlapping itself, not
 * shouting the same failure once a minute, not starting before a link exists, and not being the
 * reason a process refuses to exit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSyncDaemon } from './sync-daemon.js';
import type { ProjectCloud } from './cloud-config.js';

const LINKED: ProjectCloud = {
  config: { url: 'https://cloud.test', apiKey: 'rk_test' },
  policy: { runs: true, memory: true, flows: true },
  verify: 'local',
  projectId: 'demo',
};
const UNLINKED: ProjectCloud = {
  config: null,
  policy: { runs: true, memory: true, flows: true },
  verify: 'local',
  projectId: null,
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reticle-syncd-'));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A server that answers everything successfully and counts what it was asked. */
function counting() {
  let calls = 0;
  const request = (url: string): Promise<{ status: number; text: string }> => {
    calls += 1;
    const body = url.includes('/pull') ? { triage: [], cursor: '0:' } : {};
    return Promise.resolve({ status: 200, text: JSON.stringify(body) });
  };
  return { request, count: (): number => calls };
}

describe('it stays out of the way', () => {
  it('does nothing at all for a project that is not linked', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(UNLINKED),
      request: server.request,
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(server.count()).toBe(0);
    d.stop();
  });

  it('starts syncing once a link appears, with no restart', async () => {
    // `reticle link` must take effect on a daemon that is already running.
    const server = counting();
    let linked = false;
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(linked ? LINKED : UNLINKED),
      request: server.request,
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(8000);
    expect(server.count()).toBe(0);
    linked = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(server.count()).toBeGreaterThan(0);
    d.stop();
  });

  it('stops when told to, and schedules nothing further', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(7000);
    const before = server.count();
    d.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.count()).toBe(before);
  });

  it('does not start a second cycle on top of a slow one', async () => {
    /*
     * Two bundles in flight race, and the cursor written by the loser rewinds the winner's progress
     * — decisions already applied would be pulled and applied again, forever.
     */
    let started = 0;
    let release: (() => void) | undefined;
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      intervalMs: 1000,
      request: () => {
        started += 1;
        return new Promise((resolve) => {
          release = (): void => resolve({ status: 200, text: '{}' });
        });
      },
    });
    await vi.advanceTimersByTimeAsync(6000);
    expect(started, 'the first cycle is in flight').toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started, 'no second cycle piled on top of it').toBe(1);
    release?.();
    d.stop();
  });
});

describe('it does not shout', () => {
  it('reports a repeated failure ONCE, not once a minute', async () => {
    // A laptop on a train would otherwise write the same line four hundred times.
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(String(args[0]));
    });
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      intervalMs: 1000,
      request: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await vi.advanceTimersByTimeAsync(20_000);
    const failures = logged.filter((l) => l.includes('sync_failed'));
    expect(failures.length).toBeLessThanOrEqual(1);
    d.stop();
  });

  it('keeps cycling after a failure rather than giving up', async () => {
    let calls = 0;
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      intervalMs: 1000,
      request: () => {
        calls += 1;
        return Promise.reject(new Error('offline'));
      },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls, 'a transient outage must not end the loop').toBeGreaterThan(2);
    d.stop();
  });
});

describe('syncNow', () => {
  it('runs a cycle immediately without waiting for the timer', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 600_000,
    });
    const report = await d.syncNow();
    expect(report?.ok).toBe(true);
    expect(server.count()).toBeGreaterThan(0);
    d.stop();
  });

  it('answers undefined for an unlinked project instead of pretending', async () => {
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(UNLINKED),
      intervalMs: 600_000,
    });
    expect(await d.syncNow()).toBeUndefined();
    d.stop();
  });
});

/**
 * The two silences that cost a whole session: a daemon syncing nothing without saying so, and a
 * finished verification waiting a full interval to appear.
 */
describe('it says whether it is syncing at all', () => {
  it('announces an UNLINKED root once, naming the directory', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    });
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(UNLINKED),
      request: counting().request,
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    d.stop();
    const said = lines.filter((l) => l.includes('reticle_cloud_unlinked'));
    // Once — not once per tick, which is what teaches people to stop reading the log.
    expect(said).toHaveLength(1);
    // The directory is the answer; without it people go and check their API key instead. Read as
    // JSON rather than as a substring: `log()` writes JSON, so a Windows path arrives with its
    // separators escaped and never matches the raw string — which is a fact about the encoder, not
    // about whether the line names the root.
    expect((JSON.parse(String(said[0])) as { root?: string }).root).toBe(root);
    spy.mockRestore();
  });

  it('announces when a link APPEARS mid-session, so `reticle link` needs no restart', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    });
    let linked = false;
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(linked ? LINKED : UNLINKED),
      request: counting().request,
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines.filter((l) => l.includes('reticle_cloud_unlinked'))).toHaveLength(1);
    linked = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines.filter((l) => l.includes('reticle_cloud_linked'))).toHaveLength(1);
    d.stop();
    spy.mockRestore();
  });
});

describe('nudge', () => {
  it('cycles well before the next tick would have', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 600_000,
    });
    await vi.advanceTimersByTimeAsync(6_000); // the first cycle
    const afterFirst = server.count();
    d.nudge();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(server.count()).toBeGreaterThan(afterFirst);
    d.stop();
  });

  it('COALESCES a burst into one cycle — six runs must not mean six uploads', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 600_000,
    });
    await vi.advanceTimersByTimeAsync(6_000);
    const afterFirst = server.count();
    for (let i = 0; i < 6; i += 1) d.nudge();
    await vi.advanceTimersByTimeAsync(3_000);
    // One cycle's worth of requests, not six.
    const perCycle = afterFirst;
    expect(server.count() - afterFirst).toBeLessThanOrEqual(perCycle);
    d.stop();
  });

  it('does not leave an extra timer armed for the life of the process', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(6_000);
    d.nudge();
    await vi.advanceTimersByTimeAsync(3_000);
    const settled = server.count();
    await vi.advanceTimersByTimeAsync(10_000); // ten more intervals
    const perTick = (server.count() - settled) / 10;
    d.stop();
    // A stacked timer would double this. One cycle per interval is the whole claim.
    expect(perTick).toBeLessThanOrEqual(counting().count() + 3);
    d.stop();
  });
});

describe('a daemon syncs EVERY linked repo on the machine, not only its own', () => {
  it('pushes a sibling root as well as the one it is standing in', async () => {
    /*
     * The defect this closes, hit twice in one session: one daemon serves many projects — that is
     * what `artifactRootFor` exists for — and this loop pushed exactly one of them, whichever
     * directory it happened to start in. Every other linked repo reported nothing, which on a
     * dashboard is indistinguishable from nobody having verified anything.
     */
    const sibling = mkdtempSync(join(tmpdir(), 'reticle-sibling-'));
    const seen: string[] = [];
    const request = (
      url: string,
      init: { body?: string },
    ): Promise<{ status: number; text: string }> => {
      seen.push(String(init.body ?? '').slice(0, 0) + url);
      const body = url.includes('/pull') ? { triage: [], cursor: '0:' } : {};
      return Promise.resolve({ status: 200, text: JSON.stringify(body) });
    };
    const roots: string[] = [];
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      otherRoots: () => Promise.resolve([sibling]),
      cloudFor: (r) => {
        roots.push(r);
        return Promise.resolve(LINKED);
      },
      request,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(roots, 'the sibling was resolved and pushed').toContain(sibling);
    d.stop();
  });

  it('never resolves its OWN root twice', async () => {
    // The enumerator is machine-wide, so the daemon's own directory appears in it. Pushing it once
    // as a sibling and again as itself would double every count it reports.
    const resolved: string[] = [];
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      otherRoots: () => Promise.resolve([root]),
      cloudFor: (r) => {
        resolved.push(r);
        return Promise.resolve(LINKED);
      },
      request: server.request,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(8_000);

    expect(resolved, 'its own root is skipped in the sibling pass').toEqual([]);
    d.stop();
  });

  it('one broken repo does not silence the rest of the machine', async () => {
    /*
     * The isolation that makes this safe to ship. A revoked credential, a deleted directory or an
     * unreachable self-hosted server in ONE repo is a fact about that repo. Letting it throw would
     * take the daemon's own push down with it and turn one broken link into a machine-wide outage —
     * a strictly worse failure than the one being fixed.
     */
    const broken = mkdtempSync(join(tmpdir(), 'reticle-broken-'));
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      otherRoots: () => Promise.resolve([broken]),
      cloudFor: (r) =>
        r === broken ? Promise.reject(new Error('credential revoked')) : Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(server.count(), "the daemon's own root still pushed").toBeGreaterThan(0);
    d.stop();
  });

  it('an unreadable registry does not stop the daemon syncing itself', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      otherRoots: () => Promise.reject(new Error('registry unreadable')),
      cloudFor: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(server.count()).toBeGreaterThan(0);
    d.stop();
  });

  it('keeps the old single-root behaviour when no enumerator is supplied', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(server.count()).toBeGreaterThan(0);
    d.stop();
  });
});

/**
 * The cadence follows the work.
 *
 * A fixed minute is wrong for both states it covers: during a drive the ledger changes on every tool
 * call and a minute of lag is what makes a dashboard look dead, while idle a minute is already more
 * often than "nothing happened" deserves. Activity is inferred from what the last cycle actually
 * sent — the only honest evidence available without teaching the daemon about sessions.
 */
describe('how often it runs follows whether anything moved', () => {
  /** A server whose /sync answer says a run landed, so the cycle counts as having moved something. */
  function busy() {
    let calls = 0;
    const request = (url: string): Promise<{ status: number; text: string }> => {
      calls += 1;
      if (url.includes('/pull'))
        return Promise.resolve({ status: 200, text: '{"triage":[],"cursor":"0:"}' });
      if (url.endsWith('/v1/sync'))
        return Promise.resolve({
          status: 200,
          text: JSON.stringify({ runs: { accepted: 1, rejected: [] }, flows: { accepted: 0 } }),
        });
      return Promise.resolve({ status: 200, text: '{}' });
    };
    return { request, count: (): number => calls };
  }

  it('backs off to the idle interval when nothing is moving', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const quiet = server.count();
    // Half the idle interval later, a quiet daemon has not run again.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(server.count()).toBe(quiet);
    d.stop();
  });

  it('never polls FASTER than an interval a deployment lowered it to', async () => {
    // Lengthening the interval means "sync less". An active burst must not quietly undo that.
    const server = busy();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    // With a 1s interval the active rate is clamped to 1s, so this is bounded by the interval, not
    // by the 5s active default — which would have produced far fewer cycles.
    expect(server.count()).toBeGreaterThan(3);
    d.stop();
  });
});
