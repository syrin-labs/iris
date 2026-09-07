import { defineConfig, configDefaults } from 'vitest/config';

/**
 * Agent git worktrees are full copies of the tree. A root `vitest run` that does not
 * exclude them collects their tests and reports those branches' failures as this checkout's.
 * `pnpm test:unit` never hits this — turbo scopes per package — which is why it stayed hidden.
 */
export const AGENT_WORKTREE_GLOBS = ['**/.claude/worktrees/**', '**/.cursor/worktrees/**'] as const;

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ...AGENT_WORKTREE_GLOBS],
  },
});
