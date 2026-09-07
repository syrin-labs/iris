/**
 * Capturing a leased page.
 *
 * A lease IS a real browser page, so the pixels were always available — the visual tools simply had
 * no route to them and answered "no provider" for every context an agent can actually acquire. That
 * made visual regression impossible on exactly the isolated contexts the pool exists to hand out.
 */
import { describe, expect, it, vi } from 'vitest';
import { BrowserPool } from './browser-pool.js';
import type { Launcher, PooledPage } from './browser-pool.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** A launcher whose pages capture, unless `screenshot` is deliberately omitted. */
const launcher = (page: Partial<Record<keyof PooledPage, unknown>> = {}): Launcher => {
  const full = {
    goto: () => Promise.resolve(),
    close: () => Promise.resolve(),
    onCrash: () => undefined,
    screenshot: () => Promise.resolve(PNG),
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
      // The pool reclaims the fleet when the browser dies; a fake must offer the hook or acquire
      // throws before any of this file's subject matter runs.
      onDisconnected: (): void => undefined,
      isConnected: (): boolean => true,
    });
};

let seq = 0;
const ids = (): string => `lease-${String((seq += 1))}`;

const poolWith = (page?: Partial<Record<keyof PooledPage, unknown>>): BrowserPool =>
  new BrowserPool(launcher(page), { maxContexts: 2, genSessionId: ids });

describe('capturing a lease', () => {
  it('returns the page’s pixels', async () => {
    const pool = poolWith();
    const lease = await pool.acquire('http://app.test/');
    expect(await pool.screenshotLease(lease.sessionId)).toEqual(PNG);
    await pool.shutdown();
  });

  it('passes fullPage through rather than silently ignoring it', async () => {
    const screenshot = vi.fn(() => Promise.resolve(PNG));
    const pool = poolWith({ screenshot });
    const lease = await pool.acquire('http://app.test/');
    await pool.screenshotLease(lease.sessionId, { fullPage: true });
    expect(screenshot).toHaveBeenCalledWith({ fullPage: true });
    await pool.shutdown();
  });

  it('answers undefined for a session that is not a lease', async () => {
    const pool = poolWith();
    expect(await pool.screenshotLease('s-somebody-elses-tab')).toBeUndefined();
    await pool.shutdown();
  });

  it('answers undefined when the page cannot capture, rather than a blank image', async () => {
    // A blank image is the dangerous degradation: a visual diff would compare against it and pass.
    const pool = poolWith({ screenshot: undefined });
    const lease = await pool.acquire('http://app.test/');
    expect(await pool.screenshotLease(lease.sessionId)).toBeUndefined();
    await pool.shutdown();
  });

  it('survives a capture that throws, and leaves the lease usable', async () => {
    // Losing a working context to one bad frame is worse than reporting "could not capture".
    let calls = 0;
    const pool = poolWith({
      screenshot: () => {
        calls += 1;
        return 1 === calls ? Promise.reject(new Error('renderer busy')) : Promise.resolve(PNG);
      },
    });
    const lease = await pool.acquire('http://app.test/');
    expect(await pool.screenshotLease(lease.sessionId)).toBeUndefined();
    expect(await pool.screenshotLease(lease.sessionId)).toEqual(PNG);
    await pool.shutdown();
  });

  it('touches the lease, so capturing keeps it alive', async () => {
    // Otherwise the reaper can take the context out from under a diff that is mid-flight.
    let now = 1000;
    const pool = new BrowserPool(launcher(), {
      maxContexts: 2,
      genSessionId: ids,
      now: () => now,
      leaseTtlMs: 500,
    });
    const lease = await pool.acquire('http://app.test/');
    now += 400;
    await pool.screenshotLease(lease.sessionId);
    now += 400;
    expect(await pool.sweepExpired(), 'still alive because capturing touched it').toEqual([]);
    await pool.shutdown();
  });
});
