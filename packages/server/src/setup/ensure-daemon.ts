/**
 * Making sure something is listening before the app is asked to dial it.
 *
 * The setup phases wait for the page to appear as a session, which cannot happen unless a daemon
 * holds the bridge port. Nothing in `init` started one. On a developer machine that is invisible,
 * because an editor running `reticle mcp` has had a daemon up for hours; on a machine installing
 * Reticle for the first time, which is every machine this command exists for, there is nothing to
 * dial and setup ends with "the SDK is in the page and never dialled the bridge" — the SDK being
 * blamed for the absence of the thing it was dialling.
 *
 * Idempotent by construction: an alive daemon for this project is adopted, and one belonging to
 * somebody else is refused rather than stolen, which is the same rule `reticle mcp` follows.
 */

import { log } from '../log.js';
import { spawnDaemon } from '../daemon/daemon.js';
import { probePresence, presenceIsUsable } from '../daemon/port-presence.js';
import { waitForDaemon, probeDaemon } from '../mcp/mcp-proxy.js';
import { daemonSpawnArgs } from '../cli/daemon-start-options.js';
import { fetchStatus } from '../cli/cli-launch.js';

interface EnsureDaemonDeps {
  readonly usable: (port: number) => Promise<boolean>;
  readonly spawn: (port: number) => boolean;
  readonly waitReady: (port: number) => Promise<unknown>;
  readonly scriptPath: string | undefined;
}

export const EnsureDaemon = {
  /** Something usable was already there. */
  ADOPTED: 'adopted',
  STARTED: 'started',
  /** Could not be started, and the caller has to say so rather than blame the page. */
  UNAVAILABLE: 'unavailable',
} as const;
export type EnsureDaemon = (typeof EnsureDaemon)[keyof typeof EnsureDaemon];

export async function ensureDaemon(port: number, deps: EnsureDaemonDeps): Promise<EnsureDaemon> {
  if (await deps.usable(port)) return EnsureDaemon.ADOPTED;
  if (undefined === deps.scriptPath) return EnsureDaemon.UNAVAILABLE;
  if (!deps.spawn(port)) return EnsureDaemon.UNAVAILABLE;
  try {
    // Readiness means the port ACCEPTS, not that a child was spawned: a readiness signal that
    // precedes readiness is worse than none, because what waits on it stops waiting too early.
    await deps.waitReady(port);
  } catch {
    return EnsureDaemon.UNAVAILABLE;
  }
  return (await deps.usable(port)) ? EnsureDaemon.STARTED : EnsureDaemon.UNAVAILABLE;
}

export function nodeEnsureDaemonDeps(): EnsureDaemonDeps {
  return {
    usable: async (port: number): Promise<boolean> =>
      presenceIsUsable(await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus })),
    spawn: (port: number): boolean => {
      const scriptPath = process.argv[1];
      if (undefined === scriptPath) return false;
      const started = spawnDaemon(
        process.execPath,
        scriptPath,
        daemonSpawnArgs({ port, headless: true, http: false }),
        port,
      );
      log('reticle_setup_daemon_started', { port, started });
      return started;
    },
    waitReady: (port: number): Promise<unknown> => waitForDaemon(port),
    scriptPath: process.argv[1],
  };
}
