/**
 * The gate's hook output is the last thing a human reads before a session ends.
 *
 * Its normal output is one long JSON line, built for CI to parse. Printed by a Stop hook at the
 * moment an agent says it is done, that is a wall of flow names with no instruction attached —
 * measured on this repo, forty of them on a single line.
 *
 * A hook people cannot read is a hook people disable, and a disabled gate protects nothing. So the
 * prose has to answer what is unverified, why it matters, and what to do — including how to
 * proceed anyway, because the alternative to an honest escape hatch is not compliance, it is
 * somebody deleting the hook.
 */

import { describe, expect, it } from 'vitest';
import { gateHookMessage, GATE_SKIP_ENV } from './gate-hook-message.js';
import { GateExit } from './gate-exit.js';

const none = { uncovered: [], quarantined: [], downgraded: [], deleted: [] };

describe('it speaks only when something is actually wrong', () => {
  it('says nothing on a pass', () => {
    expect(gateHookMessage(GateExit.PASS, none)).toBeUndefined();
  });

  /**
   * The case that would have made this unusable. A project with no flows is every project on day
   * one; interrupting there makes the first experience of Reticle an agent that cannot stop.
   */
  it('says nothing when there was simply nothing to check', () => {
    expect(gateHookMessage(GateExit.NOTHING_TO_CHECK, none)).toBeUndefined();
  });
});

describe('when it does speak, it is readable and actionable', () => {
  const msg = () =>
    gateHookMessage(GateExit.FAIL, { ...none, uncovered: ['checkout', 'signup'] }) ?? '';

  it('leads with the claim, not with data', () => {
    expect(msg().split('\n')[0]).toBe('Reticle: this change is not verified.');
  });

  it('names the flows', () => {
    expect(msg()).toContain('checkout');
  });

  it('says how to fix it', () => {
    expect(msg()).toMatch(/verify/);
  });

  it('says how to proceed anyway, and that doing so is recorded', () => {
    expect(msg()).toContain(GATE_SKIP_ENV);
    expect(msg()).toMatch(/recorded/);
  });

  /** Forty names on one line is what made the JSON unreadable in the first place. */
  it('caps the list rather than printing everything', () => {
    const many = Array.from({ length: 40 }, (_, i) => `flow-${String(i)}`);
    const out = gateHookMessage(GateExit.FAIL, { ...none, uncovered: many }) ?? '';
    expect(out).toContain('+35 more');
    expect(out.split('\n').length).toBeLessThan(10);
  });
});

describe('it distinguishes the kinds of not-verified', () => {
  it('calls a weakened assertion what it is', () => {
    const out = gateHookMessage(GateExit.FAIL, { ...none, downgraded: ['checkout'] }) ?? '';
    expect(out).toMatch(/cannot fail is not a check/);
  });

  it('names deleted coverage separately from an uncovered flow', () => {
    const out = gateHookMessage(GateExit.FAIL, { ...none, deleted: ['checkout'] }) ?? '';
    expect(out).toMatch(/deleted/);
  });

  it('says a quarantined flow proves nothing', () => {
    const out = gateHookMessage(GateExit.FAIL, { ...none, quarantined: ['flaky-one'] }) ?? '';
    expect(out).toMatch(/proving nothing/);
  });
});
