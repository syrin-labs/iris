import { z } from 'zod';

/**
 * The dev-server discovery registry — the return leg of `daemon-registry.ts`.
 *
 * A live daemon already drops `daemon-<port>.json` here so a build plugin can FIND it by projectId
 * rather than being told a port in two places. Nothing went the other way: the daemon, and `init`,
 * had no way to know a dev server existed at all.
 *
 * That gap is why setup fails silently. Ten things must be true before a tool call can see anything,
 * and the commonest miss — a plugin added to a config the running dev server already read — is
 * invisible from outside the dev server's own process. So `init` wrote files, printed instructions,
 * and left; the person with an uninstrumented page was never told.
 *
 * The alternative was for `init` to run the dev command itself. It cannot: the command, the script
 * name, the package manager, the port and the framework are all things the user or their agent may
 * change, and a setup step that hardcodes any of them is a setup step that breaks on the project it
 * was most needed for. So nothing here starts anything or names a command. The plugin ALREADY runs
 * Node-side when the dev server boots; it announces there, and the reader waits.
 *
 * With both legs present the diagnosis is three-way and every branch is an observed fact:
 *
 *   no entry, no session   nothing with Reticle loaded is running — start or restart it
 *   entry, no session      the bundle is wired and no page dialled — and `url` names where to look
 *   entry and session      working
 *
 * A file rather than a request, deliberately: at `init` time there is frequently no daemon to POST
 * to yet, and a signal that requires the thing it is diagnosing to already be up is no signal.
 */

const DEV_SERVER_PREFIX = 'devserver-';
const DEV_SERVER_SUFFIX = '.json';

/** The registry filename for a dev server listening on `port`. */
export function devServerRegistryFileName(port: number): string {
  return `${DEV_SERVER_PREFIX}${String(port)}${DEV_SERVER_SUFFIX}`;
}

/**
 * The port from a registry filename, or null when the name is not one.
 *
 * Strict about the whole shape, because the daemon's own `daemon-<port>.json` sits in the same
 * directory: reading one of those as a dev server would report the daemon as an instrumented app,
 * which is the precise false green this signal exists to prevent.
 */
export function devServerRegistryPort(fileName: string): number | null {
  if (!fileName.startsWith(DEV_SERVER_PREFIX) || !fileName.endsWith(DEV_SERVER_SUFFIX)) return null;
  const mid = fileName.slice(DEV_SERVER_PREFIX.length, -DEV_SERVER_SUFFIX.length);
  return /^\d+$/.test(mid) ? Number(mid) : null;
}

/** One dev server's entry: enough to name it, reach it, and prove it is still alive. */
export const DevServerEntrySchema = z.object({
  port: z.number(),
  pid: z.number(),
  /** The project directory the dev server is serving — how a monorepo tells its apps apart. */
  root: z.string(),
  /** Where the app is actually served, as the dev server itself reports it. Never assembled here. */
  url: z.string(),
  /**
   * The SDK version in the bundle, so a skew can be named rather than guessed at.
   *
   * Optional, and ABSENT rather than empty when it cannot be resolved. `""` reads as "the version is
   * empty"; a missing field reads as "not known", which is the true statement — and the difference
   * matters to the one reader who exists for this field, a skew diagnosis.
   */
  sdkVersion: z.string().min(1).optional(),
  startedAt: z.number(),
  /**
   * Optional because an app can be running before `init` has ever named it — which is exactly the
   * state this signal has to be able to describe.
   */
  projectId: z.string().optional(),
});
export type DevServerEntry = z.infer<typeof DevServerEntrySchema>;

/**
 * The entries whose process is still running, lowest port first.
 *
 * Liveness is checked rather than trusted for the same reason the daemon registry checks it: a dev
 * server killed with SIGKILL runs no cleanup, so its file outlives it. A stale entry read as live is
 * worse than no entry at all — it reports a running, instrumented app over a dead port, and sends
 * the reader to look at their browser instead of at their terminal.
 *
 * Pure, so both the CLI and the plugins share one rule and it is testable without real processes.
 */
/**
 * The live entries that belong to THIS project.
 *
 * Scoping is not a refinement here, it is the difference between a diagnosis and a wrong answer. A
 * dev server registry is machine-wide — one directory holds every app on the box — so "a dev server
 * is running" is satisfied by somebody else's app, by another package in the same monorepo, by
 * yesterday's terminal. Reported unscoped, `init` for app A told the user their dev server was wired
 * and handed them app B's URL: confident, specific, and about a project they were not setting up.
 *
 * Two ways to belong, because both are true and neither covers the other:
 *
 *   - the projectId matches, which is exact and survives a moved directory
 *   - the entry's root is the directory being set up, or inside it, which is what makes `init` at a
 *     monorepo root see the apps underneath it — they genuinely are its apps
 *
 * With neither known nothing matches, and the caller gets the same less specific answer it had
 * before. That is the conservative direction on purpose: a missed match costs one vaguer sentence,
 * a wrong match sends somebody to another team's app.
 */
export function devServersForProject(
  entries: readonly DevServerEntry[],
  scope: { projectId?: string | undefined; root?: string | undefined },
): DevServerEntry[] {
  const { projectId, root } = scope;
  if (
    (projectId === undefined || 0 === projectId.length) &&
    (root === undefined || 0 === root.length)
  ) {
    return [];
  }
  return entries.filter(
    (e) =>
      (projectId !== undefined && 0 < projectId.length && e.projectId === projectId) ||
      isWithin(e.root, root),
  );
}

/** `path` is `base`, or sits under it. Separator-aware, so `/repo/app2` is not inside `/repo/app`. */
function isWithin(path: string, base: string | undefined): boolean {
  if (base === undefined || 0 === base.length) return false;
  const norm = (p: string): string => p.split('\\').join('/').replace(/\/+$/, '');
  const target = norm(path);
  const parent = norm(base);
  return target === parent || target.startsWith(`${parent}/`);
}

export function liveDevServers(
  entries: readonly DevServerEntry[],
  isAlive: (pid: number) => boolean,
): DevServerEntry[] {
  return entries.filter((e) => isAlive(e.pid)).sort((a, b) => a.port - b.port);
}
