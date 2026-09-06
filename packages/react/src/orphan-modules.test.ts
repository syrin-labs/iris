import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { scanPackage } from '../../../scripts/orphan-scan.mjs';

/**
 * A module that nothing imports must be DECLARED unwired, not discovered later by an auditor.
 *
 * This package publishes two entry points, `.` and `./store`, and `docs/usage.md` tells users to
 * import the second one directly. A guard that assumed `index.ts` was the only entry would have
 * reported `store.ts` — a documented, published hook — as dead code on its first run.
 *
 * The scan itself lives in `scripts/orphan-scan.mjs` so every package asks the same question the
 * same way, and so entry points come from this package's own `exports` map rather than a literal
 * `index.ts` (#548).
 */

const PACKAGE_DIR = join(__dirname, '..');

/** Modules with no production importer, each with the reason it is allowed to stay. */
const DECLARED_UNWIRED: Record<string, string> = {};

describe('no undeclared orphan modules', () => {
  const { orphans, stale } = scanPackage(PACKAGE_DIR, DECLARED_UNWIRED);

  it('every module without a production importer is declared, with a reason', () => {
    expect(orphans).toEqual([]);
  });

  it('every declared entry is still an orphan — a wired one must be removed from the list', () => {
    expect(stale).toEqual([]);
  });
});
