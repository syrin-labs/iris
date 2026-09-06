/**
 * Spend the budget you were given before reporting that you ran out of certainty.
 *
 * A login that genuinely succeeds is the most common flow an agent verifies, and it came back
 * `verified:"unknown" / unsettled` — with the declared signal fired AND its data matching, app state
 * moved from anonymous to authenticated, the auth token written to storage, honesty grade `signal`
 * (our strongest evidence class) and capture integrity clean. The single dissenting observation was
 * that the POST had not come back yet.
 *
 * The tool had 8000ms of budget and returned at 492ms. `waitForPredicate` resolves the instant the
 * predicate holds, so the verdict is taken while the app is still mid-flight, and the answer is a
 * shrug the caller then has to resolve by hand — the recovery text literally says "re-check". Seven
 * and a half seconds of authorised waiting went unused.
 *
 * Note what this deliberately does NOT do. It never turns an unsettled request into a pass by
 * assumption: the app navigates optimistically, so at 492ms nobody can know whether that POST
 * succeeds. It waits for the answer instead of guessing at it. A request that comes back a FAILURE
 * still contradicts — that is the real false green and it has to keep working — and a request that is
 * still in flight when the budget genuinely runs out still reports unsettled, which is now an honest
 * limit rather than an early exit.
 */

import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from '../events/contradictions.js';
import {
  inFlightRequestIds,
  inFlightRequestLabels,
  repeatedRequestLabels,
  waitForInFlight,
} from './settle-in-flight.js';

type Ev = { type: string; t: number; data: Record<string, unknown> };

const pending = (id: string, t = 0): Ev => ({
  type: EventType.NET_PENDING,
  t,
  data: { id, url: `https://api.test/${id}`, method: 'POST' },
});
const settled = (id: string, t = 1): Ev => ({
  type: EventType.NET_REQUEST,
  t,
  data: { id, url: `https://api.test/${id}`, method: 'POST', status: 200 },
});

describe('which requests are still in flight', () => {
  it('a pending request with no matching settle is in flight', () => {
    expect(inFlightRequestIds([pending('a')])).toEqual(['a']);
  });

  it('a pending request that settled is not', () => {
    expect(inFlightRequestIds([pending('a'), settled('a')])).toEqual([]);
  });

  it('reports only the ones still outstanding', () => {
    const events = [pending('a'), pending('b'), settled('a')];
    expect(inFlightRequestIds(events)).toEqual(['b']);
  });

  it('says nothing when there was no traffic at all', () => {
    expect(inFlightRequestIds([])).toEqual([]);
  });

  it('names them as METHOD url, because a correlation id is not something an agent can act on', () => {
    expect(inFlightRequestLabels([pending('a'), pending('b'), settled('a')])).toEqual([
      'POST https://api.test/b',
    ]);
  });

  /**
   * The other half of an honest `unsettled`. A retrying query against a dead backend leaves NOTHING
   * in flight — every attempt completes — so the verdict said the page was kept busy by unnamed
   * churn while one endpoint was being hammered in plain sight. On such an app `act_and_wait` can
   * never return a pass, and nothing in the verdict pointed at why.
   */
  it('names an endpoint that fired more than once, which is what a retry loop looks like', () => {
    const events = [settled('a', 1), settled('a', 2), settled('a', 3), settled('b', 4)];
    expect(repeatedRequestLabels(events)).toEqual(['POST https://api.test/a ×3']);
  });

  it('says nothing about a window where each endpoint was called once', () => {
    expect(repeatedRequestLabels([settled('a'), settled('b')])).toEqual([]);
  });

  it('is bounded, and reports the busiest first', () => {
    const events = [
      ...[1, 2, 3, 4].map((t) => settled('a', t)),
      ...[5, 6].map((t) => settled('b', t)),
      ...[7, 8, 9].map((t) => settled('c', t)),
      ...[10, 11].map((t) => settled('d', t)),
    ];
    const labels = repeatedRequestLabels(events);
    expect(labels).toHaveLength(3);
    expect(labels[0]).toContain('/a ×4');
    expect(labels[1]).toContain('/c ×3');
  });

  it('ignores a settle for a request it never saw start', () => {
    // The window is floored at the act cursor, so a response to a request made BEFORE the action can
    // land inside it. That settles nothing this action started and must not be read as progress.
    expect(inFlightRequestIds([settled('older')])).toEqual([]);
  });
});

describe('waiting out the remaining budget', () => {
  /** A fake session whose events change over successive polls, with a controllable clock. */
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

  it('returns as soon as everything has settled', async () => {
    const f = fakeSession([[pending('a')], [pending('a'), settled('a')]]);
    const waited = await waitForInFlight(f.session, 0, 5000, {
      sleep: (ms) => {
        f.tick(ms);
        return Promise.resolve();
      },
    });
    expect(waited.settled).toBe(true);
    expect(waited.stillInFlight).toEqual([]);
  });

  it('does not wait at all when nothing is in flight', async () => {
    const f = fakeSession([[pending('a'), settled('a')]]);
    const waited = await waitForInFlight(f.session, 0, 5000, {
      sleep: (ms) => {
        f.tick(ms);
        return Promise.resolve();
      },
    });
    expect(waited.settled).toBe(true);
    expect(f.polls()).toBe(0); // the green path with no traffic pays nothing
  });

  it('gives up at the deadline and says what was still outstanding', async () => {
    const f = fakeSession([[pending('a')]]);
    const waited = await waitForInFlight(f.session, 0, 300, {
      sleep: (ms) => {
        f.tick(ms);
        return Promise.resolve();
      },
    });
    expect(waited.settled).toBe(false);
    expect(waited.stillInFlight).toEqual(['a']);
  });

  it('never waits past the budget it was given', async () => {
    const f = fakeSession([[pending('a')]]);
    await waitForInFlight(f.session, 0, 250, {
      sleep: (ms) => {
        f.tick(ms);
        return Promise.resolve();
      },
    });
    expect(f.session.elapsed()).toBeLessThanOrEqual(250);
  });

  it('treats a zero or negative budget as no wait, not as an unbounded one', async () => {
    // The caller may have spent the whole timeout reaching the predicate. Subtracting can go negative,
    // and a negative deadline must mean "stop", never "loop forever".
    const f = fakeSession([[pending('a')]]);
    const waited = await waitForInFlight(f.session, 0, -50, {
      sleep: (ms) => {
        f.tick(ms);
        return Promise.resolve();
      },
    });
    expect(waited.settled).toBe(false);
    expect(f.polls()).toBe(0);
  });

  it('waits for a request that settles as a FAILURE, so the contradiction can still be found', async () => {
    // The point is not to make things green. A 500 that arrives during the wait is evidence the
    // action failed, and arriving is what lets the verdict see it at all.
    const failed = (id: string): Ev => ({
      type: EventType.NET_REQUEST,
      t: 2,
      data: { id, url: `https://api.test/${id}`, method: 'POST', status: 500 },
    });
    const f = fakeSession([[pending('a')], [pending('a'), failed('a')]]);
    const waited = await waitForInFlight(f.session, 0, 5000, {
      sleep: (ms) => {
        f.tick(ms);
        return Promise.resolve();
      },
    });
    expect(waited.settled).toBe(true);
  });
});

/**
 * The property that makes this change safe to ship at all.
 *
 * The instinct about anything that turns `unknown` into `yes` is that it must have loosened
 * something. This loosens nothing — it makes the window CONTAIN the response instead of ending
 * before it. A failure that used to land after the window closed, where no detector could reach it,
 * now lands inside it where `ui-advanced-request-failed` fires. Strictly more evidence, and the
 * direction of the change is toward catching false greens, not away.
 */
describe('waiting strengthens the false-green guard rather than weakening it', () => {
  let seq = 0;
  const ev = (type: EventType, data: Record<string, unknown>): ReticleEvent => {
    seq += 1;
    return { t: seq, seq, type, sessionId: 's', data };
  };

  it('a window that ends before the response sees no failure to report', () => {
    // What the old early exit produced: the UI advanced, the POST is merely absent, and the only
    // finding possible is the weak one about not having waited.
    const early = [
      ev(EventType.DOM_REMOVED, { path: 'form' }),
      ev(EventType.NET_PENDING, { id: 'n1', method: 'POST', url: '/api/login' }),
    ];
    // `actionSince` states what these windows always were — the act's. See contradictions.ts.
    const found = findContradictions(early, { actionSince: 0 }).map((c) => c.kind);
    expect(found).toContain(ContradictionKind.REQUEST_NEVER_SETTLED);
    expect(found).not.toContain(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
  });

  it('a window that waited for the SAME failing request reports the real defect', () => {
    const waited = [
      ev(EventType.DOM_REMOVED, { path: 'form' }),
      ev(EventType.NET_PENDING, { id: 'n2', method: 'POST', url: '/api/login' }),
      ev(EventType.NET_REQUEST, {
        id: 'n2',
        method: 'POST',
        url: '/api/login',
        status: 500,
        ok: false,
      }),
    ];
    const found = findContradictions(waited, { actionSince: 0 }).map((c) => c.kind);
    expect(found).toContain(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
    // And the weaker absence-derived finding is gone, because it is no longer true.
    expect(found).not.toContain(ContradictionKind.REQUEST_NEVER_SETTLED);
  });
});
