/**
 * Carrying the pre-approval rules onto a machine that installed Reticle before they existed.
 *
 * The alternative was a command the user has to know to type. Nothing reaches back into an existing
 * install, so `init --files-only` is a real upgrade path but only for somebody who reads a
 * changelog; everyone else keeps clicking Accept on every call forever, which is precisely the
 * thing this was supposed to end.
 *
 * So it runs from `reticle mcp` — the one process every client starts, every session, on the
 * version they actually have. Four properties make that safe to do unattended:
 *
 * 1. **Once per version.** A stamp in the state dir, so it is not a write on every editor launch.
 * 2. **Only where an agent is installed**, and only ever the `reticle` server.
 * 3. **Never a create that supersedes an allowlist we cannot read.** Cursor's file is deferred to an
 *    explicit `init` when it does not already exist: a version bump that silently makes somebody's
 *    OTHER MCP servers start prompting again is a regression we caused and they cannot trace.
 * 4. **Never throws, never writes to stdout.** This runs inside a stdio MCP server, where a stray
 *    byte on stdout corrupts the protocol, and where a crash is experienced as "Reticle is down".
 * 5. **Never runs against a sandboxed state directory.** A gate or a fixture that points Reticle at
 *    a temp state dir is not asking to have the real user's editor config rewritten, and every
 *    battery in this repo starts MCP servers. The one write in this repo that reached a developer's
 *    own home did so from a gate run, which is exactly the shape this rules out.
 */

import { grantAutoApproval, ApprovalOutcome, type ApprovalResult } from './auto-approve.js';
import type { AgentWriterIo } from './agent-writer.js';
import { joinFor, type PlatformPaths } from './agent-configs.js';

export const APPROVAL_STAMP_FILE = 'approvals.json';

interface Stamp {
  readonly version?: string;
}

export interface MigrationDeps {
  readonly io: AgentWriterIo;
  readonly home: string;
  readonly platform: keyof PlatformPaths;
  /** The state directory, which is where the once-per-version stamp lives. */
  readonly stateHome: string;
  readonly version: string;
  readonly log: (event: string, data: Record<string, unknown>) => void;
}

interface MigrationResult {
  readonly ran: boolean;
  readonly granted: readonly string[];
  readonly deferred: readonly string[];
}

const NOTHING: MigrationResult = { ran: false, granted: [], deferred: [] };

/**
 * Apply the approval rules once for this version, and record that it happened.
 *
 * The stamp is written even when nothing was granted. A machine with no agents installed should not
 * re-scan on every editor launch for the rest of the version's life.
 */
export function migrateApprovals(deps: MigrationDeps): MigrationResult {
  const { io, home, platform, stateHome, version, log } = deps;
  const stamp = joinFor(platform)(stateHome, APPROVAL_STAMP_FILE);
  try {
    if (io.exists(stamp)) {
      const seen = JSON.parse(io.readFile(stamp)) as Stamp;
      if (version === seen.version) return NOTHING;
    }
  } catch {
    // An unreadable stamp means we do not know what has run, and the grants below are idempotent,
    // so the safe reading is "not yet" rather than skipping the migration forever.
  }

  let results: ApprovalResult[] = [];
  try {
    results = grantAutoApproval(io, { home, platform }, undefined, { onlyIfNoSupersede: true });
  } catch {
    return NOTHING;
  }

  const granted = results.filter((r) => ApprovalOutcome.GRANTED === r.outcome).map((r) => r.name);
  const deferred = results.filter((r) => ApprovalOutcome.DEFERRED === r.outcome).map((r) => r.name);

  try {
    io.mkdirp(stateHome);
    io.writeFile(stamp, `${JSON.stringify({ version }, null, 2)}\n`);
  } catch {
    // A stamp we could not write means this runs again next launch. Wasteful, not harmful.
  }

  if (0 < granted.length || 0 < deferred.length) {
    log('reticle_approvals_migrated', { version, granted, deferred });
  }
  return { ran: true, granted, deferred };
}
