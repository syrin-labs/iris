/**
 * The version-skew remedies, which used to be two hardcoded strings (#618).
 *
 * `sdkFix` named `@reticlehq/react`, so a Nuxt/Vue project was told to install a React package it
 * must not have. `DAEMON_FIX` said `reticle stop` unconditionally, which cannot converge the pair
 * when the daemon is the newer half.
 */
import { describe, expect, it } from 'vitest';
import { daemonFix, sdkFix } from './version-skew.js';

describe('the daemon remedy branches on which half is behind', () => {
  it('asks for `reticle stop` when the daemon is the older half', () => {
    expect(daemonFix('2.3.0', '2.4.1')).not.toContain('will not converge');
    expect(daemonFix('2.3.0', '2.4.1')).toMatch(/Run `reticle stop`/);
  });

  it('does NOT ask for `reticle stop` when the daemon is newer — it cannot converge', () => {
    // The reported case: the MCP registration is unpinned and resolves fresh, so the agent's
    // server is routinely behind a long-lived daemon. Stopping it starts another newer daemon.
    const fix = daemonFix('2.5.0', '2.4.1');
    // It still NAMES `reticle stop` — to say it does not work here.
    expect(fix).toContain('will not converge');
    expect(fix).not.toMatch(/Run `reticle stop`/);
    expect(fix).toContain('restart the agent');
  });

  it('falls back to the restart-the-daemon advice when a version cannot be compared', () => {
    expect(daemonFix(undefined, '2.4.1')).toMatch(/Run `reticle stop`/);
    expect(daemonFix('2.4.1', undefined)).toMatch(/Run `reticle stop`/);
    expect(daemonFix('not-a-version', '2.4.1')).toMatch(/Run `reticle stop`/);
  });

  it('treats equal versions as no direction, so it does not invent the harder advice', () => {
    expect(daemonFix('2.4.1', '2.4.1')).toMatch(/Run `reticle stop`/);
  });

  it('compares numerically, not lexically', () => {
    // '2.10.0' < '2.9.0' as strings; the daemon here is genuinely newer.
    expect(daemonFix('2.10.0', '2.9.0')).toContain('will not converge');
  });
});

describe('the SDK remedy does not name a package the project must not have', () => {
  it('names the framework-neutral sensor, not the React kit', () => {
    // The remedy has no project context, so it must name the package that is never actively
    // wrong: @reticlehq/browser works in a React app, the reverse does not hold.
    const fix = sdkFix('2.4.1');
    expect(fix).not.toContain('@reticlehq/react');
    expect(fix).toContain('@reticlehq/browser@2.4.1');
  });

  it('says the dev server must restart, so a stale pre-bundle is not read as a fixed upgrade', () => {
    expect(sdkFix('2.4.1')).toContain('restart');
  });
});
