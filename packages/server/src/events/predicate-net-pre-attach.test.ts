import { describe, it, expect } from 'vitest';
import { EventType } from '@reticlehq/core';
import type { ReticleEvent } from '@reticlehq/core';
import { evalNet } from './predicate-eval.js';
import { PredicateKind } from './predicate.js';

/**
 * A request made before the SDK attached must not be graded as a request that never happened.
 *
 * Event `t` is stamped `performance.now() - #start`, `#start` being taken when the SDK is
 * constructed. So `t` is never negative, and a window with no `since` starts AT attach: everything
 * the page did between navigation start and attach left no event to find. Reported from the field
 * (#667) on several stacks — two `fetch`es from an effect in a provider mounted in `app/layout.tsx`
 * never appeared across many hard reloads, and a classic `<script>` at the end of `<body>` lost its
 * calls to a deferred module script under CSP. Later calls were captured perfectly in both.
 *
 * The verdict read `verified: "no" — no network call matched urlContains "/api/v1/auth/me"`, which
 * is a claim about the app rather than about the observer, and it is convincing enough that one
 * reporter re-read their provider and restarted their dev server before working out the request was
 * invisible rather than absent.
 *
 * What is asserted here is deliberately narrow. The negative keeps its grade — a missing API call is
 * the finding this oracle exists to make, and startup is the class that most needs it — so these
 * tests pin BOTH halves: the sentence stops overclaiming, and nothing about the failure weakens.
 */
function netEvent(t: number, data: Record<string, unknown>): ReticleEvent {
  return { type: EventType.NET_REQUEST, t, data } as ReticleEvent;
}

/** A call captured well after attach, so the observer is demonstrably alive in every case below. */
const LATER_CALL = netEvent(400, { method: 'GET', url: '/api/v1/poll', status: 200, ok: true });

const BLIND_HEAD = 'before that are never captured';

describe('evalNet — the window between navigation and SDK attach', () => {
  it('stops a whole-session miss claiming the request was never made', () => {
    const r = evalNet([LATER_CALL], {
      kind: PredicateKind.NET,
      urlContains: '/api/v1/auth/me',
    });

    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain(BLIND_HEAD);
  });

  it('points at the assertion that can settle it', () => {
    // The recovery matters as much as the caveat: the state such a request produces IS observable
    // after attach, and without somewhere to go the caller is left with a verdict and no next step.
    const r = evalNet([], { kind: PredicateKind.NET, urlContains: '/api/v1/auth/me' });

    expect(r.failureReason).toContain('assert on the state it produces');
  });

  it('keeps the negative a failure rather than downgrading it to inconclusive', () => {
    // The half that must NOT change. `inconclusive` lands the verdict on `unknown`, and doing that
    // to every startup assertion would cost the strongest grade for session restore, feature flags
    // and bootstrap config — the class the issue is about — to fix the wording of a sentence.
    const r = evalNet([LATER_CALL], { kind: PredicateKind.NET, urlContains: '/api/v1/auth/me' });

    expect(r.inconclusive).toBeUndefined();
    expect(r.assertion).toBe('net.present');
    expect(r.expected).toContain('/api/v1/auth/me');
  });

  it('leaves a window an action opened alone, since it cannot contain the blind head', () => {
    // `act_and_wait` stamps `since` at the moment it acts, which is necessarily after attach. The
    // caveat there would be false, and would blunt the ordinary "your click fired no request" miss.
    const r = evalNet([LATER_CALL], {
      kind: PredicateKind.NET,
      urlContains: '/api/v1/auth/me',
      since: 200,
    });

    expect(r.pass).toBe(false);
    expect(r.failureReason).not.toContain(BLIND_HEAD);
  });

  it('says nothing on a match', () => {
    const r = evalNet([LATER_CALL], { kind: PredicateKind.NET, urlContains: '/api/v1/poll' });

    expect(r.pass).toBe(true);
    expect(r.failureReason).toBeUndefined();
  });

  it('carries the same caveat into a count assertion that saw nothing', () => {
    // The identical claim through a second door: "saw 0" over a whole-session window is as blind to
    // a startup call as "no network call matched" is.
    const r = evalNet([LATER_CALL], {
      kind: PredicateKind.NET,
      urlContains: '/api/v1/auth/me',
      count: 2,
    });

    expect(r.pass).toBe(false);
    expect(r.assertion).toBe('net.count');
    expect(r.failureReason).toContain(BLIND_HEAD);
  });

  it('does not caveat a count that saw the wrong number of calls it could see', () => {
    // Matches exist, so the observer plainly caught this traffic; the cardinality is the finding.
    const r = evalNet([LATER_CALL], {
      kind: PredicateKind.NET,
      urlContains: '/api/v1/poll',
      count: 3,
    });

    expect(r.pass).toBe(false);
    expect(r.failureReason).not.toContain(BLIND_HEAD);
  });

  it('leaves a `count: 0` absence assertion passing, which is the known gap', () => {
    // Documented rather than fixed. This green is reached the same blind way, so it can assert an
    // absence it never observed — but turning it red is a change of GRADE, not of wording, and it
    // would flip existing green suites. Named here so the limit is visible in the test file rather
    // than only in a discussion.
    const r = evalNet([LATER_CALL], {
      kind: PredicateKind.NET,
      urlContains: '/api/v1/auth/me',
      count: 0,
    });

    expect(r.pass).toBe(true);
  });
});
