/**
 * The project-aware SDK remedy for version skew (#618).
 *
 * `sdkFix` in version-skew.ts is the no-project fallback: it names `@reticlehq/browser` and npm,
 * because those answers are never actively wrong. When a project directory IS in hand, name the
 * packages actually in package.json and the manager the lockfile implies.
 *
 * Does not import `init/`. The library path must never reach the installer
 * (`library-path-boundary.test.ts`); `reticleDepsOf` lives in `update/` for that reason, and the
 * lockfile → manager map is the same evidence `detectPackageManager` reads, kept here so a HELLO
 * does not load the install plan.
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { reticleDepsOf } from '../update/reticle-deps.js';

/** What a project contributes to the remedy, when we were able to read one. */
interface SdkFixContext {
  /** `@reticlehq/*` packages declared in package.json. Empty / omitted means none yet. */
  packages?: readonly string[];
  packageManager: PackageManagerName;
}

/** Lockfile / marker → manager, same evidence `init/detect.ts` uses. */
export const PackageManagerName = {
  PNPM: 'pnpm',
  YARN: 'yarn',
  BUN: 'bun',
  NPM: 'npm',
} as const;
export type PackageManagerName = (typeof PackageManagerName)[keyof typeof PackageManagerName];

/** Same package a Vue/Nuxt install gets — never the React kit. */
const FRAMEWORK_NEUTRAL_SDK = '@reticlehq/browser';
const PACKAGE_JSON = 'package.json';
const NODE_MODULES = 'node_modules';
const LOCKFILE_NAMES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'] as const;

/** Markers each manager leaves inside `node_modules` — stronger than an uncommitted lockfile. */
const NODE_MODULES_MARKERS: readonly (readonly [string, PackageManagerName])[] = [
  ['.modules.yaml', PackageManagerName.PNPM],
  ['.yarn-state.yml', PackageManagerName.YARN],
  ['.package-lock.json', PackageManagerName.NPM],
];

const INSTALL_FLAGS: Record<PackageManagerName, readonly string[]> = {
  [PackageManagerName.PNPM]: ['add', '-D'],
  [PackageManagerName.YARN]: ['add', '-D'],
  [PackageManagerName.BUN]: ['add', '-d'],
  [PackageManagerName.NPM]: ['i', '-D'],
};

function packagesFor(ctx: Partial<SdkFixContext> | undefined): readonly string[] {
  if (ctx?.packages !== undefined && 0 !== ctx.packages.length) return ctx.packages;
  return [FRAMEWORK_NEUTRAL_SDK];
}

function managerOf(
  lockfiles: ReadonlySet<string>,
  nodeModulesMarkers: ReadonlySet<string>,
): PackageManagerName {
  if (lockfiles.has('pnpm-lock.yaml')) return PackageManagerName.PNPM;
  if (lockfiles.has('yarn.lock')) return PackageManagerName.YARN;
  if (lockfiles.has('bun.lockb') || lockfiles.has('bun.lock')) return PackageManagerName.BUN;
  for (const [name, pm] of NODE_MODULES_MARKERS) {
    if (nodeModulesMarkers.has(name)) return pm;
  }
  return PackageManagerName.NPM;
}

function installLine(pm: PackageManagerName, pkgs: readonly string[]): string {
  return `${pm} ${[...INSTALL_FLAGS[pm], ...pkgs].join(' ')}`;
}

function restartClause(): string {
  return (
    'or run `reticle update`, then restart their dev server so the page reloads with it. The ' +
    'restart is not optional: a bundler keeps serving the pre-bundled copy it already has, so an ' +
    'upgrade can look applied — matching versions in `npm ls` — while the page runs the old module.'
  );
}

/**
 * The one sentence telling the human how to bring the page's SDK in line with this daemon.
 *
 * No context → the framework-neutral sensor and npm, never the React kit. Packages from
 * package.json win when present. When the project has none of ours yet, the sensor is named
 * rather than `@reticlehq/react` — that is the Vue/Nuxt failure.
 */
export function resolveSdkFix(daemonVersion: string, ctx?: Partial<SdkFixContext>): string {
  const pm = ctx?.packageManager ?? PackageManagerName.NPM;
  const pinned = packagesFor(ctx).map((name) => `${name}@${daemonVersion}`);
  return `Tell the human to install the matching SDK (\`${installLine(pm, pinned)}\`) ${restartClause()}`;
}

/**
 * Read the context `resolveSdkFix` needs off a parsed manifest and the lockfiles/markers present.
 *
 * Undefined when there is no manifest to interpret — the caller then uses the no-project fallback.
 * Pure: no filesystem.
 */
export function sdkFixContextOf(
  pkgJson: unknown,
  lockfiles: ReadonlySet<string>,
  nodeModulesMarkers: ReadonlySet<string> = new Set(),
): SdkFixContext | undefined {
  if ('object' !== typeof pkgJson || null === pkgJson) return undefined;
  return {
    packages: reticleDepsOf(pkgJson),
    packageManager: managerOf(lockfiles, nodeModulesMarkers),
  };
}

/** Reads a file, or undefined if it is not there / not readable. */
function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function present(
  directory: string,
  names: readonly string[],
  read: (path: string) => string | undefined,
  extra = '',
): Set<string> {
  const found = new Set<string>();
  for (const name of names) {
    if (read(join(directory, extra, name)) !== undefined) found.add(name);
  }
  return found;
}

/**
 * The remedy for the project in `directory`, or the no-project fallback when it cannot be read.
 *
 * `read` is injected so the decision is testable without a filesystem; the daemon uses the default.
 */
export function sdkFixForDirectory(
  daemonVersion: string,
  directory: string,
  read: (path: string) => string | undefined = readTextFile,
): string {
  const ctx = sdkFixContextOf(
    parseJson(read(join(directory, PACKAGE_JSON))),
    present(directory, LOCKFILE_NAMES, read),
    present(
      directory,
      NODE_MODULES_MARKERS.map(([name]) => name),
      read,
      NODE_MODULES,
    ),
  );
  return resolveSdkFix(daemonVersion, ctx);
}
