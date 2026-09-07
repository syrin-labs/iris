import { describe, expect, it } from 'vitest';
import {
  InstrumentationGapKind,
  dedupeGaps,
  fixForGap,
  instrumentationGap,
} from './instrumentation-gap.js';

describe('instrumentation gaps', () => {
  it('carries what was missing, what it cost, and the change that closes it', () => {
    const gap = instrumentationGap(
      InstrumentationGapKind.NO_SOURCE_MAPPING,
      'e12 has no source mapping',
      'the verdict can name the control but not the line that renders it',
      { ref: 'e12' },
    );
    expect(gap.missing).toBe('e12 has no source mapping');
    // Carried verbatim: only the emit site knows what this particular verdict lost.
    expect(gap.cost).toBe('the verdict can name the control but not the line that renders it');
    expect(gap.fix).toContain('plugin');
    expect(gap.ref).toBe('e12');
  });

  /**
   * The remedy is derived from the kind in one place, never supplied by the emit site. A kind
   * reported with a fix that has drifted from it is worse than no fix — an agent that follows a
   * wrong instruction spends the round trip AND ends up further away.
   */
  it('derives the fix from the kind, so an emit site cannot drift from it', () => {
    for (const kind of Object.values(InstrumentationGapKind)) {
      expect(fixForGap(kind).length, kind).toBeGreaterThan(0);
      expect(instrumentationGap(kind, 'x', 'y').fix).toBe(fixForGap(kind));
    }
  });

  it('names a real primitive in every remedy, not a general instruction', () => {
    expect(fixForGap(InstrumentationGapKind.NO_STORE_REGISTERED)).toContain('registerStore');
    expect(fixForGap(InstrumentationGapKind.NO_SIGNAL_ON_MUTATION)).toContain('reticle.signal');
    expect(fixForGap(InstrumentationGapKind.UNDECLARED_CONTROL)).toContain('reticle.describe');
    expect(fixForGap(InstrumentationGapKind.MISSING_TESTID)).toContain('data-testid');
  });

  /**
   * The remedy for an undeclared change has to name the tool AND what to put in it. "Declare your
   * intent" is an instruction an agent cannot follow; the tool name plus the shape of the statement
   * is one it can.
   */
  it('names reticle_intent and what to declare in it', () => {
    const fix = fixForGap(InstrumentationGapKind.UNDECLARED_CHANGE);
    expect(fix).toContain('reticle_intent');
    expect(fix).toContain('statement');
  });

  /** Same reasoning one artifact later: a saved flow's remedy has to say WHERE to put the prose. */
  it('names both ways to give a flow its intent', () => {
    const fix = fixForGap(InstrumentationGapKind.NO_FLOW_INTENT);
    expect(fix).toContain('intent');
    expect(fix).toContain('intentId');
  });

  it('omits source and ref rather than carrying empty ones', () => {
    const gap = instrumentationGap(InstrumentationGapKind.NO_ROUTE_SIGNAL, 'm', 'c');
    expect('source' in gap).toBe(false);
    expect('ref' in gap).toBe(false);
  });

  /**
   * One missing build plugin is one finding however many controls it touched. A list that grows with
   * the page rather than with the number of distinct things to fix is what trains an agent to stop
   * reading these at all.
   */
  it('collapses repeats of the same gap', () => {
    const same = instrumentationGap(InstrumentationGapKind.NO_SOURCE_MAPPING, 'no plugin', 'c');
    expect(dedupeGaps([same, same, same])).toHaveLength(1);
  });

  it('keeps genuinely different gaps of the same kind', () => {
    const a = instrumentationGap(InstrumentationGapKind.NO_STORE_REGISTERED, 'cart', 'c');
    const b = instrumentationGap(InstrumentationGapKind.NO_STORE_REGISTERED, 'session', 'c');
    expect(dedupeGaps([a, b, a])).toHaveLength(2);
  });

  it('keeps gaps of different kinds that name the same thing', () => {
    const a = instrumentationGap(InstrumentationGapKind.NO_SOURCE_MAPPING, 'e12', 'c');
    const b = instrumentationGap(InstrumentationGapKind.UNDECLARED_CONTROL, 'e12', 'c');
    expect(dedupeGaps([a, b])).toHaveLength(2);
  });

  it('is empty in, empty out', () => {
    expect(dedupeGaps([])).toEqual([]);
  });
});
