/**
 * What "a false green Reticle caught" can and cannot mean, pinned at the rule that decides it.
 *
 * The metric that counts them is defined as `passed && 'no' === verified`, and its own comment reads
 * "the assertion PASSED and Reticle still refused to call it verified". Those are not the same
 * statement, and this file is the difference between them.
 *
 * `decideVerified` refuses a passing assertion in seven ways, and exactly ONE of them answers `no`:
 * a channel that positively disagreed. Every other refusal answers `unknown`, deliberately and for a
 * reason this package is built on — UNKNOWN must never collapse into NO, because "I could not see"
 * and "it is broken" send an agent in opposite directions. So a green that proved nothing because
 * the condition already held, a green at a grade that could not have failed, and a green over a
 * write whose outcome was never read are all refusals of a passing assertion that the metric cannot
 * count, by construction rather than by circumstance.
 *
 * This test does not change what is counted. It fixes the shape of the rule in place so that
 * changing it is a decision somebody makes on purpose: if a clause below ever moves from UNKNOWN to
 * NO, the meaning of that metric changes with it, silently, and a metric whose definition drifted is
 * worse than one that reads zero.
 */

import { describe, expect, it } from 'vitest';
import { ContradictionKind, Verified, VerifiedReason } from '@reticlehq/core';
import { HonestyGrade } from './honesty.js';
import { decideVerified } from './verified.js';

const honesty = (grade: HonestyGrade = HonestyGrade.SIGNAL, clean = true) =>
  ({
    grade,
    attribution: 'window',
    coverage: { pct: 100, partial: false },
    integrity: { clean, issues: clean ? [] : ['capture truncated'] },
  }) as unknown as Parameters<typeof decideVerified>[0]['honesty'];

/** Every way this rule refuses an assertion that PASSED, one per clause. */
const refusalsOfAPassingAssertion: Record<string, Parameters<typeof decideVerified>[0]> = {
  [VerifiedReason.CONTRADICTED]: {
    pass: true,
    honesty: honesty(),
    settled: true,
    contradictions: [{ kind: ContradictionKind.UI_ADVANCED_REQUEST_FAILED }],
  },
  [VerifiedReason.ALREADY_TRUE]: {
    pass: true,
    honesty: honesty(),
    settled: true,
    alreadyTrue: true,
  },
  [VerifiedReason.UNCLEAN_CAPTURE]: {
    pass: true,
    honesty: honesty(HonestyGrade.SIGNAL, false),
    settled: true,
  },
  // `settled` deliberately absent: nothing declared over a window that DID settle is
  // NOTHING_DECLARED below. VACUOUS_GRADE is the case where nothing was proved and the engine also
  // cannot say it saw the whole window.
  [VerifiedReason.VACUOUS_GRADE]: {
    pass: true,
    honesty: honesty(HonestyGrade.NONE),
  },
  [VerifiedReason.NOTHING_DECLARED]: {
    pass: true,
    honesty: honesty(HonestyGrade.NONE),
    settled: true,
  },
  [VerifiedReason.OUTCOME_PENDING]: {
    pass: true,
    honesty: honesty(),
    settled: true,
    outcomePending: true,
  },
  [VerifiedReason.OUTCOME_UNREAD]: {
    pass: true,
    honesty: honesty(),
    settled: true,
    outcomeUnread: ['POST /api/bulk-hold'],
  },
  [VerifiedReason.UNSETTLED]: { pass: true, honesty: honesty(), settled: false },
};

describe('the refusals of a passing assertion, and which of them answers NO', () => {
  for (const [reason, inputs] of Object.entries(refusalsOfAPassingAssertion)) {
    it(`${reason} is reached by a green the rule would not certify`, () => {
      const v = decideVerified(inputs);
      expect(v.verifiedReason).toBe(reason);
      expect(v.verified).not.toBe(Verified.YES);
    });
  }

  it('only a positively OBSERVED disagreement answers `no` — every other refusal is `unknown`', () => {
    const answeredNo = Object.entries(refusalsOfAPassingAssertion)
      .filter(([, inputs]) => Verified.NO === decideVerified(inputs).verified)
      .map(([reason]) => reason);
    expect(answeredNo).toEqual([VerifiedReason.CONTRADICTED]);
  });

  it('a green that proved nothing because the condition already held is neither a pass nor a failure', () => {
    // Named separately because it is the one most easily mistaken for a caught false green: the
    // assertion held, the action is unproven, and the pre-act check that finds it exists precisely
    // to catch that. It is a refusal of a passing assertion — and it is not a `no`.
    //
    // Reads `no-fault` over a settled window since the regrade. The load-bearing invariant was never
    // the word `unknown`; it is that this answer is NEITHER of the two that decide anything, and
    // both halves are asserted below so the guard cannot go vacuous if the word moves again.
    // `no-fault` is the more useful of the two here because the remedy is "assert something", not
    // "look harder" — see the branch in `verified.ts`.
    const v = decideVerified(
      refusalsOfAPassingAssertion[VerifiedReason.ALREADY_TRUE] ?? { honesty: honesty() },
    );
    expect(v.verified).toBe(Verified.NO_FAULT);
    expect(v.verified).not.toBe(Verified.NO);
    expect(v.verified).not.toBe(Verified.YES);
  });
});
