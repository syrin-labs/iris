/**
 * The project-aware half of #618.
 *
 * `sdkFix` with no project must never name `@reticlehq/react` — that is the Vue/Nuxt failure.
 * When a project IS in hand, name the packages actually in package.json and the manager the
 * lockfile implies.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PackageManagerName,
  resolveSdkFix,
  sdkFixContextOf,
  sdkFixForDirectory,
} from './sdk-fix.js';
import { sdkFix } from './version-skew.js';

const DAEMON = '2.4.1';

describe('resolveSdkFix — names what this project actually has', () => {
  it('does not name the React kit when there is no project to read', () => {
    const fix = resolveSdkFix(DAEMON);
    expect(fix).not.toContain('@reticlehq/react');
    expect(fix).toContain(`@reticlehq/browser@${DAEMON}`);
    expect(fix).toContain('npm i -D');
  });

  it('names the Vue/Nuxt sensor and pnpm when that is what the project has', () => {
    const fix = resolveSdkFix(DAEMON, {
      packages: ['@reticlehq/browser'],
      packageManager: PackageManagerName.PNPM,
    });
    expect(fix).not.toContain('@reticlehq/react');
    expect(fix).toContain(`pnpm add -D @reticlehq/browser@${DAEMON}`);
  });

  it('names the React kit and the Vite plugin when those are what package.json declares', () => {
    const fix = resolveSdkFix(DAEMON, {
      packages: ['@reticlehq/react', '@reticlehq/vite-plugin'],
      packageManager: PackageManagerName.NPM,
    });
    expect(fix).toContain(`@reticlehq/react@${DAEMON}`);
    expect(fix).toContain(`@reticlehq/vite-plugin@${DAEMON}`);
    expect(fix).toContain('npm i -D');
  });

  it('uses yarn add -D, not npm i -D, when the lockfile said yarn', () => {
    expect(
      resolveSdkFix(DAEMON, {
        packages: ['@reticlehq/browser'],
        packageManager: PackageManagerName.YARN,
      }),
    ).toContain(`yarn add -D @reticlehq/browser@${DAEMON}`);
  });

  it('names the framework-neutral sensor when package.json has none of ours yet', () => {
    // The reported Nuxt case: they were told to install React into a Vue app. An empty SDK
    // list is absence, not React — name the sensor the Vue/Nuxt install already uses.
    const fix = resolveSdkFix(DAEMON, {
      packageManager: PackageManagerName.PNPM,
    });
    expect(fix).not.toContain('@reticlehq/react');
    expect(fix).toContain(`pnpm add -D @reticlehq/browser@${DAEMON}`);
  });

  it('still says the dev server must restart, so a stale pre-bundle is not read as a fixed upgrade', () => {
    expect(resolveSdkFix(DAEMON)).toContain('restart');
    expect(sdkFix(DAEMON)).toBe(resolveSdkFix(DAEMON));
  });
});

describe('sdkFixContextOf — lockfile + declared packages, not a third detector', () => {
  it('reads the declared SDK packages and the lockfile manager', () => {
    const ctx = sdkFixContextOf(
      {
        dependencies: { vue: '^3.0.0' },
        devDependencies: { '@reticlehq/browser': '2.2.1' },
      },
      new Set(['pnpm-lock.yaml']),
    );
    expect(ctx).toEqual({
      packages: ['@reticlehq/browser'],
      packageManager: PackageManagerName.PNPM,
    });
  });

  it('sdkFixForDirectory names pnpm + the declared sensor from an injected tree', () => {
    const files: Record<string, string> = {
      [join('/app', 'package.json')]: JSON.stringify({
        dependencies: { vue: '^3.0.0' },
        devDependencies: { '@reticlehq/browser': '2.2.1' },
      }),
      [join('/app', 'pnpm-lock.yaml')]: '',
    };
    expect(sdkFixForDirectory(DAEMON, '/app', (p) => files[p])).toContain(
      `pnpm add -D @reticlehq/browser@${DAEMON}`,
    );
  });

  it('uses the node_modules marker when there is no lockfile', () => {
    const ctx = sdkFixContextOf(
      { devDependencies: { '@reticlehq/browser': '2.2.1' } },
      new Set(),
      new Set(['.modules.yaml']),
    );
    expect(ctx?.packageManager).toBe(PackageManagerName.PNPM);
  });

  it('an empty SDK list still will not name React — that is the Vue/Nuxt failure', () => {
    const ctx = sdkFixContextOf({ dependencies: { nuxt: '^3.0.0', vue: '^3.0.0' } }, new Set());
    expect(ctx).toEqual({
      packages: [],
      packageManager: PackageManagerName.NPM,
    });
    expect(resolveSdkFix(DAEMON, ctx)).not.toContain('@reticlehq/react');
    expect(resolveSdkFix(DAEMON, ctx)).toContain(`@reticlehq/browser@${DAEMON}`);
  });

  it('treats a missing or malformed manifest as no context', () => {
    expect(sdkFixContextOf(undefined, new Set())).toBeUndefined();
    expect(sdkFixContextOf(null, new Set())).toBeUndefined();
    expect(sdkFixContextOf('not a manifest', new Set())).toBeUndefined();
  });

  it('does not name the React kit for an empty manifest — that is absence, not React', () => {
    const ctx = sdkFixContextOf({}, new Set());
    expect(ctx?.packages).toEqual([]);
    expect(resolveSdkFix(DAEMON, ctx)).not.toContain('@reticlehq/react');
  });
});
