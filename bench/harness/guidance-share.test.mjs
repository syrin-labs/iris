import { describe, expect, it } from 'vitest';
import { guidanceBytes, guidanceShare, GUIDANCE_KEYS } from './guidance-share.mjs';

/**
 * The owner's constraint on the competitor benchmark: tokens spent capturing business intent and
 * telling the agent what to do next are our work, not part of a like-for-like comparison. Excluding
 * them is only honest if the split is measured, and the split is only trustworthy if every
 * uncertainty is resolved AGAINST us.
 */
describe('what counts as guidance', () => {
  it('excludes the feedback invitation, which no competitor emits', () => {
    const payload = JSON.stringify({ verified: 'no', feedback_invite: 'tell us about it' });
    expect(guidanceBytes(payload)).toBeGreaterThan(0);
  });

  it('excludes an instrumentation gap FIX while keeping what it observed', () => {
    const gap = JSON.stringify({
      instrumentationGaps: [
        { kind: 'no-signal-on-mutation', missing: 'the DOM changed', fix: 'fire reticle.signal' },
      ],
    });
    const bytes = guidanceBytes(gap);
    expect(bytes).toBeGreaterThan(0);
    // The observation survives: only the advice is removed, so the gap still costs us its evidence.
    expect(bytes).toBeLessThan(Buffer.byteLength(gap, 'utf8') / 2);
  });

  it('keeps `because` counted, though it sometimes ends in advice', () => {
    expect(GUIDANCE_KEYS.has('because')).toBe(false);
    const verdict = JSON.stringify({
      because: 'the declared consequence did not hold — assert something it CHANGES',
    });
    expect(guidanceBytes(verdict)).toBe(0);
  });

  it('reaches guidance nested inside arrays and objects', () => {
    const nested = JSON.stringify({ a: { b: [{ c: { hint: 'do this next' } }] } });
    expect(guidanceBytes(nested)).toBeGreaterThan(0);
  });
});

describe('every uncertainty costs us, never the competitor', () => {
  it('charges nothing for a payload it cannot parse', () => {
    expect(guidanceBytes('a plain sentence with a hint: in it')).toBe(0);
    expect(guidanceShare('a plain sentence with a hint: in it')).toBe(0);
  });

  it('charges nothing for an empty or absent payload instead of throwing', () => {
    expect(guidanceBytes('')).toBe(0);
    expect(guidanceBytes(undefined)).toBe(0);
    expect(guidanceShare(undefined)).toBe(0);
  });

  it('never claims more than the payload actually is', () => {
    const payload = JSON.stringify({ hint: 'x' });
    expect(guidanceBytes(payload)).toBeLessThanOrEqual(Buffer.byteLength(payload, 'utf8'));
    expect(guidanceShare(payload)).toBeLessThanOrEqual(1);
  });
});
