/**
 * Lease tools: acquire stamps identity into the URL and returns a correlatable sessionId; release
 * frees the slot; both fail clearly when no pool is wired. A fake pool stands in for the real one.
 */

import { describe, expect, it } from 'vitest';
import { RETICLE_URL_PARAM } from '@reticlehq/core';
import {
  LEASE_TOOLS,
  appendReticleParams,
  cleanNavError,
  waitForLeasedSession,
} from './lease-tools.js';
import { ReticleTool } from './tool-names.js';
import type { ToolDeps } from './tool-kit.js';
import type { BrowserPool, Lease } from '../pool/browser-pool.js';

function tool(name: string): (deps: ToolDeps, args: Record<string, unknown>) => Promise<unknown> {
  const def = LEASE_TOOLS.find((t) => t.name === name);
  if (def === undefined) throw new Error(`no lease tool ${name}`);
  // Called on its own def rather than detached. `handler` is declared method-style (see tool-kit.ts),
  // so lifting the reference out drops the receiver — harmless for these handlers today, and exactly
  // the kind of thing that stops being harmless without warning.
  return (deps, args) => def.handler(deps, args);
}

/** A pool stub that records acquire calls and tracks active count. */
function fakePool(): {
  pool: BrowserPool;
  acquired: { url: string; sessionId: string | undefined }[];
  /** Every (registeredId, leaseId) pair the lease told the pool about. */
  aliased: [string, string][];
} {
  const acquired: { url: string; sessionId: string | undefined }[] = [];
  let active = 0;
  const released: string[] = [];
  const aliased: [string, string][] = [];
  const byOrigin = new Map<string, string>();
  const originOf = (url: string): string | undefined => {
    try {
      return new URL(url).origin;
    } catch {
      return undefined;
    }
  };
  const pool = {
    acquire(url: string, opts: { sessionId?: string } = {}): Promise<Lease> {
      acquired.push({ url, sessionId: opts.sessionId });
      active += 1;
      const sessionId = opts.sessionId ?? 'gen';
      const origin = originOf(url);
      if (origin !== undefined) byOrigin.set(origin, sessionId);
      return Promise.resolve({ sessionId, url, release: () => Promise.resolve() });
    },
    release(sessionId: string): Promise<void> {
      released.push(sessionId);
      active = Math.max(0, active - 1);
      for (const [origin, id] of byOrigin) {
        if (id === sessionId) byOrigin.delete(origin);
      }
      return Promise.resolve();
    },
    activeCount: () => active,
    queuedCount: () => 0,
    leasedSessionIds: () => [...byOrigin.values()],
    leaseTtlMs: () => 300_000,
    leaseIdOnOrigin: (origin: string) => byOrigin.get(origin),
    touch: () => undefined,
    alias: (registeredId: string, leaseId: string) => {
      aliased.push([registeredId, leaseId]);
    },
  } as unknown as BrowserPool;
  return { pool, acquired, aliased };
}

// A sessions stub where the leased tab is already "connected", so acquire's wait-for-ready resolves
// immediately (no real polling) in the happy path.
const baseDeps = { sessions: { get: () => ({ id: 'live' }) } } as unknown as ToolDeps;

describe('appendReticleParams', () => {
  it('adds the namespaced session (and project) params to a normal url', () => {
    const out = appendReticleParams('http://localhost:3000/dash', 'lease-1', 'acme');
    const u = new URL(out);
    expect(u.searchParams.get(RETICLE_URL_PARAM.SESSION)).toBe('lease-1');
    expect(u.searchParams.get(RETICLE_URL_PARAM.PROJECT)).toBe('acme');
    expect(u.pathname).toBe('/dash');
  });

  it('preserves existing query params', () => {
    const out = appendReticleParams('http://localhost:3000/?tab=2', 'lease-9');
    const u = new URL(out);
    expect(u.searchParams.get('tab')).toBe('2');
    expect(u.searchParams.get(RETICLE_URL_PARAM.SESSION)).toBe('lease-9');
    expect(u.searchParams.has(RETICLE_URL_PARAM.PROJECT)).toBe(false);
  });
});

describe('cleanNavError', () => {
  it('extracts the net:: code from a noisy Playwright goto error (ANSI + call log stripped)', () => {
    const raw = `page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5999/?__reticle_session=lease-x\nCall log:\n\u001b[2m  - navigating\u001b[22m`;
    expect(cleanNavError(new Error(raw))).toBe('net::ERR_CONNECTION_REFUSED');
  });

  it('reports a timeout plainly', () => {
    expect(cleanNavError(new Error('page.goto: Timeout 30000ms exceeded.'))).toBe(
      'navigation timed out',
    );
  });

  it('falls back to a trimmed first line without the url tail', () => {
    expect(cleanNavError(new Error('page.goto: something odd at http://x/y?z'))).toBe(
      'something odd',
    );
  });
});

describe('reticle_lease_acquire failure surfaces a clean message', () => {
  it('a navigation failure becomes "could not open <url> — is the app running?"', async () => {
    const pool = {
      acquire: () =>
        Promise.reject(new Error('page.goto: net::ERR_CONNECTION_REFUSED at http://x/')),
      activeCount: () => 0,
      queuedCount: () => 0,
    } as unknown as BrowserPool;
    await expect(
      tool(ReticleTool.LEASE_ACQUIRE)({ ...baseDeps, pool }, { url: 'http://localhost:3000/' }),
    ).rejects.toThrow(
      /could not open http:\/\/localhost:3000\/ — is the app running there\? \(net::ERR_CONNECTION_REFUSED\)/,
    );
  });
});

describe('reticle_lease_acquire preflights the browser (#400)', () => {
  it('refuses at the first call with the install fix when Chromium is absent, without a round trip', async () => {
    const { pool, acquired } = fakePool();
    await expect(
      tool(ReticleTool.LEASE_ACQUIRE)(
        { ...baseDeps, pool, browserProbe: () => Promise.resolve({ exists: false }) },
        { url: 'http://localhost:3000/' },
      ),
      // Carries "Chromium is not installed" so error-recovery routes it to the NO_POOL fix rather
      // than the misleading "is the app running?" a launch failure inside acquire would have produced.
    ).rejects.toThrow(/Chromium is not installed/);
    // The point of a PREflight: the pool was never asked to open anything.
    expect(acquired).toHaveLength(0);
  });

  it('proceeds normally when the probe says Chromium is present', async () => {
    const { pool, acquired } = fakePool();
    const result = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool, browserProbe: () => Promise.resolve({ exists: true }) },
      { url: 'http://localhost:3000/' },
    )) as { sessionId: string };
    expect(result.sessionId).toMatch(/^lease-/);
    expect(acquired).toHaveLength(1);
  });

  it('skips the preflight entirely when no probe is wired (unchanged default)', async () => {
    const { pool, acquired } = fakePool();
    await tool(ReticleTool.LEASE_ACQUIRE)({ ...baseDeps, pool }, { url: 'http://localhost:3000/' });
    expect(acquired).toHaveLength(1);
  });
});

describe('waitForLeasedSession', () => {
  it('resolves true as soon as the tab is connected (no waiting)', async () => {
    const sleeper = (): Promise<void> => Promise.reject(new Error('should not sleep'));
    await expect(waitForLeasedSession(() => true, sleeper)).resolves.toBe(true);
  });

  it('polls then resolves true once the tab connects', async () => {
    let calls = 0;
    const connected = (): boolean => ++calls >= 3; // connects on the 3rd check
    const noWait = (): Promise<void> => Promise.resolve();
    await expect(waitForLeasedSession(connected, noWait, 10, 0)).resolves.toBe(true);
  });

  it('resolves false after exhausting attempts (app has no SDK)', async () => {
    const noWait = (): Promise<void> => Promise.resolve();
    await expect(waitForLeasedSession(() => false, noWait, 5, 0)).resolves.toBe(false);
  });
});

describe('reticle_lease_acquire', () => {
  it('navigates to the app url with a stamped session and returns it ready', async () => {
    const { pool, acquired } = fakePool();
    const result = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      {
        url: 'http://localhost:3000/dashboard',
        projectId: 'acme',
      },
    )) as { sessionId: string; url: string; leased: number; ready: boolean };

    expect(result.sessionId).toMatch(/^lease-/);
    expect(result.url).toBe('http://localhost:3000/dashboard'); // clean url returned to the agent
    expect(result.ready).toBe(true); // the wait-for-connect resolved
    expect(result.leased).toBe(1);

    // The pool was navigated to the identity-stamped url, correlated to the returned sessionId.
    const navUrl = new URL(acquired[0]?.url ?? '');
    expect(navUrl.searchParams.get(RETICLE_URL_PARAM.SESSION)).toBe(result.sessionId);
    expect(navUrl.searchParams.get(RETICLE_URL_PARAM.PROJECT)).toBe('acme');
    expect(acquired[0]?.sessionId).toBe(result.sessionId);
  });

  it('reuses a live lease on the same origin rather than minting a second tab', async () => {
    // The reported case: acquire, the page needs a reload, acquire again. A second context
    // leaves both tabs connected and every later tool requires sessionId.
    const { pool, acquired } = fakePool();
    const first = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      { url: 'http://localhost:3000/dashboard' },
    )) as { sessionId: string; reused?: boolean };
    const second = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      { url: 'http://localhost:3000/settings' },
    )) as { sessionId: string; reused?: boolean; hint?: string; leased: number };

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.reused).toBe(true);
    expect(second.leased).toBe(1);
    expect(second.hint).toMatch(/already hold a lease on this origin/);
    expect(second.hint).toContain(first.sessionId);
    expect(acquired).toHaveLength(1);
  });

  it('mints a second lease when the first is on a different origin', async () => {
    const { pool, acquired } = fakePool();
    const first = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      { url: 'http://localhost:3000/' },
    )) as { sessionId: string };
    const second = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      { url: 'http://localhost:3001/' },
    )) as { sessionId: string; reused?: boolean };

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.reused).toBeUndefined();
    expect(acquired).toHaveLength(2);
    expect(pool.activeCount()).toBe(2);
  });

  it('releases a dead lease on this origin and mints a fresh one', async () => {
    const { pool, acquired } = fakePool();
    const first = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      { url: 'http://localhost:3000/' },
    )) as { sessionId: string };
    const sessions = {
      get: (id: string) => (id === first.sessionId ? undefined : { id }),
    };

    const second = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool, sessions } as unknown as ToolDeps,
      { url: 'http://localhost:3000/' },
    )) as { sessionId: string; reused?: boolean };

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.reused).toBeUndefined();
    expect(acquired).toHaveLength(2);
    expect(pool.activeCount()).toBe(1);
  });

  it('returns expiresInMs so the agent knows when the lease will die', async () => {
    const { pool } = fakePool();
    const result = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      { url: 'http://localhost:3000/' },
    )) as { expiresInMs: number };
    expect(result.expiresInMs).toBe(300_000);
  });

  it('carries versionSkew on a ready lease whose tab is skewed (#688)', async () => {
    const SKEW = 'version skew: the page is 2.2.1; this daemon is 2.4.1. run reticle update';
    const { pool } = fakePool();
    const sessions = {
      get: () => ({ id: 'live', versionSkew: SKEW }),
      all: () => [],
    };
    const result = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { sessions, pool } as unknown as ToolDeps,
      { url: 'http://localhost:3000/' },
    )) as { ready: boolean; versionSkew?: string };
    expect(result.ready).toBe(true);
    expect(result.versionSkew).toBe(SKEW);
  });

  it('throws a clear error when no pool is available', async () => {
    await expect(
      tool(ReticleTool.LEASE_ACQUIRE)(baseDeps, { url: 'http://localhost:3000/' }),
    ).rejects.toThrow(/pool unavailable/i);
  });

  it('requires a url', async () => {
    const { pool } = fakePool();
    await expect(tool(ReticleTool.LEASE_ACQUIRE)({ ...baseDeps, pool }, {})).rejects.toThrow(/url/);
  });
});

describe('reticle_lease_release', () => {
  it('releases by sessionId and reports the new leased count', async () => {
    const { pool } = fakePool();
    await tool(ReticleTool.LEASE_ACQUIRE)({ ...baseDeps, pool }, { url: 'http://localhost:3000/' });
    const acq = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      {
        url: 'http://localhost:3001/',
      },
    )) as { sessionId: string };
    expect(pool.activeCount()).toBe(2);

    const result = (await tool(ReticleTool.LEASE_RELEASE)(
      { ...baseDeps, pool },
      {
        sessionId: acq.sessionId,
      },
    )) as { released: boolean; leased: number };

    expect(result.released).toBe(true);
    expect(result.leased).toBe(1);
  });

  it('throws when no pool is available', async () => {
    await expect(
      tool(ReticleTool.LEASE_RELEASE)(baseDeps, { sessionId: 'lease-x' }),
    ).rejects.toThrow(/pool unavailable/i);
  });
});

describe('telling the human that the agent went somewhere invisible', () => {
  /**
   * Sessions stub with a watcher tab and a leased one, recording every narration posted.
   *
   * The selector is unit-tested next door; what is proved HERE is the wiring — that acquire and
   * release actually reach `pushNarration`. The reported bug was fifteen invisible tool calls, and a
   * correct selector nobody called would reproduce it exactly.
   */
  function depsWithWatcher(leasedIds: string[]): {
    deps: ToolDeps;
    narrations: { id: string; text: string }[];
  } {
    const narrations: { id: string; text: string }[] = [];
    const make = (id: string, projectId: string): unknown => ({
      id,
      projectId,
      pushNarration: (text: string) => narrations.push({ id, text }),
    });
    const watcher = make('s-human', 'acme');
    const leased = make('lease-1', 'acme');
    const { pool } = fakePool();
    const deps = {
      sessions: {
        all: () => [watcher, leased],
        get: (id: string) => ('s-human' === id ? watcher : leased),
      },
      pool: { ...pool, leasedSessionIds: () => leasedIds },
    } as unknown as ToolDeps;
    return { deps, narrations };
  }

  it("narrates into the human's tab on acquire, and not into the leased one", async () => {
    const { deps, narrations } = depsWithWatcher(['lease-1']);
    await tool(ReticleTool.LEASE_ACQUIRE)(deps, {
      url: 'http://localhost:3000/',
      projectId: 'acme',
    });
    expect(narrations.map((n) => n.id)).toEqual(['s-human']);
    expect(narrations[0]?.text).toContain('will not appear in this tab');
  });

  it('tells the tab it is live again once the LAST lease is released', async () => {
    const { deps, narrations } = depsWithWatcher(['lease-1']);
    await tool(ReticleTool.LEASE_RELEASE)(deps, { sessionId: 'lease-1' });
    expect(narrations.map((n) => n.text).join()).toContain('live again');
  });

  it('a narration that throws cannot fail the lease', async () => {
    // A courtesy to a person must never turn a working lease into a reported failure.
    const { pool } = fakePool();
    const deps = {
      sessions: {
        all: () => [{ id: 's-human', projectId: 'acme' }],
        get: () => ({
          id: 's-human',
          pushNarration: () => {
            throw new Error('socket gone');
          },
        }),
      },
      pool,
    } as unknown as ToolDeps;
    const out = (await tool(ReticleTool.LEASE_ACQUIRE)(deps, {
      url: 'http://localhost:3000/',
    })) as Record<string, unknown>;
    expect(out['sessionId']).toBeDefined();
  });
});

describe('prioritising a tab that is already open', () => {
  it('names the live non-leased tab so the agent can switch to the one a human can see', async () => {
    // Informing after the fact is not prioritising. The agent is told AT THE POINT OF CHOICE that a
    // visible tab already exists, because that is the only moment the choice is still open.
    const narrations: string[] = [];
    const watcher = {
      id: 's-human',
      projectId: 'acme',
      pushNarration: (t: string) => narrations.push(t),
    };
    const { pool } = fakePool();
    const deps = {
      sessions: { all: () => [watcher], get: () => watcher },
      pool,
    } as unknown as ToolDeps;

    const out = (await tool(ReticleTool.LEASE_ACQUIRE)(deps, {
      url: 'http://localhost:3000/',
      projectId: 'acme',
    })) as Record<string, unknown>;

    const prefer = out['preferExisting'] as { sessionId: string; note: string } | undefined;
    expect(prefer?.sessionId).toBe('s-human');
    expect(prefer?.note).toContain('release this lease');
  });

  it('stays silent when no tab was open — a lease is simply correct then', async () => {
    const { pool } = fakePool();
    const deps = {
      sessions: { all: () => [], get: () => ({ id: 'live' }) },
      pool,
    } as unknown as ToolDeps;

    const out = (await tool(ReticleTool.LEASE_ACQUIRE)(deps, {
      url: 'http://localhost:3000/',
      projectId: 'acme',
    })) as Record<string, unknown>;

    expect('preferExisting' in out).toBe(false);
  });

  it('never REFUSES the lease — isolation is a legitimate need', async () => {
    // The fix must not break agents that genuinely want a clean context. It steers; it does not veto.
    const watcher = { id: 's-human', projectId: 'acme', pushNarration: () => undefined };
    const { pool } = fakePool();
    const deps = {
      sessions: { all: () => [watcher], get: () => watcher },
      pool,
    } as unknown as ToolDeps;

    const out = (await tool(ReticleTool.LEASE_ACQUIRE)(deps, {
      url: 'http://localhost:3000/',
      projectId: 'acme',
    })) as Record<string, unknown>;

    expect(out['sessionId']).toBeDefined();
    expect(out['url']).toBe('http://localhost:3000/');
  });
});
