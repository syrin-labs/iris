/**
 * Build-time daemon discovery: when the app doesn't pin a port, find the daemon serving THIS project
 * by reading the registry entries the daemon drops in ~/.reticle (daemon-<port>.json). Node-only and
 * runs at dev-server request time (the daemon is up by then). The tricky selection rule — match by
 * projectId, drop dead daemons — is the pure `pickDaemonPort` in core; this file is just the fs plumbing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  daemonRegistryPort,
  DaemonRegistryEntrySchema,
  pickDaemonPort,
  type DaemonRegistryEntry,
} from '@reticlehq/core';
import { stateHome } from './state-home.js';

/** process.kill(pid, 0) throws iff the process is gone — the same liveness probe the daemon uses. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The port of the live daemon serving `projectId`, or undefined when none matches (caller falls back
 * to the default port — never auto-connects to a mismatched daemon). `home` and `alive` are injectable
 * so the selection is unit-tested without a real ~/.reticle or real processes.
 */
export function discoverDaemonPort(
  projectId: string | undefined,
  home: string = stateHome(),
  alive: (pid: number) => boolean = isAlive,
): number | undefined {
  const entries: DaemonRegistryEntry[] = [];
  let files: string[];
  try {
    files = readdirSync(home);
  } catch {
    return undefined; // no ~/.reticle yet
  }
  for (const file of files) {
    if (null === daemonRegistryPort(file)) continue;
    try {
      const parsed = DaemonRegistryEntrySchema.safeParse(
        JSON.parse(readFileSync(join(home, file), 'utf8')),
      );
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // corrupt/unreadable entry — skip
    }
  }
  return pickDaemonPort(entries, projectId, alive) ?? undefined;
}
