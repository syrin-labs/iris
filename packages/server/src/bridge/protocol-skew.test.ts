/**
 * A mismatch must name the component that is actually stale.
 *
 * The close reason used to be one fixed string telling the user to upgrade `@reticlehq/browser`,
 * whichever way the versions disagreed. This repo's own logs show the opposite skew in practice —
 * `got: 2, expected: 1`, a page AHEAD of the daemon — where that advice sends somebody to upgrade
 * the one component that was already current.
 */
import { describe, expect, it } from 'vitest';
import {
  BROWSER_IS_OLDER,
  CLOSE_REASON_MAX_BYTES,
  DAEMON_IS_OLDER,
  protocolSkewReason,
  SKEW_UNKNOWN,
} from './protocol-skew.js';

describe('the remedy follows the direction of the skew', () => {
  it('blames the page when the page is behind', () => {
    expect(protocolSkewReason(1, 2)).toBe(BROWSER_IS_OLDER);
  });

  it('blames the DAEMON when the page is ahead — the case seen in the wild', () => {
    // An app on a current @reticlehq/browser, dialling an @reticlehq/server that npx served from
    // cache. Telling this user to upgrade the browser is advice that cannot work.
    expect(protocolSkewReason(2, 1)).toBe(DAEMON_IS_OLDER);
    expect(protocolSkewReason(2, 1)).not.toContain('upgrade @reticlehq/browser');
    // The remedy matches the one `version/version-skew.ts` gives for a stale daemon. A user who
    // hits both paths must not be told two different things.
    expect(protocolSkewReason(2, 1)).toContain('reticle stop');
  });

  it('names both rather than guessing when the version cannot be read', () => {
    // Vague beats confidently wrong: the user checks both instead of ruling one out incorrectly.
    expect(protocolSkewReason(null, 2)).toBe(SKEW_UNKNOWN);
    expect(protocolSkewReason(Number.NaN, 2)).toBe(SKEW_UNKNOWN);
  });

  it('says something even when the versions match, rather than an empty reason', () => {
    // Reached only if a mismatch was detected some other way; a blank close reason would strand the
    // user with no diagnosis at all.
    expect(protocolSkewReason(2, 2)).toBe(SKEW_UNKNOWN);
  });
});

describe('every reason fits in a close frame', () => {
  it('stays under the 123-byte cap the socket layer enforces', () => {
    // A close reason that overflows is dropped, taking the diagnosis with it — so the cap is part
    // of the contract, not a style preference.
    for (const reason of [BROWSER_IS_OLDER, DAEMON_IS_OLDER, SKEW_UNKNOWN]) {
      expect(Buffer.byteLength(reason, 'utf8')).toBeLessThanOrEqual(CLOSE_REASON_MAX_BYTES);
    }
  });
});
