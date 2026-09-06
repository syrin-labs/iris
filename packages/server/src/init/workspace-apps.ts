import type { InitIo } from './run.js';
import { DEV_SCRIPT_NAMES } from './dev-script.js';

/**
 * The file names that say what a directory IS, shared by everything that has to ask.
 *
 * They lived in run.ts and are read from here now because `findWorkspaceApps` moved and needs them —
 * one definition, imported in both directions of the question ("is this an app?" and "which app?").
 */

export const PACKAGE_JSON = 'package.json';
const PNPM_WORKSPACE = 'pnpm-workspace.yaml';
export const VITE_CONFIG_CANDIDATES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.mts',
];
export const NEXT_CONFIG_CANDIDATES = [
  'next.config.mjs',
  'next.config.js',
  'next.config.ts',
  'next.config.cjs',
];
/**
 * Which directories to look in for the app, when `reticle init` runs at a monorepo root.
 *
 * This used to be the literal list `['apps', 'packages']`. Measured on a real repo with three Next
 * apps at `web/`, `admin/` and `space/`, it found none — so the redirect never fired, init ran
 * against the root, and it reported ✓ for writing `app/reticle-dev.tsx` into a directory Next never
 * compiles. A ⚠ tells a human to act; a ✓ tells them it is handled.
 *
 * A workspace DECLARES its packages, so that declaration is used first and directory names are not
 * guessed at all. Where nothing is declared, every top-level directory is a better candidate than two
 * hardcoded ones — filtered by the usual non-source suspects, and still subject to the `looksLikeApp`
 * check that follows, so a wrong guess here costs a `package.json` read.
 */

/** Directories that are never a workspace package, whatever the layout. */
const NEVER_A_PACKAGE = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target']);

interface WorkspaceSources {
  /** Raw contents of pnpm-workspace.yaml, when present. */
  pnpmWorkspace?: string;
  /** The `workspaces` field of package.json — array form or the yarn/npm object form. */
  pkgWorkspaces?: unknown;
  /** Directory names at the repo root, used when nothing is declared. */
  topLevelDirs?: readonly string[];
}

/** `packages/*` -> `packages`; `web` -> `web`. The base directory a glob searches. */
function globBase(pattern: string): string | undefined {
  const base = pattern
    .split('/')[0]
    ?.trim()
    .replace(/^['"]|['"]$/g, '');
  return base === undefined || '' === base || '.' === base || base.includes('*') ? undefined : base;
}

function fromPnpm(yaml: string): string[] {
  // A deliberately small reader rather than a YAML dependency: this file is a list of globs, and the
  // only shape that matters is `- 'pattern'` under `packages:`. A malformed file yields nothing,
  // which falls through to the top-level scan rather than failing the install.
  const out: string[] = [];
  let inPackages = false;
  for (const line of yaml.split('\n')) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;
    const item = /^\s*-\s*(.+)$/.exec(line);
    if (inPackages && item?.[1] !== undefined) {
      const base = globBase(item[1]);
      if (base !== undefined) out.push(base);
    }
  }
  return out;
}

function fromPkg(workspaces: unknown): string[] {
  const list = Array.isArray(workspaces)
    ? workspaces
    : 'object' === typeof workspaces && workspaces !== null
      ? (workspaces as { packages?: unknown }).packages
      : undefined;
  if (!Array.isArray(list)) return [];
  return list
    .filter((p): p is string => 'string' === typeof p)
    .map(globBase)
    .filter((p): p is string => p !== undefined);
}

export function workspaceParents(sources: WorkspaceSources): string[] {
  const declared = [
    ...(sources.pnpmWorkspace === undefined ? [] : fromPnpm(sources.pnpmWorkspace)),
    ...fromPkg(sources.pkgWorkspaces),
  ];
  const candidates =
    declared.length > 0
      ? declared
      : (sources.topLevelDirs ?? []).filter((d) => !d.startsWith('.') && !NEVER_A_PACKAGE.has(d));
  return [...new Set(candidates)];
}

/**
 * Which directories under this workspace are runnable apps.
 *
 * Moved here from run.ts, which was over the 1000-line cap and had carried a note saying it was at
 * its cohesion limit. `library-path-boundary.test.ts` had already written down that this function
 * "squats in init/ for historical reasons" — it is a general-purpose question about a repository's
 * shape, next to `workspaceParents`, which answers the other half of it.
 */
/** Deps that mark a directory as a runnable web app even when it has no bundler config file. */
const APP_DEPS = ['next', 'vite'] as const;

function hasDevScript(pkgRaw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(pkgRaw);
    const scripts =
      'object' === typeof parsed && parsed !== null
        ? (parsed as { scripts?: unknown }).scripts
        : undefined;
    if ('object' !== typeof scripts || null === scripts) return false;
    const named = scripts as Record<string, unknown>;
    return DEV_SCRIPT_NAMES.some((n) => 'string' === typeof named[n] && '' !== named[n]);
  } catch {
    // A manifest that will not parse says nothing either way, and this is a filter, not a verdict.
    return false;
  }
}

function looksLikeApp(dir: string, io: Pick<InitIo, 'exists' | 'readFile'>): boolean {
  const pkgRaw = io.readFile(`${dir}/${PACKAGE_JSON}`);
  if (null === pkgRaw) return false;
  const configs = [...VITE_CONFIG_CANDIDATES, ...NEXT_CONFIG_CANDIDATES];
  if (configs.some((c) => io.exists(`${dir}/${c}`))) return true;
  // `next.config` is optional in Next, so the dependency list is the other half of the signal.
  if (APP_DEPS.some((d) => pkgRaw.includes(`"${d}"`))) return true;
  // And the honest third: an app somebody can SERVE. Asking only for a bundler missed every app
  // built on anything else — Remix, Astro, a plain node server — and in a monorepo missing it means
  // init never redirects, wires the ROOT, and reports ✓ for files nothing compiles.
  //
  // A monorepo root has no dev script by design, and a package that can only be BUILT is not the app
  // somebody is working in, so this stays a filter rather than matching every directory.
  return hasDevScript(pkgRaw);
}

/**
 * App directories under a workspace root.
 *
 * Running `reticle init` at the repo root is what people actually do, and in a monorepo the app is a
 * directory down — so init detected "no framework", printed a wall of manual HTML instructions, and
 * would have installed the SDK into the ROOT package.json. It already walks UP for the lockfile, so
 * it knows it is in a workspace; this is the matching walk DOWN.
 */
export function findWorkspaceApps(io: Pick<InitIo, 'exists' | 'readFile' | 'listDirs'>): string[] {
  const found: string[] = [];
  // A workspace DECLARES its packages; `['apps','packages']` was a guess that missed a real repo
  // with three Next apps at web/, admin/ and space/ — and missing them meant init ran against the
  // root and reported ✓ for a file Next never compiles. See workspace-apps.
  const pkgRaw = io.readFile(PACKAGE_JSON);
  let pkgWorkspaces: unknown;
  try {
    const parsed: unknown = null === pkgRaw ? undefined : JSON.parse(pkgRaw);
    pkgWorkspaces =
      'object' === typeof parsed && parsed !== null
        ? (parsed as { workspaces?: unknown }).workspaces
        : undefined;
  } catch {
    pkgWorkspaces = undefined;
  }
  const parents = workspaceParents({
    ...(null === io.readFile(PNPM_WORKSPACE)
      ? {}
      : { pnpmWorkspace: io.readFile(PNPM_WORKSPACE) ?? '' }),
    ...(pkgWorkspaces === undefined ? {} : { pkgWorkspaces }),
    topLevelDirs: io.listDirs('.'),
  });
  // A declared parent can itself BE the app (`workspaces: ["web"]`), so check both the directory and
  // its children rather than assuming one level of nesting.
  for (const parent of parents) {
    if (looksLikeApp(parent, io)) found.push(parent);
    for (const name of io.listDirs(parent)) {
      const dir = `${parent}/${name}`;
      if (looksLikeApp(dir, io)) found.push(dir);
    }
  }
  return [...new Set(found)];
}
