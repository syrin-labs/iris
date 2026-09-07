/**
 * A leased browser must survive being navigated.
 */
import { describe, expect, it } from 'vitest';
import { carryReticleIdentity } from './lease-tools.js';

const SESSION = 'lease-8f1cde21';

describe('carryReticleIdentity', () => {
  it('carries the lease marker onto the destination, so the lease is not orphaned', () => {
    const out = carryReticleIdentity(
      `http://app.test/login?__reticle_session=${SESSION}`,
      'http://app.test/issues?category=severe',
    );
    expect(new URL(out).searchParams.get('__reticle_session')).toBe(SESSION);
    // The caller's own query survives — the marker is added, never substituted.
    expect(new URL(out).searchParams.get('category')).toBe('severe');
  });

  it('carries the project too, so a stamped tab stays attributed', () => {
    const out = carryReticleIdentity(
      `http://app.test/?__reticle_session=${SESSION}&__reticle_project=proj_1`,
      'http://app.test/settings',
    );
    expect(new URL(out).searchParams.get('__reticle_project')).toBe('proj_1');
  });

  it("leaves a human's own tab completely alone", () => {
    const to = 'http://app.test/issues';
    expect(carryReticleIdentity('http://app.test/login', to)).toBe(to);
    expect(carryReticleIdentity(undefined, to)).toBe(to);
  });

  it('does not double-stamp a destination that already claims an identity', () => {
    const to = `http://app.test/x?__reticle_session=${SESSION}`;
    expect(carryReticleIdentity(`http://app.test/?__reticle_session=other`, to)).toBe(to);
  });

  it('survives a source URL that is not parseable at all', () => {
    const to = 'http://app.test/issues';
    expect(carryReticleIdentity('not a url', to)).toBe(to);
  });
});
