import { describe, expect, it } from 'vitest';
import { LOUDNESS, Loudness, loudnessOf, byClass, ungraded } from './loudness.mjs';
import { listRegressions } from '../harness/inject.mjs';
import { FEATURES, suppressEnv } from './features.mjs';

/**
 * The suite's shape is the finding, so it is asserted rather than assumed.
 *
 * A full session of benchmarking produced almost every result from ONE scenario, because the rest
 * announce themselves. That is invisible in a headline and obvious in a per-class table — but only
 * if the classes stay honest.
 */
describe('every injection carries a loudness grade', () => {
  /**
   * The guard that matters most. A new injection joining the suite without a grade would be counted
   * in totals and reported in no class, which is how a suite quietly re-weights itself toward
   * whatever is easiest to write.
   */
  it('leaves no injection ungraded', () => {
    expect(ungraded(listRegressions())).toEqual([]);
  });

  it('grades only injections that exist, so a deleted one cannot linger as a phantom', () => {
    const real = new Set(listRegressions());
    expect(Object.keys(LOUDNESS).filter((b) => !real.has(b))).toEqual([]);
  });

  it('gives every grade a reason, because an unargued grade drifts to whatever flatters', () => {
    for (const [bug, entry] of Object.entries(LOUDNESS)) {
      expect(entry.why, bug).toBeTypeOf('string');
      expect(entry.why.length, bug).toBeGreaterThan(30);
    }
  });
});

describe('the suite is honest about its own weakness', () => {
  /**
   * The QUIET class is the product's entire claim — a false green is only possible there, since a
   * loud defect cannot be both unfixed and seen to succeed. Two scenarios is not a measurement, and
   * this test exists to keep saying so until it is fixed.
   *
   * It asserts the CURRENT number deliberately. When quiet scenarios are added this test fails, and
   * whoever adds them updates it having read this note — which is the point.
   */
  it('has only two quiet scenarios, which is the reason this suite cannot yet settle the claim', () => {
    const quiet = Object.entries(LOUDNESS).filter(([, e]) => e.grade === Loudness.QUIET);
    expect(quiet).toHaveLength(2);
  });

  it('reports per class rather than averaging, which would hide exactly that', () => {
    const rows = [
      { bug: 'silent-dom-regression', ok: true },
      { bug: 'broken-form-validation', ok: false },
    ];
    const out = byClass(rows, (r) => r.ok);
    expect(out[Loudness.LOUD]).toEqual({ n: 1, hit: 1 });
    expect(out[Loudness.QUIET]).toEqual({ n: 1, hit: 0 });
  });

  it('never guesses a grade for an unknown scenario', () => {
    expect(loudnessOf('not-a-real-bug')).toBeUndefined();
  });
});

describe('every feature flag is measurable, and says what it should move', () => {
  /**
   * A flag without a stated hypothesis produces a table nobody can read, because every direction
   * looks like a win once the numbers are in front of you. `ab.mjs` prints the hypothesis BEFORE the
   * run for the same reason — the cheapest possible pre-registration.
   */
  it('states what each feature should move, and how it is measured', () => {
    for (const [id, f] of Object.entries(FEATURES)) {
      expect(f.env, id).toBeTypeOf('string');
      expect(f.hypothesis, id).toBeTypeOf('string');
      expect(f.hypothesis.length, id).toBeGreaterThan(20);
      expect(Array.isArray(f.measure), id).toBe(true);
      expect(f.measure.length, id).toBeGreaterThan(0);
    }
  });

  it('refuses an unknown feature rather than measuring nothing', () => {
    expect(() => suppressEnv('not-a-feature')).toThrow(/no such feature flag/);
  });
});

describe('unmeasured features are visible, not forgotten', () => {
  /**
   * The whole reason this registry exists. `verify_next` shipped across releases described as "the
   * largest known lever on whether a session produces a verdict at all" and was never measured —
   * not because anyone decided against it, but because nothing tracked that it had not been.
   *
   * So every flag carries a `status`, and this test names the ones still owing a number. It does not
   * fail on them: a feature can legitimately be unmeasured for a while. It fails when a flag has no
   * status at all, because that is the state that hides the debt.
   */
  it('makes every feature state whether it has a number yet', () => {
    for (const [id, f] of Object.entries(FEATURES)) {
      expect(
        f.status,
        `${id} has no status — an unmeasured feature with no status is invisible`,
      ).toBeTypeOf('string');
    }
  });

  it('can list what is still owed, so the debt is queryable rather than remembered', () => {
    const owing = Object.entries(FEATURES)
      .filter(([, f]) => /^UNMEASURED/.test(f.status ?? ''))
      .map(([id]) => id);
    // Asserted as a known set: when one is measured this fails, and whoever measured it updates the
    // list having just done the work.
    // Both were measured on 2026-08-25 and the list is now empty. It stays asserted so a NEW
    // unmeasured feature has to be added here deliberately rather than joining silently.
    expect(owing.sort()).toEqual([]);
  });
});
