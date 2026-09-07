import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import {
  RETICLE_PROTOCOL_VERSION,
  MessageKind,
  EventType,
  SESSION_HEALTH,
  SESSION_LIFECYCLE,
  SessionState,
  HIDDEN_TAB_RECOMMENDATION,
  THROTTLED_TAB_RECOMMENDATION,
  type HelloMessage,
  type ReticleEvent,
} from '@reticlehq/core';
import { AppRuntime } from '@reticlehq/core';
import { Session, SessionManager } from './session.js';

const HELLO: HelloMessage = {
  kind: MessageKind.HELLO,
  protocolVersion: RETICLE_PROTOCOL_VERSION,
  sessionId: 'demo',
  url: 'http://localhost/',
  title: 'Demo',
  adapters: [],
  hasCapabilities: false,
};

const fakeSocket = { send: (): void => {} } as unknown as WebSocket;

function makeSession(): { session: Session; tick: (ms: number) => void } {
  let now = 0;
  const session = new Session(HELLO, fakeSocket, () => now);
  return {
    session,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe('SPA navigation keeps session.url live (real-input correlation fix)', () => {
  const routeEvent = (to: string): ReticleEvent =>
    ({
      type: EventType.ROUTE_CHANGE,
      data: { from: 'x', to, pathname: '', search: '', hash: '' },
    }) as unknown as ReticleEvent;

  it('updates url on a ROUTE_CHANGE event (so CDP page correlation tracks SPA nav)', () => {
    const { session } = makeSession();
    expect(session.url).toBe('http://localhost/');
    session.pushEvent(routeEvent('http://localhost/workspace?script=42'));
    expect(session.url).toBe('http://localhost/workspace?script=42');
    expect(session.info().url).toBe('http://localhost/workspace?script=42');
  });

  it('ignores a route event with a missing/empty/non-string `to` (keeps the last good url)', () => {
    const { session } = makeSession();
    session.pushEvent(routeEvent('http://localhost/a'));
    session.pushEvent({
      type: EventType.ROUTE_CHANGE,
      data: { to: '' },
    } as unknown as ReticleEvent);
    session.pushEvent({ type: EventType.ROUTE_CHANGE, data: {} } as unknown as ReticleEvent);
    expect(session.url).toBe('http://localhost/a');
  });
});

describe('session health', () => {
  it('throttles when lastSeen exceeds the stale threshold (clock injected)', () => {
    const { session, tick } = makeSession();
    session.touch();
    expect(session.throttled()).toBe(false);
    tick(SESSION_HEALTH.STALE_THRESHOLD_MS + 1);
    expect(session.throttled()).toBe(true);
    expect(session.lastSeenMs()).toBeGreaterThan(SESSION_HEALTH.STALE_THRESHOLD_MS);
  });

  it('throttles immediately when the tab is hidden, regardless of recency', () => {
    const { session } = makeSession();
    session.touch();
    session.applyHealth(true, false);
    expect(session.throttled()).toBe(true);
    expect(session.health().focused).toBe(false);
  });

  it('is not throttled when visible and recently seen', () => {
    const { session, tick } = makeSession();
    session.applyHealth(false, true);
    tick(1000);
    session.touch();
    expect(session.throttled()).toBe(false);
    const h = session.health();
    expect(h.throttled).toBe(false);
    expect(h.focused).toBe(true);
  });

  it('carries the engine and brand the page reported on PAGE_HEALTH', () => {
    const { session } = makeSession();
    expect(session.brand).toBeUndefined(); // an SDK too old to report one says nothing
    session.pushEvent({
      type: EventType.PAGE_HEALTH,
      data: { hidden: false, focused: true, engine: 'blink', brand: 'arc' },
    } as unknown as ReticleEvent);
    expect(session.engine).toBe('blink');
    expect(session.brand).toBe('arc');
  });

  it('exposes health on info()', () => {
    const { session } = makeSession();
    session.applyHealth(true, false);
    const info = session.info();
    expect(info.hidden).toBe(true);
    expect(info.focused).toBe(false);
    expect(info.throttled).toBe(true);
    expect(typeof info.lastSeenMs).toBe('number');
  });
});

describe('server-authoritative liveness', () => {
  it('tracks agent idle time from the injected clock', () => {
    const { session, tick } = makeSession();
    session.markAgentActivity();
    expect(session.agentIdleMs()).toBe(0);
    tick(5000);
    expect(session.agentIdleMs()).toBe(5000);
  });

  it('agentIdleMs resets on the next agent activity', () => {
    const { session, tick } = makeSession();
    tick(10_000);
    session.markAgentActivity();
    expect(session.agentIdleMs()).toBe(0);
  });

  it('defaults idleEndMs and floors a tuned value below the minimum', () => {
    const { session } = makeSession();
    expect(session.idleEndMs()).toBe(SESSION_LIFECYCLE.IDLE_END_MS);
    session.setIdleEndMs(1000); // below the floor
    expect(session.idleEndMs()).toBe(SESSION_LIFECYCLE.IDLE_END_MIN_MS);
    session.setIdleEndMs(30_000);
    expect(session.idleEndMs()).toBe(30_000);
  });

  it('autoEnd marks the session ended', () => {
    const { session } = makeSession();
    session.autoEnd('idle');
    expect(session.isEnded()).toBe(true);
    expect(session.getState()).toBe(SessionState.ENDED);
  });

  it('revives an auto-ended session when the agent acts again (slow-but-alive Claude)', () => {
    const { session } = makeSession();
    session.autoEnd('idle');
    expect(session.getState()).toBe(SessionState.ENDED);
    session.markAgentActivity();
    expect(session.getState()).toBe(SessionState.ACTIVE);
  });

  it('an EXPLICIT end stays terminal even if the agent acts again', () => {
    const { session } = makeSession();
    session.setState(SessionState.ENDED); // human/agent reticle_end_session, not the reaper
    session.markAgentActivity();
    expect(session.getState()).toBe(SessionState.ENDED);
  });
});

describe('SessionManager.resolve() auto-selection', () => {
  function makeHello(id: string): HelloMessage {
    return { ...HELLO, sessionId: id };
  }

  function makeThrottledSession(id: string, nowMs: number): Session {
    const now = nowMs;
    const s = new Session(makeHello(id), fakeSocket, () => now);
    s.touch(); // mark seen at nowMs
    s.applyHealth(true, false); // hidden → throttled
    return s;
  }

  it('single session resolves regardless of throttled state', () => {
    const mgr = new SessionManager();
    const s = makeThrottledSession('a', 0);
    mgr.add(s);
    expect(mgr.resolve().id).toBe('a');
  });

  it('prefers the non-throttled session when one is focused and the other is not', () => {
    const mgr = new SessionManager();
    // sA: focused, lastSeenMs = 0
    const clockA = 0;
    const sA = new Session(makeHello('a'), fakeSocket, () => clockA);
    sA.touch();
    sA.applyHealth(false, true);
    // sB: hidden, touch happened 5 s in the past → lastSeenMs = 5000
    let clockB = -5_000;
    const sB = new Session(makeHello('b'), fakeSocket, () => clockB);
    sB.touch();
    clockB = 0;
    sB.applyHealth(true, false);
    mgr.add(sB);
    mgr.add(sA);
    expect(mgr.resolve().id).toBe('a');
  });

  it('all-throttled: picks the session with the freshest heartbeat, no gap required', () => {
    // Simulates: user is in VS Code, Chrome is on another desktop — both tabs are hidden.
    // The gap between lastSeenMs values is only 500 ms (< 1000 ms old threshold).
    // Before the fix this would throw. After the fix it should silently pick the freshest.
    const mgr = new SessionManager();
    let clockA = 0;
    const sA = new Session(makeHello('a'), fakeSocket, () => clockA);
    sA.touch(); // touched at 0
    clockA = 500; // now it's 500 ms later — lastSeenMs(a) = 500
    sA.applyHealth(true, false);

    let clockB = 0;
    const sB = new Session(makeHello('b'), fakeSocket, () => clockB);
    sB.touch(); // touched at 0
    clockB = 200; // lastSeenMs(b) = 200 (more recent — smaller value means fresher)
    sB.applyHealth(true, false);

    mgr.add(sA);
    mgr.add(sB);
    // sB is the freshest (lastSeenMs=200 < 500). Should be auto-selected.
    expect(mgr.resolve().id).toBe('b');
  });

  it('all-throttled with exactly equal lastSeenMs still throws — cannot distinguish without sessionId', () => {
    // Degenerate edge case: two sessions have precisely the same heartbeat time.
    // Even with no gap required (allThrottled), 0 < 0 is false — still ambiguous.
    // In practice this never happens; the test documents the invariant.
    const mgr = new SessionManager();
    const sA = makeThrottledSession('a', 0);
    const sB = makeThrottledSession('b', 0);
    mgr.add(sA);
    mgr.add(sB);
    expect(() => mgr.resolve()).toThrow('multiple sessions connected');
  });

  it('mixed throttled: still throws when two non-throttled sessions are within 1 s of each other', () => {
    const mgr = new SessionManager();
    const sA = new Session(makeHello('a'), fakeSocket, () => 0);
    sA.touch();
    sA.applyHealth(false, true); // focused, lastSeenMs = 0

    const sB = new Session(makeHello('b'), fakeSocket, () => 0);
    sB.touch();
    sB.applyHealth(false, true); // focused, lastSeenMs = 0

    mgr.add(sA);
    mgr.add(sB);
    expect(() => mgr.resolve()).toThrow('multiple sessions connected');
  });
});

describe('tab-health recommendation', () => {
  it('info() carries the recommendation when hidden', () => {
    const { session } = makeSession();
    session.applyHealth(true, false);
    expect(session.info().recommendation).toBe(HIDDEN_TAB_RECOMMENDATION);
  });

  it('info() recommends when stale past the threshold — the NOT-hidden wording', () => {
    // Stale is not hidden. `throttled` is `hidden || stale`, so a quiet visible tab trips it, and
    // that tab is usually still driveable: telling it "you may be un-focusable, go lease one" sent
    // agents off the only screen a human can watch, for a heartbeat that was merely late.
    const { session, tick } = makeSession();
    session.touch();
    tick(SESSION_HEALTH.STALE_THRESHOLD_MS + 1);
    expect(session.info().recommendation).toBe(THROTTLED_TAB_RECOMMENDATION);
  });

  it('info() omits recommendation when visible and recently seen', () => {
    const { session, tick } = makeSession();
    session.applyHealth(false, true);
    tick(1000);
    session.touch();
    expect('recommendation' in session.info()).toBe(false);
  });

  it('health() carries the recommendation when throttled', () => {
    const { session } = makeSession();
    session.applyHealth(true, false);
    expect(session.health().recommendation).toBe(HIDDEN_TAB_RECOMMENDATION);
  });
});

/**
 * An observer that throws must not end the daemon.
 *
 * `pushEvent` runs inside the bridge's websocket `message` handler, which is a plain non-async
 * callback: a sync throw out of a subscriber escapes every try/catch the tool call is wrapped in,
 * reaches the process as an uncaughtException, and the daemon answers that by exiting — killing
 * every agent and every browser session on that port, from every project sharing it. The
 * session-ready fan-out has been individually wrapped for this reason for a long time; the event
 * fan-out, which runs thousands of times more often, was not.
 */
describe('an event observer that throws', () => {
  const anyEvent = (): ReticleEvent =>
    ({
      type: EventType.ROUTE_CHANGE,
      data: { from: 'x', to: 'http://localhost/next', pathname: '', search: '', hash: '' },
    }) as unknown as ReticleEvent;

  it('neither escapes pushEvent nor costs the other observers their turn', () => {
    const { session } = makeSession();
    const seen: string[] = [];
    session.onEvent(() => seen.push('before'));
    session.onEvent(() => {
      throw new Error('an observer with a bug in it');
    });
    session.onEvent(() => seen.push('after'));

    expect(() => session.pushEvent(anyEvent())).not.toThrow();
    expect(seen).toEqual(['before', 'after']);
  });
});

// The WIRING, not the helper. `buildSessionRecommendation` grew a desktop branch and every unit test
// for it passed while the branch was unreachable in production, because `Session` was not passing
// its own `runtime` in. Deleting that one argument left all 506 session tests green — which is the
// same shape of gap this repo has hit twice before: the decision is tested, the call is not.
describe('the session hands its runtime to the recommendation', () => {
  it('an Electron window in the background is not told to open a browser', () => {
    const session = new Session(HELLO, fakeSocket, () => 0);
    session.applyHealth(true, false, AppRuntime.ELECTRON);
    const advice = String(session.health().recommendation ?? '');
    expect(advice).not.toContain('reticle_lease');
    expect(advice).toContain('window');
  });

  it('a plain web tab still gets the lease it can actually use', () => {
    const session = new Session(HELLO, fakeSocket, () => 0);
    session.applyHealth(true, false, AppRuntime.WEB);
    expect(String(session.health().recommendation ?? '')).toContain('reticle_lease');
  });
});
