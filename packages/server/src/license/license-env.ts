/**
 * Find an enterprise licence key the customer actually placed, wherever they reasonably placed it.
 *
 * The daemon folded in `<cwd>/.env` and nothing else. It is spawned without an explicit `cwd`, so it
 * inherits whatever directory the editor launched the MCP server from — in a monorepo that is the
 * workspace root while the key sits in the app's own `.env`, and under some editors it is the user's
 * home. The key was never read, `describeLicense` reported `missing`, and every event that customer
 * produced said they had no licence, which is indistinguishable from a customer who has none.
 *
 * That is the worst shape a licensing bug can take. A key that fails LOUDLY gets reported by the
 * customer within the hour. A key that silently fails to register leaves them believing they are
 * licensed and us believing they are not, and neither side finds out.
 *
 * Two directions, because the field hits both: DOWN one level into app directories (the daemon
 * starts at the workspace root) and UP to the project root (the editor starts inside the app).
 *
 * ONLY the licence key is ever taken out of a file found this way, and that restriction is the point
 * rather than an optimisation. Bulk-importing a `.env` discovered by walking would let a directory
 * the caller never named rebind the daemon's port, its telemetry gate or its allowed origins — a far
 * worse bug than the one this fixes. `loadDotEnv` still owns the local file, where importing
 * everything is what the caller asked for.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LICENSE_KEY_ENV } from './license.js';
import { discoverProjectConfigs } from '../cli/config-discovery.js';

/** The files a framework tells people to put secrets in, most specific first. */
const ENV_FILES = ['.env.local', '.env'] as const;
/** Stop the upward walk here: a licence belongs to a project, not to a machine. */
const ROOT_MARKERS = ['.git', 'package.json', 'pnpm-workspace.yaml'] as const;
/** A bound on the upward walk, so a pathological path cannot spin. */
const MAX_DEPTH = 12;

function readKey(file: string): string | undefined {
  try {
    if (!existsSync(file)) return undefined;
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (0 === line.length || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      if (line.slice(0, eq).trim() !== LICENSE_KEY_ENV) continue;
      const value = line.slice(eq + 1).trim();
      const first = value[0];
      const unquoted =
        ('"' === first || "'" === first) && value.endsWith(first) && value.length >= 2
          ? value.slice(1, -1)
          : value;
      if (unquoted.length > 0) return unquoted;
    }
  } catch {
    // A licence probe may never take the daemon down, and an unreadable file is not an error here.
  }
  return undefined;
}

function inDir(dir: string): string | undefined {
  for (const name of ENV_FILES) {
    const found = readKey(join(dir, name));
    if (found !== undefined) return found;
  }
  return undefined;
}

function isRoot(dir: string): boolean {
  return ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

/**
 * The directories that hold a `.reticle.json`: the apps that were actually instrumented.
 *
 * This is the closest thing the daemon has to "the session's project directory", and it is the same
 * discovery the no-session diagnosis uses to tell an agent where the app really is. Reusing it means
 * the licence search and that diagnosis can never disagree about where the project lives.
 *
 * It replaced a guess at `apps/*` and `packages/*`, which missed exactly the repo shape
 * `findWorkspaceApps` was written for: three apps at `web/`, `admin/` and `space/`.
 */
/**
 * The conventional layout, kept as a fallback beside the declaration-driven search above.
 *
 * `discoverProjectConfigs` descends only into DECLARED workspaces, which is right and is what a real
 * monorepo has. But `apps/web` with no `workspaces` entry is a shape people genuinely ship, and for
 * a licence key the cost of one extra `readdir` is nothing against reporting a paying customer as
 * unlicensed. Strictly widens coverage; it can never contradict the discovery, only add to it.
 */
const CONVENTIONAL_DIRS = ['apps', 'packages'] as const;

function inConventionalChildren(dir: string): string | undefined {
  for (const group of CONVENTIONAL_DIRS) {
    const base = join(dir, group);
    let entries: string[];
    try {
      if (!existsSync(base) || !statSync(base).isDirectory()) continue;
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const found = inDir(join(base, entry));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function inDiscoveredProjects(dir: string): string | undefined {
  let found: readonly { directory: string }[];
  try {
    found = discoverProjectConfigs(dir).found;
  } catch {
    return undefined;
  }
  for (const config of found) {
    const key = inDir(config.directory);
    if (key !== undefined) return key;
  }
  return undefined;
}

/**
 * The key, or undefined. Never throws, never mutates anything the caller did not ask it to.
 *
 * A key already present in `env` always wins: that is the operator stating it explicitly, and a file
 * silently overriding it is the surprise `loadDotEnv` already refuses to cause.
 */
export function licenseKeyFromEnvFiles(
  startDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const existing = env[LICENSE_KEY_ENV];
  if (existing !== undefined && existing.length > 0) return existing;

  let dir = startDir;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const here = inDir(dir) ?? inDiscoveredProjects(dir) ?? inConventionalChildren(dir);
    if (here !== undefined) return here;
    if (isRoot(dir)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
