/**
 * #726: the helper only stops the fifth occurrence if it keeps returning a REAL `Session`.
 *
 * A future edit that goes back to a structural object, or that drops a default, would silently
 * restore exactly the failure this replaces -- a method added to `Session` that is `undefined` at
 * runtime in files unrelated to the change. These tests pin the two properties that make the
 * guarantee hold: the thing is a `Session`, and it answers every method a stub used to hand-roll.
 */
import { describe, expect, it } from 'vitest';
import { SessionState } from '@reticlehq/core';
import { Session } from './session.js';
import { createFakeSession, fakeHello } from './fake-session.js';

describe('createFakeSession', () => {
  it('is an instance of Session, not a structural look-alike', () => {
    // The property that does the work. A `Partial<Session>` cast through `as Session` passes every
    // type check and then throws on the first method nobody remembered to stub.
    expect(createFakeSession()).toBeInstanceOf(Session);
  });

  it('answers every method the hand-rolled stubs used to fill in', async () => {
    const session = createFakeSession();
    expect(session.id).toBe('demo');
    expect(session.elapsed()).toBe(0);
    expect(session.bufferHealth()).toEqual({ total: 0, dropped: 0 });
    expect(session.lostSince(0)).toBe(false);
    expect(session.blindSpots()).toEqual({});
    expect(session.eventsSince(0)).toEqual([]);
    expect(session.eventsInWindow(1000)).toEqual([]);
    expect(session.throttled()).toBe(false);
    expect(session.getState()).toBe(SessionState.ACTIVE);
    expect(session.drainInbox()).toEqual([]);
    expect(session.inboxSize()).toBe(0);
    expect(session.ambientCounts()).toEqual({});
    expect(session.lastAct).toBeDefined();
    expect(typeof session.recordAction('tool', {})).toBe('string');
    expect(typeof session.onEvent(() => undefined)).toBe('function');
    await expect(session.queryEvents({})).resolves.toEqual([]);
  });

  it('lets a test override a method without touching the rest', () => {
    const session = createFakeSession({ elapsed: () => 1000, throttled: () => true });
    expect(session.elapsed()).toBe(1000);
    expect(session.throttled()).toBe(true);
    expect(session.bufferHealth()).toEqual({ total: 0, dropped: 0 });
  });

  it('overrides a getter-only accessor, which a plain assignment cannot', () => {
    // `runtime` is fed by `applyHealth` on a live session, which a fake has no events for.
    // Assigning to it throws "has only a getter"; the helper redefines it instead.
    const session = createFakeSession({ runtime: 'electron-renderer' as never });
    expect(session.runtime).toBe('electron-renderer');
  });

  it('takes handshake fields separately from behaviour', () => {
    const session = createFakeSession({}, { url: 'http://localhost:5173/app', sessionId: 's-2' });
    expect(session.url).toBe('http://localhost:5173/app');
    expect(session.id).toBe('s-2');
    expect(fakeHello().sessionId).toBe('demo');
  });
});
