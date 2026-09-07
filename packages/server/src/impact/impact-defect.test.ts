/**
 * What one failed verdict becomes, in the user's own record.
 *
 * The rule under test is the product's own rule, applied to the HUD: only a verified:"no" is a
 * defect. An "unknown" is Reticle admitting it could not tell, and recording those here would fill
 * somebody's short list with the tool's own blind spots rather than their app's.
 */
import { describe, expect, it } from 'vitest';
import { Verified } from '@reticlehq/core';
import { defectForToolResult } from './impact-recorder.js';

const NOW = 1_700_000_000_000;

describe('only a real failure becomes a defect', () => {
  it('records a verified:"no"', () => {
    expect(defectForToolResult({ verified: Verified.NO }, NOW)).toBeDefined();
  });

  it('records nothing for a pass', () => {
    expect(defectForToolResult({ verified: Verified.YES }, NOW)).toBeUndefined();
  });

  it('records nothing for an UNKNOWN — that is our blind spot, not their bug', () => {
    expect(defectForToolResult({ verified: Verified.UNKNOWN }, NOW)).toBeUndefined();
  });

  it('records nothing for a call that produced no verdict at all', () => {
    expect(defectForToolResult({ ok: true }, NOW)).toBeUndefined();
    expect(defectForToolResult(null, NOW)).toBeUndefined();
    expect(defectForToolResult('nope', NOW)).toBeUndefined();
  });
});

describe('the line it writes', () => {
  it('names the control that was acted on — a sentence somebody can act on', () => {
    const d = defectForToolResult(
      {
        verified: Verified.NO,
        effect: { name: 'Sign In' },
        verdict: { failureReason: 'the route never changed' },
      },
      NOW,
    );
    expect(d?.title).toBe('Sign In');
    expect(d?.detail).toBe('the route never changed');
  });

  it('falls back through testid then component when there is no accessible name', () => {
    expect(
      defectForToolResult({ verified: Verified.NO, effect: { testid: 'submit-btn' } }, NOW)?.title,
    ).toBe('submit-btn');
    expect(
      defectForToolResult({ verified: Verified.NO, effect: { component: 'LoginForm' } }, NOW)
        ?.title,
    ).toBe('LoginForm');
  });

  it('uses the REASON as the title when nothing names the control', () => {
    // Better a line that says what went wrong than one that says "a verdict failed".
    const d = defectForToolResult(
      { verified: Verified.NO, because: 'the declared consequence did not hold' },
      NOW,
    );
    expect(d?.title).toBe('the declared consequence did not hold');
    expect(d?.detail, 'not repeated as its own detail').toBeUndefined();
  });

  it('carries the source line so the reader can go straight there', () => {
    expect(
      defectForToolResult({ verified: Verified.NO, source: 'src/login.tsx:42' }, NOW)?.source,
    ).toBe('src/login.tsx:42');
  });

  it('ignores blank strings rather than titling a defect with whitespace', () => {
    const d = defectForToolResult({ verified: Verified.NO, effect: { name: '   ' } }, NOW);
    expect(d?.title).toBe('a declared consequence did not hold');
  });

  it('stamps the time it was caught', () => {
    expect(defectForToolResult({ verified: Verified.NO }, NOW)?.at).toBe(NOW);
  });
});
