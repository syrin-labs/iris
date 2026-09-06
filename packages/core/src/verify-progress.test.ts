/**
 * The narration contract.
 *
 * A verification is silent for its whole duration — the artifact only exists at the end — so from
 * outside, a run that is working and a run that has died look the same. These events are what makes
 * the difference visible, and what they must never do is become a second source of truth about
 * whether anything was PROVED. That stays the artifact's job.
 */
import { describe, expect, it } from 'vitest';
import {
  VerifyPhase,
  VERIFY_PROGRESS_MAX_EVENTS,
  VERIFY_PROGRESS_NAME_MAX,
  boundFlowName,
  verifyProgressBatchSchema,
  verifyProgressEventSchema,
} from './verify-progress.js';

describe('a progress event', () => {
  it('accepts the shape a flow replay produces', () => {
    const parsed = verifyProgressEventSchema.safeParse({
      phase: VerifyPhase.FLOW_STARTED,
      index: 2,
      total: 12,
      name: 'checkout',
      at: 1_000,
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a phase nobody defined, rather than rendering it', () => {
    const parsed = verifyProgressEventSchema.safeParse({ phase: 'thinking', at: 1 });
    expect(parsed.success).toBe(false);
  });

  /* `at` comes from an injected clock, so an emitter that forgot it is a bug worth catching here. */
  it('requires a timestamp', () => {
    const parsed = verifyProgressEventSchema.safeParse({ phase: VerifyPhase.GRADING });
    expect(parsed.success).toBe(false);
  });

  it('leaves flow fields off the phases that are not about one flow', () => {
    const parsed = verifyProgressEventSchema.safeParse({ phase: VerifyPhase.CONNECTING, at: 1 });
    expect(parsed.success).toBe(true);
  });

  /*
   * A flow name is user-supplied, unbounded, and ends up rendered in somebody's dashboard. Bounded
   * on the wire so no consumer has to remember to truncate it.
   */
  it('refuses a name longer than the wire bound', () => {
    const parsed = verifyProgressEventSchema.safeParse({
      phase: VerifyPhase.FLOW_STARTED,
      name: 'x'.repeat(VERIFY_PROGRESS_NAME_MAX + 1),
      at: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it('truncates one to fit rather than leaving a caller to overflow the schema', () => {
    const bounded = boundFlowName('y'.repeat(VERIFY_PROGRESS_NAME_MAX + 50));
    expect(bounded).toHaveLength(VERIFY_PROGRESS_NAME_MAX);
    expect(
      verifyProgressEventSchema.safeParse({
        phase: VerifyPhase.FLOW_STARTED,
        name: bounded,
        at: 1,
      }).success,
    ).toBe(true);
  });

  it('leaves a name that already fits exactly as it was', () => {
    expect(boundFlowName('checkout')).toBe('checkout');
  });
});

describe('a batch', () => {
  it('carries the run it belongs to, so a watcher can tell two runs apart', () => {
    const parsed = verifyProgressBatchSchema.safeParse({
      runId: 'run_1',
      events: [{ phase: VerifyPhase.GRADING, at: 1 }],
    });
    expect(parsed.success).toBe(true);
  });

  /* Unbounded narration is a denial-of-service with a friendly name. */
  it('refuses more events than a receiver will keep', () => {
    const parsed = verifyProgressBatchSchema.safeParse({
      runId: 'run_1',
      events: Array.from({ length: VERIFY_PROGRESS_MAX_EVENTS + 1 }, () => ({
        phase: VerifyPhase.GRADING,
        at: 1,
      })),
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a batch with no run to attribute it to', () => {
    const parsed = verifyProgressBatchSchema.safeParse({ runId: '', events: [] });
    expect(parsed.success).toBe(false);
  });
});
