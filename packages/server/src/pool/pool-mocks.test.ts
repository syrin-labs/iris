/**
 * Mocking the network on a leased page.
 *
 * A lease IS a Playwright-owned page, so CDP intercept was always available — `reticle_network_mock`
 * simply had no route to it and answered `no-cdp-provider` for the isolated context the docs point
 * agents at. The pool now exposes the same optional-capability pattern as capture and hover: a page
 * that cannot install routes must read as "could not mock", never as a stub that did not apply.
 */
import { describe, expect, it, vi } from 'vitest';
import { BrowserPool } from './browser-pool.js';
import type { Launcher, PooledPage } from './browser-pool.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** A launcher whose pages can install mocks, unless `installMocks` is deliberately omitted. */
const launcher = (page: Partial<Record<keyof PooledPage, unknown>> = {}): Launcher => {
  const full = {
    goto: () => Promise.resolve(),
    close: () => Promise.resolve(),
    onCrash: () => undefined,
    screenshot: () => Promise.resolve(PNG),
    installMocks: () => Promise.resolve(),
    ...page,
  } as PooledPage;
  return () =>
    Promise.resolve({
      newContext: () =>
        Promise.resolve({
          newPage: () => Promise.resolve(full),
          close: () => Promise.resolve(),
        }),
      close: () => Promise.resolve(),
      onDisconnected: (): void => undefined,
      isConnected: (): boolean => true,
    });
};

let seq = 0;
const ids = (): string => `lease-${String((seq += 1))}`;

const poolWith = (page?: Partial<Record<keyof PooledPage, unknown>>): BrowserPool =>
  new BrowserPool(launcher(page), { maxContexts: 2, genSessionId: ids });

describe('mocking the network on a lease', () => {
  it('installs the rules on the leased page', async () => {
    const installMocks = vi.fn(() => Promise.resolve());
    const pool = poolWith({ installMocks });
    const lease = await pool.acquire('http://app.test/');
    const rules = [{ urlContains: '/api/pay', status: 500 }];
    expect(await pool.setMocksLease(lease.sessionId, rules)).toBe(true);
    expect(installMocks).toHaveBeenCalledWith(rules);
    await pool.shutdown();
  });

  it('answers false for a session that is not a lease', async () => {
    const pool = poolWith();
    expect(await pool.setMocksLease('s-somebody-elses-tab', [{ urlContains: '/x' }])).toBe(false);
    await pool.shutdown();
  });

  it('answers false when the page cannot intercept, rather than claiming the stub applied', async () => {
    const pool = poolWith({ installMocks: undefined });
    const lease = await pool.acquire('http://app.test/');
    expect(await pool.setMocksLease(lease.sessionId, [{ urlContains: '/x' }])).toBe(false);
    await pool.shutdown();
  });

  it('survives an install that throws, and leaves the lease usable', async () => {
    let calls = 0;
    const pool = poolWith({
      installMocks: () => {
        calls += 1;
        return 1 === calls ? Promise.reject(new Error('renderer busy')) : Promise.resolve();
      },
    });
    const lease = await pool.acquire('http://app.test/');
    expect(await pool.setMocksLease(lease.sessionId, [])).toBe(false);
    expect(await pool.setMocksLease(lease.sessionId, [])).toBe(true);
    await pool.shutdown();
  });

  it('touches the lease, so mocking keeps it alive', async () => {
    let now = 1000;
    const pool = new BrowserPool(launcher(), {
      maxContexts: 2,
      genSessionId: ids,
      now: () => now,
      leaseTtlMs: 500,
    });
    const lease = await pool.acquire('http://app.test/');
    now += 400;
    await pool.setMocksLease(lease.sessionId, []);
    now += 400;
    expect(await pool.sweepExpired(), 'still alive because mocking touched it').toEqual([]);
    await pool.shutdown();
  });
});
