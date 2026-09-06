/**
 * What to say when the dependency install fails.
 *
 * Split out of plan.ts, which was at the 1000-line backstop. A cohesive unit rather than an
 * arbitrary cut: it is prose about one step's failure modes, and the only thing it needs is which
 * package manager was used.
 */
import { PackageManager } from './detect.js';

/**
 * Every package manager fetches, so every one of them can fail for a reason that is nothing to do
 * with the project: offline, a proxy that blocks npmjs, a corporate mirror that is down.
 *
 * The hint used to name only version pinning and pnpm's maturity window. Both are real causes, and
 * neither is that one — so a blocked registry sent the reader through their own dependency versions
 * looking for a problem that was entirely about reachability.
 */
const REGISTRY_HINT =
  'If it could not reach the registry at all (offline, a proxy, a mirror that is down), that is ' +
  'about reachability and not about this project: check `npm config get registry` and whether this ' +
  'machine can reach it.';

/**
 * A checkout whose `node_modules` is symlinked into another checkout's `.pnpm` store — a git
 * worktree, or an A/B harness running two copies of the same repo — makes pnpm refuse to add a
 * package with ERR_PNPM_UNEXPECTED_VIRTUAL_STORE, because it will not silently repoint an
 * existing virtual store. The original hint named only the maturity-window cause, so this one
 * sent the reader through their dependency versions looking for a problem that was actually
 * about where the store lives (#683).
 */
const VIRTUAL_STORE_HINT =
  "If pnpm reported ERR_PNPM_UNEXPECTED_VIRTUAL_STORE, this checkout's node_modules is " +
  "symlinked into another checkout's pnpm store (a git worktree, or an A/B harness). Either run " +
  '`pnpm install` once in that other checkout first, or point this one at its own store:\n' +
  '  pnpm add -D --config.virtual-store-dir=node_modules/.pnpm <packages>';

export function installFailureHint(pm: PackageManager): string {
  if (pm !== PackageManager.PNPM) {
    return `If the version was refused, install the SDK yourself. ${REGISTRY_HINT}`;
  }
  return (
    'If pnpm reported ERR_PNPM_NO_MATURE_MATCHING_VERSION, its minimumReleaseAge setting is holding ' +
    'this release back. Either wait out the window, or allow these packages explicitly:\n' +
    '  pnpm config set minimumReleaseAgeExclude "@reticlehq/*"\n' +
    'Do NOT drop the version pin — unpinned, pnpm installs an older SDK against a newer daemon, and ' +
    `that mismatch surfaces as a -32000 with nothing naming a version.\n${VIRTUAL_STORE_HINT}\n${REGISTRY_HINT}`
  );
}
