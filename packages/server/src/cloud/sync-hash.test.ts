/**
 * The hash is a contract with the server, so these are vectors, not behaviour tests: if any of them
 * changes value, every linked machine re-uploads every record once and the server's stored hashes
 * stop matching anything. That is a breaking change and should read like one in a diff.
 */
import { describe, expect, it } from 'vitest';
import { hashPayload } from './sync-hash.js';

describe('the hash is stable across serialisations', () => {
  it('ignores key order — the whole reason it exists', () => {
    // A machine whose JSON key order differs from the server's would otherwise re-upload the same
    // unchanged record on every cycle, forever.
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
  });

  it('ignores key order at depth, not just at the top level', () => {
    expect(hashPayload({ outer: { a: 1, b: [{ x: 1, y: 2 }] } })).toBe(
      hashPayload({ outer: { b: [{ y: 2, x: 1 }], a: 1 } }),
    );
  });

  it('does NOT ignore array order — that is data, not formatting', () => {
    expect(hashPayload([1, 2])).not.toBe(hashPayload([2, 1]));
  });

  it('moves when a value actually changes', () => {
    expect(hashPayload({ calls: 1 })).not.toBe(hashPayload({ calls: 2 }));
  });

  it('distinguishes a missing key from an explicit null', () => {
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 1, b: null }));
  });

  it('is 32 hex characters', () => {
    expect(hashPayload({ any: 'thing' })).toMatch(/^[0-9a-f]{32}$/);
  });

  /*
   * Taken from the SERVER's implementation, not from this one — running both over the same inputs and
   * recording what they agreed on. A vector generated from the code it is testing proves only that
   * the code is deterministic; these prove the two halves of sync compute the same number.
   */
  it('matches these fixed vectors — changing one is a WIRE BREAK, not a refactor', () => {
    expect(hashPayload({})).toBe('44136fa355b3678a1146ad16f7e8649e');
    expect(hashPayload({ a: 1, b: 2 })).toBe('43258cff783fe7036d8a43033f830adf');
    expect(hashPayload([])).toBe('4f53cda18c2baa0c0354bb5f9a3ecbe5');
    expect(hashPayload({ counts: { calls: 3 }, days: [] })).toBe(
      'e1978af26f37f8ca634478886f0afa13',
    );
  });
});
