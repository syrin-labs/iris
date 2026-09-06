import { describe, expect, it } from 'vitest';
import { Verified, VerifiedReason, ContradictionKind } from '@reticlehq/core';
import { decideVerified } from './verified.js';

type VerifiedVerdictInput = Parameters<typeof decideVerified>[0];
import { HonestyGrade, type HonestyBlock } from './honesty.js';

const clean = (grade: HonestyGrade = HonestyGrade.SIGNAL): HonestyBlock => ({
  grade,
  coverage: { partial: false },
  integrity: { clean: true, issues: [] },
});

const dirty = (...issues: string[]): HonestyBlock => ({
  grade: HonestyGrade.SIGNAL,
  coverage: { partial: false },
  integrity: { clean: false, issues },
});

/**
 * `202 Accepted` is HTTP's only word for "no outcome yet".
 *
 * Measured on a logistics console with server-side reconciliation: a dispatch answered 202, the row
 * optimistically rendered "dispatched", the page settled, every channel agreed — and the server
 * REVERTED it to `held` 1.2s later. The verdict was not wrong about what it saw; it was early, and
 * folding 202 into the 2xx success band is what let it be early silently.
 */
describe('a 202 means the outcome does not exist yet', () => {
  const clean = {
    grade: HonestyGrade.STATE,
    integrity: { clean: true, issues: [] },
  } as unknown as Parameters<typeof decideVerified>[0]['honesty'];

  it('is UNKNOWN, not yes, when a write is still being processed', () => {
    const r = decideVerified({ pass: true, honesty: clean, settled: true, outcomePending: true });
    expect(r.verified).toBe(Verified.UNKNOWN);
    expect(r.because).toContain('202');
  });

  it('is UNKNOWN rather than NO — nothing has failed yet', () => {
    // Reporting a failure that has not happened is its own false report, in the other direction.
    expect(
      decideVerified({ pass: true, honesty: clean, settled: true, outcomePending: true }).verified,
    ).not.toBe(Verified.NO);
  });

  it('a real failure still outranks it', () => {
    const r = decideVerified({ pass: false, honesty: clean, settled: true, outcomePending: true });
    expect(r.verified).toBe(Verified.NO);
  });

  it('leaves an ordinary synchronous action green', () => {
    expect(decideVerified({ pass: true, honesty: clean, settled: true }).verified).toBe(
      Verified.YES,
    );
  });
});

describe('decideVerified — one answer from eight dimensions', () => {
  it('says YES for a graded, clean, settled, uncontradicted pass', () => {
    const v = decideVerified({ pass: true, honesty: clean(), settled: true });
    expect(v.verified).toBe(Verified.YES);
    expect(v.because).toContain('signal');
  });

  it('says NO when the declared consequence did not hold', () => {
    expect(decideVerified({ pass: false, honesty: clean(), settled: true }).verified).toBe(
      Verified.NO,
    );
  });
});

/**
 * The case the product exists for. Measured on the bench app: `ui-advanced-request-failed` arrived
 * with verdict.pass true and every other channel agreeing the action was fine. If `pass` outranked
 * the contradiction, the single field an agent reads would report the very false green being
 * detected — so this inversion is the most important assertion in the file.
 */
describe('a contradiction outranks a passing assertion', () => {
  it('says NO when channels disagree even though the assertion passed', () => {
    const v = decideVerified({
      pass: true,
      honesty: clean(),
      settled: true,
      contradictions: [{ kind: 'ui-advanced-request-failed' }],
    });
    expect(v.verified).toBe(Verified.NO);
    expect(v.because).toContain('ui-advanced-request-failed');
  });

  it('names every disagreeing channel, so the agent knows where to look', () => {
    const v = decideVerified({
      pass: true,
      honesty: clean(),
      settled: true,
      contradictions: [{ kind: 'duplicate-request' }, { kind: 'response-ignored' }],
    });
    expect(v.because).toContain('duplicate-request');
    expect(v.because).toContain('response-ignored');
  });
});

/**
 * UNKNOWN must never collapse into NO. "I could not see" and "it is broken" send an agent in
 * opposite directions — look again with better coverage, versus go change code. Merging them
 * manufactures false alarms in one direction and false confidence in the other.
 */
describe('UNKNOWN is a distinct answer, never folded into NO', () => {
  it('is UNKNOWN — not NO — when the capture was not clean', () => {
    const v = decideVerified({ pass: true, honesty: dirty('capture truncated'), settled: true });
    expect(v.verified).toBe(Verified.UNKNOWN);
    expect(v.verified).not.toBe(Verified.NO);
    expect(v.because).toContain('capture truncated');
  });

  it('is never a pass when nothing was asserted at a real grade (a vacuous green)', () => {
    // The invariant this test has always been about: a green that could not have failed is not
    // proof. It answers `no-fault` rather than `unknown` once the window settled — a different
    // word for a different fact, and still not `yes`.
    const settledWindow = decideVerified({
      pass: true,
      honesty: clean(HonestyGrade.NONE),
      settled: true,
    });
    expect(settledWindow.verified).toBe(Verified.NO_FAULT);
    expect(settledWindow.verified).not.toBe(Verified.YES);

    const unsettledWindow = decideVerified({ pass: true, honesty: clean(HonestyGrade.NONE) });
    expect(unsettledWindow.verified).toBe(Verified.UNKNOWN);
    expect(unsettledWindow.because).toMatch(/proves nothing/);
  });

  it('is UNKNOWN when the page never settled', () => {
    const v = decideVerified({ pass: true, honesty: clean(), settled: false });
    expect(v.verified).toBe(Verified.UNKNOWN);
    expect(v.because).toMatch(/never settled/);
  });

  /** The exact signal that stumped a real drive: settled:false with no other fault. */
  it('resolves the settle-timeout ambiguity that previously had no answer', () => {
    expect(decideVerified({ pass: true, honesty: clean(), settled: false }).verified).toBe(
      Verified.UNKNOWN,
    );
  });
});

/**
 * The false RED. Every other clause in this rule is tuned against claiming more than was observed;
 * this one was the hole in the other direction.
 *
 * Measured twice, on a healthy app: reload the page 300ms into a wait and the verdict came back
 *
 *   verified:"no", verifiedReason:"assertion_failed",
 *   because:"the declared consequence did not hold", source:"src/components/Counter.tsx:18"
 *
 * The app was fine. The observer left. An agent reading that goes and edits Counter.tsx.
 */
describe('a lost connection is not a failed assertion', () => {
  it('is UNKNOWN, not NO, when the tab went away mid-wait', () => {
    const v = decideVerified({
      pass: false,
      observationLost: true,
      honesty: clean(),
      settled: true,
    });
    expect(v.verified).toBe(Verified.UNKNOWN);
    expect(v.verified).not.toBe(Verified.NO);
    expect(v.verifiedReason).toBe(VerifiedReason.OBSERVATION_LOST);
  });

  it('says the tab disconnected, and never that the consequence did not hold', () => {
    const v = decideVerified({
      pass: false,
      observationLost: true,
      honesty: clean(),
      settled: true,
    });
    expect(v.because).toMatch(/disconnected/);
    // The specific sentence that sent an agent to the wrong file.
    expect(v.because).not.toMatch(/did not hold/);
  });

  it('leaves a GENUINE failure alone — the flag is the only difference', () => {
    // Identical inputs but for `observationLost`. If this ever goes UNKNOWN, the fix has swallowed
    // real failures, which is far worse than the bug it replaced.
    const v = decideVerified({ pass: false, honesty: clean(), settled: true });
    expect(v.verified).toBe(Verified.NO);
    expect(v.verifiedReason).toBe(VerifiedReason.ASSERTION_FAILED);
  });

  it('an assertion nobody could EVALUATE still outranks one nobody could OBSERVE', () => {
    // Both are "we cannot say", and `inconclusive` names the more specific cause (the agent's own
    // call), so it must keep leading.
    const v = decideVerified({
      pass: false,
      observationLost: true,
      inconclusive: 'no store named cart',
      honesty: clean(),
      settled: true,
    });
    expect(v.verifiedReason).toBe(VerifiedReason.INCONCLUSIVE);
  });
});

describe('precedence between competing faults', () => {
  it('reports the failed assertion first, as the most actionable fact', () => {
    const v = decideVerified({
      pass: false,
      honesty: dirty('capture truncated'),
      contradictions: [{ kind: 'duplicate-request' }],
      settled: false,
    });
    expect(v.verified).toBe(Verified.NO);
    expect(v.because).toContain('did not hold');
  });

  it('prefers a contradiction over a dirty capture: evidence AGAINST beats absence of evidence', () => {
    const v = decideVerified({
      pass: true,
      honesty: dirty('capture truncated'),
      contradictions: [{ kind: 'signal-contradicted' }],
      settled: true,
    });
    expect(v.verified).toBe(Verified.NO);
  });

  /**
   * The same rule as the dirty-capture case above, applied to the other absence-of-evidence verdict.
   *
   * `alreadyTrue` says the assertion proves nothing about the action; a contradiction says a channel
   * observed the action going WRONG. Both can hold at once — assert `{ text: 'Saved' }` that was
   * already on screen while the write 500s — and ordering alreadyTrue first downgraded a detected
   * false green from NO to UNKNOWN, which reads as "assert something else" rather than "this is
   * broken". Evidence AGAINST beats absence of evidence, whichever absence it is.
   */
  it('prefers a contradiction over an already-true assertion', () => {
    const v = decideVerified({
      pass: true,
      honesty: clean(),
      alreadyTrue: true,
      contradictions: [{ kind: 'ui-advanced-request-failed' }],
      settled: true,
    });
    expect(v.verified).toBe(Verified.NO);
    expect(v.because).toContain('disagree');
  });

  /** Partial coverage is a caveat carried in `honesty.coverage`, not grounds to withhold a verdict. */
  it('still says YES under partial coverage when nothing else is wrong', () => {
    const v = decideVerified({
      pass: true,
      honesty: { ...clean(), coverage: { partial: true } },
      settled: true,
    });
    expect(v.verified).toBe(Verified.YES);
  });

  it('treats an action that declared no consequence as ungraded, not as a pass', () => {
    const v = decideVerified({ honesty: clean(HonestyGrade.NONE), settled: true });
    expect(v.verified).not.toBe(Verified.YES);
    expect(v.verified).toBe(Verified.NO_FAULT);
  });
});

/**
 * `dropped` is CUMULATIVE for the session, so reading it raw asks "has this session ever lost an
 * event" rather than "was this action's window complete". Measured on the Next.js demo at
 * `dropped: 51`: every action's own window was intact, and every one still reported an untrustworthy
 * capture — which pinned `verified` to `unknown` permanently, silently destroying the field's value
 * on exactly the long-running sessions it matters most for.
 *
 * The rule below is unchanged; what changed is the input. These pin the consequence so the scoping
 * cannot regress into a session-lifetime read again.
 */
describe('a stale eviction from earlier in the session must not condemn later actions', () => {
  it('is YES when nothing was dropped DURING this action', () => {
    // dropped-during is false → integrity clean, even on a session that evicted plenty earlier.
    const v = decideVerified({ pass: true, honesty: clean(), settled: true });
    expect(v.verified).toBe(Verified.YES);
  });

  it('is UNKNOWN when the buffer lost events during THIS action', () => {
    const v = decideVerified({
      pass: true,
      honesty: dirty('capture truncated'),
      settled: true,
    });
    expect(v.verified).toBe(Verified.UNKNOWN);
    expect(v.because).toContain('capture truncated');
  });
});

/**
 * `verified` has three values and this rule has twelve clauses, so the verdict alone throws away the
 * only thing that says WHO has to act. Measured in a real capture: `unknown` + `passed: false` was
 * indistinguishable between "Reticle caught a real bug", "the agent wrote a bad predicate" and
 * "Reticle itself could not see", and `no` collapsed "channels disagree" into "the agent's predicate
 * failed". Seven distinct causes reached the wire as two payloads.
 *
 * The pair of checks below is what keeps the enum honest in BOTH directions: a clause without a
 * member cannot compile, and a member without a clause fails here. Neither list is hand-maintained
 * against the other.
 */
describe('nothing declared over a settled window is not the same as not having looked', () => {
  /**
   * Two very different facts used to share one answer.
   *
   * By the time this clause is reached, a failure, a contradiction, a dirty capture, a pending write
   * and an unread one have all been ruled out. So when the window ALSO settled, the engine did not
   * fail to see: it saw the whole window, ran every oracle, and found nothing wrong. Saying `unknown`
   * there reports a clean look and an unproved claim in the same word as a look that never finished,
   * and the two need opposite responses — "assert something" versus "look again with better
   * coverage".
   *
   * It is never `yes`, so it cannot be mistaken for proof, and it is gated on the window having
   * settled rather than on a caller's say-so — which is what stops it becoming the green-forever
   * button an always-available "nothing was wrong" would be.
   */
  it('answers no-fault when the window settled and nothing was declared', () => {
    const v = decideVerified({ honesty: clean(HonestyGrade.NONE), settled: true });
    expect(v.verified).toBe(Verified.NO_FAULT);
    expect(v.verifiedReason).toBe(VerifiedReason.NOTHING_DECLARED);
    expect(v.verified).not.toBe(Verified.YES); // it is not proof, and must never read as proof
  });

  it('stays unknown when nothing was declared AND the window never settled', () => {
    const v = decideVerified({ honesty: clean(HonestyGrade.NONE) });
    expect(v.verified).toBe(Verified.UNKNOWN);
    expect(v.verifiedReason).toBe(VerifiedReason.VACUOUS_GRADE);
  });
});

describe('every verdict names the clause that decided it', () => {
  const branches: Record<VerifiedReason, VerifiedVerdictInput> = {
    [VerifiedReason.INCONCLUSIVE]: { pass: true, honesty: clean(), inconclusive: 'no store named' },
    [VerifiedReason.ASSERTION_FAILED]: { pass: false, honesty: clean(), settled: true },
    // Same `pass: false` as the row above — the ONLY difference is that the observer left. Those two
    // rows sitting next to each other is the point: for a long time they produced the same verdict.
    [VerifiedReason.OBSERVATION_LOST]: {
      pass: false,
      honesty: clean(),
      settled: true,
      observationLost: true,
    },
    [VerifiedReason.WINDOW_CLOSED_EARLY]: {
      pass: false,
      declaredConsequence: true,
      honesty: clean(),
      settled: false,
      namedRequestInFlight: true,
      unsettled: {
        waitedFor: "a request POST matching '/api/v1/auth/register'",
        stillInFlight: ['POST /api/v1/auth/register'],
      },
    },
    [VerifiedReason.CONTRADICTED]: {
      pass: true,
      honesty: clean(),
      settled: true,
      contradictions: [{ kind: 'signal-contradicted' }],
    },
    [VerifiedReason.ALREADY_TRUE]: {
      pass: true,
      honesty: clean(),
      settled: true,
      alreadyTrue: true,
    },
    [VerifiedReason.UNCLEAN_CAPTURE]: {
      pass: true,
      honesty: dirty('capture truncated'),
      settled: true,
    },
    // `settled` deliberately absent: with nothing declared AND a settled window the answer is
    // NOTHING_DECLARED below, because the engine did not fail to see — it saw everything and found
    // nothing wrong. VACUOUS_GRADE is now the case where both are true: nothing proved, and we
    // stopped looking early.
    [VerifiedReason.VACUOUS_GRADE]: { honesty: clean(HonestyGrade.NONE) },
    [VerifiedReason.NOTHING_DECLARED]: { honesty: clean(HonestyGrade.NONE), settled: true },
    [VerifiedReason.OUTCOME_PENDING]: {
      pass: true,
      honesty: clean(),
      settled: true,
      outcomePending: true,
    },
    [VerifiedReason.OUTCOME_UNREAD]: {
      pass: true,
      honesty: clean(),
      settled: true,
      outcomeUnread: ['POST /api/bulk-hold'],
    },
    [VerifiedReason.UNSETTLED]: { pass: true, honesty: clean(), settled: false },
    [VerifiedReason.EVIDENCE_INCOMPLETE]: {
      pass: true,
      honesty: clean(),
      settled: true,
      contradictions: [{ kind: 'duplicate-request' }],
    },
    [VerifiedReason.PROVED]: { pass: true, honesty: clean(), settled: true },
    [VerifiedReason.ABSENCE_BLIND_SPOT]: {
      pass: true,
      honesty: clean(),
      settled: true,
      absenceBlindSpot: 'the absence target was in an unobserved region',
    },
  };

  it.each(Object.entries(branches))('reports %s', (expected, inputs) => {
    expect(decideVerified(inputs).verifiedReason).toBe(expected);
  });

  /**
   * A member nobody produces is a value a dashboard will wait for forever. This is the half a typed
   * record cannot catch: `Record<VerifiedReason, …>` forces a row per member, but only running the
   * rule proves the row actually reaches that clause.
   */
  it('has no member that no clause produces', () => {
    const produced = new Set(
      Object.values(branches).map((inputs) => decideVerified(inputs).verifiedReason),
    );
    expect([...Object.values(VerifiedReason)].filter((r) => !produced.has(r))).toEqual([]);
  });
});

/**
 * A caveat an agent cannot locate is one it learns to skip. Every other clause in the rule names the
 * evidence that decided it; this one described a shape ("a write returned 2xx…") and named no write,
 * so on any page making more than one call the next move was a guess.
 */
describe('an unread outcome names the write that decided the verdict', () => {
  it('puts the method and url in the sentence', () => {
    const decision = decideVerified({
      pass: true,
      honesty: clean(),
      settled: true,
      outcomeUnread: ['POST /api/bulk-hold', 'PUT /api/shipments/9'],
    });
    expect(decision.verifiedReason).toBe(VerifiedReason.OUTCOME_UNREAD);
    expect(decision.because).toContain('POST /api/bulk-hold');
    expect(decision.because).toContain('PUT /api/shipments/9');
  });

  // Negative control: an empty list is not a caveat. Nothing went unread, so nothing is withheld.
  it('does not downgrade when no write went unread', () => {
    expect(
      decideVerified({ pass: true, honesty: clean(), settled: true, outcomeUnread: [] }).verified,
    ).toBe(Verified.YES);
  });
});

describe('a settle that never happened is not a failed assertion', () => {
  /**
   * Measured on the hard fixture: `reticle_act_and_wait` with NO `until` on a healthy pagination
   * button returned `verified:"no"` because the page — which carries push updates and therefore
   * never goes idle — did not settle inside the window. The sentence read "the declared consequence
   * did not hold", naming a consequence the caller never declared.
   *
   * Every live app has this shape. Grading it NO accuses each of them of a defect for being alive,
   * which is exactly the false NEGATIVE that ABSENCE_DERIVED_CONTRADICTIONS was written to prevent.
   */
  const settleTimedOut = {
    pass: false,
    declaredConsequence: false,
    honesty: clean(HonestyGrade.PRESENCE),
    settled: false,
  } as VerifiedVerdictInput;

  it('grades unknown, not no', () => {
    expect(decideVerified(settleTimedOut).verified).toBe(Verified.UNKNOWN);
  });

  it('names the absence rather than a consequence nobody declared', () => {
    const { verifiedReason, because } = decideVerified(settleTimedOut);
    expect(verifiedReason).toBe(VerifiedReason.UNSETTLED);
    expect(because).not.toMatch(/declared consequence did not hold/);
    expect(because).toMatch(/until/);
  });

  it('still fails a consequence that WAS declared and did not hold', () => {
    const declared = decideVerified({ ...settleTimedOut, declaredConsequence: true });
    expect(declared.verified).toBe(Verified.NO);
    expect(declared.verifiedReason).toBe(VerifiedReason.ASSERTION_FAILED);
  });
});

/**
 * A net predicate that misses while its own request is still open is not a failed assertion.
 *
 * Field: `verified: "no"` / `assertion_failed` beside `contradictions[0].kind: request-never-settled`
 * naming `POST /api/v1/auth/register`, with `firstDivergence.observed: "no request to …"`. The
 * request completed 200 ~500ms after the window. Cold backend → no; warm backend → yes. That red
 * is a race, not a defect, and grading it `no` teaches the agent to weaken the check.
 */
describe('an in-flight named request is not a failed assertion', () => {
  const inFlightMiss = {
    pass: false,
    declaredConsequence: true,
    honesty: clean(),
    settled: false,
    namedRequestInFlight: true,
    unsettled: {
      waitedFor: "a request POST matching '/api/v1/auth/register'",
      stillInFlight: ['POST /api/v1/auth/register'],
    },
  } as VerifiedVerdictInput;

  it('grades unknown, not no', () => {
    expect(decideVerified(inFlightMiss).verified).toBe(Verified.UNKNOWN);
    expect(decideVerified(inFlightMiss).verifiedReason).toBe(VerifiedReason.WINDOW_CLOSED_EARLY);
  });

  it('does not say the declared consequence did not hold', () => {
    expect(decideVerified(inFlightMiss).because).not.toMatch(/declared consequence did not hold/);
    expect(decideVerified(inFlightMiss).because).toMatch(/in flight/i);
  });

  it('still fails when the named request is not the one left open', () => {
    const unrelatedOpen = decideVerified({
      ...inFlightMiss,
      namedRequestInFlight: false,
    });
    expect(unrelatedOpen.verified).toBe(Verified.NO);
    expect(unrelatedOpen.verifiedReason).toBe(VerifiedReason.ASSERTION_FAILED);
  });
});

describe('a signal nothing corroborated explains itself', () => {
  /**
   * The verdict was already right — UNKNOWN, not the `yes` it used to be. The SENTENCE was wrong:
   * the generic contradiction prose says the window "closed before the app finished" and blames a
   * poll or a timer for keeping the page busy. Nothing kept this page busy. Nothing happened at
   * all, which is the whole finding, and an agent told to wait longer goes to the wrong place.
   */
  const signalOnly = {
    pass: true,
    declaredConsequence: true,
    honesty: clean(HonestyGrade.SIGNAL),
    settled: true,
    contradictions: [{ kind: ContradictionKind.SIGNAL_WITHOUT_CONSEQUENCE }],
  } as VerifiedVerdictInput;

  it('still refuses to call it proved', () => {
    expect(decideVerified(signalOnly).verified).toBe(Verified.UNKNOWN);
  });

  it('does not blame a busy page for a page that did nothing', () => {
    const { because } = decideVerified(signalOnly);
    expect(because).not.toMatch(/closed before the app finished/);
    expect(because).not.toMatch(/poll|timer|animation/);
  });

  it('names the fact and where to look instead', () => {
    const { because } = decideVerified(signalOnly);
    expect(because).toMatch(/NOTHING else moved/);
    expect(because).toMatch(/reticle_snapshot|reticle_state/);
  });
});
