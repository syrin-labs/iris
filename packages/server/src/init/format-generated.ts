/**
 * Format a file `init` is about to write, using the project's own Prettier when it is installed.
 *
 * Reported from the field (#684): a clean CRA install failed the project's own lint because
 * `src/reticle-dev.ts` was emitted as one long line. The project already had Prettier; init never
 * asked it. Best-effort: resolve Prettier from the app (not from ours — we do not ship it), apply
 * its config, and on any failure return the original content so init never fails because of a
 * formatter. Sync only — `applyEffects` is sync, and Prettier 3's async `format` cannot join here.
 */

import { createRequire } from 'node:module';
import { basename, join } from 'node:path';

/** Basenames of full-file generators that a project's lint will see. */
const GENERATED_SOURCE_NAMES = new Set(['reticle-dev.ts', 'reticle-dev.tsx', 'hooks.client.ts']);

/** True when this write is a connect/dev module lint will treat as project source. */
export function isGeneratedSourcePath(relPath: string): boolean {
  return GENERATED_SOURCE_NAMES.has(basename(relPath));
}

interface PrettierLike {
  format: (source: string, options: Record<string, unknown>) => string | Promise<string>;
  resolveConfig: {
    sync?: (filePath: string) => Record<string, unknown> | null;
  };
}

/**
 * Format `content` for `relPath` under `projectRoot`, or return it unchanged.
 *
 * Only the sync Prettier API is used. Prettier 3's async `format` is skipped (returns the original)
 * rather than holding init open on a promise `applyEffects` cannot await.
 */
export function formatGeneratedSource(
  content: string,
  relPath: string,
  projectRoot: string,
): string {
  if (!isGeneratedSourcePath(relPath)) return content;
  try {
    const require = createRequire(join(projectRoot, 'package.json'));
    const prettier = require('prettier') as PrettierLike;
    const filePath = join(projectRoot, relPath);
    const resolved = prettier.resolveConfig.sync?.(filePath) ?? {};
    const formatted = prettier.format(content, { ...resolved, filepath: filePath });
    // Prettier 2 returns a string; Prettier 3 returns a Promise we cannot join from sync code.
    return 'string' === typeof formatted ? formatted : content;
  } catch {
    return content;
  }
}
