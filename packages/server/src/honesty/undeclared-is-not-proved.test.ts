/**
 * A verdict over nothing declared is not a pass, whatever the page happened to do.
 *
 * `reticle_act_and_wait` treats an omitted `until` as `{ kind: "settled" }` — a deliberate
 * sleep-replacement, not an assertion. Measured live on 2026-08-23 against a real app: clicking a
 * submit button, and separately an inert text input, with no `until` returned
 *
 *     verified: "yes", verifiedReason: "proved",
 *     because: "assertion held at presence grade over a clean capture with no channel disagreeing"
 *
 * Nothing was asserted. The click merely moved the DOM, which lifted the honesty grade from NONE to
 * PRESENCE — and the `no-fault` branch that exists for exactly this case is gated on
 * `grade === NONE`, so an incidental mutation walks straight past it into a full green.
 *
 * The cost is not one bad answer. `reticle_context` records the run's proven claims, so the verdict
 * persists: `proven: [{ claim: "the page to go idle", verified: "yes" }]`. An agent that compacts
 * and re-enters reads a false green as established fact.
 *
 * `declaredConsequence` was already computed correctly at both call sites
 * (`act-tools.ts`, `assert-verdict.ts`) and the decision never consulted it on the green path.
 */

import { describe, expect, it } from 'vitest';
import { Verified, VerifiedReason } from '@reticlehq/core';
import { decideVerified } from './verified.js';
import { buildHonestyBlock, HonestyGrade } from './honesty.js';

/** What an omitted `until` produces: the page moved, so the grade is not NONE. */
const incidental = buildHonestyBlock({ grade: HonestyGrade.PRESENCE, attribution: 'window' });
const strong = buildHonestyBlock({ grade: HonestyGrade.SIGNAL, attribution: 'window' });

describe('nothing declared is never `yes`', () => {
  it('does not report "proved" when the caller declared no consequence', () => {
    const d = decideVerified({
      pass: true,
      honesty: incidental,
      settled: true,
      declaredConsequence: false,
    });
    expect(d.verified).not.toBe(Verified.YES);
  });

  it('says no-fault, the value that exists for this exact case', () => {
    const d = decideVerified({
      pass: true,
      honesty: incidental,
      settled: true,
      declaredConsequence: false,
    });
    expect(d.verified).toBe(Verified.NO_FAULT);
    expect(d.verifiedReason).toBe(VerifiedReason.NOTHING_DECLARED);
  });

  it('tells the agent what to do instead of just refusing the green', () => {
    const d = decideVerified({
      pass: true,
      honesty: incidental,
      settled: true,
      declaredConsequence: false,
    });
    expect(d.because).toContain('declare');
  });

  /**
   * A strong grade is the more dangerous version of the same bug: an action that happens to fire a
   * signal would grade `signal` and read as the best possible verdict, still having asserted nothing.
   */
  it('is not rescued by a strong grade the caller never asked for', () => {
    const d = decideVerified({
      pass: true,
      honesty: strong,
      settled: true,
      declaredConsequence: false,
    });
    expect(d.verified).toBe(Verified.NO_FAULT);
  });

  /**
   * The guard must not fire before the app stopped moving — same rule the existing no-fault branch
   * states: an unsettled window has not earned "nothing was wrong".
   */
  it('stays UNKNOWN when the page never settled', () => {
    const d = decideVerified({
      pass: true,
      honesty: incidental,
      settled: false,
      declaredConsequence: false,
    });
    expect(d.verified).toBe(Verified.UNKNOWN);
  });
});

describe('the declared path is untouched', () => {
  it('a declared consequence that held is still a pass', () => {
    const d = decideVerified({
      pass: true,
      honesty: strong,
      settled: true,
      declaredConsequence: true,
    });
    expect(d.verified).toBe(Verified.YES);
    expect(d.verifiedReason).toBe(VerifiedReason.PROVED);
  });

  it('a declared consequence that failed is still a failure', () => {
    const d = decideVerified({
      pass: false,
      honesty: strong,
      settled: true,
      declaredConsequence: true,
    });
    expect(d.verified).toBe(Verified.NO);
  });

  /**
   * Callers that never pass the flag (every other verdict route) must keep their behaviour — this
   * change is about an explicit `false`, not about an absent field.
   */
  it('leaves a caller that says nothing about declaration alone', () => {
    const d = decideVerified({ pass: true, honesty: strong, settled: true });
    expect(d.verified).toBe(Verified.YES);
  });
});
