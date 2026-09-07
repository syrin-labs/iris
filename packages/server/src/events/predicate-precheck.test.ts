/**
 * A predicate the caller wrote badly must not cost them the action AND the verdict.
 *
 * `reticle_act_and_wait` dispatches, then evaluates `until` — so a locator naming fields the element
 * resolver drops used to be caught only after the click had landed, and reported as
 * `verified:"unknown", inconclusive`: "Reticle could not tell what happened". Reticle could tell.
 * What it could not do was evaluate the predicate, and blaming the app for that sends somebody to
 * fix code that is not broken.
 */
import { describe, expect, it } from 'vitest';
import { unevaluablePredicateReason } from './predicate-precheck.js';

const el = (query: Record<string, unknown>) => ({ kind: 'element', query });

describe('refusing what could never be evaluated', () => {
  it('catches the locator that started this — `by` alongside `label`', () => {
    const reason = unevaluablePredicateReason(el({ by: 'label', label: 'Workspace name' }));
    expect(reason).toContain('ignores');
    expect(reason).toContain('Nothing was acted on');
  });

  it('names the offending field, so the fix is obvious', () => {
    // `placeholder` is dropped by the resolver and there is no descriptor to check it against
    // afterwards, which is what makes it unusable rather than a residual check.
    expect(unevaluablePredicateReason(el({ testid: 'submit', placeholder: 'Email' }))).toContain(
      'placeholder',
    );
  });

  it('allows a field the resolver drops but this side CAN still check', () => {
    // role/name/value/text are recoverable from the element descriptor, so they narrow the match
    // after the fact rather than making the predicate unevaluable. Refusing those would reject
    // predicates that work.
    expect(
      unevaluablePredicateReason(el({ by: 'testid', value: 'x', role: 'button' })),
    ).toBeUndefined();
  });

  it('allows a locator the resolver can actually use', () => {
    expect(unevaluablePredicateReason(el({ testid: 'submit' }))).toBeUndefined();
    expect(unevaluablePredicateReason(el({ role: 'button', name: 'Sign In' }))).toBeUndefined();
    expect(unevaluablePredicateReason(el({ by: 'testid', value: 'submit' }))).toBeUndefined();
  });

  it('leaves predicates with no locator alone', () => {
    for (const p of [
      { kind: 'net', urlContains: '/v1/x', status: 200 },
      { kind: 'text', contains: 'hello' },
      { kind: 'signal', name: 'saved' },
      { kind: 'settled' },
    ]) {
      expect(unevaluablePredicateReason(p), JSON.stringify(p)).toBeUndefined();
    }
  });

  it('finds an unusable locator nested inside allOf', () => {
    // The composite case is the one that matters: a good predicate beside a bad one still cannot be
    // evaluated, and the good half passing would be the most misleading outcome of all.
    const reason = unevaluablePredicateReason({
      kind: 'allOf',
      predicates: [
        { kind: 'net', urlContains: '/x', status: 200 },
        el({ by: 'label', label: 'W' }),
      ],
    });
    expect(reason).toContain('ignores');
  });

  it('finds one nested two levels deep', () => {
    const reason = unevaluablePredicateReason({
      kind: 'allOf',
      predicates: [{ kind: 'anyOf', predicates: [el({ by: 'label', label: 'W' })] }],
    });
    expect(reason).toContain('ignores');
  });

  it('finds one behind a `not`', () => {
    expect(
      unevaluablePredicateReason({ kind: 'not', predicate: el({ by: 'label', label: 'W' }) }),
    ).toContain('ignores');
  });

  it('passes a composite whose locators are all usable', () => {
    expect(
      unevaluablePredicateReason({
        kind: 'allOf',
        predicates: [el({ testid: 'a' }), { kind: 'net', urlContains: '/x' }],
      }),
    ).toBeUndefined();
  });

  it('tolerates junk rather than throwing on the hot path', () => {
    for (const junk of [undefined, null, 'string', 42, [], {}]) {
      expect(() => unevaluablePredicateReason(junk)).not.toThrow();
    }
  });
});
