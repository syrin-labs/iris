/**
 * A caller that says how long it will wait should be made to wait, not refused instantly.
 */

import { describe, expect, it } from 'vitest';
import { resolveSessionWithin, type ResolvableSessions } from './resolve-within.js';

const SESSION = { id: 'live' };
const NO_SESSION =
  'no browser session connected. NEXT ACTION: run `reticle open http://localhost:5173`';

/** A clock that only moves when the code under test sleeps. No real time passes. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

/** Empty until `appearsAfter` resolve attempts, then a session is there. */
function sessions(appearsAfter: number): ResolvableSessions<typeof SESSION> & { calls: number } {
  const state = {
    calls: 0,
    count: () => (state.calls >= appearsAfter ? 1 : 0),
    resolve: () => {
      state.calls += 1;
      if (state.calls > appearsAfter) return SESSION;
      throw new Error(NO_SESSION);
    },
  };
  return state;
}

describe('resolving a session within the caller’s budget', () => {
  it('returns immediately when one is already connected', async () => {
    const s = sessions(0);
    await expect(resolveSessionWithin(s, undefined, 5_000, fakeClock())).resolves.toBe(SESSION);
    expect(s.calls).toBe(1);
  });

  it('waits for a session that arrives inside the budget', async () => {
    const s = sessions(3);
    await expect(resolveSessionWithin(s, undefined, 30_000, fakeClock())).resolves.toBe(SESSION);
    expect(s.calls).toBeGreaterThan(1);
  });

  // The budget is the caller's only instruction. Ignoring it was the defect.
  it('refuses instantly when no budget was given', async () => {
    const s = sessions(3);
    await expect(resolveSessionWithin(s, undefined, 0, fakeClock())).rejects.toThrow(NO_SESSION);
    expect(s.calls).toBe(1);
  });

  /**
   * The error carries the daemon's whole diagnosis — the port scan, the next action, the literal
   * command. It is the most valuable string the product emits to an agent with nothing connected,
   * and a wait that expires must not trade it for a stopwatch reading.
   */
  it('throws the original diagnosis on expiry, not a timeout message', async () => {
    const s = sessions(Number.MAX_SAFE_INTEGER);
    await expect(resolveSessionWithin(s, undefined, 1_000, fakeClock())).rejects.toThrow(
      /NEXT ACTION/,
    );
  });

  it('gives up once the budget is spent rather than polling forever', async () => {
    const s = sessions(Number.MAX_SAFE_INTEGER);
    await expect(resolveSessionWithin(s, undefined, 1_000, fakeClock())).rejects.toThrow();
    // 1000ms of budget at a 250ms poll is a bounded number of attempts, whatever the machine does.
    expect(s.calls).toBeLessThanOrEqual(6);
  });

  /**
   * A named session that is not connected while OTHERS are is a typo, not a race. Waiting on it
   * would hide the mistake behind the timeout instead of reporting it.
   */
  it('does not wait when other sessions are connected', async () => {
    const s: ResolvableSessions<typeof SESSION> = {
      count: () => 2,
      resolve: () => {
        throw new Error("no connected session with id 'typo'");
      },
    };
    await expect(resolveSessionWithin(s, 'typo', 30_000, fakeClock())).rejects.toThrow(/typo/);
  });
});
