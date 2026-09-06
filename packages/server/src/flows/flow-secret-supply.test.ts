import { afterEach, describe, expect, it } from 'vitest';
import { REDACTED_FILL } from './flows.js';
import { replayActionArgs } from './replay.js';

/**
 * Supplying at replay the secret that was redacted at save.
 *
 * Redacting the password out of a git-checked flow is only half a fix. The other half is that
 * sign-in still has to REPLAY — a flow that drifts at step two forever because its own credential
 * was removed is a flow nobody keeps, and a team that cannot replay sign-in cannot replay anything
 * behind it.
 *
 * So the value comes from the environment at replay time: the one place a secret can live that is
 * neither the repository nor our database.
 */

const KEY = 'RETICLE_SECRET_AUTH_PASSWORD';

afterEach(() => {
  delete process.env[KEY];
});

describe('a redacted fill at replay time', () => {
  it('is filled from the environment variable named after its field', () => {
    process.env[KEY] = 'the-real-password';
    const args = replayActionArgs({ value: REDACTED_FILL }, false, 'auth-password');
    expect(args['value']).toBe('the-real-password');
  });

  /**
   * Left as the placeholder rather than blanked. The replay then fails at the login form with the
   * placeholder visible on screen, which names its own fix — an empty field fails identically and
   * tells the reader nothing.
   */
  it('stays the placeholder when nothing supplies it', () => {
    const args = replayActionArgs({ value: REDACTED_FILL }, false, 'auth-password');
    expect(args['value']).toBe(REDACTED_FILL);
  });

  /** An ordinary recorded value is never touched, whatever the environment holds. */
  it('leaves a non-redacted value exactly as recorded', () => {
    process.env[KEY] = 'the-real-password';
    const args = replayActionArgs({ value: 'checkout total' }, false, 'auth-password');
    expect(args['value']).toBe('checkout total');
  });

  /** Field names become env keys predictably, or nobody can guess what to set. */
  it('maps a dashed field name onto a SCREAMING_SNAKE variable', () => {
    process.env['RETICLE_SECRET_API_KEY'] = 'rk_live_x';
    const args = replayActionArgs({ value: REDACTED_FILL }, false, 'api-key');
    expect(args['value']).toBe('rk_live_x');
  });
});
