/**
 * Multi-project / multi-port madman tests.
 *
 * Simulates the real chaos of a vibe-coder juggling multiple apps at once:
 * - 3+ Reticle daemons on different ports running simultaneously
 * - Browsers connecting to the wrong port
 * - Daemon started, no browser
 * - Browser started, no daemon
 * - Port conflicts (two daemons fight for the same port)
 * - Daemon killed mid-session
 * - Session isolation — app A's events must never bleed into app B's session list
 * - Reconnection after daemon restart
 * - Daemon on port A, then port A killed, then B takes over (musical chairs)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from './bridge/bridge.js';
import { FakeBrowser, callTool, makeDeps, waitUntil } from './bridge/bridge.test-harness.js';
import { ReticleTool } from './tools/tool-names.js';
import type { ToolDeps } from './tools/tools.js';
import { EventType, RETICLE_DEFAULT_PORT } from '@reticlehq/core';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Spin up a raw Bridge (no daemon process) bound to a random free port. */
async function startBridge(): Promise<{ bridge: Bridge; port: number; deps: ToolDeps }> {
  const bridge = new Bridge({ port: 0 });
  const port = await bridge.ready;
  const deps = makeDeps(bridge);
  return { bridge, port, deps };
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'reticle-multi-'));
}

// ─── 1. Port isolation — sessions never bleed across daemons ─────────────────

describe('port isolation', () => {
  it('three bridges on different ports: each has its own session list', async () => {
    const [a, b, c] = await Promise.all([startBridge(), startBridge(), startBridge()]);
    const browserA = new FakeBrowser(a.port, 'proj-a');
    const browserB = new FakeBrowser(b.port, 'proj-b');
    const browserC = new FakeBrowser(c.port, 'proj-c');

    await Promise.all([browserA.open(), browserB.open(), browserC.open()]);
    await Promise.all([
      waitUntil(() => 1 === a.bridge.sessions.count()),
      waitUntil(() => 1 === b.bridge.sessions.count()),
      waitUntil(() => 1 === c.bridge.sessions.count()),
    ]);

    const [sessA, sessB, sessC] = await Promise.all([
      callTool(a.deps, ReticleTool.SESSIONS),
      callTool(b.deps, ReticleTool.SESSIONS),
      callTool(c.deps, ReticleTool.SESSIONS),
    ]);

    // Each daemon sees exactly its own browser
    expect((sessA as { sessions: unknown[] }).sessions).toHaveLength(1);
    expect((sessB as { sessions: unknown[] }).sessions).toHaveLength(1);
    expect((sessC as { sessions: unknown[] }).sessions).toHaveLength(1);

    // Session IDs are distinct
    const idA = (sessA as { sessions: { sessionId: string }[] }).sessions[0]?.sessionId;
    const idB = (sessB as { sessions: { sessionId: string }[] }).sessions[0]?.sessionId;
    const idC = (sessC as { sessions: { sessionId: string }[] }).sessions[0]?.sessionId;
    expect(new Set([idA, idB, idC]).size).toBe(3);

    browserA.close();
    browserB.close();
    browserC.close();
    await Promise.all([a.bridge.close(), b.bridge.close(), c.bridge.close()]);
  });

  it('connecting to the wrong port returns no sessions for this project', async () => {
    const [projectPort, wrongPort] = await Promise.all([startBridge(), startBridge()]);

    const browser = new FakeBrowser(projectPort.port, 'my-app');
    await browser.open();
    await waitUntil(() => 1 === projectPort.bridge.sessions.count());

    // Agent mistakenly queries the wrong daemon
    const wrongSessions = (await callTool(wrongPort.deps, ReticleTool.SESSIONS)) as {
      sessions: unknown[];
    };
    expect(wrongSessions.sessions).toHaveLength(0);

    browser.close();
    await Promise.all([projectPort.bridge.close(), wrongPort.bridge.close()]);
  });
});

// ─── 2. Daemon without app ─────────────────────────────────────────────────────

describe('daemon without app', () => {
  it('reticle_snapshot throws a clear error when no session is pinned', async () => {
    const { bridge, deps } = await startBridge();
    await expect(callTool(deps, ReticleTool.SNAPSHOT, {})).rejects.toThrow();
    await bridge.close();
  });
});

// ─── 3. Multiple browsers same daemon (multi-tab chaos) ───────────────────────

describe('multiple browsers on same daemon', () => {
  it('4 tabs connected — each registers its own session', async () => {
    const bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    const deps = makeDeps(bridge);

    const tabs = Array.from({ length: 4 }, (_, i) => new FakeBrowser(port, `tab-${i}`));
    await Promise.all(tabs.map((t) => t.open()));
    await waitUntil(() => 4 === bridge.sessions.count(), 3000);

    const result = (await callTool(deps, ReticleTool.SESSIONS)) as { sessions: unknown[] };
    expect(result.sessions).toHaveLength(4);

    tabs.forEach((t) => t.close());
    await bridge.close();
  });

  it('each tab sees only its own events — snapshot is session-scoped', async () => {
    const bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;

    const tabA = new FakeBrowser(port, 'tab-checkout');
    const tabB = new FakeBrowser(port, 'tab-home');
    await Promise.all([tabA.open(), tabB.open()]);
    await waitUntil(() => 2 === bridge.sessions.count());

    // Tab A emits an event; tab B doesn't
    tabA.emit(EventType.NET_REQUEST, {
      method: 'GET',
      url: '/api/cart',
      status: 200,
      durationMs: 10,
    });

    await waitUntil(() => bridge.sessions.resolve('tab-checkout').eventsSince(0).length >= 1);

    // Session B should have 0 events
    const eventsB = bridge.sessions.resolve('tab-home').eventsSince(0);
    expect(eventsB.length).toBe(0);

    // Session A should have 1 event
    const eventsA = bridge.sessions.resolve('tab-checkout').eventsSince(0);
    expect(eventsA.length).toBeGreaterThanOrEqual(1);

    tabA.close();
    tabB.close();
    await bridge.close();
  });
});

// ─── 4. Daemon killed mid-session ─────────────────────────────────────────────

describe('daemon killed mid-session', () => {
  it('browser WebSocket disconnects cleanly when the bridge closes', async () => {
    const bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    const browser = new FakeBrowser(port, 'orphaned-session');
    await browser.open();
    await waitUntil(() => 1 === bridge.sessions.count());

    // Verify connected: session is live
    expect(bridge.sessions.count()).toBe(1);

    // Close the daemon mid-session — the WebSocket close frame is sent to the browser
    await bridge.close();

    // The bridge HTTP server is closed; any new connection attempt will fail.
    // Sessions remain in the ring buffer (they are event history, not live connections).
    // The important guarantee is that the bridge no longer accepts new connections.
    const bridge2 = new Bridge({ port });
    // The port is now free so a new bridge can claim it
    await expect(bridge2.ready).resolves.toBe(port);
    await bridge2.close();

    browser.close();
  });

  it('new daemon on same port accepts fresh browser after old one dies', async () => {
    const bridge1 = new Bridge({ port: 0 });
    const port = await bridge1.ready;
    const browser1 = new FakeBrowser(port, 'session-before');
    await browser1.open();
    await waitUntil(() => 1 === bridge1.sessions.count());

    // Kill the first daemon
    browser1.close();
    await bridge1.close();

    // Start a new daemon on the exact same port
    const bridge2 = new Bridge({ port });
    await bridge2.ready;
    const deps2 = makeDeps(bridge2);

    const browser2 = new FakeBrowser(port, 'session-after');
    await browser2.open();
    await waitUntil(() => 1 === bridge2.sessions.count(), 3000);

    const result = (await callTool(deps2, ReticleTool.SESSIONS)) as { sessions: unknown[] };
    expect(result.sessions).toHaveLength(1);
    expect((result.sessions[0] as { sessionId: string }).sessionId).toBe('session-after');

    browser2.close();
    await bridge2.close();
  });
});

// ─── 5. Port conflict — two daemons can't share a port ────────────────────────

describe('port conflict', () => {
  it('second Bridge on the same port rejects immediately', async () => {
    const bridge1 = new Bridge({ port: 0 });
    const port = await bridge1.ready;

    // Try to bind a second bridge to the occupied port
    const bridge2 = new Bridge({ port });
    await expect(bridge2.ready).rejects.toThrow();

    await bridge1.close();
  });

  it('after first daemon releases port, second can claim it', async () => {
    const bridge1 = new Bridge({ port: 0 });
    const port = await bridge1.ready;
    await bridge1.close();

    // Now the port is free
    const bridge2 = new Bridge({ port });
    await expect(bridge2.ready).resolves.toBe(port);
    await bridge2.close();
  });
});

// ─── 6. Musical chairs — port reassignment across projects ────────────────────

describe('musical chairs', () => {
  it('project A stops on port 4401 → project B claims port 4401 → new browser finds B', async () => {
    // Project A starts
    const bridgeA = new Bridge({ port: 0 });
    const portA = await bridgeA.ready;
    const browserA = new FakeBrowser(portA, 'app-a');
    await browserA.open();
    await waitUntil(() => 1 === bridgeA.sessions.count());

    // Project A stops
    browserA.close();
    await bridgeA.close();

    // Project B claims the same port
    const bridgeB = new Bridge({ port: portA });
    await bridgeB.ready;
    const depsB = makeDeps(bridgeB);

    // New browser connects to project B
    const browserB = new FakeBrowser(portA, 'app-b');
    await browserB.open();
    await waitUntil(() => 1 === bridgeB.sessions.count(), 3000);

    const sessions = (await callTool(depsB, ReticleTool.SESSIONS)) as {
      sessions: { sessionId: string }[];
    };
    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions[0]?.sessionId).toBe('app-b'); // B, not A's ghost

    browserB.close();
    await bridgeB.close();
  });
});

// ─── 7. Event volume stress — many apps, many events, no cross-contamination ──

describe('event volume stress', () => {
  it('5 simultaneous projects emit 50 events each — no events land in wrong session', async () => {
    const stacks = await Promise.all(Array.from({ length: 5 }, () => startBridge()));
    const browsers = stacks.map((s, i) => new FakeBrowser(s.port, `app-${i}`));

    await Promise.all(browsers.map((b) => b.open()));
    await Promise.all(stacks.map((s) => waitUntil(() => 1 === s.bridge.sessions.count(), 3000)));

    // Emit 50 events per browser in rapid succession
    for (const [i, b] of browsers.entries()) {
      for (let n = 0; n < 50; n++) {
        b.emit(EventType.SIGNAL, { name: `app-${i}-event-${n}`, data: {} });
      }
    }

    // Wait for all events to land
    await Promise.all(
      stacks.map((s, i) =>
        waitUntil(() => s.bridge.sessions.resolve(`app-${i}`).eventsSince(0).length >= 50, 5000),
      ),
    );

    // Each session has exactly its 50 events, no bleed
    for (const [i, s] of stacks.entries()) {
      const events = s.bridge.sessions.resolve(`app-${i}`).eventsSince(0);
      expect(events.length).toBeGreaterThanOrEqual(50);
      // All events in this session should have the app-i prefix signal name
      const signals = events.filter((e) => e.type === EventType.SIGNAL);
      for (const sig of signals) {
        expect((sig.data as { name: string }).name).toMatch(new RegExp(`^app-${i}-`));
      }
    }

    browsers.forEach((b) => b.close());
    await Promise.all(stacks.map((s) => s.bridge.close()));
  });
});

// ─── 8. Rapid connect/disconnect cycling ─────────────────────────────────────

describe('rapid connect/disconnect cycling', () => {
  it('browser connects and disconnects 10 times without leaking sessions', async () => {
    const bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    const deps = makeDeps(bridge);

    for (let round = 0; round < 10; round++) {
      const browser = new FakeBrowser(port, `cycle-${round}`);
      await browser.open();
      await waitUntil(() => bridge.sessions.count() >= 1, 2000);
      browser.close();
      // Slight pause for WebSocket close frame to propagate
      await new Promise<void>((r) => setTimeout(r, 20));
    }

    // After all cycles settle, sessions count should be 0 or very low (stale sessions prune)
    await new Promise<void>((r) => setTimeout(r, 200));
    const result = (await callTool(deps, ReticleTool.SESSIONS)) as { sessions: unknown[] };
    // May have some stale sessions in the ring buffer but should not be accumulating unboundedly
    expect(result.sessions.length).toBeLessThanOrEqual(10);

    await bridge.close();
  });

  // This one was raised to 60s twice on the theory that the Windows runner was merely slow, and blew
  // both times — the second at 60173ms. It was never a timeout: see the note on the wait below. Kept
  // explicit at 120s because the storm itself is genuinely slower there, but the bound is now only a
  // backstop, not the thing under test.
  it('50 browsers connect simultaneously — bridge does not crash', async () => {
    const bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;

    const browsers = Array.from({ length: 50 }, (_, i) => new FakeBrowser(port, `stress-${i}`));

    // Connect all at once. `open()` resolves on socket-open having only QUEUED the hello, so this
    // awaits fifty sockets, not fifty sessions.
    await Promise.all(browsers.map((b) => b.open()));

    // NOT `waitUntil(count >= 32)`. A socket counts as pending from connect until its hello is
    // processed, MAX_PENDING_CONNECTIONS is 16, and over that cap the bridge CLOSES the socket and
    // it never retries. So how many of fifty become sessions is a race between hello-processing and
    // connection arrival: it reaches 32 on a fast machine and stalled below it on the Windows runner
    // for the full 60s. No bound can fix that — the rejected sockets are gone. Admission control
    // behaved exactly as documented; the assertion was the bug.
    await waitUntil(() => bridge.sessions.count() > 0, 30_000);

    // The real invariants, both platform-independent: the cap held, and nothing was admitted past it.
    expect(bridge.sessions.count()).toBeGreaterThan(0);
    expect(bridge.sessions.count()).toBeLessThanOrEqual(32);

    browsers.forEach((b) => b.close());

    // "Does not crash" deserves better than a count. A browser arriving after the storm DRAINS gets a
    // session — the bridge is alive, still accepting, and released the slots it took. It has to come
    // after the closes: the storm saturates MAX_SESSIONS, so at capacity a new browser is refused by
    // design and this would be asserting the cap is broken. (Learned by writing it the other way.)
    await waitUntil(() => 0 === bridge.sessions.count(), 30_000);
    const late = new FakeBrowser(port, 'stress-late');
    await late.open();
    await waitUntil(() => bridge.sessions.get('stress-late') !== undefined, 30_000);
    late.close();
    await bridge.close();
  }, 120_000);
});

// ─── 9. Mixed states (the messy human scenarios) ─────────────────────────────

describe('messy human scenarios', () => {
  it('user forgets to open browser — agent polls and waits, then browser connects', async () => {
    const bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    const deps = makeDeps(bridge);

    // Agent checks: no sessions
    const before = (await callTool(deps, ReticleTool.SESSIONS)) as { sessions: unknown[] };
    expect(before.sessions).toHaveLength(0);

    // User eventually opens browser
    const browser = new FakeBrowser(port, 'late-browser');
    await browser.open();
    await waitUntil(() => 1 === bridge.sessions.count(), 3000);

    // Agent checks again: session appears
    const after = (await callTool(deps, ReticleTool.SESSIONS)) as { sessions: unknown[] };
    expect(after.sessions).toHaveLength(1);

    browser.close();
    await bridge.close();
  });

  it('user has 3 dev servers open — agent must pick the right session by URL', async () => {
    const bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;

    // Override URLs via HELLO message (use custom FakeBrowser subclass pattern)
    const ws = await import('ws');
    const { RETICLE_WS_PATH, MessageKind, LOOPBACK_HOST } = await import('@reticlehq/core');

    function connectWithUrl(sessionId: string, url: string): Promise<void> {
      return new Promise((resolve) => {
        const sock = new ws.WebSocket(`ws://${LOOPBACK_HOST}:${String(port)}${RETICLE_WS_PATH}`, {
          origin: 'http://localhost',
        });
        sock.on('open', () => {
          sock.send(
            JSON.stringify({
              kind: MessageKind.HELLO,
              protocolVersion: 1,
              sessionId,
              url,
              title: `App at ${url}`,
              adapters: [],
              hasCapabilities: false,
            }),
          );
          resolve();
          // Keep socket open (don't close — we need the session to persist)
          sock.on('message', () => undefined); // consume messages
        });
      });
    }

    await Promise.all([
      connectWithUrl('next-app', 'http://localhost:3000'),
      connectWithUrl('vite-app', 'http://localhost:5173'),
      connectWithUrl('other-app', 'http://localhost:8080'),
    ]);

    await waitUntil(() => 3 === bridge.sessions.count(), 3000);

    const deps = makeDeps(bridge);
    const result = (await callTool(deps, ReticleTool.SESSIONS)) as {
      sessions: { sessionId: string; url: string }[];
    };

    expect(result.sessions).toHaveLength(3);
    const urls = result.sessions.map((s) => s.url).sort();
    expect(urls).toEqual([
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:8080',
    ]);

    await bridge.close();
  });

  it('user closes dev server tab then reopens — new session replaces old one', async () => {
    const bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    const deps = makeDeps(bridge);

    const tab1 = new FakeBrowser(port, 'my-tab');
    await tab1.open();
    await waitUntil(() => bridge.sessions.count() >= 1);

    // User closes the tab
    tab1.close();
    await new Promise<void>((r) => setTimeout(r, 50));

    // User reopens (new session ID because the page refreshed)
    const tab2 = new FakeBrowser(port, 'my-tab-refreshed');
    await tab2.open();
    await waitUntil(() => bridge.sessions.count() >= 1, 2000);

    const result = (await callTool(deps, ReticleTool.SESSIONS)) as {
      sessions: { sessionId: string }[];
    };
    const ids = result.sessions.map((s) => s.sessionId);
    // New session is present
    expect(ids).toContain('my-tab-refreshed');

    tab2.close();
    await bridge.close();
  });

  it('two projects accidentally share a port — second one fails, first is unaffected', async () => {
    // Project A claims port
    const bridgeA = new Bridge({ port: 0 });
    const port = await bridgeA.ready;
    const depsA = makeDeps(bridgeA);

    const browserA = new FakeBrowser(port, 'project-a-session');
    await browserA.open();
    await waitUntil(() => 1 === bridgeA.sessions.count());

    // Project B tries to claim the same port — must fail, not corrupt A
    const bridgeB = new Bridge({ port });
    await expect(bridgeB.ready).rejects.toThrow();

    // Project A is still fully functional
    const resultA = (await callTool(depsA, ReticleTool.SESSIONS)) as { sessions: unknown[] };
    expect(resultA.sessions).toHaveLength(1);

    browserA.close();
    await bridgeA.close();
  });
});

// ─── 10. Default port + project port interaction ──────────────────────────────

describe('default port vs project port', () => {
  it('default port (RETICLE_DEFAULT_PORT) is usable as a project port', async () => {
    // Some projects legitimately use the default port
    const bridge = new Bridge({ port: 0 }); // use 0 to avoid conflict if 4400 is taken
    const port = await bridge.ready;
    const browser = new FakeBrowser(port, 'default-port-project');
    await browser.open();
    await waitUntil(() => 1 === bridge.sessions.count());
    expect(bridge.sessions.count()).toBe(1);
    browser.close();
    await bridge.close();
    // Confirms RETICLE_DEFAULT_PORT is not special — it's just a number
    expect(RETICLE_DEFAULT_PORT).toBe(4400);
  });

  it('two projects, one on default port and one on custom port, are completely independent', async () => {
    const [defaultProj, customProj] = await Promise.all([startBridge(), startBridge()]);

    // One browser per project
    const browserDefault = new FakeBrowser(defaultProj.port, 'default-proj-session');
    const browserCustom = new FakeBrowser(customProj.port, 'custom-proj-session');

    await Promise.all([browserDefault.open(), browserCustom.open()]);
    await Promise.all([
      waitUntil(() => 1 === defaultProj.bridge.sessions.count()),
      waitUntil(() => 1 === customProj.bridge.sessions.count()),
    ]);

    // Emit different events in each
    browserDefault.emit(EventType.SIGNAL, { name: 'default:event', data: {} });
    browserCustom.emit(EventType.SIGNAL, { name: 'custom:event', data: {} });

    await waitUntil(
      () =>
        defaultProj.bridge.sessions.resolve('default-proj-session').eventsSince(0).length >= 1 &&
        customProj.bridge.sessions.resolve('custom-proj-session').eventsSince(0).length >= 1,
      2000,
    );

    const defaultEvents = defaultProj.bridge.sessions
      .resolve('default-proj-session')
      .eventsSince(0)
      .filter((e) => e.type === EventType.SIGNAL);
    const customEvents = customProj.bridge.sessions
      .resolve('custom-proj-session')
      .eventsSince(0)
      .filter((e) => e.type === EventType.SIGNAL);

    expect((defaultEvents[0]?.data as { name: string } | undefined)?.name).toBe('default:event');
    expect((customEvents[0]?.data as { name: string } | undefined)?.name).toBe('custom:event');

    browserDefault.close();
    browserCustom.close();
    await Promise.all([defaultProj.bridge.close(), customProj.bridge.close()]);
  });
});

// ─── 11. Temp-dir isolation (as reticle init would create per project) ────────────

describe('temp-dir isolation (simulates reticle init per project)', () => {
  let dirs: string[] = [];

  beforeEach(async () => {
    dirs = await Promise.all(Array.from({ length: 3 }, () => tempDir()));
  });
  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it('each project directory gets an isolated bridge and clean session state', async () => {
    const stacks = await Promise.all(
      dirs.map(async (dir) => {
        const { bridge, port, deps } = await startBridge();
        return { dir, bridge, port, deps };
      }),
    );

    // Each project connects one browser
    const browsers = stacks.map((s, i) => new FakeBrowser(s.port, `project-${i}`));
    await Promise.all(browsers.map((b) => b.open()));
    await Promise.all(stacks.map((s) => waitUntil(() => 1 === s.bridge.sessions.count(), 2000)));

    // Verify isolation: each daemon has exactly 1 session, not 3
    for (const [i, s] of stacks.entries()) {
      const result = (await callTool(s.deps, ReticleTool.SESSIONS)) as { sessions: unknown[] };
      expect(result.sessions).toHaveLength(1);
      expect((result.sessions[0] as { sessionId: string }).sessionId).toBe(`project-${i}`);
    }

    browsers.forEach((b) => b.close());
    await Promise.all(stacks.map((s) => s.bridge.close()));
  });
});
