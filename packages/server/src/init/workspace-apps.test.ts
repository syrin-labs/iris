/**
 * A monorepo whose apps are NOT under `apps/` was invisible, and init reported success anyway.
 *
 * Measured on a real repo: three Next apps at `web/`, `admin/`, `space/`, each with next.config.js
 * and app/layout.tsx, nothing at the root. `findWorkspaceApps` only ever looked in `apps/` and
 * `packages/`, so it found none, the redirect did not fire, and init ran against the ROOT — warning
 * about a `next.config.mjs` that exists nowhere and reporting ✓ for writing `app/reticle-dev.tsx`
 * into the repo root, which Next never compiles.
 *
 * A ⚠ tells a human to act. A ✓ tells them it is handled. This produced the second for a file that
 * does nothing.
 *
 * The fix is to stop guessing directory names. A workspace DECLARES its packages — `workspaces` in
 * package.json, `packages:` in pnpm-workspace.yaml — and that declaration is authoritative. Where
 * there is none, the top-level directories are a better guess than two hardcoded names.
 */

import { describe, expect, it } from 'vitest';
import { findWorkspaceApps, workspaceParents } from './workspace-apps.js';

describe('where a workspace keeps its packages', () => {
  it('reads pnpm-workspace.yaml, which is the authoritative answer', () => {
    const yaml = "packages:\n  - 'web'\n  - 'admin'\n  - 'tools/*'\n";
    expect(workspaceParents({ pnpmWorkspace: yaml })).toEqual(
      expect.arrayContaining(['web', 'admin', 'tools']),
    );
  });

  it('reads the package.json `workspaces` array', () => {
    expect(workspaceParents({ pkgWorkspaces: ['packages/*', 'web'] })).toEqual(
      expect.arrayContaining(['packages', 'web']),
    );
  });

  it('reads the yarn/npm object form too', () => {
    expect(workspaceParents({ pkgWorkspaces: { packages: ['apps/*'] } })).toContain('apps');
  });

  it('falls back to the top-level directories when nothing is declared', () => {
    // Three Next apps at the root with no workspace file is a real shape, and hardcoding
    // apps/packages misses every one of them.
    expect(
      workspaceParents({ topLevelDirs: ['web', 'admin', 'space', 'node_modules', '.git'] }),
    ).toEqual(expect.arrayContaining(['web', 'admin', 'space']));
  });

  it('never scans node_modules, dot-directories, or build output', () => {
    const parents = workspaceParents({
      topLevelDirs: ['node_modules', '.git', '.next', 'dist', 'build', 'coverage', 'web'],
    });
    expect(parents).toEqual(['web']);
  });

  it('survives a malformed workspace file rather than throwing', () => {
    expect(() => workspaceParents({ pnpmWorkspace: 'packages: [unclosed' })).not.toThrow();
    expect(() => workspaceParents({ pkgWorkspaces: 42 })).not.toThrow();
  });

  it('deduplicates, so a directory named in both places is scanned once', () => {
    const parents = workspaceParents({
      pkgWorkspaces: ['apps/*'],
      topLevelDirs: ['apps', 'web'],
    });
    expect(parents.filter((p) => 'apps' === p)).toHaveLength(1);
  });
});

/**
 * A workspace app is one somebody can SERVE.
 *
 * `looksLikeApp` asked only for a bundler: a vite/next config file, or one of those two in the
 * dependencies. That misses every app built on anything else — Remix, Astro, a plain node server,
 * a Rails-style app with a JS front end — and in a monorepo missing it means init never redirects,
 * wires the ROOT, and reports ✓ for files nothing compiles.
 *
 * The honest signal is the one setup/reticle.mjs used: the app somebody is working in is the app
 * with a dev script. A monorepo root has none by design, which is what keeps this from matching
 * everything.
 */
describe('an app is a directory that can be served', () => {
  const repo = (files: Record<string, string>) => ({
    exists: (p: string) => p in files,
    readFile: (p: string) => files[p] ?? null,
    listDirs: (p: string) => ('apps' === p ? ['docs', 'web'] : []),
  });

  it('finds an app whose only signal is a dev script', () => {
    const apps = findWorkspaceApps(
      repo({
        'package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
        // NOT `dev: 'vite'` — the dependency check is a substring match on the raw manifest, so that
        // string would make this pass without the dev-script signal existing at all.
        'apps/web/package.json': JSON.stringify({
          name: 'web',
          scripts: { dev: 'node server.js' },
        }),
      }),
    );
    expect(apps).toEqual(['apps/web']);
  });

  // The whole point of the filter: a package that cannot be served is not the app.
  it('skips a workspace package with only a build script', () => {
    const apps = findWorkspaceApps(
      repo({
        'package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
        'apps/docs/package.json': JSON.stringify({ name: 'docs', scripts: { build: 'true' } }),
        'apps/web/package.json': JSON.stringify({
          name: 'web',
          scripts: { dev: 'node server.js' },
        }),
      }),
    );
    expect(apps).toEqual(['apps/web']);
  });

  it('accepts start and serve as well as dev', () => {
    for (const script of ['start', 'serve'] as const) {
      const apps = findWorkspaceApps(
        repo({
          'package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
          'apps/web/package.json': JSON.stringify({ name: 'web', scripts: { [script]: 'node .' } }),
        }),
      );
      expect(apps).toEqual(['apps/web']);
    }
  });

  // Unchanged: a bundler config is still enough on its own, for an app whose scripts are elsewhere.
  it('still finds one by its bundler config alone', () => {
    const apps = findWorkspaceApps(
      repo({
        'package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
        'apps/web/package.json': JSON.stringify({ name: 'web' }),
        'apps/web/vite.config.ts': 'x',
      }),
    );
    expect(apps).toEqual(['apps/web']);
  });
});
