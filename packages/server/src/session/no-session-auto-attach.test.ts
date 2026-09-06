/**
 * The near-miss this exists for: the app is UP, nothing is connected, and Reticle reports absence.
 *
 * When the probe finds exactly one listening dev server and the project is wired, there is nothing
 * left to ask a human — so the daemon opens that URL in a browser it already owns instead of
 * returning "no browser session connected". The tests below are mostly about the guards, because an
 * auto-attach that fires twice, fires on a foreign port, or hides its own failure is worse than none.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoSessionAction } from '@reticlehq/core';
import { startNoSessionWatch } from './no-session-watch.js';
import type { NoSessionNextAction } from './no-session-next-action.js';
import type { SessionManager } from './session-manager.js';

/**
 * A generous ceiling, not a measurement. Every case here writes a real temp directory, which is
 * milliseconds locally and much slower on a Windows runner — so the bound exists to stop vitest's 5s
 * default from deciding the result. Never assert a duration.
 */
const TEMP_PROJECT_TIMEOUT_MS = 20_000;

/** Enough fake time for several background refreshes — the watch re-probes every 15s. */
const REFRESH_INTERVALS_MS = 60_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project directory, wired or not, optionally with a dev script to source a command from. */
function projectDir(opts: { wired: boolean; devScript?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'reticle-attach-'));
  dirs.push(dir);
  if (opts.wired) {
    writeFileSync(
      join(dir, '.reticle.json'),
      JSON.stringify({ framework: 'vite', projectId: 'app-1' }),
      'utf8',
    );
  }
  if (opts.devScript !== undefined) {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { dev: opts.devScript } }),
      'utf8',
    );
  }
  return dir;
}

interface Stub {
  manager: SessionManager;
  hint: () => string;
  next: () => NoSessionNextAction | undefined;
}

function stubSessions(count = 0): Stub {
  let hint: (() => string | undefined) | undefined;
  let next: (() => NoSessionNextAction | undefined) | undefined;
  const manager = {
    count: () => count,
    everConnected: () => false,
    // Nothing has departed in these cases, so the lease branch stays off.
    lastDeparted: () => undefined,
    // Registered alongside the hint (#615): the branch code for the same diagnosis.
    setNoSessionReason: () => {},
    setNoSessionHint: (fn: (() => string | undefined) | undefined) => {
      hint = fn;
    },
    setNoSessionNextAction: (fn: (() => NoSessionNextAction | undefined) | undefined) => {
      next = fn;
    },
    setConnectionRecorder: () => undefined,
  } as unknown as SessionManager;
  return { manager, hint: () => hint?.() ?? '', next: () => next?.() };
}

/** Let the probe promise and the attach promise chained behind it both settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe('auto-attach when a dev server is already running', () => {
  it(
    'opens the listening URL in a Reticle-owned browser when the project is wired',
    async () => {
      const opened: string[] = [];
      const { manager } = stubSessions();
      const stop = startNoSessionWatch({
        sessions: manager,
        port: 4400,
        initialized: true,
        directory: projectDir({ wired: true }),
        probe: () => Promise.resolve([5173]),
        attach: (url) => {
          opened.push(url);
          return Promise.resolve();
        },
      });
      await settle();
      stop();
      expect(opened).toEqual(['http://localhost:5173']);
    },
    TEMP_PROJECT_TIMEOUT_MS,
  );

  it(
    'attempts a given port at most once per daemon, however often the probe runs',
    async () => {
      const opened: string[] = [];
      const { manager } = stubSessions();
      // Fake timers so the background refresh genuinely fires again — a second `await` proves nothing,
      // because the probe only re-runs on the interval.
      vi.useFakeTimers();
      try {
        const stop = startNoSessionWatch({
          sessions: manager,
          port: 4400,
          initialized: true,
          directory: projectDir({ wired: true }),
          probe: () => Promise.resolve([5173]),
          attach: (url) => {
            opened.push(url);
            return Promise.resolve();
          },
        });
        await vi.advanceTimersByTimeAsync(REFRESH_INTERVALS_MS);
        stop();
      } finally {
        vi.useRealTimers();
      }
      expect(opened).toHaveLength(1);
    },
    TEMP_PROJECT_TIMEOUT_MS,
  );

  it(
    'never attaches to an unwired project — leasing an app with no SDK just burns a browser',
    async () => {
      let attempts = 0;
      const { manager } = stubSessions();
      const stop = startNoSessionWatch({
        sessions: manager,
        port: 4400,
        initialized: false,
        directory: projectDir({ wired: false }),
        probe: () => Promise.resolve([5173]),
        attach: () => {
          attempts += 1;
          return Promise.resolve();
        },
      });
      await settle();
      stop();
      expect(attempts).toBe(0);
    },
    TEMP_PROJECT_TIMEOUT_MS,
  );

  it(
    'never attaches when several ports are listening — none can be attributed to this project',
    async () => {
      let attempts = 0;
      const { manager } = stubSessions();
      const stop = startNoSessionWatch({
        sessions: manager,
        port: 4400,
        initialized: true,
        directory: projectDir({ wired: true }),
        probe: () => Promise.resolve([5173, 8080]),
        attach: () => {
          attempts += 1;
          return Promise.resolve();
        },
      });
      await settle();
      stop();
      expect(attempts).toBe(0);
    },
    TEMP_PROJECT_TIMEOUT_MS,
  );

  it(
    'reports the reason it could not attach, on top of the ordinary diagnosis',
    async () => {
      const { manager, hint } = stubSessions();
      const stop = startNoSessionWatch({
        sessions: manager,
        port: 4400,
        initialized: true,
        directory: projectDir({ wired: true }),
        probe: () => Promise.resolve([5173]),
        attach: () => Promise.reject(new Error('chromium is not installed')),
      });
      await settle();
      const message = hint();
      stop();
      expect(message).toContain('chromium is not installed');
      // The ordinary diagnosis survives — the failure is added to it, never instead of it.
      expect(message).toMatch(/no browser session connected/);
    },
    TEMP_PROJECT_TIMEOUT_MS,
  );

  it(
    'names port arbitration when the failure is a port collision, not a generic error',
    async () => {
      const { manager, hint } = stubSessions();
      const stop = startNoSessionWatch({
        sessions: manager,
        port: 4400,
        initialized: true,
        directory: projectDir({ wired: true }),
        probe: () => Promise.resolve([5173]),
        attach: () =>
          Promise.reject(new Error('listen EADDRINUSE: address already in use :::4400')),
      });
      await settle();
      const message = hint();
      stop();
      expect(message).toMatch(/already holds the port/i);
    },
    TEMP_PROJECT_TIMEOUT_MS,
  );

  it(
    'runs without an attach path at all (a daemon with no pool) and still diagnoses',
    async () => {
      const { manager, hint } = stubSessions();
      const stop = startNoSessionWatch({
        sessions: manager,
        port: 4400,
        initialized: true,
        directory: projectDir({ wired: true }),
        probe: () => Promise.resolve([5173]),
      });
      await settle();
      const message = hint();
      stop();
      expect(message).toMatch(/no browser session connected/);
    },
    TEMP_PROJECT_TIMEOUT_MS,
  );
});

describe('the structured next action the watch publishes', () => {
  it(
    'hands back the project’s own dev command when nothing is listening',
    async () => {
      const { manager, next } = stubSessions();
      const stop = startNoSessionWatch({
        sessions: manager,
        port: 4400,
        initialized: true,
        directory: projectDir({ wired: true, devScript: 'vite --port 4311' }),
        probe: () => Promise.resolve([]),
      });
      await settle();
      const action = next();
      stop();
      expect(action?.action).toBe(NoSessionAction.START_DEV_SERVER);
      expect(action?.command).toBe('npm run dev');
      expect(action?.port).toBe(4311);
    },
    TEMP_PROJECT_TIMEOUT_MS,
  );

  it(
    'renders the same command into the prose the resolve refusal throws',
    async () => {
      const { manager, hint } = stubSessions();
      const stop = startNoSessionWatch({
        sessions: manager,
        port: 4400,
        initialized: true,
        directory: projectDir({ wired: true, devScript: 'vite' }),
        probe: () => Promise.resolve([]),
      });
      await settle();
      const message = hint();
      stop();
      expect(message).toContain('`npm run dev`');
    },
    TEMP_PROJECT_TIMEOUT_MS,
  );

  it(
    'says there is no dev script rather than guessing one',
    async () => {
      const { manager, next } = stubSessions();
      const stop = startNoSessionWatch({
        sessions: manager,
        port: 4400,
        initialized: true,
        directory: projectDir({ wired: true }),
        probe: () => Promise.resolve([]),
      });
      await settle();
      const action = next();
      stop();
      expect(action?.command).toBeUndefined();
      expect(action?.reason).toContain('no dev script');
    },
    TEMP_PROJECT_TIMEOUT_MS,
  );

  it(
    'asks for `reticle init` — never a dev command — when a server is up and nothing is wired',
    async () => {
      const { manager, next } = stubSessions();
      const stop = startNoSessionWatch({
        sessions: manager,
        port: 4400,
        initialized: false,
        directory: projectDir({ wired: false, devScript: 'vite' }),
        probe: () => Promise.resolve([5173]),
      });
      await settle();
      const action = next();
      stop();
      expect(action?.action).toBe(NoSessionAction.RUN_INIT);
      expect(action?.command).toBe('reticle init');
    },
    TEMP_PROJECT_TIMEOUT_MS,
  );
});
