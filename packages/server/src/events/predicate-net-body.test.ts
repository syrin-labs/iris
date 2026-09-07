import { describe, it, expect } from 'vitest';
import { EventType } from '@reticlehq/core';
import type { ReticleEvent } from '@reticlehq/core';
import { evalNet } from './predicate-eval.js';
import { parsePredicate } from './predicate-parse.js';
import { PredicateKind } from './predicate.js';

/**
 * Asserting on a response BODY, because a status code cannot see the worst false green there is.
 *
 * Found by an agent driving a real payments UI, and its report is the clearest statement of the
 * problem: a refund posted `{"amount":"1187.01"}`, the server answered 200 with
 * `{"ok":true,"refunded":11.87}` after reading the number as paise, and the page rendered the amount
 * the user had typed rather than the amount that came back. Every channel that could be asserted was
 * green - the request fired, exactly once, status 200, console clean, page settled - so
 * `act_and_wait` returned `verified: "yes"` on a hundred-fold wrong money operation.
 *
 * The truth was in the captured body, and the only way to reach it was `reticle_network` read by eye,
 * which produces no verdict. In the reporter's words: the comparison that actually matters happened
 * in its head, not in Reticle, so it was neither verifiable nor repeatable. A predicate that can name
 * a value inside the body is what turns that into a pass or a fail.
 */
function netEvent(t: number, data: Record<string, unknown>): ReticleEvent {
  return { type: EventType.NET_REQUEST, t, data } as ReticleEvent;
}

const REFUND = netEvent(10, {
  method: 'POST',
  url: '/api/refund',
  status: 200,
  ok: true,
  requestBody: '{"amount":"1187.01"}',
  responseBody: '{"ok":true,"refunded":11.87}',
});

describe('evalNet — bodyContains', () => {
  it('fails when the response body does not carry the value the caller declared', () => {
    // The assertion the payments case needed: the server acted on the amount the user asked for.
    const r = evalNet([REFUND], {
      kind: PredicateKind.NET,
      urlContains: '/api/refund',
      bodyContains: '1187.01',
    });
    expect(r.pass).toBe(false);
  });

  it('passes when the response body does carry it', () => {
    const r = evalNet([REFUND], {
      kind: PredicateKind.NET,
      urlContains: '/api/refund',
      bodyContains: '11.87',
    });
    expect(r.pass).toBe(true);
  });

  it('reads the RESPONSE only, so a value the app merely SENT cannot satisfy it', () => {
    // The trap this field exists to avoid, subtle enough that it caught the first implementation:
    // 1187.01 appears in the request because the app posted it, so matching the request would return
    // a pass on precisely the under-refund being hunted. Only the server's answer counts.
    const r = evalNet([REFUND], {
      kind: PredicateKind.NET,
      urlContains: '/api/refund',
      bodyContains: '"amount":"1187.01"',
    });
    expect(r.pass).toBe(false);
  });

  it('composes with status, so a 200 whose body says otherwise is still a failure', () => {
    const r = evalNet([REFUND], {
      kind: PredicateKind.NET,
      urlContains: '/api/refund',
      status: 200,
      bodyContains: '"refunded":1187.01',
    });
    expect(r.pass).toBe(false);
  });

  it('says the body was never recorded, rather than reporting a plain mismatch', () => {
    // Bodies are opt-in. Without them this predicate can never hold, and "no call matched" would send
    // the caller looking at the url and the method - which are both fine - instead of at the one
    // setting that makes the assertion possible at all.
    const unrecorded = netEvent(10, {
      method: 'POST',
      url: '/api/refund',
      status: 200,
      ok: true,
    });
    const r = evalNet([unrecorded], {
      kind: PredicateKind.NET,
      urlContains: '/api/refund',
      bodyContains: '1187.01',
    });
    expect(r.pass).toBe(false);
    expect(`${r.failureReason ?? ''}${r.observed ?? ''}`).toMatch(
      /captureNetworkBodies|not recorded/,
    );
  });

  it('still counts only the calls whose body matched', () => {
    // `count` is the double-submit guard. Combined with a body match it becomes "exactly one call
    // carried this value", which is what a retry storm on a money endpoint needs.
    const r = evalNet([REFUND, netEvent(20, { ...REFUND.data })], {
      kind: PredicateKind.NET,
      urlContains: '/api/refund',
      bodyContains: '11.87',
      count: 1,
    });
    expect(r.pass).toBe(false);
  });
});

/**
 * `of` for `predicates` on a composite, because the rejection costs a whole round trip and produces
 * no verdict at all.
 *
 * Observed twice in one drive: an agent composing `allOf` wrote `of`, which reads naturally and is
 * what several assertion libraries call it. A rejected predicate is the worst of the three outcomes —
 * the drive ends with nothing rather than with a pass or a fail — and this one is unambiguous, since
 * `of` has no other meaning on a composite.
 */
describe('composite aliases', () => {
  it('accepts `of` where a composite means `predicates`', () => {
    const parsed = parsePredicate({
      kind: 'allOf',
      of: [{ kind: 'net', urlContains: '/api/refund' }],
    });
    expect(parsed).toMatchObject({ predicates: [{ urlContains: '/api/refund' }] });
  });

  it('leaves an explicit `predicates` alone when both are somehow present', () => {
    const parsed = parsePredicate({
      kind: 'anyOf',
      predicates: [{ kind: 'text', contains: 'real' }],
      of: [{ kind: 'text', contains: 'ignored' }],
    }) as { predicates: { contains: string }[] };
    expect(parsed.predicates[0]?.contains).toBe('real');
  });
});

/**
 * The count failure used to print a predicate with the body assertion removed.
 *
 * Reported by the first field user of `bodyContains`, against the same refund case this field was
 * built for:
 *
 * > "net.count reporting 'expected 1 network call(s) matching {method:POST, urlContains:/api/refund},
 * > saw 0' — but the call DID happen … The misleading 'saw 0' sent me looking for a request that never
 * > fired — i.e. a UI wiring bug — when the real defect was the response amount."
 *
 * `bodyContains` and `ok` were filtered out of the PRINTED predicate while still being APPLIED by the
 * filter, so a body mismatch read as "the request never fired": a false red pointing at the wiring
 * instead of at the value that actually differed.
 */
describe('a body mismatch reports the body, not a count of zero', () => {
  it('names the response value rather than claiming the call was never made', () => {
    const r = evalNet([REFUND], {
      kind: PredicateKind.NET,
      method: 'POST',
      urlContains: '/api/refund',
      bodyContains: '1187.01',
      count: 1,
    });
    expect(r.pass).toBe(false);
    expect(r.failureReason, 'the call fired; only its body differed').not.toContain('saw 0');
    expect(r.failureReason).toContain('11.87');
    expect(r.assertion).toBe('net.bodyContains');
  });

  it('the same on a presence assertion, where "no call matched" was equally wrong', () => {
    const r = evalNet([REFUND], {
      kind: PredicateKind.NET,
      urlContains: '/api/refund',
      bodyContains: '1187.01',
    });
    expect(r.assertion).toBe('net.bodyContains');
    expect(r.observed).toContain('11.87');
  });

  it('a genuine count miss still prints the WHOLE predicate, body assertion included', () => {
    const r = evalNet([REFUND], {
      kind: PredicateKind.NET,
      urlContains: '/api/refund',
      bodyContains: '11.87',
      count: 2,
    });
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('bodyContains');
  });
});

/**
 * A truncated body cannot decide the assertion (#614).
 *
 * The observer caps a recorded body at MAX_BODY_CHARS and sets `responseBodyTruncated`. The grader
 * was the one reader that ignored the flag, so a needle missing from the recorded PREFIX fell
 * through to the hard-fail branch and reported "the request fired, the response value is what
 * differed" — a decided verdict on an undecidable observation, against a response that was very
 * likely correct.
 */
describe('evalNet — bodyContains against a truncated body', () => {
  const TRUNCATED = netEvent(10, {
    method: 'GET',
    url: '/api/report',
    status: 200,
    ok: true,
    responseBody: '{"rows":[{"id":1},{"id":2}',
    responseBodyTruncated: true,
  });

  it('does not decide against a needle missing from the recorded prefix', () => {
    const r = evalNet([TRUNCATED], {
      kind: PredicateKind.NET,
      urlContains: '/api/report',
      bodyContains: 'grand_total',
    });
    // Not a pass — nothing here proves the needle was present either.
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeDefined();
    expect(r.inconclusive).toContain('TRUNCATED');
    // The wording that made this a bug: it must not claim the value differed.
    expect(r.failureReason).toBeUndefined();
  });

  it('names an action the caller can take, not just a diagnosis', () => {
    const r = evalNet([TRUNCATED], {
      kind: PredicateKind.NET,
      urlContains: '/api/report',
      bodyContains: 'grand_total',
    });
    expect(r.inconclusive).toContain('cap');
  });

  it('still passes when the needle IS inside the recorded prefix', () => {
    // Truncation only blocks a NEGATIVE conclusion; a hit is a hit.
    const r = evalNet([TRUNCATED], {
      kind: PredicateKind.NET,
      urlContains: '/api/report',
      bodyContains: '"id":1',
    });
    expect(r.pass).toBe(true);
  });

  it('still decides against a full body, so the ordinary mismatch verdict is intact', () => {
    const r = evalNet([REFUND], {
      kind: PredicateKind.NET,
      urlContains: '/api/refund',
      bodyContains: '1187.01',
    });
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('the response value is what differed');
    expect(r.inconclusive).toBeUndefined();
  });

  it('prefers the undecidable verdict when a truncated and a full body both miss', () => {
    const FULL_MISS = netEvent(11, {
      method: 'GET',
      url: '/api/report',
      status: 200,
      ok: true,
      responseBody: '{"rows":[]}',
    });
    const r = evalNet([TRUNCATED, FULL_MISS], {
      kind: PredicateKind.NET,
      urlContains: '/api/report',
      bodyContains: 'grand_total',
    });
    expect(r.inconclusive).toBeDefined();
    expect(r.failureReason).toBeUndefined();
  });
});
