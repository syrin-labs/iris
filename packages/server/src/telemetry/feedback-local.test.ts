/**
 * A refusal must not be the end of the road.
 *
 * The report is written and redacted before delivery is even attempted, so discarding it on a
 * refusal punishes exactly the behaviour this channel exists to encourage — and it hits hardest
 * where the reports are best, because a Reticle source checkout disables telemetry by cwd.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import { saveFeedbackLocally } from './feedback-local.js';

const NOW = Date.parse('2026-08-26T11:22:33.444Z');

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'reticle-fb-'));
});

describe('a report that cannot be sent is written down', () => {
  it('writes it under the workspace, not a temp dir nobody is told about', () => {
    const saved = saveFeedbackLocally(cwd, { kind: 'gap' }, 'the thing broke', {}, NOW);
    expect(saved?.path.startsWith(join(cwd, ReticleDir.ROOT, 'feedback'))).toBe(true);
    expect(existsSync(saved?.path ?? '')).toBe(true);
  });

  it('keeps the author’s text verbatim', () => {
    const saved = saveFeedbackLocally(
      cwd,
      { kind: 'bug' },
      'reticle_query returned nothing',
      {},
      NOW,
    );
    expect(readFileSync(saved?.path ?? '', 'utf8')).toContain('reticle_query returned nothing');
  });

  it('keeps the context, which is the half a human cannot reconstruct', () => {
    const saved = saveFeedbackLocally(
      cwd,
      { kind: 'gap' },
      'x',
      { stack: 'react', client: 'claude-code' },
      NOW,
    );
    const body = readFileSync(saved?.path ?? '', 'utf8');
    expect(body).toContain('react');
    expect(body).toContain('claude-code');
  });

  it('hands back a command that runs as written', () => {
    // A command somebody has to repair before running is a command they do not run. `--body-file`
    // because the report contains newlines, quotes and JSON.
    const saved = saveFeedbackLocally(cwd, { kind: 'gap' }, 'x', {}, NOW);
    expect(saved?.command).toContain('gh issue create');
    expect(saved?.command).toContain('--body-file');
    expect(saved?.command).toContain(saved?.path ?? 'MISSING');
  });

  it('names the file by kind and time, so two reports never collide', () => {
    saveFeedbackLocally(cwd, { kind: 'gap' }, 'a', {}, NOW);
    saveFeedbackLocally(cwd, { kind: 'bug' }, 'b', {}, NOW + 1000);
    const files = readdirSync(join(cwd, ReticleDir.ROOT, 'feedback'));
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.includes('gap'))).toBe(true);
    expect(files.some((f) => f.includes('bug'))).toBe(true);
  });

  it('uses a filesystem-safe name — a raw ISO timestamp is not one on every platform', () => {
    const saved = saveFeedbackLocally(cwd, { kind: 'gap' }, 'x', {}, NOW);
    // The NAME, not the path: every Windows absolute path carries a drive-letter colon, so asserting
    // over the whole path failed on the one platform this invariant exists for.
    expect(basename(saved?.path ?? '')).not.toContain(':');
  });

  it('creates the directory when the workspace has never had one', () => {
    expect(saveFeedbackLocally(cwd, { kind: 'note' }, 'x', {}, NOW)).toBeDefined();
  });

  it('returns undefined rather than throwing when the path is unwritable', () => {
    // A feedback save that throws would take down the tool call that was reporting a problem, which
    // is the one outcome worse than losing the report.
    const saved = saveFeedbackLocally('\0not-a-path', { kind: 'gap' }, 'x', {}, NOW);
    expect(saved).toBeUndefined();
  });
});
