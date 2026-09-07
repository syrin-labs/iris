import { describe, expect, it } from 'vitest';
import { astroManual } from './snippets.js';
import { bridgeWsUrl } from '@reticlehq/core';
import { craEnvPatch, craDevModuleFile, TOKEN_VAR, URL_VAR } from './cra.js';

/**
 * A daemon URL written once at install time is a fact about the day someone ran `init`. Every stack
 * needs a way to learn the current one, and they do not all have the same way.
 *
 * Vite and Next re-resolve it on every dev-server start through a build hook of ours. Astro owns its
 * Vite instance, so its generated config can do the same. CRA has no hook at all — no plugin, no
 * config wrapper, no `define` — so its URL travels through the env file `init` already writes, and
 * `init` is the heal rather than the dev server. That last one is weaker, and is asserted as what it
 * is rather than dressed up.
 */
describe('Astro re-resolves the daemon on every dev-server start', () => {
  const generated = astroManual(4460, 'shop-abc123', 'src/layouts/Layout.astro');

  it('generates a discovery helper rather than trusting the install-time port', () => {
    expect(generated).toContain('function reticleUrl()');
    expect(generated).toContain('__RETICLE_URL__: JSON.stringify(reticleUrl())');
  });

  it('matches on projectId, so it cannot adopt another project’s daemon', () => {
    expect(generated).toContain("entry.projectId !== 'shop-abc123'");
  });

  it('skips dead daemons, so a stale registry entry is not connected to', () => {
    expect(generated).toContain('process.kill(entry.pid, 0)');
  });

  it('lets the discovered URL beat the one written at install time', () => {
    const baked = generated.indexOf("url: 'ws://localhost:4460/reticle'");
    const discovered = generated.indexOf('...(url.length > 0 ? { url } : {})');
    expect(baked).toBeGreaterThan(-1);
    expect(discovered).toBeGreaterThan(baked); // later key wins
  });

  /** Nothing to match on means any daemon is a guess, and a wrong one reports another app's state. */
  it('omits discovery entirely when there is no projectId', () => {
    expect(astroManual(4460, undefined)).not.toContain('reticleUrl');
  });

  it('imports readdirSync, without which the generated config throws on boot', () => {
    expect(generated).toContain("import { readFileSync, readdirSync } from 'node:fs';");
  });
});

describe('CRA carries the daemon URL through the channel it has', () => {
  it('writes the URL beside the token', () => {
    const out = craEnvPatch(null, 'tok123', 'ws://localhost:4788/reticle');
    expect(out).toContain(`${TOKEN_VAR}=tok123`);
    expect(out).toContain(`${URL_VAR}=ws://localhost:4788/reticle`);
  });

  /** Two assignments of one variable is a coin flip on which wins — for the URL, on which daemon. */
  it('replaces a stale URL rather than appending a second one', () => {
    const out = craEnvPatch(
      `${TOKEN_VAR}=tok123\n${URL_VAR}=ws://localhost:4400/reticle\n`,
      'tok123',
      'ws://localhost:4788/reticle',
    );
    expect(out).toContain('ws://localhost:4788/reticle');
    expect(out).not.toContain('ws://localhost:4400/reticle');
    expect(out?.match(new RegExp(`^${URL_VAR}=`, 'gm'))).toHaveLength(1);
  });

  it('reports no change when both values are already current', () => {
    const current = `${TOKEN_VAR}=tok123\n${URL_VAR}=ws://localhost:4788/reticle\n`;
    expect(craEnvPatch(current, 'tok123', 'ws://localhost:4788/reticle')).toBeNull();
  });

  it('still works when no URL is supplied, so the token path is unchanged', () => {
    expect(craEnvPatch(null, 'tok123', undefined)).toBe(`${TOKEN_VAR}=tok123\n`);
  });

  it('has the module prefer the env URL over the port baked into it', () => {
    const mod = craDevModuleFile(4400, 'shop-abc123');
    const baked = mod.indexOf(`url: '${bridgeWsUrl(4400)}'`);
    const fromEnv = mod.indexOf('...(url.length > 0 ? { url } : {})');
    expect(baked).toBeGreaterThan(-1);
    expect(fromEnv).toBeGreaterThan(baked);
    expect(mod).toContain(`process.env.${URL_VAR}`);
  });
});
