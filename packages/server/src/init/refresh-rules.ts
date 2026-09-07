/**
 * Bring an already-installed project's agent rules up to the version that is running.
 *
 * `mergeMarkedInstruction` has always been able to do this: the managed block is marker-delimited,
 * idempotence is decided by comparing CONTENT rather than by seeing a marker, and everything
 * outside the markers is left exactly as the human wrote it. What was missing is anything that
 * CALLS it after the first install.
 *
 * It is reachable only from `buildPlan`, so the rules refresh when somebody re-runs `init` and
 * never otherwise. A project set up on an older release keeps that release's instructions forever,
 * which means every improvement to them — what to do when a capabilities file registers nothing,
 * that an install is not finished until a verdict exists, that intent is captured while building —
 * reaches new projects only.
 *
 * That is the wrong way round. The people who most need better instructions are the ones already
 * installed and not getting value, and `reticle update` is the moment they are already touching the
 * install.
 */

import { join } from 'node:path';
import { mergeMarkedInstruction, AgentRuleStatus, hasManagedBlock } from './agent-rules.js';

/** The instruction files the managed block lives in. Cursor's rule file is regenerated whole. */
export const RULE_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;

interface RuleFileIo {
  read: (path: string) => string | null;
  write: (path: string, content: string) => void;
}

interface RefreshResult {
  /** Files whose managed block was replaced with the current one. */
  updated: string[];
  /** Files that were already current, or that carry no Reticle block to update. */
  unchanged: string[];
}

/**
 * Refresh every instruction file that already carries a Reticle block.
 *
 * Deliberately does NOT create one where none exists. A project with no Reticle block in its
 * CLAUDE.md either never ran `init` here or had the block removed on purpose, and `update` is not
 * the place to make that decision for somebody — it is a version command, and quietly writing
 * instructions into a file a user curates would be a surprise.
 */
export function refreshAgentRules(cwd: string, io: RuleFileIo): RefreshResult {
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const name of RULE_FILES) {
    const path = join(cwd, name);
    const existing = io.read(path);
    if (null === existing || !hasManagedBlock(existing)) {
      unchanged.push(name);
      continue;
    }
    const result = mergeMarkedInstruction(existing);
    if (AgentRuleStatus.APPLY === result.status && result.content !== existing) {
      io.write(path, result.content);
      updated.push(name);
    } else {
      unchanged.push(name);
    }
  }
  return { updated, unchanged };
}
