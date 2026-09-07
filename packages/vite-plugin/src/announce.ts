/**
 * Announce this dev server to `~/.reticle`, so setup can be diagnosed from facts rather than guesses.
 *
 * The mirror of `discover-port.ts`: that reads the daemon's `daemon-<port>.json` to find a bridge,
 * this writes `devserver-<port>.json` so the bridge — and `reticle init` — can see that an
 * instrumented dev server exists at all.
 *
 * Why this is the right half to add, rather than teaching `init` to run the dev command: the script
 * name, the package manager, the port and the framework are all things a user or their agent can
 * change, and a setup step that hardcodes any of them breaks on exactly the project that needed it.
 * This plugin is ALREADY inside the dev server when it boots. It knows the port because it is being
 * served on it, and it knows the URL because Vite reports it. Nothing here is assumed.
 *
 * Writing this file proves one specific thing and no more: the plugin is loaded in the process that
 * is actually running. That is the fact nobody could observe, and the commonest setup failure — a
 * plugin added to a config the running dev server already read — is precisely its absence.
 *
 * Best-effort throughout. This is a diagnostic, and a diagnostic that can break the dev server it
 * reports on is worse than no diagnostic at all.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { devServerRegistryFileName, type DevServerEntry } from '@reticlehq/core';
import { stateHome } from './state-home.js';

const JSON_INDENT = 2;

/** The filesystem this needs, injected so the writer is unit-testable without a real home. */
export interface AnnounceIo {
  mkdir: (dir: string) => void;
  writeFile: (path: string, data: string) => void;
  removeFile: (path: string) => void;
}

const nodeIo: AnnounceIo = {
  mkdir: (dir) => void mkdirSync(dir, { recursive: true }),
  writeFile: (path, data) => void writeFileSync(path, data),
  removeFile: (path) => void rmSync(path, { force: true }),
};

/**
 * Publish the entry; returns the cleanup that withdraws it.
 *
 * The cleanup is idempotent because it is called from shutdown paths — `close`, `SIGINT`, process
 * exit — which fire more than once and race each other. A stale entry is handled on the read side
 * by a liveness check (`liveDevServers`), so a missed cleanup degrades rather than misleads; a
 * throw inside a signal handler does not degrade, it takes the shutdown with it.
 */
export function announceDevServer(
  entry: DevServerEntry,
  home: string = stateHome(),
  io: AnnounceIo = nodeIo,
): () => void {
  const path = join(home, devServerRegistryFileName(entry.port));
  try {
    io.mkdir(home);
    io.writeFile(path, `${JSON.stringify(entry, null, JSON_INDENT)}\n`);
  } catch {
    // No home directory, a read-only filesystem, a sandbox. The app still serves; we just cannot say so.
  }
  let withdrawn = false;
  return () => {
    if (withdrawn) return;
    withdrawn = true;
    try {
      io.removeFile(path);
    } catch {
      // Already gone, or never written. The reader's liveness check covers what we cannot remove.
    }
  };
}
