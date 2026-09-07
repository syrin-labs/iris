/**
 * A licence key a customer actually placed must be a key we actually find.
 *
 * The daemon folded in `<cwd>/.env` and nothing else, and it is spawned without an explicit `cwd`,
 * so it inherits whatever directory the editor launched the MCP server from. In a monorepo that is
 * the workspace root while the key sits in the app's own `.env`; under some editors it is the user's
 * home. Either way the key was never read, `describeLicense` reported `missing`, and every event for
 * that customer said they had no licence — indistinguishable from a customer who has none.
 *
 * An enterprise key that silently fails to register is worse than one that fails loudly: the
 * customer believes they are licensed, we believe they are not, and neither side finds out.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LICENSE_KEY_ENV } from './license.js';
import { licenseKeyFromEnvFiles } from './license-env.js';

const KEY = 'rtl_test_key_value';

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'reticle-licenv-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'apps', 'web'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root' }));
  return root;
}

describe('finding a licence key the customer placed in a .env', () => {
  it('reads it from the directory the daemon happens to stand in', () => {
    const root = repo();
    writeFileSync(join(root, '.env'), `${LICENSE_KEY_ENV}=${KEY}\n`);
    expect(licenseKeyFromEnvFiles(root)).toBe(KEY);
  });

  // The monorepo case, and the one the field hits: the daemon starts at the workspace root, the
  // key is in the app that is actually licensed.
  it('finds it in an app subdirectory when the daemon starts at the repo root', () => {
    const root = repo();
    writeFileSync(join(root, 'apps', 'web', '.env'), `${LICENSE_KEY_ENV}=${KEY}\n`);
    expect(licenseKeyFromEnvFiles(root)).toBe(KEY);
  });

  // The inverse, and just as common: the editor launches the MCP server inside the app.
  it('walks UP to the repo root when the daemon starts inside the app', () => {
    const root = repo();
    writeFileSync(join(root, '.env'), `${LICENSE_KEY_ENV}=${KEY}\n`);
    expect(licenseKeyFromEnvFiles(join(root, 'apps', 'web'))).toBe(KEY);
  });

  // `.env.local` is where Vite and Next tell people to put secrets, so it is where a key goes.
  it('reads .env.local, which is where the frameworks tell people to put secrets', () => {
    const root = repo();
    writeFileSync(join(root, '.env.local'), `${LICENSE_KEY_ENV}=${KEY}\n`);
    expect(licenseKeyFromEnvFiles(root)).toBe(KEY);
  });

  it('handles quotes and surrounding whitespace, because people paste keys', () => {
    const root = repo();
    writeFileSync(join(root, '.env'), `\n# licence\n  ${LICENSE_KEY_ENV} = "${KEY}"  \n`);
    expect(licenseKeyFromEnvFiles(root)).toBe(KEY);
  });

  it('returns undefined when there is genuinely no key', () => {
    const root = repo();
    writeFileSync(join(root, '.env'), 'SOMETHING_ELSE=1\n');
    expect(licenseKeyFromEnvFiles(root)).toBeUndefined();
  });

  /**
   * The blast-radius guard. Walking parent directories to bulk-import a stranger's `.env` would be a
   * far worse bug than the one being fixed: a parent `.env` could rebind the daemon's port, its
   * telemetry gate, or its allowed origins, none of which the caller asked for. Only the licence key
   * is ever taken out of a file found by walking.
   */
  it('takes ONLY the licence key out of the files it walks', () => {
    const root = repo();
    writeFileSync(join(root, '.env'), `RETICLE_PORT=9999\n${LICENSE_KEY_ENV}=${KEY}\n`);
    const env: NodeJS.ProcessEnv = {};
    licenseKeyFromEnvFiles(root, env);
    expect(env['RETICLE_PORT']).toBeUndefined();
  });

  // A key already in the real environment is the operator's explicit choice and outranks a file.
  it('never overrides a key already set in the environment', () => {
    const root = repo();
    writeFileSync(join(root, '.env'), `${LICENSE_KEY_ENV}=from-file\n`);
    expect(licenseKeyFromEnvFiles(root, { [LICENSE_KEY_ENV]: 'from-shell' })).toBe('from-shell');
  });

  it('never throws, whatever it finds', () => {
    expect(() => licenseKeyFromEnvFiles('/nonexistent/path/xyz')).not.toThrow();
  });
});

/**
 * The key resolved from the SESSION's project directory, not the daemon's cwd.
 *
 * The daemon inherits the editor's cwd, which is frequently neither the repo root nor the app. The
 * directories that actually matter are the ones holding a `.reticle.json`, because those are the
 * apps that were instrumented and therefore the apps a licence covers. `discoverProjectConfigs` is
 * the same discovery the no-session diagnosis already uses to tell an agent where the app really is;
 * reusing it means the licence search and the diagnosis can never disagree about where the project
 * lives.
 *
 * This replaces an earlier guess at `apps/*` and `packages/*`, which missed the real repo shape that
 * `findWorkspaceApps` exists to handle: three Next apps at `web/`, `admin/` and `space/`.
 */
describe('resolving from the instrumented project rather than the daemon cwd', () => {
  it('finds a key beside a .reticle.json in a directory the daemon never stood in', () => {
    const root = repo();
    // A DECLARED workspace, because that is what a real monorepo has and it is the only shape
    // `discoverProjectConfigs` descends into. The undeclared `apps/*` layout is covered separately.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
    );
    writeFileSync(join(root, 'apps', 'web', '.reticle.json'), JSON.stringify({ projectId: 'p1' }));
    writeFileSync(join(root, 'apps', 'web', '.env'), `${LICENSE_KEY_ENV}=${KEY}\n`);
    expect(licenseKeyFromEnvFiles(root)).toBe(KEY);
  });

  it('finds it in a declared workspace that is not apps/ or packages/', () => {
    const root = repo();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['services/*'] }),
    );
    for (const name of ['admin', 'space']) {
      mkdirSync(join(root, 'services', name), { recursive: true });
      writeFileSync(
        join(root, 'services', name, '.reticle.json'),
        JSON.stringify({ projectId: name }),
      );
    }
    writeFileSync(join(root, 'services', 'space', '.env.local'), `${LICENSE_KEY_ENV}=${KEY}\n`);
    expect(licenseKeyFromEnvFiles(root)).toBe(KEY);
  });

  // The guard still holds on the widened search: a `.env` reached this way may still only ever
  // yield the licence key, never the rest of its contents.
  it('still takes ONLY the licence key from a project directory it discovered', () => {
    const root = repo();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['services/*'] }),
    );
    mkdirSync(join(root, 'services', 'web'), { recursive: true });
    writeFileSync(
      join(root, 'services', 'web', '.reticle.json'),
      JSON.stringify({ projectId: 'p1' }),
    );
    writeFileSync(
      join(root, 'services', 'web', '.env'),
      `RETICLE_PORT=9999\n${LICENSE_KEY_ENV}=${KEY}\n`,
    );
    const env: NodeJS.ProcessEnv = {};
    expect(licenseKeyFromEnvFiles(root, env)).toBe(KEY);
    expect(env['RETICLE_PORT']).toBeUndefined();
  });
});
