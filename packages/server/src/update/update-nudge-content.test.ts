import { describe, expect, it } from 'vitest';
import { buildNudge } from './update-nudge.js';

/**
 * The update nudge must say what the update CONTAINS, and warn when it breaks something.
 *
 * `packages/server/package.json` carries `reticle.changelog` and `reticle.breakingChanges`, and
 * `update-checker` faithfully parses both into the manifest — where they stopped. `buildNudge` only
 * ever named two version numbers, so both fields were written, shipped, parsed and then discarded.
 * Latent metadata nobody printed.
 *
 * That is survivable while releases are additive and actively harmful for one that is not: this
 * release retires an environment variable, makes six parameters reject values they used to accept,
 * and changes what `isError` is set on. An agent told only "2.4.1 → 2.5.0" will run `reticle update`
 * mid-task and discover the rest by breaking.
 */
describe('the update nudge carries the release, not just its number', () => {
  it('still names both versions and the exact command', () => {
    const nudge = buildNudge('2.5.0', '2.4.1');
    expect(nudge.action).toContain('2.4.1');
    expect(nudge.action).toContain('2.5.0');
    expect(nudge.command).toBe('reticle update');
  });

  it('includes the changelog line when the manifest has one', () => {
    const nudge = buildNudge('2.5.0', '2.4.1', {
      changelog: 'Tools refuse instead of answering wrongly.',
    });
    expect(nudge.action).toContain('Tools refuse instead of answering wrongly.');
  });

  it('WARNS when the release has breaking changes, and lists them', () => {
    const nudge = buildNudge('2.5.0', '2.4.1', {
      breakingChanges: ['RETICLE_TOOL_PROFILE is retired', 'select refuses an unmatched option'],
    });
    expect(nudge.action).toMatch(/breaking/i);
    expect(nudge.action).toContain('RETICLE_TOOL_PROFILE is retired');
    expect(nudge.action).toContain('select refuses an unmatched option');
  });

  it('says nothing about breaking changes when there are none', () => {
    // A warning that fires on every release is a warning nobody reads.
    expect(buildNudge('2.5.0', '2.4.1', { breakingChanges: [] }).action).not.toMatch(/breaking/i);
    expect(buildNudge('2.5.0', '2.4.1').action).not.toMatch(/breaking/i);
  });

  it('stays bounded — this rides on a tool result, every turn until delivered', () => {
    const nudge = buildNudge('2.5.0', '2.4.1', {
      changelog: 'x'.repeat(5_000),
      breakingChanges: Array.from({ length: 50 }, (_, i) => `breaking change number ${String(i)}`),
    });
    expect(nudge.action.length).toBeLessThan(1_200);
  });
});

describe('the nudge names what update does to the RULE FILES', () => {
  /**
   * The half nobody would guess. A release changes what the always-loaded instructions should say —
   * that is the entire reason `refreshAgentRules` exists — and an agent reading "it restarts the
   * daemon" has no reason to think its CLAUDE.md is a release behind.
   *
   * This is also the answer to "how does an installed fleet learn its rules changed" WITHOUT a new
   * feature. The nudge already rides every tool result until delivered, already carries the
   * changelog and the breaking changes, and already names the command. It only had to say what the
   * command does.
   */
  it('says update refreshes the project rule files, not just the daemon', () => {
    const nudge = buildNudge('2.13.0', '2.12.0');
    expect(nudge.action).toMatch(/CLAUDE\.md/);
    expect(nudge.action).toMatch(/refreshes/i);
  });

  it('still names the command and the restart caveat', () => {
    const nudge = buildNudge('2.13.0', '2.12.0');
    expect(nudge.command).toBe('reticle update');
    expect(nudge.action).toMatch(/between tasks rather than mid-verification/);
  });
});
