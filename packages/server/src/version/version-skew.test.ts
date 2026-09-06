import { describe, expect, it } from 'vitest';
import {
  describeSkew,
  sdkFix,
  daemonFix,
  isPlaywrightClosedError,
  rewriteClosedAsSkew,
  type PeerIdentity,
} from './version-skew.js';

/**
 * A 2.2.1 SDK against a 2.4.0 daemon agrees on `protocolVersion`, connects fine, and then disagrees
 * about tool behaviour — which surfaced to a user as a bare `-32000` with nothing on either side
 * naming a version. It took a stale pnpm metadata cache to produce, was invisible to everyone, and
 * the only reason we know the shape of it is that someone hit it and reported the symptom.
 *
 * The point is that skew SAYS SO. Silence is the failure mode being fixed — but so is crying wolf:
 * a warning that fires on every harmless patch difference is one nobody reads by the third time.
 */

const SELF = { version: '2.4.1', contract: 'aaaa1111' };
const page = (over: Partial<PeerIdentity> = {}): PeerIdentity => ({
  what: 'the page',
  version: '2.4.1',
  contract: 'aaaa1111',
  fix: sdkFix(SELF.version),
  ...over,
});

describe('describeSkew — the contract decides, not the version', () => {
  it('says nothing when the fingerprints match', () => {
    expect(describeSkew(page(), SELF)).toBeUndefined();
  });

  it('says nothing when the VERSIONS differ but the contract is identical', () => {
    // The whole reason for the fingerprint. A patch release that renamed nothing on the wire is not
    // skew, and warning about it is exactly how a real warning gets trained into background noise.
    expect(describeSkew(page({ version: '2.4.0' }), SELF)).toBeUndefined();
  });

  it('WARNS when the contracts differ, even at the same version number', () => {
    // Two builds of one version: a stale daemon, a cached npx install. Version equality is blind to
    // this case, which is the one that cost real debugging time.
    const msg = describeSkew(page({ contract: 'bbbb2222' }), SELF) ?? '';
    expect(msg).toContain('aaaa1111');
    expect(msg).toContain('bbbb2222');
    expect(msg).toMatch(/different wire contracts/i);
  });

  it('names both versions and a concrete fix when the contracts differ', () => {
    const msg = describeSkew(page({ version: '2.2.1', contract: 'bbbb2222' }), SELF) ?? '';
    expect(msg).toContain('2.2.1');
    expect(msg).toContain('2.4.1');
    expect(msg).toMatch(/npm i -D @reticlehq\/browser@2\.4\.1|reticle update/);
  });

  it('treats a missing fingerprint plus a different version as skew — it predates the field', () => {
    const msg = describeSkew(page({ version: '2.2.1', contract: undefined }), SELF) ?? '';
    expect(msg).toContain('2.2.1');
    expect(msg).toMatch(/too old to report/i);
  });

  it('says nothing when there is genuinely nothing to go on', () => {
    // No fingerprint and no version: a hand-wired connect on an unknown build. Inventing a warning
    // here is as dishonest as swallowing a real one.
    expect(describeSkew(page({ version: undefined, contract: undefined }), SELF)).toBeUndefined();
    // Same version, no fingerprint — consistent with simply being this build.
    expect(describeSkew(page({ contract: undefined }), SELF)).toBeUndefined();
  });
});

describe('the daemon pair', () => {
  it('explains that a daemon keeps serving its own code until restarted', () => {
    const msg =
      describeSkew(
        {
          what: 'the daemon on this port',
          version: '2.3.0',
          contract: 'cccc3333',
          // The daemon (2.3.0) is behind this process (2.4.1), so restarting it converges.
          fix: daemonFix('2.3.0', SELF.version),
        },
        SELF,
      ) ?? '';
    expect(msg).toContain('2.3.0');
    expect(msg).toMatch(/reticle stop/);
  });
});

/**
 * The acceptance criterion from #127, pinned.
 *
 * > a test that boots an SDK one minor behind and asserts the user sees **one actionable sentence
 * > naming both versions** — not a `-32000`.
 *
 * The behaviour is already right. What was missing is anything holding it there: the delivery test
 * beside this one asserts the SDK version reaches the agent and never checks that the DAEMON's does.
 * "Your SDK is 2.4.0" is half an answer — it does not say which direction the skew runs or how far,
 * which is the part that decides whether you upgrade the app or the CLI.
 *
 * A characterisation test, not a fix. Its worth is that it fails if a future reword drops one of the
 * two numbers, which is the cheapest way for this to regress and the hardest to notice: the sentence
 * would still read fluently.
 */
describe('Playwright closed-target wording under skew (#688)', () => {
  const SKEW =
    'version skew: the page is 2.2.1; this daemon is 2.4.1, and they speak DIFFERENT wire contracts. Tell the human to install the matching SDK.';

  it('recognises the closed-page class Playwright puts on CDP tools', () => {
    expect(
      isPlaywrightClosedError(
        new Error('page.screenshot: Target page, context or browser has been closed'),
      ),
    ).toBe(true);
    expect(
      isPlaywrightClosedError(new Error('page.setViewportSize: Target page has been closed')),
    ).toBe(true);
    expect(isPlaywrightClosedError(new Error('no browser session connected'))).toBe(false);
  });

  it('rewrites that class to the session skew sentence, and leaves other throws alone', () => {
    const closed = new Error('page.screenshot: Target page, context or browser has been closed');
    expect(rewriteClosedAsSkew(closed, SKEW)?.message).toBe(SKEW);
    expect(rewriteClosedAsSkew(closed, undefined)).toBeUndefined();
    expect(rewriteClosedAsSkew(new Error('no browser session connected'), SKEW)).toBeUndefined();
  });
});

describe('a skew sentence names BOTH versions, not just the peer', () => {
  const SELF = { version: '2.5.0', contract: 'abc123' };

  it('a minor behind, with a foreign contract', () => {
    const message = describeSkew(
      { what: 'the page', version: '2.4.0', contract: 'deadbeef', fix: 'run reticle update' },
      SELF,
    );
    expect(message).toContain('2.4.0');
    expect(message, "the daemon's own version is the half that says which way to move").toContain(
      '2.5.0',
    );
  });

  it('a minor behind on an SDK too old to report a contract at all', () => {
    // The -32000 case from the report: no contract to compare, so the versions are all there is.
    // `contract: undefined` explicitly — the field is required and "predates it" is the case here.
    const message = describeSkew(
      { what: 'the page', version: '2.4.0', contract: undefined, fix: 'run reticle update' },
      SELF,
    );
    expect(message).toContain('2.4.0');
    expect(message).toContain('2.5.0');
  });

  it('and it is one sentence a human can act on, not a dump', () => {
    const message = describeSkew(
      { what: 'the page', version: '2.4.0', contract: 'deadbeef', fix: 'run reticle update' },
      SELF,
    );
    expect(message).toContain('run reticle update');
    expect(message, 'a version-skew warning must not itself be a wall of JSON').not.toContain('{');
  });
});
