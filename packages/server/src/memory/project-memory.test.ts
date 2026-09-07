/**
 * Ranking and shaping what the project knows.
 *
 * The network half is exercised by the tool's own test and by driving it; these are the decisions
 * that would otherwise only be visible in a live run — which is where an ordering bug hides longest.
 */
import { describe, expect, it } from 'vitest';
import { rankKnown, type KnownThing } from './project-memory.js';

const thing = (statement: string, status: string): KnownThing => ({
  statement,
  status,
  flowName: null,
  sourceFile: null,
  subject: 'checkout',
});

describe('what an agent reads first', () => {
  it('puts PROVED statements ahead of the rest', () => {
    // An agent is about to ACT on this. A statement a verdict established outranks one somebody
    // merely wrote down, and the cap means the tail may never be read at all.
    const ranked = rankKnown([thing('a', 'agreed'), thing('b', 'proved'), thing('c', 'proposed')]);
    expect(ranked.map((t) => t.statement)).toEqual(['b', 'a', 'c']);
  });

  it('keeps the original order within each group, so the same call twice reads the same', () => {
    // An unstable list reads as the corpus churning when nothing has changed.
    const ranked = rankKnown([thing('a', 'proved'), thing('b', 'proved'), thing('c', 'agreed')]);
    expect(ranked.map((t) => t.statement)).toEqual(['a', 'b', 'c']);
  });

  it('loses nothing — ranking reorders, it does not filter', () => {
    const input = [thing('a', 'stale'), thing('b', 'proved'), thing('c', 'agreed')];
    expect(rankKnown(input)).toHaveLength(input.length);
  });

  it('handles a corpus with nothing proved yet', () => {
    const ranked = rankKnown([thing('a', 'agreed'), thing('b', 'proposed')]);
    expect(ranked.map((t) => t.statement)).toEqual(['a', 'b']);
  });

  it('is empty for an empty corpus rather than throwing', () => {
    expect(rankKnown([])).toEqual([]);
  });
});
