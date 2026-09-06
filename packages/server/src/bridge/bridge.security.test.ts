import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  EventType,
  RETICLE_PROTOCOL_VERSION,
  RETICLE_WS_PATH,
  MessageKind,
  TRANSPORT_LIMITS,
} from '@reticlehq/core';
import { BlindSpotKind } from '@reticlehq/core';
import { Bridge } from './bridge.js';
import { WS_CLOSE_REASON } from './bridge.js';
import { SessionManager } from '../session/session-manager.js';

const bridges: Bridge[] = [];
const sockets: WebSocket[] = [];

function hello(sessionId: string, token?: string): Record<string, unknown> {
  return {
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId,
    url: 'http://localhost/',
    title: 'Security test',
    adapters: [],
    ...(token === undefined ? {} : { token }),
  };
}

async function makeBridge(options: Omit<ConstructorParameters<typeof Bridge>[0], 'port'> = {}) {
  const bridge = new Bridge({ port: 0, ...options });
  bridges.push(bridge);
  return { bridge, port: await bridge.ready };
}

// Default to a loopback Origin — a real browser SDK always sends one. Pass `null` to simulate a
// non-browser local process that omits Origin entirely.
function openSocket(port: number, origin: string | null = 'http://localhost'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${RETICLE_WS_PATH}`, {
      ...(null === origin ? {} : { origin }),
    });
    sockets.push(socket);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once('close', (code) => resolve(code));
  });
}

function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = (): void => {
      if (condition()) {
        resolve();
      } else if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('condition timed out'));
      } else {
        setTimeout(poll, 10);
      }
    };
    poll();
  });
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

describe('Bridge security boundary', () => {
  it('rejects non-local browser origins by default', async () => {
    const { port } = await makeBridge();
    await expect(openSocket(port, 'https://evil.example')).rejects.toThrow(
      /Unexpected server response: 403/,
    );
    await expect(openSocket(port, 'http://127.evil.example')).rejects.toThrow(
      /Unexpected server response: 403/,
    );
  });

  // Tauri on WINDOWS is the one desktop origin that is NOT opaque: the webview needs a real http
  // origin, so Tauri serves `http://tauri.localhost` there while macOS/Linux get `tauri://localhost`.
  // The SDK's own page-side gate was taught that hostname and this handshake check was not, so a
  // Windows Tauri app passed its own gate, dialed the bridge, and got 403 on every attempt —
  // Reticle could not connect to a Tauri app on Windows at all. Found by running the packaged
  // binary there for the first time.
  it('accepts the Tauri Windows http origin, which is loopback by RFC 6761', async () => {
    const { bridge, port } = await makeBridge();
    const socket = await openSocket(port, 'http://tauri.localhost');
    socket.send(JSON.stringify(hello('tauri-win')));
    await waitUntil(() => 1 === bridge.sessions.count());
    expect(bridge.sessions.get('tauri-win')).toBeDefined();
  });

  it('still rejects a lookalike that merely ENDS with the Tauri hostname', async () => {
    const { port } = await makeBridge();
    await expect(openSocket(port, 'http://evil-tauri.localhost.example')).rejects.toThrow(
      /Unexpected server response: 403/,
    );
  });

  it('accepts configured origins and requires the pairing token', async () => {
    const { bridge, port } = await makeBridge({
      token: 'shared-secret',
      allowedOrigins: ['https://app.example'],
    });
    const bad = await openSocket(port, 'https://app.example');
    const badClosed = waitForClose(bad);
    bad.send(JSON.stringify(hello('bad', 'wrong-secret')));
    expect(await badClosed).toBe(1008);
    expect(bridge.sessions.count()).toBe(0);

    const good = await openSocket(port, 'https://app.example');
    good.send(JSON.stringify(hello('good', 'shared-secret')));
    await waitUntil(() => 1 === bridge.sessions.count());
    expect(bridge.sessions.get('good')).toBeDefined();
  });

  it('rejects a handshake with no Origin when no token is configured (non-browser local process)', async () => {
    const { port } = await makeBridge();
    await expect(openSocket(port, null)).rejects.toThrow(/Unexpected server response: 403/);
  });

  it('allows a no-Origin handshake when a token is configured (HELLO token check is the gate)', async () => {
    const { bridge, port } = await makeBridge({ token: 'shared-secret' });
    const socket = await openSocket(port, null);
    socket.send(JSON.stringify(hello('nobrowser', 'shared-secret')));
    await waitUntil(() => 1 === bridge.sessions.count());
    expect(bridge.sessions.get('nobrowser')).toBeDefined();
  });

  // Desktop webviews (Electron, Tauri) send an OPAQUE Origin — one whose URL.origin is the string
  // "null". They carry no attributable hostname, so they are treated exactly like a missing Origin:
  // the pairing token is the gate. Parsing them must never throw inside the WS handshake.
  const OPAQUE_ORIGINS = ['tauri://localhost', 'app://.', 'file://', 'null'];

  for (const origin of OPAQUE_ORIGINS) {
    it(`rejects the opaque desktop origin ${origin} when no token is configured`, async () => {
      const { port } = await makeBridge();
      await expect(openSocket(port, origin)).rejects.toThrow(/Unexpected server response: 403/);
    });

    it(`accepts the opaque desktop origin ${origin} when a token is configured`, async () => {
      const { bridge, port } = await makeBridge({ token: 'shared-secret' });
      const socket = await openSocket(port, origin);
      socket.send(JSON.stringify(hello('desktop', 'shared-secret')));
      await waitUntil(() => 1 === bridge.sessions.count());
      expect(bridge.sessions.get('desktop')).toBeDefined();
    });
  }

  it('allow-lists an opaque desktop origin verbatim when binding beyond localhost', async () => {
    const { bridge, port } = await makeBridge({
      token: 'shared-secret',
      allowedOrigins: ['tauri://localhost'],
    });
    const socket = await openSocket(port, 'tauri://localhost');
    socket.send(JSON.stringify(hello('tauri', 'shared-secret')));
    await waitUntil(() => 1 === bridge.sessions.count());
    expect(bridge.sessions.get('tauri')).toBeDefined();
  });

  it('requires a token before binding beyond localhost', () => {
    expect(() => new Bridge({ port: 0, host: '0.0.0.0' })).toThrow(/pairing token/);
  });

  it('requires allowedOrigins when binding beyond localhost (else it rejects every browser)', () => {
    expect(() => new Bridge({ port: 0, host: '0.0.0.0', token: 'shared-secret' })).toThrow(
      /ALLOWED_ORIGINS/,
    );
  });

  // A scheme-less entry (`RETICLE_ALLOWED_ORIGINS=myapp.test`) fails URL construction and used to
  // be filtered out with NO trace: the allow-list looked configured, every dial was refused, and
  // nothing anywhere said the entry had been dropped. The drop stands (fail closed), but it must
  // be loud and name the accepted form, so the fix is copy-pasteable from the log.
  it('warns with the copy-pasteable form when an allow-list entry has no scheme', async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    let port: number;
    try {
      ({ port } = await makeBridge({ allowedOrigins: ['myapp.test', 'https://app.example'] }));
    } finally {
      spy.mockRestore();
    }
    const line = written.find((entry) => entry.includes('allowed_origin_ignored'));
    expect(line, 'dropping a configured origin must leave a trace').toBeDefined();
    const parsed = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(parsed['entry']).toBe('myapp.test');
    expect(String(parsed['warning'])).toContain('http://myapp.test');
    // The drop itself is unchanged — the scheme-less entry does not allow-list anything…
    await expect(openSocket(port, 'http://myapp.test')).rejects.toThrow(
      /Unexpected server response: 403/,
    );
    // …and the valid sibling entry still made it into the allow-list.
    const socket = await openSocket(port, 'https://app.example');
    socket.close();
  });

  it('rejects protocol mismatches with a distinct "upgrade" reason (not a generic drop)', async () => {
    const { bridge, port } = await makeBridge();
    const socket = await openSocket(port);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    socket.send(
      JSON.stringify({
        ...hello('old-client'),
        protocolVersion: RETICLE_PROTOCOL_VERSION + 1,
      }),
    );
    const { code, reason } = await closed;
    expect(code).toBe(1008);
    // The distinct reason is what stops the agent misdiagnosing a version skew as a port mismatch.
    expect(reason).toContain('protocol mismatch');
    /*
     * And it names the RIGHT side. This fixture sends `RETICLE_PROTOCOL_VERSION + 1` — a page AHEAD
     * of the daemon, which is the skew that actually happens (a current SDK in the app dialling a
     * daemon npx served from cache). The reason used to be a fixed "upgrade @reticlehq/browser",
     * sending that user to upgrade the one component that was already current.
     */
    expect(reason).toContain('daemon is older');
    expect(reason).not.toContain('upgrade @reticlehq/browser');
    expect(bridge.sessions.count()).toBe(0);
  });

  it('closes the socket when the message handler throws, rather than hanging open', async () => {
    /*
     * A throw inside the handler used to leave the socket OPEN and unresponsive. The agent's next
     * tool call then answers "no browser session connected" — indistinguishable from an app nobody
     * started, which is the exact invisible failure the close reasons in this file exist to prevent.
     *
     * Found by accident: a missing import made `protocolSkewReason` undefined, and the symptom was
     * not an error anywhere but a test that timed out waiting for a close that never came.
     *
     * The clock is the seam because the handler reads it on its first line, so a clock that throws
     * reproduces "any exception at all" without needing a specific malformed payload.
     */
    let calls = 0;
    const { port } = await makeBridge({
      clock: () => {
        calls += 1;
        // Let the handshake through; blow up once the first message is being handled.
        if (calls > 3) throw new Error('clock exploded');
        return 1_700_000_000_000;
      },
    });
    const socket = await openSocket(port);
    const closed = new Promise<number>((resolve) => {
      socket.once('close', (code) => resolve(code));
    });

    socket.send(JSON.stringify(hello('boom-client')));

    await expect(closed).resolves.toBeGreaterThan(0);
  });

  it('keeps a replacement session when the older duplicate socket closes', async () => {
    const { bridge, port } = await makeBridge();
    const first = await openSocket(port);
    first.send(JSON.stringify(hello('same-id')));
    await waitUntil(() => 1 === bridge.sessions.count());

    const second = await openSocket(port);
    const firstClosed = waitForClose(first);
    second.send(JSON.stringify(hello('same-id')));
    expect(await firstClosed).toBe(1008);
    await waitUntil(() => 1 === bridge.sessions.count());

    second.send(
      JSON.stringify({
        kind: MessageKind.EVENT,
        event: {
          t: 1,
          type: EventType.SIGNAL,
          sessionId: 'same-id',
          data: { name: 'still-connected' },
        },
      }),
    );
    await waitUntil(() => 1 === bridge.sessions.resolve('same-id').eventsSince(0).length);
  });

  it('caps concurrent sessions', async () => {
    const limitedSessions = await makeBridge({ maxSessions: 1 });
    const first = await openSocket(limitedSessions.port);
    first.send(JSON.stringify(hello('one')));
    await waitUntil(() => 1 === limitedSessions.bridge.sessions.count());
    const second = await openSocket(limitedSessions.port);
    const sessionLimitClose = waitForClose(second);
    second.send(JSON.stringify(hello('two')));
    expect(await sessionLimitClose).toBe(1013);
  });

  /**
   * Above the message cap the bridge SAMPLES; it does not disconnect.
   *
   * It used to close with 1008 — a policy code the SDK correctly never retries — so a burst left the
   * app running and Reticle blind from that instant, silently, with the reason only in the page
   * console. Measured: each request emits two messages (pending + settled), so the cap binds at ~500
   * requests/second, which a dashboard burst reaches and a streaming app lives above. Going blind
   * when it sees too much is the one behaviour an observability layer cannot have.
   */
  it('samples events above the rate cap instead of disconnecting', async () => {
    const rateLimited = await makeBridge({ maxMessagesPerSecond: 2 });
    const noisy = await openSocket(rateLimited.port);
    noisy.send(JSON.stringify(hello('noisy')));
    await waitUntil(() => 1 === rateLimited.bridge.sessions.count());

    for (let i = 0; i < 30; i += 1) {
      noisy.send(
        JSON.stringify({
          kind: MessageKind.EVENT,
          event: { t: i, type: 'dom.added', sessionId: 'noisy' },
        }),
      );
    }
    await waitUntil(() => {
      const session = rateLimited.bridge.sessions.get('noisy');
      return session !== undefined && (session.blindSpots()[BlindSpotKind.RATE_LIMITED] ?? 0) > 0;
    });

    // Still connected, and honest about what it missed.
    expect(rateLimited.bridge.sessions.count(), 'the session must survive a burst').toBe(1);
    expect(noisy.readyState, 'the socket must stay open').toBe(WebSocket.OPEN);
    const spots = rateLimited.bridge.sessions.get('noisy')?.blindSpots() ?? {};
    expect(spots[BlindSpotKind.RATE_LIMITED], 'sampling must be reported').toBeGreaterThan(0);
  });

  /**
   * Over the cap, sampling must drop by VALUE rather than by arrival order.
   *
   * Volume is inversely correlated with value: a render/DOM storm emits thousands per second while
   * the network call an assertion actually turns on is a single event. First-come-first-dropped
   * therefore spends the whole budget on churn and loses exactly the signal the agent asked about.
   * Measured on a react-admin renderer with a render loop: 11,138 events dropped in one window, the
   * one IPC call under test among them, and the assertion came back `unknown` — honest, but blind.
   */
  it('keeps high-value events when a low-value flood is over the cap', async () => {
    const rateLimited = await makeBridge({ maxMessagesPerSecond: 2 });
    const noisy = await openSocket(rateLimited.port);
    noisy.send(JSON.stringify(hello('mixed')));
    await waitUntil(() => 1 === rateLimited.bridge.sessions.count());

    // A churn flood far past the cap, then the one event that matters, in the SAME window.
    for (let i = 0; i < 50; i += 1) {
      noisy.send(
        JSON.stringify({
          kind: MessageKind.EVENT,
          event: { t: i, type: EventType.DOM_ADDED, sessionId: 'mixed' },
        }),
      );
    }
    noisy.send(
      JSON.stringify({
        kind: MessageKind.EVENT,
        event: { t: 999, type: EventType.NET_REQUEST, sessionId: 'mixed', data: { url: '/paid' } },
      }),
    );

    await waitUntil(() =>
      (rateLimited.bridge.sessions.get('mixed')?.eventsSince(0) ?? []).some(
        (event) => event.type === EventType.NET_REQUEST,
      ),
    );
    const kept = rateLimited.bridge.sessions.get('mixed')?.eventsSince(0) ?? [];
    expect(
      kept.some((event) => event.type === EventType.NET_REQUEST),
      'the network call must survive a DOM flood that is over the cap',
    ).toBe(true);
    // The bound still holds — the reserve is bounded, so the flood is still shed.
    expect(kept.length, 'sampling must still shed the flood').toBeLessThan(50);
  });

  /**
   * Only EVENTS may be dropped. A dropped hello strands the session and a dropped command_result
   * hangs the agent's in-flight call, so the cap must bound observation without breaking protocol.
   */
  it('never drops control traffic, however fast it arrives', async () => {
    const rateLimited = await makeBridge({ maxMessagesPerSecond: 1 });
    const noisy = await openSocket(rateLimited.port);
    noisy.send(JSON.stringify(hello('ctrl')));
    // The hello itself is already over a cap of 1; the session must still exist.
    await waitUntil(() => 1 === rateLimited.bridge.sessions.count());
    expect(rateLimited.bridge.sessions.get('ctrl')).toBeDefined();
    expect(noisy.readyState).toBe(WebSocket.OPEN);
  });

  it('caps and expires unauthenticated pending handshakes', async () => {
    // The hello timeout has to outlast the SECOND connect, not merely be short. At 50ms this raced
    // on a loaded runner: `idle` expired before `excess` finished connecting, which freed the one
    // pending slot, so `excess` was ACCEPTED and later closed 1008 (hello timeout) instead of 1013
    // (too many pending). The assertion then read `expected 1008 to be 1013` — a real cap reported
    // as broken because the machine was slow, which is the failure mode a duration-based test has.
    // A second is far longer than a loopback connect and still expires well inside the test.
    const limited = await makeBridge({
      maxPendingConnections: 1,
      helloTimeoutMs: 1_000,
    });
    const idle = await openSocket(limited.port);
    const idleClosed = waitForClose(idle);

    const excess = await openSocket(limited.port);
    const excessClosed = waitForClose(excess);
    // Refused by the cap while `idle` still holds the slot — not by its own timeout.
    expect(await excessClosed).toBe(1013);
    // And the slot is not held for ever: the idle handshake still expires on its own.
    expect(await idleClosed).toBe(1008);
    expect(limited.bridge.sessions.count()).toBe(0);
  });

  /**
   * Every other refusal on this path records WHY, and this one did not.
   *
   * A dial turned away because the handshake pool was full closed the socket and returned — no
   * `noteClosure`, no log. So an app that was running, instrumented and actively trying to connect
   * was indistinguishable from an app nobody started, and the no-session diagnosis went looking for
   * a stopped dev server. That is the same shape as the origin-gate refusal that used to leave no
   * trace, and the same remedy: put it on the channel the diagnosis already reads.
   */
  it('says WHY when a dial is turned away for a full handshake pool', async () => {
    const limited = await makeBridge({ maxPendingConnections: 1, helloTimeoutMs: 5_000 });
    const holder = await openSocket(limited.port);
    const excess = await openSocket(limited.port);
    expect(await waitForClose(excess)).toBe(1013);

    const why = limited.bridge.sessions.lastClosure()?.reason ?? '';
    expect(why, 'the refusal must be readable, not just logged').toMatch(/handshake/i);
    holder.close();
  });

  it('rejects messages above the transport payload limit', async () => {
    const { port } = await makeBridge();
    const socket = await openSocket(port);
    const closed = waitForClose(socket);
    socket.send(Buffer.alloc(TRANSPORT_LIMITS.MAX_MESSAGE_BYTES + 1));
    expect(await closed).toBe(1009);
  });
});

/**
 * The bridge closes a socket that exceeds the message-rate cap with a POLICY code, so the SDK does
 * not retry: the app keeps running and Reticle is blind from that moment on.
 *
 * Measured on the bench app — 2600 requests fired in one tick disconnected the session permanently,
 * and the only trace was a line in the PAGE console, which no agent reads. The agent saw "no browser
 * session connected — check your app is running with @reticlehq/browser enabled", which is exactly
 * wrong: the app IS running and instrumented. It was hung up on. An unexplained disappearance is the
 * worst shape of error, because every recovery it suggests is the wrong one.
 */
describe('a session closed by the bridge explains itself to the agent', () => {
  it('surfaces the close reason on the next resolve, instead of blaming the app', () => {
    const sessions = new SessionManager();
    sessions.noteClosure('message rate exceeded', 1000);
    expect(() => sessions.resolve()).toThrow(/message rate exceeded/);
  });

  it('says the app is probably still running, so the agent does not go restart it', () => {
    const sessions = new SessionManager();
    sessions.noteClosure('message rate exceeded', 1000);
    expect(() => sessions.resolve()).toThrow(/still running/);
  });

  it('keeps the plain message when nothing was closed', () => {
    expect(() => new SessionManager().resolve()).not.toThrow(/bridge closed/);
  });
});

/**
 * An SDK the bridge REFUSED looks exactly like an app that was never started.
 *
 * `noteClosure` exists, is tested directly above, and **nothing in production calls it** — the
 * message-rate close it was built for was later replaced by sampling ("Over the cap we SAMPLE — we
 * never disconnect"), and the mechanism was left wired to nothing. So the branch in `resolve()` that
 * reports a bridge-initiated close has been unreachable.
 *
 * That matters most for the two closes that reject a would-be session with a diagnosis the bridge
 * already knows:
 *
 *   PROTOCOL_MISMATCH: 'protocol version mismatch — upgrade @reticlehq/browser'
 *   AUTH_FAILED:       'authentication failed' (or 'no pairing token on the page' when none was sent)
 *
 * The SDK prints those and stops retrying. The agent, meanwhile, calls a tool and is told "no
 * browser session connected" — indistinguishable from an app nobody started. An outdated SDK and a
 * stale pairing token are both **invisible**, which is the same shape as #127: skew that surfaces as
 * a bare failure with nothing naming a version.
 */
describe('a hello the bridge rejected is reported, not silently absent', () => {
  it('a protocol mismatch reaches the agent instead of "no session connected"', () => {
    const sessions = new SessionManager();
    sessions.noteClosure(WS_CLOSE_REASON.PROTOCOL_MISMATCH, 1000);
    expect(() => sessions.resolve()).toThrow(/protocol version mismatch/);
    expect(() => sessions.resolve()).toThrow(/@reticlehq\/browser/);
  });

  it('an auth failure names the token, not the tab', () => {
    const sessions = new SessionManager();
    sessions.noteClosure(WS_CLOSE_REASON.AUTH_FAILED, 1000);
    expect(() => sessions.resolve()).toThrow(/authentication failed/);
  });

  it('does not tell the reader to reload when reloading is not the fix', () => {
    const sessions = new SessionManager();
    sessions.noteClosure(WS_CLOSE_REASON.PROTOCOL_MISMATCH, 1000);
    let message = '';
    try {
      sessions.resolve();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(
      message,
      'a reload cannot fix an SDK on the wrong protocol — the close reason already names the fix',
    ).not.toMatch(/Reload the page to reconnect/);
  });
});
