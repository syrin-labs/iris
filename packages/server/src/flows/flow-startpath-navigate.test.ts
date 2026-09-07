/**
 * Replay's half of the FlowFile contract: `startPath` says replay navigates there before step 1.
 * These pin the navigate-then-replay behaviour — that replay dispatches the navigation itself,
 * continues on the session the SDK reconnects as, and degrades to the wrong-page hint (never a
 * hang, never someone else's tab) when arrival cannot be confirmed.
 */

import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  FLOW_FILE_VERSION,
  RETICLE_URL_PARAM,
  QueryBy,
  ReticleCommand,
  type CommandResult,
  type FlowFile,
} from '@reticlehq/core';
import { arriveAtStartPath } from './flow-replay-run.js';
import type { SessionManager } from '../session/session-manager.js';
import type { Session } from '../session/session.js';

const flow = (startPath?: string): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name: 'sign-in',
  createdAt: 1,
  steps: [{ tool: 'reticle_act', anchor: { kind: AnchorKind.TESTID, value: 'submit' } }],
  ...(startPath === undefined ? {} : { startPath }),
});

interface NavCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * A connected tab that accepts (or refuses) a NAVIGATE and records what it was sent.
 *
 * `stepOnPage` answers the QUERY `arriveAtStartPath` now runs first — "can step 1 start from here?".
 * It defaults FALSE, which is the situation these cases are about: the tab is on the wrong route AND
 * the flow's first anchor is not on it, so the navigation is the thing that helps. The true case has
 * its own test below, because it is the one that used to navigate and must no longer.
 */
function tab(
  url: string | undefined,
  options: { accepted?: boolean; stepOnPage?: boolean } = {},
): {
  calls: NavCall[];
  session: {
    id: string;
    url?: string;
    eventsSince: () => never[];
    command: (name: string, args?: Record<string, unknown>) => Promise<CommandResult>;
  };
} {
  const calls: NavCall[] = [];
  return {
    calls,
    session: {
      id: 'old',
      ...(url === undefined ? {} : { url }),
      eventsSince: () => [],
      command: (name: string, args: Record<string, unknown> = {}) => {
        calls.push({ name, args });
        if (name === ReticleCommand.QUERY) {
          return Promise.resolve({
            kind: 'command_result',
            id: 'q',
            ok: true,
            result: { elements: true === options.stepOnPage ? [{ ref: 'e1' }] : [] },
          } as CommandResult);
        }
        return Promise.resolve({
          kind: 'command_result',
          id: 'n',
          ok: true,
          result: { ok: options.accepted ?? true },
        } as CommandResult);
      },
    },
  };
}

/**
 * A manager whose `resolve('old')` answers from a script, one entry per look — mirroring the
 * tombstone rebind: first the still-registered old tab, later the successor on the new page.
 */
function manager(resolutionsOverTime: (Partial<Session> | undefined)[]): SessionManager {
  let look = 0;
  return {
    resolve: () => {
      const found = resolutionsOverTime[Math.min(look, resolutionsOverTime.length - 1)];
      look++;
      if (found === undefined) throw new Error('no connected session');
      return found as Session;
    },
  } as unknown as SessionManager;
}

/** A clock that advances only when slept on — deterministic and instant, as navigate-arrival's. */
function instantClock(step: number): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: () => {
      t += step;
      return Promise.resolve();
    },
  };
}

const successor = (url: string): Partial<Session> => ({ id: 'fresh', url, eventsSince: () => [] });

describe('arriveAtStartPath — replay navigates to the flow start page before step 1', () => {
  it('dispatches the navigation and returns the session the SDK reconnects as', async () => {
    const { calls, session } = tab('http://localhost:3000/reset-password');
    const fresh = successor('http://localhost:3000/login');
    const sessions = manager([session, fresh]);
    const arrived = await arriveAtStartPath(
      sessions,
      session,
      flow('/login'),
      5_000,
      instantClock(100),
    );
    expect(arrived).toBe(fresh);
    // The QUERY that establishes step 1 cannot start here comes first; the navigation follows it.
    expect(calls).toEqual([
      { name: ReticleCommand.QUERY, args: { by: QueryBy.TESTID, value: 'submit' } },
      { name: ReticleCommand.NAVIGATE, args: { url: 'http://localhost:3000/login' } },
    ]);
  });

  it('does nothing when the tab already sits on the start page', async () => {
    const { calls, session } = tab('http://localhost:3000/login');
    const arrived = await arriveAtStartPath(manager([]), session, flow('/login'));
    expect(arrived).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('does nothing for a flow with no startPath (back-compat)', async () => {
    const { calls, session } = tab('http://localhost:3000/anywhere');
    const arrived = await arriveAtStartPath(manager([]), session, flow());
    expect(arrived).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('never navigates blind: an unobservable current route stays put', async () => {
    const { calls, session } = tab(undefined);
    const arrived = await arriveAtStartPath(manager([]), session, flow('/login'));
    expect(arrived).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('falls back (undefined) when the browser refuses the navigation', async () => {
    const { calls, session } = tab('http://localhost:3000/reset-password', { accepted: false });
    const arrived = await arriveAtStartPath(manager([]), session, flow('/login'));
    expect(arrived).toBeUndefined();
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toHaveLength(1);
  });

  it('gives up after the window rather than hanging when the SDK never reconnects', async () => {
    const { session } = tab('http://localhost:3000/reset-password');
    // resolve keeps answering the old tab, still on the old page — arrival never happens.
    const sessions = manager([session]);
    const arrived = await arriveAtStartPath(
      sessions,
      session,
      flow('/login'),
      500,
      instantClock(100),
    );
    expect(arrived).toBeUndefined();
  });

  it('keeps waiting through the teardown gap where the old id resolves to nothing yet', async () => {
    const { session } = tab('http://localhost:3000/reset-password');
    const fresh = successor('http://localhost:3000/login');
    const sessions = manager([session, undefined, undefined, fresh]);
    const arrived = await arriveAtStartPath(
      sessions,
      session,
      flow('/login'),
      5_000,
      instantClock(100),
    );
    expect(arrived).toBe(fresh);
  });

  // The regression this guard exists for, found by the benchmark rather than by a test.
  //
  // Two saved flows with IDENTICAL steps, replayed in one suite: the first passed, the second failed
  // on step 1 with `testid "nav-diagnostics" not found` and named the sidebar component holding it —
  // a correct sentence about a file that was completely fine. The first replay had left the tab on
  // another route, so the second navigated "back" to its startPath; the page load dropped the login,
  // and the anchor really was gone, from the login screen. The anchor had been on the page the whole
  // time, in a sidebar that renders on every route. Navigating could only hurt, and did.
  it('does not navigate when step 1 can already start from this page', async () => {
    const { calls, session } = tab('http://localhost:3000/diagnostics', { stepOnPage: true });
    const arrived = await arriveAtStartPath(manager([]), session, flow('/'));
    expect(arrived).toBeUndefined();
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toEqual([]);
  });

  // The other half of the same rule: a query that cannot answer is not evidence the page is fine.
  // "Cannot tell" keeps the navigation, which is what this did before the guard existed.
  it('still navigates when the page cannot be asked', async () => {
    const { calls, session } = tab('http://localhost:3000/elsewhere');
    const fresh = successor('http://localhost:3000/login');
    const arrived = await arriveAtStartPath(
      manager([session, fresh]),
      session,
      flow('/login'),
      5_000,
      instantClock(100),
    );
    expect(arrived).toBe(fresh);
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toHaveLength(1);
  });

  it('carries a leased tab’s identity params so the navigation cannot strand the lease', async () => {
    const leased = `http://localhost:3000/?${RETICLE_URL_PARAM.SESSION}=lease-1`;
    const { calls, session } = tab(leased);
    const fresh = successor(`http://localhost:3000/checkout?${RETICLE_URL_PARAM.SESSION}=lease-1`);
    const sessions = manager([session, fresh]);
    const arrived = await arriveAtStartPath(
      sessions,
      session,
      flow('/checkout'),
      5_000,
      instantClock(100),
    );
    expect(arrived).toBe(fresh);
    const sent = String(calls.find((c) => c.name === ReticleCommand.NAVIGATE)?.args['url']);
    expect(sent).toContain('/checkout');
    expect(sent).toContain(`${RETICLE_URL_PARAM.SESSION}=lease-1`);
  });
});
