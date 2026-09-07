/**
 * Where a feedback report goes when it cannot be sent.
 *
 * The report is fully written and redacted by the time delivery is refused. Throwing it away
 * punishes exactly the behaviour the channel exists to encourage — and it hits hardest where the
 * reports are best, because a Reticle source checkout disables telemetry by cwd, so the contributor
 * who can name the file and the line is the one person who cannot file at all.
 *
 * Writing it down costs nothing and loses nothing. The receipt then carries a path and a command,
 * so the human is handed one thing to run instead of being asked to retype what an agent already
 * wrote.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import type { Feedback } from '@reticlehq/core';

/** Reports live beside the rest of the workspace, not in a temp dir somebody has to be told about. */
const FEEDBACK_SUBDIR = 'feedback';

interface SavedFeedback {
  path: string;
  /** A ready-to-run command that turns the file into an issue. */
  command: string;
}

/** Filesystem-safe, sortable, and unique enough for one report per second per kind. */
const stamp = (now: number): string =>
  new Date(now).toISOString().replace(/[:.]/g, '-').replace('Z', '');

const asMarkdown = (
  input: { kind?: string; source?: string },
  text: string,
  context: Partial<Feedback>,
): string => {
  const title = `Reticle feedback: ${input.kind ?? 'note'}`;
  return [
    `# ${title}`,
    '',
    text.trim(),
    '',
    '## Context',
    '',
    '```json',
    JSON.stringify(context, null, 2),
    '```',
    '',
  ].join('\n');
};

/**
 * Write the report under `<cwd>/.reticle/feedback/`. Returns undefined if it cannot be written —
 * a feedback save that throws would take down the tool call that was reporting a problem, which is
 * the one outcome worse than losing the report.
 */
export function saveFeedbackLocally(
  cwd: string,
  input: { kind?: string; source?: string },
  text: string,
  context: Partial<Feedback>,
  now: number = Date.now(),
): SavedFeedback | undefined {
  try {
    const dir = join(cwd, ReticleDir.ROOT, FEEDBACK_SUBDIR);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${stamp(now)}-${input.kind ?? 'note'}.md`);
    writeFileSync(path, asMarkdown(input, text, context), 'utf8');
    return {
      path,
      // `--body-file` rather than an inlined body: the report contains newlines, quotes and JSON,
      // and a command somebody has to repair before running is a command they do not run.
      command: `gh issue create --repo reticlehq/reticle --title "Reticle feedback: ${input.kind ?? 'note'}" --body-file "${path}"`,
    };
  } catch {
    return undefined;
  }
}
