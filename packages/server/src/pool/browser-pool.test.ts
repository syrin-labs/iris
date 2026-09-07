/**
 * BrowserPool lifecycle: one browser, capped isolated contexts, FIFO queue, crash relaunch.
 * Uses a fake launcher so no real Chromium is needed — the pool logic is what's under test.
 */

import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  BrowserPool,
  type Launcher,
  type PooledBrowser,
  type PooledContext,
  type PooledPage,
} from './browser-pool.js';

class FakePage implements PooledPage {
  gotoUrls: string[] = [];
  closed = false;
  failNav = false;
  #onCrash: (() => void) | undefined;
  goto(url: string): Promise<unknown> {
    this.gotoUrls.push(url);
    return this.failNav ? Promise.reject(new Error('nav timeout')) : Promise.resolve(undefined);
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  onCrash(handler: () => void): void {
    this.#onCrash = handler;
  }
  /** Test helper: simulate this page's renderer crashing. */
  crash(): void {
    this.#onCrash?.();
  }
}

class FakeContext implements PooledContext {
  readonly pages: FakePage[] = [];
  closed = false;
  constructor(private readonly failNav = false) {}
  newPage(): Promise<PooledPage> {
    const p = new FakePage();
    p.failNav = this.failNav;
    this.pages.push(p);
    return Promise.resolve(p);
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeBrowser implements PooledBrowser {
  readonly contexts: FakeContext[] = [];
  failNav = false;
  #connected = true;
  #onDisc: (() => void) | undefined;
  isConnected(): boolean {
    return this.#connected;
  }
  newContext(): Promise<PooledContext> {
    const c = new FakeContext(this.failNav);
    this.contexts.push(c);
    return Promise.resolve(c);
  }
  close(): Promise<void> {
    this.#connected = false;
    return Promise.resolve();
  }
  onDisconnected(handler: () => void): void {
    this.#onDisc = handler;
  }
  /** Test helper: simulate a process crash. */
  crash(): void {
    this.#connected = false;
    this.#onDisc?.();
  }
}

function counterIds(): () => string {
  let n = 0;
  return () => `s${String(++n)}`;
}

/** A launcher that hands out fresh FakeBrowsers and records how many it made. */
function fakeLauncher(): { launch: Launcher; browsers: FakeBrowser[] } {
  const browsers: FakeBrowser[] = [];
  const launch: Launcher = () => {
    const b = new FakeBrowser();
    browsers.push(b);
    return Promise.resolve(b);
  };
  return { launch, browsers };
}

describe('BrowserPool', () => {
  it('leases an isolated context+page navigated to the url', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const lease = await pool.acquire('http://localhost:3000/dashboard');

    expect(lease.sessionId).toBe('s1');
    expect(lease.url).toBe('http://localhost:3000/dashboard');
    expect(pool.activeCount()).toBe(1);
    expect(browsers).toHaveLength(1);
    expect(browsers[0]?.contexts[0]?.pages[0]?.gotoUrls).toEqual([
      'http://localhost:3000/dashboard',
    ]);
  });

  it('reuses one browser across many leases; each context is isolated', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 8, genSessionId: counterIds() });

    const a = await pool.acquire('http://localhost:3000/a');
    const b = await pool.acquire('http://localhost:3000/b');

    expect(browsers).toHaveLength(1); // ONE browser
    expect(browsers[0]?.contexts).toHaveLength(2); // TWO contexts
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(pool.activeCount()).toBe(2);
  });

  it('leaseIdOnOrigin names the public id of a lease already on that origin', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const a = await pool.acquire('http://localhost:3000/a');
    await pool.acquire('http://localhost:4000/other');
    expect(pool.leaseIdOnOrigin('http://localhost:3000')).toBe(a.sessionId);
    expect(pool.leaseIdOnOrigin('http://localhost:4000')).toBe('s2');
    expect(pool.leaseIdOnOrigin('http://localhost:9999')).toBeUndefined();

    pool.alias('app-name', a.sessionId);
    expect(pool.leaseIdOnOrigin('http://localhost:3000')).toBe('app-name');
  });

  it('release frees the slot and closes the context', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const lease = await pool.acquire('http://localhost:3000/');
    const ctx = browsers[0]?.contexts[0];
    await lease.release();

    expect(pool.activeCount()).toBe(0);
    expect(ctx?.closed).toBe(true);
  });

  it('caps concurrency: over-cap acquires queue until a slot frees', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 2, genSessionId: counterIds() });

    const l1 = await pool.acquire('http://localhost:3000/1');
    const l2 = await pool.acquire('http://localhost:3000/2');
    expect(pool.activeCount()).toBe(2);

    // Third acquire can't proceed yet.
    const third = pool.acquire('http://localhost:3000/3');
    const settled = vi.fn();
    void third.then(settled);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(pool.queuedCount()).toBe(1);

    // Free a slot → the queued acquire proceeds.
    await l2.release();
    const l3 = await third;
    expect(l3.sessionId).toBeDefined();
    expect(pool.activeCount()).toBe(2);
    expect(pool.queuedCount()).toBe(0);

    await l1.release();
    await l3.release();
  });

  it('concurrent burst respects the cap — slots are claimed synchronously at the gate', async () => {
    // The "10 agents at once" case: many acquires race through the gate in the same tick. The cap
    // must still hold (regression guard — a non-atomic check let them all slip through before).
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 2, genSessionId: counterIds() });

    const acquires = Array.from({ length: 6 }, () => pool.acquire('http://localhost:3000/'));
    await new Promise((r) => setTimeout(r, 0)); // flush all microtasks

    // Only the cap may be active; the rest must be queued — NOT all 6 active.
    expect(pool.activeCount()).toBe(2);
    expect(pool.queuedCount()).toBe(4);

    // Drain release-on-resolve; after the first release exactly one queued acquire promotes (cap
    // still holds at 2), and by the end nothing leaks.
    let released = 0;
    for (const acquired of acquires) {
      const lease = await acquired;
      await lease.release();
      released += 1;
      await new Promise((r) => setTimeout(r, 0));
      if (1 === released) {
        expect(pool.activeCount()).toBe(2);
        expect(pool.queuedCount()).toBe(3);
      }
    }
    expect(pool.activeCount()).toBe(0);
    expect(pool.queuedCount()).toBe(0);
  });

  it('relaunches the browser after a crash; prior leases are dropped', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    await pool.acquire('http://localhost:3000/');
    expect(pool.activeCount()).toBe(1);

    browsers[0]?.crash();
    expect(pool.activeCount()).toBe(0); // dead leases dropped

    await pool.acquire('http://localhost:3000/again');
    expect(browsers).toHaveLength(2); // a fresh browser was launched
    expect(pool.activeCount()).toBe(1);
  });

  it('does not resurrect a lease when the browser crashes DURING goto (occupancy stays consistent)', async () => {
    // The race: onDisconnected fires (clearing #active, zeroing #occupied) while an in-flight acquire's
    // goto is resolving. If that acquire then registered its lease, it would resurrect a dead entry with
    // the slot count out of sync — drifting below #active.size and eventually exceeding the cap.
    const browsers: FakeBrowser[] = [];
    let crashDuringGoto = false;
    const launch: Launcher = () => {
      const b = new FakeBrowser();
      const realNewContext = b.newContext.bind(b);
      b.newContext = async (): Promise<PooledContext> => {
        const c = await realNewContext();
        const realNewPage = c.newPage.bind(c);
        c.newPage = async (): Promise<PooledPage> => {
          const p = await realNewPage();
          const realGoto = p.goto.bind(p);
          p.goto = (url: string): Promise<unknown> => {
            if (crashDuringGoto) b.crash(); // the browser dies while we "navigate"
            return realGoto(url);
          };
          return p;
        };
        return c;
      };
      browsers.push(b);
      return Promise.resolve(b);
    };
    const pool = new BrowserPool(launch, { maxContexts: 2, genSessionId: counterIds() });

    await pool.acquire('http://x/a'); // browser up, one live lease
    crashDuringGoto = true;
    await expect(pool.acquire('http://x/b')).rejects.toThrow(/crashed/);

    // Crash reset occupancy to 0 and dropped the first lease; the failed acquire left no phantom entry.
    expect(pool.activeCount()).toBe(0);

    // Occupancy is not corrupted: a fresh acquire (relaunch) still succeeds within the cap.
    crashDuringGoto = false;
    const lease = await pool.acquire('http://x/c');
    expect(lease.sessionId).toBeDefined();
    expect(pool.activeCount()).toBe(1);
  });

  it('sweepExpired reclaims a lease untouched past the TTL; touch keeps it alive', async () => {
    const { launch } = fakeLauncher();
    let clock = 1000;
    const pool = new BrowserPool(launch, {
      maxContexts: 4,
      genSessionId: counterIds(),
      now: () => clock,
      leaseTtlMs: 500,
    });

    const stale = await pool.acquire('http://localhost:3000/stale');
    const fresh = await pool.acquire('http://localhost:3000/fresh');
    expect(pool.activeCount()).toBe(2);

    // Advance past the TTL, but touch only the fresh lease.
    clock += 600;
    pool.touch(fresh.sessionId);

    const reclaimed = await pool.sweepExpired();
    expect(reclaimed).toEqual([stale.sessionId]);
    expect(pool.activeCount()).toBe(1);
    expect(pool.leasedSessionIds()).toEqual([fresh.sessionId]);
  });

  /**
   * An app that names its own session must not have its lease reaped out from under it.
   *
   * The pool keys leases by the id it navigated with. The SDK usually adopts that id off the URL, so
   * the two agree — but an app passing an explicit `session` to `connect()` keeps its own name, which
   * is legitimate and what a single-app fixture does deliberately. The lease tool resolves to the
   * name the app actually registered, because that is the one the agent has to drive with, and from
   * then on every tool call touches THAT name.
   *
   * Without an alias those touches hit nothing. The lease then ages out at the TTL despite continuous
   * activity and the reaper closes the context mid-flow, which is exactly the failure reported in
   * https://github.com/reticlehq/reticle/issues/157: a session dying on the very next call that would
   * have read a computed value, with the measurement lost.
   */
  it('touching a lease by the name the APP registered keeps it alive', async () => {
    const { launch } = fakeLauncher();
    let clock = 1000;
    const pool = new BrowserPool(launch, {
      maxContexts: 4,
      genSessionId: counterIds(),
      now: () => clock,
      leaseTtlMs: 500,
    });

    const lease = await pool.acquire('http://localhost:3100/', { sessionId: 'lease-abc' });
    // The app kept its own name; the lease tool reports that one to the agent.
    pool.alias('next-smoke', lease.sessionId);

    clock += 600;
    pool.touch('next-smoke');

    expect(
      await pool.sweepExpired(),
      'activity under the registered name is still activity',
    ).toEqual([]);
    expect(pool.activeCount()).toBe(1);
  });

  it('an alias releases the lease it points at', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });
    const lease = await pool.acquire('http://localhost:3100/', { sessionId: 'lease-xyz' });
    pool.alias('next-smoke', lease.sessionId);

    await pool.release('next-smoke');
    expect(pool.activeCount(), 'releasing by the name the agent was given must work').toBe(0);
  });

  it('an unknown alias touches nothing rather than throwing', () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });
    expect(() => pool.touch('never-seen')).not.toThrow();
  });

  it('sweepExpired reclaiming a lease frees the slot for a queued acquire', async () => {
    const { launch } = fakeLauncher();
    let clock = 0;
    const pool = new BrowserPool(launch, {
      maxContexts: 1,
      genSessionId: counterIds(),
      now: () => clock,
      leaseTtlMs: 100,
    });

    await pool.acquire('http://localhost:3000/1');
    const queued = pool.acquire('http://localhost:3000/2'); // waits for a slot
    expect(pool.queuedCount()).toBe(1);

    clock += 200; // first lease goes stale
    await pool.sweepExpired();

    const l2 = await queued; // the reaped slot lets the queued acquire proceed
    expect(l2.sessionId).toBeDefined();
    expect(pool.activeCount()).toBe(1);
  });

  it('acquire after shutdown rejects (no zombie browser relaunch)', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 2, genSessionId: counterIds() });
    await pool.acquire('http://localhost:3000/');
    await pool.shutdown();
    await expect(pool.acquire('http://localhost:3000/')).rejects.toThrow(/shut down/);
    expect(browsers).toHaveLength(1); // no second browser launched after shutdown
  });

  it('shutdown rejects queued (over-cap) acquires instead of relaunching for them', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 1, genSessionId: counterIds() });
    await pool.acquire('http://localhost:3000/1'); // fills the single slot
    const queued = pool.acquire('http://localhost:3000/2'); // waits
    const rejected = vi.fn();
    queued.catch(rejected);
    await pool.shutdown();
    await Promise.resolve();
    await expect(queued).rejects.toThrow(/shut down/);
  });

  it('aborting a queued acquire removes it from the queue (no slot leak)', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 1, genSessionId: counterIds() });
    const held = await pool.acquire('http://localhost:3000/held');
    const controller = new AbortController();
    const aborted = pool.acquire('http://localhost:3000/aborted', { signal: controller.signal });
    expect(pool.queuedCount()).toBe(1);
    controller.abort();
    await expect(aborted).rejects.toThrow(/aborted/);
    expect(pool.queuedCount()).toBe(0); // the aborted waiter is gone, not lingering

    // Releasing the held lease must hand the slot to a real new acquire — not waste it on the
    // abandoned one. A fresh acquire succeeds and reaches full capacity.
    await held.release();
    const fresh = await pool.acquire('http://localhost:3000/fresh');
    expect(fresh.sessionId).toBeDefined();
    expect(pool.activeCount()).toBe(1);
  });

  it('removes the abort handler from the signal after a successful acquire', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 1, genSessionId: counterIds() });
    const held = await pool.acquire('http://localhost:3000/held');

    const controller = new AbortController();
    const queued = pool.acquire('http://localhost:3000/queued', { signal: controller.signal });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

    await held.release();
    const lease = await queued;
    expect(lease.sessionId).toBeDefined();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('removes the abort handler when the pool shuts down while waiting', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 1, genSessionId: counterIds() });
    await pool.acquire('http://localhost:3000/held');

    const controller = new AbortController();
    const queued = pool.acquire('http://localhost:3000/queued', { signal: controller.signal });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

    await pool.shutdown();
    await expect(queued).rejects.toThrow(/shut down/);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('a single page crash reclaims ONLY that lease; the fleet survives', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });
    await pool.acquire('http://localhost:3000/a');
    const b = await pool.acquire('http://localhost:3000/b');
    expect(pool.activeCount()).toBe(2);

    // Crash A's page — a single renderer dying must not take down the shared browser or B.
    const ctxA = browsers[0]?.contexts[0];
    ctxA?.pages[0]?.crash();
    await new Promise((r) => setTimeout(r, 0)); // let the async release settle

    expect(pool.activeCount()).toBe(1);
    expect(pool.leasedSessionIds()).toEqual([b.sessionId]); // B survives
    expect(browsers).toHaveLength(1); // browser NOT relaunched (it didn't die)
    expect(ctxA?.closed).toBe(true); // A's context was closed
  });

  it('a navigation timeout fails only its own lease and frees the slot', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 2, genSessionId: counterIds() });
    await pool.acquire('http://localhost:3000/ok'); // launches the browser, succeeds

    const browser = browsers[0];
    if (browser !== undefined) browser.failNav = true;
    await expect(pool.acquire('http://localhost:3000/hangs')).rejects.toThrow('nav timeout');
    expect(pool.activeCount()).toBe(1); // the good lease is untouched; the bad one didn't leak a slot

    if (browser !== undefined) browser.failNav = false;
    const ok = await pool.acquire('http://localhost:3000/ok2'); // the freed slot is reusable
    expect(ok.sessionId).toBeDefined();
    expect(pool.activeCount()).toBe(2);
  });

  it('a failed context setup frees the slot (queue not deadlocked)', async () => {
    let calls = 0;
    const launch: Launcher = () => {
      const b = new FakeBrowser();
      // Make the first newContext throw, the rest succeed.
      const realNew = b.newContext.bind(b);
      b.newContext = (): Promise<PooledContext> => {
        calls += 1;
        if (1 === calls) return Promise.reject(new Error('context boom'));
        return realNew();
      };
      return Promise.resolve(b);
    };
    const pool = new BrowserPool(launch, { maxContexts: 1, genSessionId: counterIds() });

    await expect(pool.acquire('http://localhost:3000/')).rejects.toThrow('context boom');
    expect(pool.activeCount()).toBe(0);
    // Slot was freed → a subsequent acquire still works.
    const ok = await pool.acquire('http://localhost:3000/ok');
    expect(ok.sessionId).toBeDefined();
  });

  it('shutdown closes a browser whose launch was in-flight (no orphaned Chromium)', async () => {
    let resolveDelayed: ((b: FakeBrowser) => void) | undefined;
    const browsers: FakeBrowser[] = [];
    const launch: Launcher = () =>
      new Promise<PooledBrowser>((resolve) => {
        const b = new FakeBrowser();
        browsers.push(b);
        resolveDelayed = resolve;
      });
    const pool = new BrowserPool(launch, { maxContexts: 2, genSessionId: counterIds() });

    const acquiring = pool.acquire('http://localhost:3000/slow');
    await Promise.resolve(); // the launch is now in flight

    const shutdownDone = pool.shutdown();
    expect(resolveDelayed).toBeDefined();

    // The launch completes AFTER shutdown was called.
    resolveDelayed?.(browsers[0] as FakeBrowser);
    await shutdownDone;

    // The browser that resolved after shutdown must have been closed.
    expect(browsers[0]?.isConnected()).toBe(false);
    await expect(acquiring).rejects.toThrow();
  });
});
