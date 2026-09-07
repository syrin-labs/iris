/**
 * A DECLARED consequence that held decides the verdict. Settlement corroborates it; it does not veto.
 *
 * `act_and_wait { until }` names the expected consequence BEFORE the action — the whole epistemic
 * claim of this product. When that predicate holds and the page merely never reaches idle, the
 * verdict used to come back `unknown / unsettled` anyway, so idle-settlement overruled the caller's
 * own declaration. Reported from three different real apps: a tab click whose expected text was
 * visible, a save whose toast rendered over a 204, and a login whose expected heading matched — all
 * `unknown`, two of them on a hidden tab.
 *
 * A hidden or throttled tab is the NORMAL state for agent-driven verification (the human is working
 * in another window) and the browser's `settled` flag is "a real animation frame fired within
 * 200ms", which a throttled tab never does. If a throttled tab can never settle, settlement cannot
 * be a precondition for a verdict on one.
 *
 * The other half of every test here is the false-green guard: nothing that was positively OBSERVED
 * may be softened by a declaration, and a caller who declared nothing still gets the old answer.
 */

import { describe, expect, it } from 'vitest';
import { ContradictionKind, Verified, VerifiedReason } from '@reticlehq/core';
import { decideVerified } from './verified.js';
import { HonestyGrade, type HonestyBlock } from './honesty.js';

const clean: HonestyBlock = {
  grade: HonestyGrade.SIGNAL,
  attribution: 'window',
  coverage: { partial: false },
  integrity: { clean: true, issues: [] },
};

describe('a satisfied declared consequence outranks idle-settlement', () => {
  it('is YES when the declared predicate held and the page never went idle', () => {
    const v = decideVerified({
      pass: true,
      declaredConsequence: true,
      honesty: clean,
      settled: false,
    });
    expect(v.verified).toBe(Verified.YES);
    expect(v.verifiedReason).toBe(VerifiedReason.PROVED);
  });

  it('still SAYS the page never settled — corroboration missing is not corroboration hidden', () => {
    const v = decideVerified({
      pass: true,
      declaredConsequence: true,
      honesty: clean,
      settled: false,
    });
    expect(v.because).toMatch(/never went idle|never settled/i);
  });

  it('a poll left in flight no longer overrides the consequence the caller declared', () => {
    const v = decideVerified({
      pass: true,
      declaredConsequence: true,
      honesty: clean,
      contradictions: [{ kind: ContradictionKind.REQUEST_NEVER_SETTLED }],
      unsettled: {
        waitedFor: "text containing 'Saved'",
        stillInFlight: ['GET /api/notifications'],
      },
    });
    expect(v.verified).toBe(Verified.YES);
  });

  it('an open WRITE still downgrades — that outcome does not exist yet', () => {
    // The archetype: the toast says Saved while the POST is still open. A read left hanging says
    // nothing about the action; an unfinished mutation says the answer is not in yet.
    const v = decideVerified({
      pass: true,
      declaredConsequence: true,
      honesty: clean,
      contradictions: [{ kind: ContradictionKind.REQUEST_NEVER_SETTLED }],
      unsettled: { waitedFor: "text containing 'Saved'", stillInFlight: ['POST /api/save'] },
    });
    expect(v.verified).toBe(Verified.UNKNOWN);
  });

  it('softens nothing when there is no record of what was left open', () => {
    const v = decideVerified({
      pass: true,
      declaredConsequence: true,
      honesty: clean,
      contradictions: [{ kind: ContradictionKind.REQUEST_NEVER_SETTLED }],
    });
    expect(v.verified).toBe(Verified.UNKNOWN);
  });

  // ── guards: the declaration must not soften anything OBSERVED ─────────────────────────────────
  it('a failed declared consequence is still NO', () => {
    const v = decideVerified({
      pass: false,
      declaredConsequence: true,
      honesty: clean,
      settled: false,
    });
    expect(v.verified).toBe(Verified.NO);
  });

  it('an observed contradiction still outranks the declaration', () => {
    const v = decideVerified({
      pass: true,
      declaredConsequence: true,
      honesty: clean,
      settled: true,
      contradictions: [{ kind: ContradictionKind.UI_ADVANCED_REQUEST_FAILED }],
    });
    expect(v.verified).toBe(Verified.NO);
    expect(v.verifiedReason).toBe(VerifiedReason.CONTRADICTED);
  });

  it('an absence-derived finding that is NOT about settlement still downgrades', () => {
    // A duplicate write or a dead control is a finding about what the action DID, not about when we
    // stopped looking. Widening the fix to those would trade a false negative for a false green.
    for (const kind of [
      ContradictionKind.DUPLICATE_REQUEST,
      ContradictionKind.ACTION_HAD_NO_EFFECT,
      ContradictionKind.RESPONSE_IGNORED,
      ContradictionKind.ROUTE_RENDERED_NOTHING,
    ]) {
      const v = decideVerified({
        pass: true,
        declaredConsequence: true,
        honesty: clean,
        contradictions: [{ kind }],
      });
      expect(v.verified).toBe(Verified.UNKNOWN);
    }
  });

  it('a caller who declared NOTHING still gets the unsettled answer', () => {
    // Omitting `until` means "wait for idle" — idle IS the declared consequence there, so failing to
    // reach it is the assertion failing to hold, not a technicality.
    const v = decideVerified({ pass: true, honesty: clean, settled: false });
    expect(v.verified).toBe(Verified.UNKNOWN);
    expect(v.verifiedReason).toBe(VerifiedReason.UNSETTLED);
  });

  it('every other caveat still outranks a declared pass', () => {
    expect(
      decideVerified({
        pass: true,
        declaredConsequence: true,
        honesty: clean,
        settled: false,
        outcomePending: true,
      }).verified,
    ).toBe(Verified.UNKNOWN);
    // A net-only declaration still loses to an unread body: the body is then the only channel
    // that could have contradicted the screen. The skip is the next describe, and it requires
    // `independentOfBody` — passing `declaredConsequence` alone must not open that path.
    expect(
      decideVerified({
        pass: true,
        declaredConsequence: true,
        honesty: clean,
        settled: false,
        outcomeUnread: ['POST /api/save'],
      }).verified,
    ).toBe(Verified.UNKNOWN);
    expect(
      decideVerified({
        pass: true,
        declaredConsequence: true,
        settled: false,
        honesty: { ...clean, integrity: { clean: false, issues: ['capture truncated'] } },
      }).verified,
    ).toBe(Verified.UNKNOWN);
    expect(
      decideVerified({
        pass: true,
        declaredConsequence: true,
        settled: false,
        alreadyTrue: true,
        honesty: clean,
      }).verified,
    ).toBe(Verified.UNKNOWN);
  });
});

/**
 * An unread 2xx body is not a veto when the caller already proved the action on a channel the
 * body does not own.
 *
 * Measured on a chat composer: `act_and_wait` declared a 201 AND the unique message text, both
 * held, and the verdict came back `unknown / outcome_unread` solely because bodies were not
 * captured. The agent then went to enable body capture instead of finishing the drive. The clause
 * exists for batch/GraphQL 200s whose failures live only in the body; it must not fire when a
 * body-independent declaration already held. The unread write still rides out in `because`.
 */
describe('a body-independent declared consequence outranks an unread payload', () => {
  it('is YES when the independent channel held and a 2xx body went unread', () => {
    const v = decideVerified({
      pass: true,
      declaredConsequence: true,
      independentOfBody: true,
      honesty: clean,
      settled: true,
      outcomeUnread: ['POST /api/chat/messages'],
    });
    expect(v.verified).toBe(Verified.YES);
    expect(v.verifiedReason).toBe(VerifiedReason.PROVED);
  });

  it('still NAMES the unread write — a caveat hidden is a caveat dropped', () => {
    const v = decideVerified({
      pass: true,
      declaredConsequence: true,
      independentOfBody: true,
      honesty: clean,
      settled: true,
      outcomeUnread: ['POST /api/chat/messages'],
    });
    expect(v.because).toContain('POST /api/chat/messages');
    expect(v.because).toMatch(/unread|never recorded/i);
  });

  it('a net-only declaration still downgrades — the body is the remaining channel', () => {
    const v = decideVerified({
      pass: true,
      declaredConsequence: true,
      honesty: clean,
      settled: true,
      outcomeUnread: ['POST /api/bulk-hold'],
    });
    expect(v.verified).toBe(Verified.UNKNOWN);
    expect(v.verifiedReason).toBe(VerifiedReason.OUTCOME_UNREAD);
  });

  it('an observed contradiction still outranks the independent channel', () => {
    const v = decideVerified({
      pass: true,
      declaredConsequence: true,
      independentOfBody: true,
      honesty: clean,
      settled: true,
      outcomeUnread: ['POST /api/chat/messages'],
      contradictions: [{ kind: ContradictionKind.UI_ADVANCED_REQUEST_FAILED }],
    });
    expect(v.verified).toBe(Verified.NO);
    expect(v.verifiedReason).toBe(VerifiedReason.CONTRADICTED);
  });

  it('a 202 still downgrades — that outcome does not exist yet', () => {
    const v = decideVerified({
      pass: true,
      declaredConsequence: true,
      independentOfBody: true,
      honesty: clean,
      settled: true,
      outcomePending: true,
      outcomeUnread: ['POST /api/chat/messages'],
    });
    expect(v.verified).toBe(Verified.UNKNOWN);
    expect(v.verifiedReason).toBe(VerifiedReason.OUTCOME_PENDING);
  });
});

/**
 * A verdict must not contradict its own evidence.
 *
 * Reported verbatim as "internally contradictory": one payload carried `verified: "unknown"`,
 * `verifiedReason: "unsettled"`, a passing nested verdict, the requested POST at 200, the expected
 * route, a clean console — and `settled: true`. Both facts were produced by the same rule: the
 * absence-derived clause reused the UNSETTLED reason, which is a claim about idle that the settled
 * flag beside it denies.
 */
describe('unsettled is never reported beside settled: true', () => {
  it('an absence-derived finding over a SETTLED window does not call itself unsettled', () => {
    const v = decideVerified({
      pass: true,
      honesty: clean,
      settled: true,
      contradictions: [{ kind: ContradictionKind.DUPLICATE_REQUEST }],
    });
    expect(v.verified).toBe(Verified.UNKNOWN);
    expect(v.verifiedReason).not.toBe(VerifiedReason.UNSETTLED);
    expect(v.verifiedReason).toBe(VerifiedReason.EVIDENCE_INCOMPLETE);
  });
});
