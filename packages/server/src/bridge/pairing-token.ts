import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ReticleDir, ReticleEnv } from '@reticlehq/core';

/**
 * Auto-provisioned bridge pairing token. The daemon reads-or-creates a per-user secret at
 * ~/.reticle/pairing-token; the bridge then requires it, so a rogue localhost app (which, running in a
 * browser sandbox, cannot read the file) can no longer register/drive sessions just by being on a
 * loopback origin. The build plugins read the same file Node-side and inject it into connect, so a
 * legitimately-served app stays zero-config.
 */

/** Injectable IO + randomness so the provisioner is unit-testable without touching the real home dir. */
export interface PairingTokenDeps {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  randomToken: () => string;
}

/** 24 random bytes → 48 hex chars: well under MAX_TOKEN_LENGTH, ample entropy for a local secret. */
const TOKEN_BYTES = 24;

/** Env override for the token directory (`RETICLE_PAIRING_TOKEN_DIR`) — relocate the secret off $HOME. */
export const PAIRING_TOKEN_DIR_ENV = ReticleEnv.PAIRING_TOKEN_DIR;

/** The default directory that holds the token — the per-user ~/.reticle so it's shared across projects. */
export function defaultPairingTokenDir(): string {
  const override = process.env[PAIRING_TOKEN_DIR_ENV];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ReticleDir.ROOT);
}

export function pairingTokenPath(dir: string): string {
  return join(dir, ReticleDir.PAIRING_TOKEN_FILE);
}

/** Production IO adapter: 0600 file + 0700 dir so only the owner can read the secret. */
export function nodePairingTokenDeps(): PairingTokenDeps {
  return {
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: async (path, data) => {
      await writeFile(path, data, { encoding: 'utf8', mode: 0o600 });
      // Enforce perms even if the file pre-existed with a looser mode (writeFile keeps old perms).
      await chmod(path, 0o600);
    },
    mkdir: async (path) => {
      await mkdir(path, { recursive: true, mode: 0o700 });
    },
    randomToken: () => randomBytes(TOKEN_BYTES).toString('hex'),
  };
}

/**
 * Read the stored token, or create + persist one on first run. Stable across restarts so a
 * plugin-injected page keeps working after the daemon bounces. Best-effort: returns undefined if IO
 * fails, so the caller degrades to the prior tokenless behavior rather than bricking the daemon.
 */
export async function readOrCreatePairingToken(
  dir: string,
  deps: PairingTokenDeps,
): Promise<string | undefined> {
  const path = pairingTokenPath(dir);
  try {
    const existing = (await deps.readFile(path)).trim();
    if (existing.length > 0) return existing;
  } catch {
    // Missing/unreadable — fall through to create one.
  }
  try {
    const token = deps.randomToken().trim();
    if (0 === token.length) return undefined;
    await deps.mkdir(dir);
    await deps.writeFile(path, token);
    return token;
  } catch {
    return undefined;
  }
}

/**
 * Sync twin of `readOrCreatePairingToken`. `reticle init` and Next's `withReticle` are both
 * synchronous, and a snippet printed with no token is a page that can never authenticate.
 */
export function readOrCreatePairingTokenSync(dir: string): string | undefined {
  const path = pairingTokenPath(dir);
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length > 0) return existing;
  } catch {
    /* missing or unreadable — fall through and create one */
  }
  try {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    if (0 === token.length) return undefined;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 });
    chmodSync(path, 0o600);
    return token;
  } catch {
    return undefined;
  }
}
