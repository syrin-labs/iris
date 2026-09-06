/**
 * An `unknown` an agent cannot act on ends the drive.
 *
 * `unsettled` is the commonest reason a verdict comes back `unknown`, and the whole of what it said
 * was that the page "never settled" — equally true of a page that polls, a page that animates, and a
 * page whose write is still open, which need three different next moves. This pins that the sentence
 * names the wait, what the window held when the budget ran out, and the one thing to try next.
 */

import { describe, expect, it } from 'vitest';
import { ContradictionKind, PredicateKind, Verified, VerifiedReason } from '@reticlehq/core';
import { HonestyGrade } from './honesty.js';
import { decideVerified } from './verified.js';
import { describeWaitTarget, namedNetIsInFlight, unsettledBecause } from './unsettled.js';

const clean = {
  grade: HonestyGrade.SIGNAL,
  attribution: 'window',
  coverage: { pct: 100, partial: false },
  integrity: { clean: true, issues: [] },
} as unknown as Parameters<typeof decideVerified>[0]['honesty'];

describe('describeWaitTarget names what was being waited for', () => {
  it('names the implicit settle wait, which is what an agent that passed no `until` got', () => {
    expect(describeWaitTarget({ kind: PredicateKind.SETTLED })).toContain('idle');
  });

  it('names a signal by name', () => {
    expect(describeWaitTarget({ kind: PredicateKind.SIGNAL, name: 'auth:granted' })).toContain(
      'auth:granted',
    );
  });

  it('names a request by method and url', () => {
    const said = describeWaitTarget({
      kind: PredicateKind.NET,
      method: 'POST',
      urlContains: '/api/login',
    });
    expect(said).toContain('POST');
    expect(said).toContain('/api/login');
  });

  it('describes a composite without losing its parts', () => {
    const said = describeWaitTarget({
      kind: PredicateKind.ALL_OF,
      predicates: [
        { kind: PredicateKind.SIGNAL, name: 'saved' },
        { kind: PredicateKind.TEXT, contains: 'Saved' },
      ],
    });
    expect(said).toContain('saved');
    expect(said).toContain('Saved');
  });
});

/**
 * A named net that is still open is the register POST that finished 500ms after the window, not a
 * miss. Matching is the whole discriminator: an unrelated in-flight poll must not pardon a real miss.
 */
describe("namedNetIsInFlight matches the assertion's own request", () => {
  it('is true when the named POST is still open', () => {
    expect(
      namedNetIsInFlight(
        { kind: PredicateKind.NET, method: 'POST', urlContains: '/api/v1/auth/register' },
        ['POST /api/v1/auth/register'],
      ),
    ).toBe(true);
  });

  it('is false when a different URL is the one left open', () => {
    expect(
      namedNetIsInFlight({ kind: PredicateKind.NET, urlContains: '/api/v1/auth/register' }, [
        'GET /api/notifications',
      ]),
    ).toBe(false);
  });

  it('is false when the caller only asked about the screen', () => {
    expect(
      namedNetIsInFlight({ kind: PredicateKind.TEXT, contains: 'Welcome' }, [
        'POST /api/v1/auth/register',
      ]),
    ).toBe(false);
  });

  it('reads the net out of an allOf that also names on-screen proof', () => {
    expect(
      namedNetIsInFlight(
        {
          kind: PredicateKind.ALL_OF,
          predicates: [
            { kind: PredicateKind.NET, urlContains: '/api/v1/auth/register' },
            { kind: PredicateKind.TEXT, contains: 'Welcome' },
          ],
        },
        ['POST /api/v1/auth/register'],
      ),
    ).toBe(true);
  });
});

describe('unsettledBecause says what the window held instead', () => {
  it('names the outstanding requests, which is the retry an agent can actually make', () => {
    const said = unsettledBecause('the page never settled', {
      waitedFor: 'the page to go idle',
      stillInFlight: ['POST /api/login'],
    });
    expect(said).toContain('the page to go idle');
    expect(said).toContain('POST /api/login');
    expect(said).toMatch(/re-check/i);
  });

  it('says waiting longer will NOT help when nothing was outstanding', () => {
    // The distinction the old sentence could not make: an open write is worth waiting for, page
    // churn is not, and telling an agent to raise the timeout on churn buys it a slower dead end.
    const said = unsettledBecause('the page never settled', {
      waitedFor: 'the page to go idle',
      stillInFlight: [],
    });
    expect(said).toMatch(/will not help/i);
  });

  /**
   * The measured dead end: a retrying query against a dead backend. Every attempt COMPLETES, so
   * nothing is ever "still in flight" when the budget runs out, and the sentence blamed unnamed
   * churn — "a poll, a timer, an animation" — on an app whose whole problem was one endpoint being
   * hammered. Naming the repeat is the difference between "my assertion was wrong" and "this app has
   * a retry loop that never quiets".
   */
  it('names the request that kept firing when nothing was left open', () => {
    const said = unsettledBecause('the page never settled', {
      waitedFor: 'the page to go idle',
      stillInFlight: [],
      repeated: ['GET /api/v1/session ×7'],
    });
    expect(said).toContain('GET /api/v1/session ×7');
    expect(said).toMatch(/will not help/i);
  });

  // Negative control: with nothing repeating either, the honest answer is still the churn sentence —
  // inventing a culprit would be its own false claim.
  it('keeps the churn sentence when nothing repeated', () => {
    const said = unsettledBecause('the page never settled', {
      waitedFor: 'the page to go idle',
      stillInFlight: [],
      repeated: [],
    });
    expect(said).toMatch(/will not help/i);
    expect(said).toMatch(/poll, a timer, an animation/);
  });

  it('is bounded — a chatty window must not spend the verdict on a request list', () => {
    const said = unsettledBecause('base', {
      waitedFor: 'the page to go idle',
      stillInFlight: ['GET /a', 'GET /b', 'GET /c', 'GET /d', 'GET /e'],
    });
    expect(said).not.toContain('/e');
    expect(said).toContain('2 more');
  });
});

describe('the verdict carries it, in the field an agent already reads', () => {
  it('puts the detail in `because` rather than a second parallel channel', () => {
    const v = decideVerified({
      pass: true,
      honesty: clean,
      settled: false,
      unsettled: { waitedFor: "signal 'saved'", stillInFlight: ['PUT /api/doc/7'] },
    });
    expect(v.verified).toBe(Verified.UNKNOWN);
    expect(v.verifiedReason).toBe(VerifiedReason.UNSETTLED);
    expect(v.because).toContain("signal 'saved'");
    expect(v.because).toContain('PUT /api/doc/7');
    expect(Object.keys(v).sort()).toEqual(['because', 'verified', 'verifiedReason']);
  });

  it('reaches the absence-derived clause too — the other way unsettled is reported', () => {
    const v = decideVerified({
      pass: true,
      honesty: clean,
      contradictions: [{ kind: ContradictionKind.REQUEST_NEVER_SETTLED }],
      unsettled: { waitedFor: 'the page to go idle', stillInFlight: ['POST /api/pay'] },
    });
    expect(v.verifiedReason).toBe(VerifiedReason.EVIDENCE_INCOMPLETE);
    expect(v.because).toContain('POST /api/pay');
    // and still names the finding it was derived from
    expect(v.because).toContain(ContradictionKind.REQUEST_NEVER_SETTLED);
  });

  it('keeps the old sentence when no detail was supplied — nothing is undone', () => {
    const v = decideVerified({ pass: true, honesty: clean, settled: false });
    expect(v.because).toMatch(/never settled/);
    expect(v.because).toMatch(/re-check/i);
  });
});
