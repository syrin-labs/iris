/**
 * Which results count as a completed verification — and the two ways this was wrong.
 *
 * `flow_verify` reports `status: pass | fail | unverifiable`; `assert` reports a boolean `pass`. The
 * reader accepted `status === 'pass'` and mapped everything else to `undefined`, which produced two
 * opposite errors at once:
 *
 *   1. A FAILING suite emitted NOTHING. `verification_completed` only ever fired on a green, so the
 *      denominator was systematically biased — and a CI `verify` that went red, the single most
 *      valuable event the product can produce, was invisible. Meanwhile `bugsInResult` DID fire on
 *      `status: 'fail'`, so the data shows bugs with no verification to divide them by. That is
 *      precisely the shape of "80 daily actives and almost no verifications".
 *
 *   2. An EMPTY suite emitted `verified: "yes", passed: true`. Found by the adversarial MCP sweep:
 *      `reticle_flow_verify {}` on a project with no flows returned "all 0 flows pass" and counted
 *      itself as a passing verification. Nothing was verified.
 */

import { describe, expect, it } from 'vitest';
import { BrowserBrand, CaptureLoss, Verified, VerifiedReason } from '@reticlehq/core';
import { decideVerified } from '../honesty/verified.js';
import { HonestyGrade } from '../honesty/honesty.js';
import { verificationOf } from './verification-of.js';
import { ReticleTool } from '../tools/tool-names.js';
import { BrowserMode, setBrowserMode, resetBrowserMode } from './browser-mode.js';

// Whole-suite replay is `reticle_verify { action: 'flows' }` since the merge, so the NAME telemetry
// sees is the merged one. The shape check below is what keeps the metric honest either way: naming
// the merged tool does not make every action a verification.
const VERIFY = ReticleTool.VERIFY;
const ASSERT = ReticleTool.ASSERT;

describe('verificationOf', () => {
  it('a PASSING suite is a verification', () => {
    expect(verificationOf(VERIFY, { status: 'pass', total: 3 }, 10)).toMatchObject({
      verified: 'yes',
      passed: true,
    });
  });

  it('a FAILING suite is a verification too — it is the most valuable one', () => {
    expect(verificationOf(VERIFY, { status: 'fail', total: 3, failed: 1 }, 10)).toMatchObject({
      verified: 'no',
      passed: false,
    });
  });

  it('an EMPTY or unverifiable suite is NOT a verification — nothing was checked', () => {
    expect(verificationOf(VERIFY, { status: 'unverifiable', total: 0 }, 0)).toBeUndefined();
  });

  /**
   * This test used to pin the defect as correct behaviour, which is why nobody found it from the
   * data. It asserted `falseGreenCaught: false` for act_and_wait's REAL shape (`verdict.pass`
   * nested), directly beneath a comment calling that case "the thesis", and asserted `true` only for
   * a flat `pass` that act_and_wait never emits. So the metric read zero in the field forever and
   * the suite was green about it.
   */
  it('act_and_wait: a green Reticle refused to call verified IS the thesis, nested verdict and all', () => {
    expect(
      verificationOf(ReticleTool.ACT_AND_WAIT, { verified: 'no', verdict: { pass: true } }, 5),
    ).toMatchObject({ verified: 'no', passed: true, falseGreenCaught: true });
  });

  it('reads a flat pass too, since assert spreads its verdict at the top level', () => {
    expect(
      verificationOf(ReticleTool.ACT_AND_WAIT, { verified: 'no', pass: true }, 5),
    ).toMatchObject({ falseGreenCaught: true });
  });

  it('a nested verdict that FAILED is not a false green', () => {
    expect(
      verificationOf(ReticleTool.ACT_AND_WAIT, { verified: 'no', verdict: { pass: false } }, 5),
    ).toMatchObject({ passed: false, falseGreenCaught: false });
  });

  it('a nested green that Reticle also called verified is just a pass', () => {
    expect(
      verificationOf(ReticleTool.ACT_AND_WAIT, { verified: 'yes', verdict: { pass: true } }, 5),
    ).toMatchObject({ passed: true, falseGreenCaught: false });
  });

  it('an UNKNOWN verdict is not counted as a catch, however it was refused', () => {
    // The seven refusals that answer `unknown` stay out by design; see verification-of.ts. Pinned so
    // that moving one of them to `no` is a conscious decision rather than a metric quietly changing
    // what it means.
    expect(
      verificationOf(
        ReticleTool.ACT_AND_WAIT,
        { verified: 'unknown', verifiedReason: 'already_true', verdict: { pass: true } },
        5,
      ),
    ).toMatchObject({ falseGreenCaught: false, reason: 'already_true' });
  });

  it('a tool that is not a verification tool never counts', () => {
    expect(verificationOf(ReticleTool.SNAPSHOT, { status: 'pass' }, 1)).toBeUndefined();
  });

  it('a verification tool that returned no verdict never counts', () => {
    expect(verificationOf(VERIFY, { error: 'no session' }, 1)).toBeUndefined();
  });

  /**
   * A pause REFUSES the call: nothing is driven and nothing is asserted. The refusal now carries
   * `verified: 'unknown'` so the agent's read of that field is never undefined — which must not turn
   * a refusal into a row in the metric investors are shown.
   */
  it('a paused refusal is not a verification, verdict field or no', () => {
    expect(
      verificationOf(ReticleTool.ACT_AND_WAIT, { paused: true, verified: 'unknown' }, 1),
    ).toBeUndefined();
  });
});

describe('how the browser got there rides on the event', () => {
  it('defaults to attached — Reticle launched nothing, so it must not claim headless', () => {
    resetBrowserMode();
    expect(verificationOf(VERIFY, { status: 'pass' }, 1)?.browser).toBe(BrowserMode.ATTACHED);
  });

  it('reports headless and headed when Reticle DID launch the browser', () => {
    // "verifications run" was one number covering unattended CI, a human watching an agent, and the
    // SDK in somebody's own dev server. Three products, three costs, three failure modes.
    setBrowserMode(BrowserMode.HEADLESS);
    expect(verificationOf(VERIFY, { status: 'pass' }, 1)?.browser).toBe(BrowserMode.HEADLESS);
    setBrowserMode(BrowserMode.HEADED);
    expect(verificationOf(VERIFY, { status: 'fail' }, 1)?.browser).toBe(BrowserMode.HEADED);
    resetBrowserMode();
  });
});

/**
 * `attached` says Reticle launched nothing; it does not say WHICH browser the SDK is sitting in, and
 * Chrome, Edge, Arc and Brave are one `blink` as far as the engine field is concerned. The brand
 * comes from the page (`navigator.userAgentData`), so it is absent whenever the page has not said —
 * an older SDK, a desktop webview — and absent must mean absent, never a guessed `"unknown"`.
 */
describe('the browser brand rides alongside the mode', () => {
  it('carries the brand the session reported', () => {
    expect(verificationOf(VERIFY, { status: 'pass' }, 1, BrowserBrand.ARC)?.brand).toBe(
      BrowserBrand.ARC,
    );
  });

  it('omits the field entirely when no brand was reported', () => {
    const verification = verificationOf(VERIFY, { status: 'pass' }, 1);
    expect(verification).toBeDefined();
    expect(verification !== undefined && 'brand' in verification).toBe(false);
  });
});

/**
 * WHY a verdict came out that way, not just what it was.
 *
 * Seven clauses of `decideVerified` reached the wire as two payloads: `verified: 'unknown'` covered
 * the agent malforming a call, the app answering 202, and Reticle failing to see — three owners,
 * three opposite responses, one bar on a dashboard. The clause travels on the result the rule wrote,
 * so nothing had to be re-plumbed; what had to change is that anybody read it.
 */
describe('the verdict carries the clause that decided it', () => {
  it('forwards the reason `decideVerified` wrote onto the result', () => {
    const decision = decideVerified({
      pass: true,
      honesty: {
        grade: HonestyGrade.SIGNAL,
        coverage: { partial: false },
        integrity: { clean: true, issues: [] },
      },
      settled: true,
      alreadyTrue: true,
    });
    const verification = verificationOf(VERIFY, { ...decision, pass: true }, 1);
    // `no-fault` since `already_true` was regraded off `unknown`: over a SETTLED window the engine
    // saw everything and the fault is in the assertion, so the remedy is "assert something", not
    // "look harder". What this test is actually about is the clause travelling with the verdict,
    // which is asserted on the next line and is unaffected by the word.
    expect(verification?.verified).toBe('no-fault');
    expect(verification?.reason).toBe(VerifiedReason.ALREADY_TRUE);
  });

  it('omits it for a verdict no clause produced — a suite reports pass/fail and no reason', () => {
    const verification = verificationOf(VERIFY, { status: 'pass' }, 1);
    expect(verification).toBeDefined();
    expect(verification !== undefined && 'reason' in verification).toBe(false);
  });

  it('refuses a value core does not define rather than forwarding it', () => {
    // The result is an untyped record here; a string nobody can group by is worse than a gap.
    const verification = verificationOf(VERIFY, { pass: false, verifiedReason: 'made-up' }, 1);
    expect(verification !== undefined && 'reason' in verification).toBe(false);
  });
});

/**
 * WHAT was lost, when the reason was `unclean_capture`.
 *
 * The reason field says a capture was dirty. It does not say whether that was our server buffer, our
 * browser transport, or a boundary in the page nobody can see through — three owners, three fixes.
 * In the field `unclean_capture` became the dominant cause of `unknown`, and answering "which one?"
 * meant reading the eviction policy because the data could not. (It was the buffer, and it was
 * miscounting.)
 */
describe('an unclean capture says which loss made it unclean', () => {
  const unclean = (losses?: unknown): Record<string, unknown> => ({
    pass: true,
    verified: Verified.UNKNOWN,
    verifiedReason: VerifiedReason.UNCLEAN_CAPTURE,
    honesty: {
      integrity: {
        clean: false,
        issues: ['capture truncated'],
        ...(losses === undefined ? {} : { losses }),
      },
    },
  });

  it('carries the kind the honesty block named', () => {
    expect(verificationOf(ASSERT, unclean([CaptureLoss.BUFFER_LOSS]), 1)?.uncleanLoss).toBe(
      CaptureLoss.BUFFER_LOSS,
    );
    expect(verificationOf(ASSERT, unclean([CaptureLoss.TRANSPORT_GAP]), 1)?.uncleanLoss).toBe(
      CaptureLoss.TRANSPORT_GAP,
    );
  });

  it('sends the FIRST of several — a multi-value property is not something a dashboard groups by', () => {
    const both = unclean([CaptureLoss.BUFFER_LOSS, CaptureLoss.BLIND_SPOT]);
    expect(verificationOf(ASSERT, both, 1)?.uncleanLoss).toBe(CaptureLoss.BUFFER_LOSS);
  });

  it('reports `other` when the capture was dirty and named no kind, never nothing', () => {
    // An older sender, or a producer that forgot. The loss is real either way, and a gap here would
    // read on a dashboard as "no unclean verdicts happened" — the opposite of the truth.
    expect(verificationOf(ASSERT, unclean(), 1)?.uncleanLoss).toBe(CaptureLoss.OTHER);
    expect(verificationOf(ASSERT, unclean(['not-a-member']), 1)?.uncleanLoss).toBe(
      CaptureLoss.OTHER,
    );
  });

  it('is absent on every verdict whose capture was clean', () => {
    const proved = verificationOf(
      ASSERT,
      { pass: true, verified: Verified.YES, verifiedReason: VerifiedReason.PROVED },
      1,
    );
    expect(proved).toBeDefined();
    expect(proved !== undefined && 'uncleanLoss' in proved).toBe(false);
  });
});
