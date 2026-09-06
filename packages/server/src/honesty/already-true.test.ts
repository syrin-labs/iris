/**
 * `verified: "yes"` for a navigation that never happened.
 *
 * Measured in the field, on a Next app-router fixture:
 *
 *   act_and_wait { ref: <"Parallel Routes" link>, until: { kind: 'text', contains: 'Parallel Routes' } }
 *   -> verdict at 478ms, verified: "yes", routeChanges: 0
 *   observe -> the real route.change landed at t=22270, ~1.8s LATER
 *
 * The predicate matched the nav link that was already on the page before the click. It was right by
 * accident, and only `honesty.grade: "presence"` and `routeChanges: 0` hinted otherwise — neither is
 * the field an agent reads first.
 *
 * Event-based predicates (net/signal/route) are already floored at the act's cursor, so a stale event
 * cannot satisfy them. `element` and `text` read the LIVE DOM, where no floor applies: a condition
 * that held BEFORE the action holds after it, and passes instantly whatever the action did.
 *
 * So the rule: if a DOM-state predicate was already true before the act, its passing afterwards is
 * not evidence about the act. That is `unknown` — the same answer a dirty capture gets, for the same
 * reason. It is deliberately not `no`: the app may well be fine, and claiming a failure would be its
 * own false report.
 */

import { describe, expect, it } from 'vitest';
import { Verified } from '@reticlehq/core';
import { decideVerified } from './verified.js';
import { buildHonestyBlock, HonestyGrade } from './honesty.js';
import { readsDomState } from './already-true.js';

const clean = buildHonestyBlock({ grade: HonestyGrade.PRESENCE, attribution: 'window' });

describe('a condition that already held proves nothing about the action', () => {
  /**
   * `no-fault` over `unknown`, once the window settled.
   *
   * The two words ask for opposite things. `unknown` means LOOK AGAIN WITH BETTER COVERAGE, and an
   * agent that reads it reasonably concludes Reticle could not see — so it spends turns enabling
   * capture, widening timeouts and re-driving, none of which can help, because the engine saw
   * everything and there was nothing wrong with the evidence. `no-fault` means ASSERT SOMETHING,
   * which is the actual remedy: the caller declared a consequence that was true before the action,
   * so their check cannot tell success from a no-op.
   *
   * Same distinction `nothing_declared` already carries, and the same gate: it requires a SETTLED
   * window, so it cannot be earned by returning early.
   */
  it('is NO_FAULT once the window settled — the caller must assert, not look harder', () => {
    const d = decideVerified({ pass: true, alreadyTrue: true, settled: true, honesty: clean });
    expect(d.verified).toBe(Verified.NO_FAULT);
    expect(d.because).toContain('before');
  });

  it('stays UNKNOWN when the window never settled — no-fault must not be earned early', () => {
    const d = decideVerified({ pass: true, alreadyTrue: true, settled: false, honesty: clean });
    expect(d.verified).toBe(Verified.UNKNOWN);
  });

  it('is never a pass, either way', () => {
    for (const settled of [true, false]) {
      const d = decideVerified({ pass: true, alreadyTrue: true, settled, honesty: clean });
      expect(d.verified).not.toBe(Verified.YES);
    }
  });

  it('a genuine pass is untouched', () => {
    expect(decideVerified({ pass: true, honesty: clean }).verified).toBe(Verified.YES);
  });

  it('a FAILURE still leads — the assertion not holding is the more actionable fact', () => {
    const d = decideVerified({ pass: false, alreadyTrue: true, honesty: clean });
    expect(d.verified).toBe(Verified.NO);
  });
});

describe('which predicates need the before-check at all', () => {
  it('element and text read the live DOM, so they do', () => {
    expect(readsDomState({ kind: 'element', query: { testid: 'x' } })).toBe(true);
    expect(readsDomState({ kind: 'text', contains: 'Parallel Routes' })).toBe(true);
  });

  it('event-based kinds do not — they are already floored at the act cursor', () => {
    expect(readsDomState({ kind: 'signal', name: 's' })).toBe(false);
    expect(readsDomState({ kind: 'net', urlContains: '/api' })).toBe(false);
    expect(readsDomState({ kind: 'settled' })).toBe(false);
  });

  /**
   * `route` USED to be purely event-based, and was listed with the floored kinds above for that
   * reason. It is not any more: when the window holds no route change it falls back to where the app
   * currently is, so it can now be satisfied by a state that predates the action.
   *
   * Without the before-check that makes it a guaranteed green. The app is already on `/login`, the
   * agent clicks a button whose handler is broken, nothing navigates, and
   * `until: { kind: 'route', pathname: '/login' }` passes — an assertion that the action navigated,
   * answered by the fact that it did not need to. A bare `{ kind: 'route' }` becomes unconditionally
   * true, since the app always has a current route.
   *
   * Declaring it here is what turns that into `already_true`, which the verdict layer reports as
   * UNKNOWN with the reason. Trading a false red for a false green is the one trade this codebase
   * does not make, and the fallback is worth keeping only with this in place.
   */
  it('route does, now that it can be answered from the current route', () => {
    expect(readsDomState({ kind: 'route', pathname: '/a' })).toBe(true);
    expect(readsDomState({ kind: 'route' })).toBe(true);
  });

  it('state reads a store, which the action is supposed to change — and it IS floored', () => {
    expect(readsDomState({ kind: 'state', path: 'cart.total' })).toBe(false);
  });

  it('a combinator inherits it from any branch that reads the DOM', () => {
    expect(
      readsDomState({
        kind: 'allOf',
        predicates: [{ kind: 'settled' }, { kind: 'text', contains: 'Done' }],
      }),
    ).toBe(true);
    expect(readsDomState({ kind: 'not', predicate: { kind: 'text', contains: 'Error' } })).toBe(
      true,
    );
    expect(readsDomState({ kind: 'anyOf', predicates: [{ kind: 'signal', name: 'a' }] })).toBe(
      false,
    );
  });
});
