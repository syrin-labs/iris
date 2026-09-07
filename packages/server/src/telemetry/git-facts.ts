/**
 * What we can honestly know about a project's git setup, read from `.git/` on disk.
 *
 * This exists to make three counting questions answerable and, just as importantly, to make it
 * visible when they are NOT answerable:
 *
 *   - how many users does one project have?  (distinct anonymousId per projectId)
 *   - how many projects does one user have?  (distinct projectId per anonymousId)
 *   - how many people work alone vs on a shared repo?
 *
 * All three depend on `projectId` meaning the same thing on two different machines, which is only
 * true when it was derived from a git ORIGIN. Outside a repo, or in a repo nobody has pushed, the
 * fingerprint falls back to a hash of the directory path — and two teammates on the same unpushed
 * project then look like two unrelated projects. That is not a bug we can fix (there is nothing
 * shared to hash), so instead every event reports WHICH source it used, and the analytics can filter
 * to the rows where "users per project" is a real number instead of quietly averaging in the ones
 * where it is always 1.
 *
 * Read from `.git/config` directly rather than by shelling out to `git`: this runs on the CLI's
 * startup path, where a ~30ms subprocess spawn would tax every single `reticle` command, and it must
 * work on a machine with no `git` binary installed at all.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GitState, RepoForge } from '@reticlehq/core';

/** How far up the tree to look for a `.git` before giving up. Deep monorepos are still well inside. */
const MAX_PARENT_WALK = 20;

/**
 * The public forges we name. Everything else reports `self_hosted` WITHOUT its hostname — an internal
 * git host is often `git.<company>.com`, which would identify the company outright and is exactly the
 * covert identification the telemetry policy promises not to do. The bucket alone is the useful
 * signal anyway: self-hosted git is a strong enterprise tell, which is the question actually being
 * asked.
 */
const PUBLIC_FORGES: readonly (readonly [string, RepoForge])[] = [
  ['github.com', RepoForge.GITHUB],
  ['gitlab.com', RepoForge.GITLAB],
  ['bitbucket.org', RepoForge.BITBUCKET],
  ['dev.azure.com', RepoForge.AZURE],
  ['git.sr.ht', RepoForge.SOURCEHUT],
  ['codeberg.org', RepoForge.CODEBERG],
];

interface GitFacts {
  /** none | local_only (init'd, never pushed) | remote (has an origin). */
  state: GitState;
  /** The NORMALIZED origin — hashed by the caller, never sent raw. Absent unless state is `remote`. */
  origin?: string;
  /** Which forge hosts it, bucketed. Absent unless state is `remote`. */
  forge?: RepoForge;
  /**
   * The directory holding `.git` — the repo boundary. Absent only when state is `none`.
   *
   * Never sent: it is a local path. It exists so an UNPUSHED repo can still key its projectId to
   * something stable across every directory inside it, which a raw cwd is not.
   */
  root?: string;
}

/** `git@github.com:Acme/Web.git` / `https://u:p@github.com/Acme/Web` → `github.com/acme/web`. */
export const normalizeGitOrigin = (url: string): string =>
  url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^@/]*@/i, '') // strip scheme + any inline credentials
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // strip a bare scheme
    .replace(/^[^@/]+@/, '') // strip `git@` from the scp-style form
    .replace(/:/g, '/') // scp-style `host:path` → `host/path`
    // Trailing slashes BEFORE the `.git` suffix: a url written `…/web.git/` would otherwise keep its
    // `.git` and count as a different project from the same repo cloned without the slash.
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();

/** Bucket a normalized origin by its host. Unknown hosts are `self_hosted` — never the host itself. */
export function forgeOf(normalizedOrigin: string): RepoForge {
  const host = normalizedOrigin.split('/')[0] ?? '';
  for (const [domain, forge] of PUBLIC_FORGES) {
    // `ssh.dev.azure.com` and `www.github.com` are the same forge; match on suffix, not equality.
    if (host === domain || host.endsWith(`.${domain}`)) return forge;
  }
  return RepoForge.SELF_HOSTED;
}

type FileReader = (path: string) => string;
type PathExists = (path: string) => boolean;

const defaultRead: FileReader = (path) => readFileSync(path, 'utf8');
const defaultExists: PathExists = (path) => {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Walk up from `cwd` looking for a `.git`, and report what is there. Never throws: an unreadable or
 * malformed config reports the state we could confirm rather than failing a startup path.
 */
export function gitFacts(
  cwd: string,
  read: FileReader = defaultRead,
  exists: PathExists = defaultExists,
): GitFacts {
  let dir = cwd;
  for (let depth = 0; depth < MAX_PARENT_WALK; depth += 1) {
    const gitDir = join(dir, '.git');
    if (exists(gitDir)) {
      let config = '';
      try {
        config = read(join(gitDir, 'config'));
      } catch {
        // A `.git` with no readable config is still a repo — report it as one rather than as absent.
        return { state: GitState.LOCAL_ONLY, root: dir };
      }
      // The url line inside the [remote "origin"] section — the first url after that header wins.
      const section = config.split(/\[remote\s+"origin"\]/)[1];
      const url = section?.match(/^\s*url\s*=\s*(.+)$/m)?.[1];
      if (url === undefined) return { state: GitState.LOCAL_ONLY, root: dir };
      const origin = normalizeGitOrigin(url);
      if ('' === origin) return { state: GitState.LOCAL_ONLY, root: dir };
      return { state: GitState.REMOTE, origin, forge: forgeOf(origin), root: dir };
    }
    const parent = dirname(dir);
    if (parent === dir) break; // hit the filesystem root
    dir = parent;
  }
  return { state: GitState.NONE };
}
