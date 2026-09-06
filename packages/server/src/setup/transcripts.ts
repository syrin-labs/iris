/**
 * Which conversation is asking, and does it really exist.
 *
 * Both answers come off the filesystem, so they are kept away from the pure decision in relaunch.ts
 * — that is the part worth testing, and it is the part that can be wrong without anybody noticing.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Does a transcript exist for this Claude Code session.
 *
 * Two roots, because a shared-config install writes elsewhere and a restart that checks only one of
 * them refuses a session that is perfectly real.
 */
export function claudeTranscriptExists(sessionId: string): boolean {
  for (const base of [
    join(homedir(), '.claude-shared', 'projects'),
    join(homedir(), '.claude', 'projects'),
  ]) {
    try {
      for (const project of readdirSync(base)) {
        if (existsSync(join(base, project, `${sessionId}.jsonl`))) return true;
      }
    } catch {
      /* that history directory does not exist on this machine */
    }
  }
  return false;
}

/**
 * The codex conversation running in `cwd`, when one is.
 *
 * Codex names no session in the environment — unlike Claude Code — so it is recognised from the
 * rollout file it is writing. Not yet wired to a reader here: returning undefined means "no codex
 * session identified", which is the honest answer until one exists, and the decision it feeds says
 * plainly that the client identified no conversation.
 */
export function codexSessionFor(_cwd: string): string | undefined {
  return undefined;
}
