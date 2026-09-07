/**
 * The verdict nudge carries a call, and the call cannot be sent unchanged.
 *
 * `verify_next` fires when an agent has driven the page several times and asked for no verdict —
 * the commonest shape of a wasted session. It used to carry prose, which the agent had to translate
 * back into arguments, and that translation is exactly where agents were already going wrong.
 *
 * Driven over MCP against a live app: the baton arrives on the third un-verified act, naming the
 * ref that actually dispatched (`e5`), the action, and the nested argument shape.
 *
 * The placeholder is the interesting half. Sent verbatim it parsed as a valid text predicate that
 * simply never matched, so the verdict read `verified:"no"` / "the declared consequence did not
 * hold" — blaming the app for a value the agent had not filled in, and sending it to hunt a defect
 * that did not exist. Measured, then guarded in `parsePredicate`, then re-measured: it now refuses
 * and says why.
 */

import { describe, expect, it } from 'vitest';
import { verifyNextBaton, UNTIL_PLACEHOLDER } from './verify-next-baton.js';
import { parsePredicate } from '../events/predicate-parse.js';
import { ReticleTool } from './tool-names.js';

const PROSE = 'you have driven this page 3 times without asking for a verdict.';

describe('the baton names the element the agent actually touched', () => {
  it('builds an act_and_wait against the last dispatched ref', () => {
    const b = verifyNextBaton(PROSE, { ref: 'e42', action: 'click' });
    expect(b.call?.tool).toBe(ReticleTool.ACT_AND_WAIT);
    expect(b.call?.args['ref']).toBe('e42');
    expect(b.call?.args['action']).toBe('click');
  });

  it('keeps the prose, which explains why the call is being suggested', () => {
    expect(verifyNextBaton(PROSE, { ref: 'e42', action: 'click' }).why).toBe(PROSE);
  });

  it('points at the tool params on disk rather than at a web page', () => {
    expect(verifyNextBaton(PROSE, { ref: 'e42', action: 'click' }).docs).toContain('reticle_tools');
  });
});

describe('it suggests nothing when there is nothing honest to suggest', () => {
  /**
   * No ref means no act dispatched under one this session — a navigation, or a read-only run. A
   * call naming an element nobody touched is the router failure in miniature: an agent that follows
   * a fabricated next step follows it confidently.
   */
  it('omits the call when no ref has acted', () => {
    expect(verifyNextBaton(PROSE, { action: 'click' }).call).toBeUndefined();
  });

  it('omits the call when no action has dispatched', () => {
    expect(verifyNextBaton(PROSE, { ref: 'e42' }).call).toBeUndefined();
  });

  it('still carries the prose, so the agent is not left with nothing', () => {
    expect(verifyNextBaton(PROSE, {}).why).toBe(PROSE);
  });
});

describe('the placeholder cannot be sent back unchanged', () => {
  it('refuses the predicate the baton ships', () => {
    expect(() => parsePredicate({ kind: 'text', value: UNTIL_PLACEHOLDER })).toThrow(
      /placeholder/i,
    );
  });

  /** The refusal has to say what to do, not just what is wrong. */
  it('names what to replace it with', () => {
    expect(() => parsePredicate({ kind: 'text', value: UNTIL_PLACEHOLDER })).toThrow(
      /signal|request|route|state/i,
    );
  });

  /** And it must say nothing ran, so the agent does not read it as a failed assertion. */
  it('says no verdict was produced', () => {
    expect(() => parsePredicate({ kind: 'text', value: UNTIL_PLACEHOLDER })).toThrow(
      /nothing ran|no verdict/i,
    );
  });

  it('leaves a real predicate alone', () => {
    expect(parsePredicate({ kind: 'text', value: 'Invalid email or password' }).kind).toBe('text');
  });
});
