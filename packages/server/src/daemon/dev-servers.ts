/**
 * Reading what dev servers have announced about themselves.
 *
 * The consumer half of `devserver-<port>.json`. A build plugin writes one when its dev server is
 * actually listening; this reads them back, so `init` and `status` can tell three states apart that
 * used to be one:
 *
 *   nothing announced    no dev server with Reticle loaded is running
 *   announced, no page   the bundle is wired and no browser dialled — and the entry names the URL
 *   announced + session  working
 *
 * The middle one is the case that had no message. It was folded into "restart your dev server and
 * load the app", which is two instructions where only the second one applies, addressed to someone
 * who has already done the first.
 *
 * Fs plumbing only — the selection rule is `liveDevServers` in core, shared with anything else that
 * reads this registry, for the same reason `pickDaemonPort` lives there.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DevServerEntrySchema,
  devServerRegistryPort,
  liveDevServers,
  type DevServerEntry,
} from '@reticlehq/core';

/** process.kill(pid, 0) throws iff the process is gone — the same probe the daemon registry uses. */
function isAliveNow(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Injected so the reading is unit-testable without a real home or real processes. */
export interface DevServerIo {
  readdir: (dir: string) => string[];
  readFile: (path: string) => string;
  isAlive: (pid: number) => boolean;
}

const nodeIo: DevServerIo = {
  readdir: (dir) => readdirSync(dir),
  readFile: (path) => readFileSync(path, 'utf8'),
  isAlive: isAliveNow,
};

/**
 * Every dev server that announced itself and is still running, lowest port first.
 *
 * Fails soft at every step. This runs on the path that explains to a user why setup has not worked,
 * so a half-written file, a hand-edit, or a missing directory must degrade the answer rather than
 * replace the diagnosis with a stack trace.
 */
export function readDevServers(home: string, io: DevServerIo = nodeIo): DevServerEntry[] {
  let files: string[];
  try {
    files = io.readdir(home);
  } catch {
    return []; // No state directory yet — nothing has ever run here.
  }
  const entries: DevServerEntry[] = [];
  for (const file of files) {
    // Strict on the filename BEFORE reading: the daemon's own `daemon-<port>.json` is a sibling, and
    // parsing one as a dev server would report the daemon itself as an instrumented app.
    if (null === devServerRegistryPort(file)) continue;
    try {
      const parsed = DevServerEntrySchema.safeParse(JSON.parse(io.readFile(join(home, file))));
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // Truncated, mid-write, or hand-edited. One bad file is not a reason to report none.
    }
  }
  return liveDevServers(entries, io.isAlive);
}
