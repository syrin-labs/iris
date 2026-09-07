/**
 * An existing install must be able to receive better instructions.
 *
 * `mergeMarkedInstruction` has always been able to update the managed block — marker-delimited,
 * idempotent by comparing CONTENT rather than by seeing a marker, and everything outside the
 * markers left exactly as the human wrote it. What was missing is anything that calls it after the
 * first install.
 *
 * Measured: it is reachable from `buildPlan` only, and `reticle update` touches three things —
 * the server package, the app's SDK deps, and the daemon restart. `CLAUDE.md` and `AGENTS.md`
 * appear nowhere in it.
 *
 * So a project set up on an older release keeps that release's rules forever, and every improvement
 * to them reaches new projects only. That is backwards: the people who most need better
 * instructions are the ones already installed and not getting value from it.
 */

import { describe, expect, it } from 'vitest';
import { refreshAgentRules, RULE_FILES } from './refresh-rules.js';
import { markedBlock } from './agent-rules.js';

/**
 * An in-memory instruction file set, so nothing here touches a real disk.
 *
 * The basename is taken on EITHER separator. The first version split on '/' alone, which is a
 * POSIX assumption in a stub standing in for a filesystem: `refreshAgentRules` builds its paths
 * with `join`, so on Windows it asks for `\app\CLAUDE.md`, the split returns the whole string,
 * every lookup misses and the refresh reports that it found nothing to update.
 *
 * Green on macOS, red on the Windows CI job, and the failure looked exactly like the product being
 * broken — three tests asserting the block was rewritten, all reporting it was not. The product was
 * fine; the stub was lying about what a path is.
 */
const basename = (p: string) => p.split(/[\\/]/).pop() ?? '';

function io(files: Record<string, string>) {
  const written: Record<string, string> = {};
  return {
    written,
    read: (p: string) => files[basename(p)] ?? null,
    write: (p: string, c: string) => {
      written[basename(p)] = c;
    },
  };
}

const STALE = [
  '# My project',
  '',
  'Some notes I wrote myself.',
  '',
  '<!-- reticle:begin (managed by `reticle init` — edit outside these markers) -->',
  '## Verifying with Reticle',
  'An old rule from a previous release.',
  '<!-- reticle:end -->',
  '',
  'More of my own notes, after the block.',
].join('\n');

describe('a stale block is brought up to date', () => {
  it('rewrites the managed block', () => {
    const f = io({ 'CLAUDE.md': STALE });
    const r = refreshAgentRules('/app', f);
    expect(r.updated).toContain('CLAUDE.md');
    expect(f.written['CLAUDE.md']).toContain('do not stop until a verdict exists');
  });

  /**
   * The property that makes doing this automatically safe at all. A user's own notes live outside
   * the markers, and silently rewriting somebody's instruction file would be far worse than a
   * stale rule.
   */
  it('leaves every character outside the markers alone', () => {
    const f = io({ 'CLAUDE.md': STALE });
    refreshAgentRules('/app', f);
    const out = f.written['CLAUDE.md'] ?? '';
    expect(out).toContain('Some notes I wrote myself.');
    expect(out).toContain('More of my own notes, after the block.');
    expect(out.startsWith('# My project')).toBe(true);
  });

  it('updates both instruction files', () => {
    const f = io({ 'CLAUDE.md': STALE, 'AGENTS.md': STALE });
    expect(refreshAgentRules('/app', f).updated).toEqual([...RULE_FILES]);
  });
});

describe('it changes nothing it should not', () => {
  it('reports a current block as unchanged and writes nothing', () => {
    // The real block, from the same source init writes — not a hand-typed marker.
    const current = markedBlock();
    const f = io({ 'CLAUDE.md': current });
    expect(refreshAgentRules('/app', f).updated).toEqual([]);
    expect(Object.keys(f.written)).toEqual([]);
  });

  /**
   * `update` is a version command. A file with no Reticle block either never ran `init` here or had
   * the block removed deliberately, and quietly writing instructions into a file somebody curates
   * would be a surprise. That decision belongs to `init`.
   */
  it('does NOT create a block where none exists', () => {
    const f = io({ 'CLAUDE.md': '# Just my own notes\n' });
    expect(refreshAgentRules('/app', f).updated).toEqual([]);
    expect(Object.keys(f.written)).toEqual([]);
  });

  it('does nothing when the files are absent', () => {
    const f = io({});
    expect(refreshAgentRules('/app', f).updated).toEqual([]);
  });

  /**
   * A begin marker with no end is malformed. Rewriting from the marker to end-of-file would eat
   * whatever came after it, so the existing code reports ALREADY and leaves it — pinned here
   * because this path now runs without anybody asking for it.
   */
  it('leaves a malformed block untouched rather than guessing where it ends', () => {
    const f = io({
      'CLAUDE.md':
        '<!-- reticle:begin (managed by `reticle init` — edit outside these markers) -->\nhalf a block\n\nmy own notes',
    });
    expect(refreshAgentRules('/app', f).updated).toEqual([]);
    expect(Object.keys(f.written)).toEqual([]);
  });
});
