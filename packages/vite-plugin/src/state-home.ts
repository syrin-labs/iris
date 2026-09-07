/**
 * Where Reticle keeps machine state — the one answer, for both halves of discovery.
 *
 * `RETICLE_STATE_DIR` already exists and already relocates the daemon's pidfiles, logs and discovery
 * registry (a read-only `$HOME` — sandboxed agent, locked-down Windows profile, container — makes
 * the default unwritable). The plugin's reader did not honour it: with the variable set, the daemon
 * wrote its registry to one directory while `discoverDaemonPort` looked in another, so discovery
 * silently found nothing and every app fell back to the default port. Exactly the class of split
 * this file exists to prevent — two halves of one mechanism with two ideas of where it lives.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ReticleDir, ReticleEnv } from '@reticlehq/core';

export function stateHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ReticleEnv.STATE_DIR];
  return override !== undefined && override.length > 0
    ? override
    : join(homedir(), ReticleDir.ROOT);
}
