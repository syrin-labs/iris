import { describe, expect, it } from 'vitest';
import { consultSubjectFor, selectConsulted, MEMORY_CONSULT_LIMIT } from './flow-memory-consult.js';
import type { FlowFile } from '@reticlehq/core';

/**
 * Shared memory is written on every verification and read essentially never — every subject on the
 * dashboard showed `fetches: 0`. Consulting it is a separate act an agent must remember to perform,
 * and knowledge that must be deliberately fetched is a wiki. These pin the rule that lets a replay
 * ask on the agent's behalf.
 */

const flow = (name: string): FlowFile =>
  ({ version: 1, name, createdAt: 1, steps: [] }) as unknown as FlowFile;

describe('the subject a replay consults', () => {
  it('is the flow name — a flow is a feature, and that is the axis memory shards on', () => {
    expect(consultSubjectFor(flow('checkout'))).toBe('checkout');
  });

  /**
   * Asking for `unsorted` would return the project's junk drawer on every verdict, which is worse
   * than silence because it looks like an answer.
   */
  it('is undefined when the flow name says nothing', () => {
    expect(consultSubjectFor(flow('   '))).toBeUndefined();
    expect(
      consultSubjectFor({ version: 1, createdAt: 1, steps: [] } as unknown as FlowFile),
    ).toBeUndefined();
  });
});

describe('what travels back with the verdict', () => {
  it('puts PROVED statements first — verified beats merely proposed', () => {
    const got = selectConsulted([
      { statement: 'a proposal', status: 'proposed' },
      { statement: 'something verified', status: 'proved' },
    ]);
    expect(got[0]?.statement).toBe('something verified');
  });

  /** A verdict that arrives with fifty statements is one whose result is below the fold. */
  it('is bounded, so the verdict stays the thing you read first', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      statement: `s${String(i)}`,
      status: 'agreed',
    }));
    expect(selectConsulted(many)).toHaveLength(MEMORY_CONSULT_LIMIT);
  });

  it('drops a record with no statement rather than rendering an empty line', () => {
    expect(
      selectConsulted([{ status: 'proved' }, { statement: 'real', status: 'agreed' }]),
    ).toEqual([{ statement: 'real', status: 'agreed' }]);
  });

  it('is empty when the project knows nothing yet', () => {
    expect(selectConsulted([])).toEqual([]);
  });
});
