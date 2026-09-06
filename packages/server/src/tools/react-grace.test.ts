/**
 * "The app ignored this response" is only sayable once the app has had a chance to read it.
 *
 * `response-ignored` fires when a write succeeded on the server and nothing on the client moved. It
 * is a genuine and valuable finding — a lost write, a response parsed into the void, a render that
 * never happened. It is also an ACCUSATION, and it is decided by a window boundary.
 *
 * Waiting for in-flight requests before taking the verdict made that boundary dangerous in a way it
 * was not before. Previously the write was still pending when the window closed, so it never reached
 * the `settled` list and this rule could not fire at all. Now the response lands inside the window by
 * design — and the app's re-render happens in a later task, a few milliseconds after. Close the
 * window in that gap and every channel agrees the app took a successful write and did nothing.
 *
 * The verdict would be `verified: "no"` on a completely correct application, produced entirely by
 * where we chose to stop looking. That is a false green's evil twin and the more damaging one for a
 * verification tool: it accuses.
 *
 * So the response is not the end of the window — the app's REACTION to it is. When a successful write
 * settles and nothing has moved yet, wait briefly for the reaction, bounded by the caller's remaining
 * budget. Only after that grace has passed with nothing at all is "ignored" an honest word.
 *
 * The grace is paid only in the exact case that would otherwise be accused: a successful mutating
 * write with no movement after it. An action that already moved the UI returns immediately.
 */

import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from '../events/contradictions.js';
import { awaitsReaction, waitForReaction } from './react-grace.js';

type Ev = { type: string; t: number; data: Record<string, unknown> };

const okWrite = (t = 1): Ev => ({
  type: EventType.NET_REQUEST,
  t,
  data: { id: 'n1', method: 'POST', url: '/api/save', status: 200, ok: true },
});
const okRead = (t = 1): Ev => ({
  type: EventType.NET_REQUEST,
  t,
  data: { id: 'n2', method: 'GET', url: '/api/list', status: 200, ok: true },
});
const failedWrite = (t = 1): Ev => ({
  type: EventType.NET_REQUEST,
  t,
  data: { id: 'n3', method: 'POST', url: '/api/save', status: 500, ok: false },
});
/** A desktop IPC write, exactly as the IPC observer records one: method `IPC`, url `ipc://<cmd>`. */
const okIpcWrite = (t = 1): Ev => ({
  type: EventType.NET_REQUEST,
  t,
  data: { id: 'n4', method: 'IPC', url: 'ipc://save_todo', status: 200, ok: true },
});
const domMoved = (t = 2): Ev => ({ type: EventType.DOM_TEXT, t, data: { path: 'div' } });
const stateMoved = (t = 2): Ev => ({ type: EventType.STATE_CHANGE, t, data: { store: 'app' } });

describe('is this window one that could be wrongly accused?', () => {
  it('yes: a successful write with nothing moved after it', () => {
    expect(awaitsReaction([okWrite()])).toBe(true);
  });

  it('no: the app already moved, so there is nothing to wait for', () => {
    expect(awaitsReaction([okWrite(), domMoved()])).toBe(false);
    expect(awaitsReaction([okWrite(), stateMoved()])).toBe(false);
  });

  it('no: a READ that changed nothing is a prefetch, never an accusation', () => {
    // response-ignored is writes-only, so a GET must not buy a grace period nobody needs.
    expect(awaitsReaction([okRead()])).toBe(false);
  });

  it('no: a FAILED write is a different finding, and waiting cannot change it', () => {
    expect(awaitsReaction([failedWrite()])).toBe(false);
  });

  it('no: no traffic at all — the overwhelmingly common action pays nothing', () => {
    expect(awaitsReaction([])).toBe(false);
    expect(awaitsReaction([domMoved()])).toBe(false);
  });

  it('yes: an IPC write, because the detector counts one as a write and this must agree', () => {
    // The accuser and the grace must read "write" the same way. `MUTATING_METHODS` in
    // @reticlehq/core is ['POST','PUT','PATCH','DELETE','IPC'] and `findContradictions` raises
    // response-ignored off it; this module re-declares its own list and leaves IPC out. So on a
    // Tauri or Electron app EVERY successful IPC write skips the grace, the window closes in the
    // gap before the app re-renders, and a correct desktop app is told it ignored its own response.
    // The grace exists to stop exactly that accusation; it is currently paid for every method
    // except the desktop one.
    expect(awaitsReaction([okIpcWrite()])).toBe(true);
  });

  it('no: an IPC write the app already reacted to still buys nothing', () => {
    expect(awaitsReaction([okIpcWrite(), domMoved()])).toBe(false);
  });
});

describe('waiting for the reaction', () => {
  function fakeSession(frames: Ev[][]) {
    let poll = 0;
    let now = 0;
    return {
      session: {
        eventsSince: () => frames[Math.min(poll, frames.length - 1)] ?? [],
        elapsed: () => now,
      },
      tick: (ms: number) => {
        now += ms;
        poll += 1;
      },
      polls: () => poll,
    };
  }
  const sleeper = (f: { tick: (ms: number) => void }) => ({
    sleep: (ms: number) => {
      f.tick(ms);
      return Promise.resolve();
    },
  });

  it('returns the moment the app reacts', async () => {
    const f = fakeSession([[okWrite()], [okWrite(), domMoved()]]);
    expect(await waitForReaction(f.session, 0, 5000, sleeper(f))).toBe(true);
  });

  it('does not wait when the app had already reacted', async () => {
    const f = fakeSession([[okWrite(), stateMoved()]]);
    expect(await waitForReaction(f.session, 0, 5000, sleeper(f))).toBe(true);
    expect(f.polls()).toBe(0);
  });

  it('gives up after the grace, so a genuinely ignored write is still reported', async () => {
    // The finding must survive. An app that really does drop the response gets accused, as it should.
    const f = fakeSession([[okWrite()]]);
    expect(await waitForReaction(f.session, 0, 5000, sleeper(f))).toBe(false);
  });

  it('never waits longer than the grace, however much budget is left', async () => {
    const f = fakeSession([[okWrite()]]);
    await waitForReaction(f.session, 0, 60_000, sleeper(f));
    expect(f.session.elapsed()).toBeLessThanOrEqual(300);
  });

  it('never waits past the remaining budget when that is the smaller of the two', async () => {
    const f = fakeSession([[okWrite()]]);
    await waitForReaction(f.session, 0, 80, sleeper(f));
    expect(f.session.elapsed()).toBeLessThanOrEqual(80);
  });

  it('treats a spent budget as no wait', async () => {
    const f = fakeSession([[okWrite()]]);
    expect(await waitForReaction(f.session, 0, 0, sleeper(f))).toBe(false);
    expect(f.polls()).toBe(0);
  });
});

/** The behaviour this exists to protect, stated against the real detector. */
describe('the accusation itself', () => {
  let seq = 0;
  const ev = (type: EventType, data: Record<string, unknown>): ReticleEvent => {
    seq += 1;
    return { t: seq, seq, type, sessionId: 's', data };
  };
  const write = (): ReticleEvent =>
    ev(EventType.NET_REQUEST, { id: 'w', method: 'POST', url: '/api/save', status: 200, ok: true });

  it('a window cut between the response and the render accuses a correct app', () => {
    // Exactly what the grace prevents — kept as the statement of the hazard.
    const cut = [write()];
    expect(findContradictions(cut, { actionSince: 0 }).map((c) => c.kind)).toContain(
      ContradictionKind.RESPONSE_IGNORED,
    );
  });

  it('the same window including the render does not', () => {
    const whole = [write(), ev(EventType.DOM_TEXT, { path: 'div' })];
    expect(findContradictions(whole, { actionSince: 0 }).map((c) => c.kind)).not.toContain(
      ContradictionKind.RESPONSE_IGNORED,
    );
  });
});
