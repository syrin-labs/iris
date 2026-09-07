/**
 * Where the project config actually is, and — when we cannot find it — where we looked.
 *
 * `findProjectConfig` walks UP from the daemon's working directory, which is right for a developer
 * who ran `reticle` in their project and wrong for the way most daemons are actually started.
 * Editors launch MCP servers from wherever they like, and in at least one popular one that is the
 * user's home directory: the config then sits at `<repo>/apps/web/.reticle.json`, the up-walk from
 * home never touches it, and Reticle confidently reports the project unwired. Reported twice, plus a
 * git-worktree variant of the same shape.
 *
 * So: walk up, then — from the repo root, if there is one — look in the workspace directories the
 * project's OWN manifest declares, falling back to the two conventions everybody uses.
 *
 * The second half is the `searched` list. "There is no `.reticle.json`" is unfalsifiable without it,
 * and this file exists because that claim was made, confidently, about configs that were right
 * there. Every result carries the places that were checked.
 *
 * Deliberately NOT a "pick one" function. Several configs means several projects, and choosing one
 * silently is how an agent ends up with a confident verdict about an app it never touched. Callers
 * are handed the list and must name it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { RETICLE_CONFIG_BASENAME } from './cli-port.js';

/** How far up to walk. Matches the existing config search so the two cannot disagree. */
const MAX_UP_LEVELS = 6;

/**
 * Workspace directories checked when the manifest declares none.
 *
 * Not a guess at where an app might be — these are the two layouts the JS ecosystem converged on,
 * and both reported cases used one of them.
 */
const CONVENTIONAL_WORKSPACES: readonly string[] = ['apps', 'packages'];

/** How many entries of one workspace directory to stat. A backstop, not a policy. */
const MAX_WORKSPACE_ENTRIES = 64;

interface FoundConfig {
  /** Absolute path to the `.reticle.json`. */
  path: string;
  /** The directory it configures — what a reader needs in order to act. */
  directory: string;
  /** Its projectId, when it declares a usable one. */
  projectId?: string;
}

export interface ConfigDiscovery {
  found: FoundConfig[];
  /** Every directory checked, in the order checked. The answer to "are you sure?". */
  searched: string[];
}

function readConfig(directory: string): FoundConfig | undefined {
  const path = join(directory, RETICLE_CONFIG_BASENAME);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if ('object' !== typeof parsed || null === parsed || Array.isArray(parsed)) return undefined;
    const projectId = (parsed as Record<string, unknown>)['projectId'];
    return {
      path,
      directory,
      ...('string' === typeof projectId && projectId.length > 0 ? { projectId } : {}),
    };
  } catch {
    // Absent, unreadable, or not JSON. A malformed config is reported elsewhere; here it is simply
    // not a config we can name a project from.
    return undefined;
  }
}

/** The nearest ancestor holding a `.git`, or undefined. The repo root is where workspaces hang off. */
function repoRootOf(start: string): string | undefined {
  let dir = start;
  for (let level = 0; level <= MAX_UP_LEVELS; level += 1) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * The workspace directories this repo declares, from its own manifest where it has one.
 *
 * Reading `pnpm-workspace.yaml` with a substring scan rather than a YAML parser is deliberate: the
 * only thing wanted from it is the leading path segment of each glob, the file is machine-written in
 * practice, and a parser dependency to read one list of strings does not pay for itself.
 */
function declaredWorkspaceDirs(repoRoot: string): string[] {
  const dirs = new Set<string>();
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    if ('object' === typeof pkg && null !== pkg) {
      const workspaces = (pkg as Record<string, unknown>)['workspaces'];
      const globs = Array.isArray(workspaces)
        ? workspaces
        : 'object' === typeof workspaces && null !== workspaces
          ? ((workspaces as Record<string, unknown>)['packages'] ?? [])
          : [];
      if (Array.isArray(globs)) {
        for (const glob of globs) if ('string' === typeof glob) dirs.add(firstSegment(glob));
      }
    }
  } catch {
    // No manifest, or one we cannot read. The conventions below still apply.
  }
  try {
    const yaml = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
    for (const line of yaml.split('\n')) {
      const match = /^\s*-\s*['"]?([^'"\s]+)/.exec(line);
      const glob = match?.[1];
      if (glob !== undefined) dirs.add(firstSegment(glob));
    }
  } catch {
    // Not a pnpm workspace.
  }
  for (const conventional of CONVENTIONAL_WORKSPACES) dirs.add(conventional);
  return [...dirs].filter((dir) => dir.length > 0 && !dir.startsWith('.'));
}

/** `apps/*` -> `apps`. The glob machinery is not needed; the leading directory is all we scan. */
function firstSegment(glob: string): string {
  const [first] = glob.split('/');
  return first ?? '';
}

export function discoverProjectConfigs(cwd: string): ConfigDiscovery {
  const searched: string[] = [];
  const found: FoundConfig[] = [];
  const seen = new Set<string>();

  const check = (directory: string): void => {
    if (seen.has(directory)) return;
    seen.add(directory);
    searched.push(directory);
    const config = readConfig(directory);
    if (config !== undefined) found.push(config);
  };

  let dir = resolve(cwd);
  for (let level = 0; level <= MAX_UP_LEVELS; level += 1) {
    check(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const repoRoot = repoRootOf(resolve(cwd));
  if (repoRoot === undefined) return { found, searched };

  for (const workspace of declaredWorkspaceDirs(repoRoot)) {
    const base = join(repoRoot, workspace);
    let entries: string[] = [];
    try {
      entries = readdirSync(base).slice(0, MAX_WORKSPACE_ENTRIES);
    } catch {
      continue; // A declared workspace directory that does not exist is not an error here.
    }
    check(base);
    for (const entry of entries) {
      const candidate = join(base, entry);
      try {
        if (!statSync(candidate).isDirectory()) continue;
      } catch {
        continue;
      }
      check(candidate);
    }
  }

  return { found, searched };
}
