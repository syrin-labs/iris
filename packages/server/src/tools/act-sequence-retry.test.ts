/**
 * The stale-ref retry inside a sequence.
 *
 * The line to hold is that this retries ONE failure mode and no other. A tool that quietly re-runs
 * actions turns one click into two — worse than the failure it was papering over — so a step that
 * failed for any other reason must never be attempted twice.
 */
import { describe, expect, it } from 'vitest';
import { isStaleRefError, runStepWithStaleRetry, type StepOutcome } from './act-sequence-retry.js';

const STALE = "ref 'e127' no longer resolves to an element";

/** Enough of a session for the grace period: no events means no reaction to wait for. */
const session = { eventsSince: () => [], elapsed: () => 0 } as never;
const noSleep = { sleep: (): Promise<void> => Promise.resolve() };

/** An attempt that answers from a script, and counts how many times it was called. */
const scripted = (...outcomes: StepOutcome[]) => {
  let calls = 0;
  return {
    attempt: (): Promise<StepOutcome> => {
      const outcome = outcomes[Math.min(calls, outcomes.length - 1)];
      calls += 1;
      return Promise.resolve(outcome ?? { ok: false });
    },
    calls: (): number => calls,
  };
};

describe('recognising the failure', () => {
  it('matches the daemon’s own stale-ref wording', () => {
    expect(isStaleRefError(STALE)).toBe(true);
  });

  it('does not match an unrelated failure', () => {
    expect(isStaleRefError('target matched no element')).toBe(false);
    expect(isStaleRefError('element is not visible')).toBe(false);
    expect(isStaleRefError(undefined)).toBe(false);
  });
});

describe('one retry, and only for staleness', () => {
  it('does not retry a step that succeeded', async () => {
    const s = scripted({ ok: true });
    await runStepWithStaleRetry(s.attempt, session, 0, 100, noSleep);
    expect(s.calls()).toBe(1);
  });

  it('retries a stale ref exactly once, and reports the success', async () => {
    // The observed case: the same refs work once React has finished re-rendering.
    const s = scripted({ ok: false, error: STALE }, { ok: true, result: { ref: 'e127' } });
    const out = await runStepWithStaleRetry(s.attempt, session, 0, 100, noSleep);
    expect(s.calls()).toBe(2);
    expect(out.ok).toBe(true);
  });

  it('gives up after ONE retry — a gone element is gone', async () => {
    const s = scripted({ ok: false, error: STALE });
    const out = await runStepWithStaleRetry(s.attempt, session, 0, 100, noSleep);
    expect(s.calls()).toBe(2);
    expect(out.ok).toBe(false);
    expect(out.error).toBe(STALE);
  });

  it('never retries any other failure', async () => {
    // A tool that re-runs actions turns one click into two. Only staleness earns a second attempt.
    for (const error of ['target matched no element', 'element is not visible', 'timed out']) {
      const s = scripted({ ok: false, error });
      const out = await runStepWithStaleRetry(s.attempt, session, 0, 100, noSleep);
      expect(s.calls(), error).toBe(1);
      expect(out.error).toBe(error);
    }
  });

  it('passes the original outcome through untouched when it does not retry', async () => {
    const s = scripted({ ok: false, error: 'nope', result: { detail: 1 } });
    const out = await runStepWithStaleRetry(s.attempt, session, 0, 100, noSleep);
    expect(out.result).toEqual({ detail: 1 });
  });
});
