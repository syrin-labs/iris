import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { scanPackage } from '../../../scripts/orphan-scan.mjs';

/**
 * A module that nothing imports must be declared unwired, not discovered later as dead code.
 *
 * This test does not ban orphans. It requires every deliberate orphan to be named with the reason
 * it remains, and fails when a production module becomes unreachable without that decision.
 *
 * The scan lives in `scripts/orphan-scan.mjs` so every package asks the same question the same way,
 * and so entry points are derived from this package's `exports` map rather than a literal
 * `index.ts` (#548).
 */

const PACKAGE_DIR = join(__dirname, '..');

/** Modules with no production importer, each with the reason it is allowed to stay. */
const DECLARED_UNWIRED: Record<string, string> = {
  'presenter/presenter-test-helpers.ts':
    'Test-only DOM and presenter builders shared by presenter specs. Production code has no ' +
    'reason to import test fixture construction.',
};

describe('no undeclared orphan modules', () => {
  const { orphans, stale } = scanPackage(PACKAGE_DIR, DECLARED_UNWIRED);

  it('every module without a production importer is declared, with a reason', () => {
    expect(orphans).toEqual([]);
  });

  it('every declared entry is still an orphan — a wired one must be removed from the list', () => {
    expect(stale).toEqual([]);
  });
});
