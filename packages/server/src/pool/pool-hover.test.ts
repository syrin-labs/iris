/**
 * Hovering a leased page.
 *
 * A lease IS a real browser page, so a native mouse move was always available — hover simply had no
 * route to it and dispatched a synthetic mouseover that reported dispatched/settled while CSS
 * `:hover` never applied. The pool now exposes the same optional-capability pattern as capture:
 * a page that cannot move a pointer must read as "could not hover", never as a successful dispatch.
 */
import { describe, expect, it, vi } from 'vitest';
import { BrowserPool } from './browser-pool.js';
import type { Launcher, PooledPage } from './browser-pool.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** A launcher whose pages can hover, unless `hover` is deliberately omitted. */
const launcher = (page: Partial<Record<keyof PooledPage, unknown>> = {}): Launcher => {
  const full = {
    goto: () => Promise.resolve(),
    close: () => Promise.resolve(),
    onCrash: () => undefined,
    screenshot: () => Promise.resolve(PNG),
    hover: () => Promise.resolve(),
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

describe('hovering a lease', () => {
  it('moves the pointer to the given coordinates', async () => {
    const hover = vi.fn(() => Promise.resolve());
    const pool = poolWith({ hover });
    const lease = await pool.acquire('http://app.test/');
    expect(await pool.hoverLease(lease.sessionId, 120, 40)).toBe(true);
    expect(hover).toHaveBeenCalledWith(120, 40);
    await pool.shutdown();
  });

  it('answers false for a session that is not a lease', async () => {
    const pool = poolWith();
    expect(await pool.hoverLease('s-somebody-elses-tab', 1, 1)).toBe(false);
    await pool.shutdown();
  });

  it('answers false when the page cannot move a pointer, rather than claiming the hover landed', async () => {
    const pool = poolWith({ hover: undefined });
    const lease = await pool.acquire('http://app.test/');
    expect(await pool.hoverLease(lease.sessionId, 10, 10)).toBe(false);
    await pool.shutdown();
  });

  it('survives a hover that throws, and leaves the lease usable', async () => {
    let calls = 0;
    const pool = poolWith({
      hover: () => {
        calls += 1;
        return 1 === calls ? Promise.reject(new Error('renderer busy')) : Promise.resolve();
      },
    });
    const lease = await pool.acquire('http://app.test/');
    expect(await pool.hoverLease(lease.sessionId, 1, 1)).toBe(false);
    expect(await pool.hoverLease(lease.sessionId, 1, 1)).toBe(true);
    await pool.shutdown();
  });

  it('touches the lease, so hovering keeps it alive', async () => {
    let now = 1000;
    const pool = new BrowserPool(launcher(), {
      maxContexts: 2,
      genSessionId: ids,
      now: () => now,
      leaseTtlMs: 500,
    });
    const lease = await pool.acquire('http://app.test/');
    now += 400;
    await pool.hoverLease(lease.sessionId, 1, 1);
    now += 400;
    expect(await pool.sweepExpired(), 'still alive because hovering touched it').toEqual([]);
    await pool.shutdown();
  });
});
