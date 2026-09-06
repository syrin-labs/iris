import { describe, expect, it } from 'vitest';
import { PackageManager } from './detect.js';
import { installFailureHint } from './install-hint.js';

describe('installFailureHint', () => {
  /**
   * Reported in #683: a pnpm checkout whose node_modules is symlinked into another checkout's
   * `.pnpm` store (a git worktree, or an A/B harness) makes `pnpm add` die with
   * ERR_PNPM_UNEXPECTED_VIRTUAL_STORE. The hint named only ERR_PNPM_NO_MATURE_MATCHING_VERSION,
   * so a symlinked-store user got guidance that did not match what they were seeing.
   */
  it('names ERR_PNPM_UNEXPECTED_VIRTUAL_STORE and points at installing in the worktree first', () => {
    const hint = installFailureHint(PackageManager.PNPM);
    expect(hint).toContain('ERR_PNPM_UNEXPECTED_VIRTUAL_STORE');
    expect(hint).toContain('pnpm install');
  });

  it('still names ERR_PNPM_NO_MATURE_MATCHING_VERSION (no regression)', () => {
    const hint = installFailureHint(PackageManager.PNPM);
    expect(hint).toContain('ERR_PNPM_NO_MATURE_MATCHING_VERSION');
    expect(hint).toContain('minimumReleaseAgeExclude');
  });

  it('does not mention pnpm-specific error codes for a non-pnpm package manager', () => {
    const hint = installFailureHint(PackageManager.NPM);
    expect(hint).not.toContain('ERR_PNPM');
  });
});
