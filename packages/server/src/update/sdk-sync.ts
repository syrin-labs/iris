/**
 * The half of `reticle update` that was missing: bringing the APP's SDK to the same version as the
 * daemon being installed.
 *
 * `reticle update` swapped the CLI and stopped. The app kept whatever `@reticlehq/react` it had, so
 * the command whose job is to keep an install current was itself a way to create a version-skewed
 * pair — the failure the HELLO skew check, the nudge and the pin all exist to prevent. The skew
 * message even told people to run `reticle update` to fix an outdated SDK, which could not work.
 *
 * Pinned to an exact version for the same reason `init` pins: an unpinned `add` can resolve out of a
 * stale registry cache and reinstall the skew being fixed. Measured once as pnpm taking 2.2.1 while
 * npm took 2.3.0 in the next project over.
 */

import { installCommandParts, type PackageManager } from '../init/detect.js';

export { reticleDepsOf } from './reticle-deps.js';

/** The install to run, or null when this project has nothing of ours to sync. */
export function sdkSyncCommand(
  pm: PackageManager,
  packages: readonly string[],
  version: string,
): { command: string; args: string[] } | null {
  if (0 === packages.length) return null;
  const { command, args } = installCommandParts(
    pm,
    packages.map((p) => `${p}@${version}`),
  );
  return { command, args: [...args] };
}
