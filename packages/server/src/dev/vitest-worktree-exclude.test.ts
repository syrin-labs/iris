/**
 * A root `vitest run` must not collect tests from other agents' worktrees.
 *
 * Those directories are full checkouts of other branches. Their failures are real for those
 * branches and meaningless for this one. `pnpm test:unit` is safe — turbo scopes per package —
 * but `pnpm vitest run <file>` from the repo root is exactly how someone narrows to one file,
 * and without an exclude it walks every worktree and reports those failures as this checkout's.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CLAUDE_WORKTREES = '.claude/worktrees';
const PROBE_DIR = 'exclude-probe';
const PROBE_FILE = 'must-not-run.test.ts';
const PROBE_SENTINEL = 'root vitest collected a test from an agent worktree';
const ROOT_CONFIG = 'vitest.config.ts';
const CLAUDE_WORKTREE_GLOB = '**/.claude/worktrees/**';
const CURSOR_WORKTREE_GLOB = '**/.cursor/worktrees/**';
const NODE_MODULES_GLOB = '**/node_modules/**';
const PASS_WITH_NO_TESTS = '--passWithNoTests';
const VITEST_RUN = 'run';
const SPAWN_TIMEOUT_MS = 30_000;
/**
 * The test's own deadline, derived from the spawn's so the two cannot drift apart.
 *
 * It had none, so it inherited vitest's 5s default while the child it waits for was allowed 30s —
 * a deadline shorter than the work it was measuring. On Windows, where booting a nested vitest is
 * several times slower than on POSIX (the parent run's collect phase alone is minutes), it timed
 * out on the harness rather than on the behaviour, and reported a red `windows` job on unrelated
 * pull requests until somebody re-ran it.
 *
 * The property under test is a BOUND — the planted test is not collected — and that is asserted
 * below. Nothing here is a statement about how fast a machine is, which is the only kind of timing
 * assertion this repo allows.
 */
const TEST_TIMEOUT_MS = SPAWN_TIMEOUT_MS + 15_000;
const VITEST_PACKAGE_JSON = 'vitest/package.json';
const VITEST_BIN = 'vitest.mjs';
/**
 * Drive the CLI with `node <resolved vitest.mjs>`, not `pnpm exec`. On Windows `pnpm` is a `.cmd`
 * shim; `spawnSync('pnpm', …)` without a shell returns `status: null` (ENOENT) and the assertion
 * reads as the exclude failing. POSIX never saw it. Resolve the binary through Node: a hardcoded
 * path under the install tree is what the turbo-input guard treats as a repo-root read, and listing
 * that tree as a cache input would bust the key on every install.
 */
const VITEST_CLI = join(
  dirname(createRequire(import.meta.url).resolve(VITEST_PACKAGE_JSON)),
  VITEST_BIN,
);

const planted = join(REPO, CLAUDE_WORKTREES, PROBE_DIR);

afterEach(() => {
  rmSync(planted, { recursive: true, force: true });
});

describe('root vitest excludes agent worktrees', () => {
  it(
    'does not run a failing test planted in a Claude worktree',
    () => {
      mkdirSync(planted, { recursive: true });
      writeFileSync(
        join(planted, PROBE_FILE),
        `import { it } from 'vitest';\nit('must not be collected', () => { throw new Error(${JSON.stringify(PROBE_SENTINEL)}); });\n`,
      );

      const result = spawnSync(
        process.execPath,
        [VITEST_CLI, VITEST_RUN, PASS_WITH_NO_TESTS, CLAUDE_WORKTREES],
        { cwd: REPO, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS },
      );
      const spawnErr =
        undefined === result.error ? '' : `${result.error.name}: ${result.error.message}`;
      const output = `${spawnErr}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      expect(result.status, output).toBe(0);
      expect(output).not.toContain(PROBE_SENTINEL);
    },
    TEST_TIMEOUT_MS,
  );

  it('keeps vitest defaults and names both in-repo agent worktree trees', async () => {
    const mod = (await import(pathToFileURL(join(REPO, ROOT_CONFIG)).href)) as {
      default: { test?: { exclude?: string[] } };
      AGENT_WORKTREE_GLOBS: readonly string[];
    };
    const exclude = mod.default.test?.exclude ?? [];
    expect(mod.AGENT_WORKTREE_GLOBS).toEqual([CLAUDE_WORKTREE_GLOB, CURSOR_WORKTREE_GLOB]);
    expect(exclude).toEqual(
      expect.arrayContaining([...mod.AGENT_WORKTREE_GLOBS, NODE_MODULES_GLOB]),
    );
  });
});
