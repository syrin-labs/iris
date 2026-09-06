import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { scanPackage } from '../../../scripts/orphan-scan.mjs';

/**
 * A module that nothing imports must be DECLARED unwired, not discovered by an auditor.
 *
 * Four modules sat in the tree with doc comments written in the present tense — describing behaviour
 * the product does not have. The worst claimed "the server snapshots registered store paths + storage
 * keys BEFORE dispatching an action and again after", which nothing does; anyone reading the source to
 * evaluate the product would conclude that fallback exists. Dead code is cheap; dead code that asserts
 * it is alive is a lie told to the next reader.
 *
 * This test does not ban orphans — some are staged work with real tests, and deleting them would throw
 * away sound code. It bans UNDECLARED orphans: to add one you must name it here, which is exactly the
 * moment to ask whether it should be wired or removed.
 *
 * The scan lives in `scripts/orphan-scan.mjs` so every package asks the same question the same way,
 * and so entry points are derived from this package's `exports` map rather than a literal
 * `index.ts` (#548).
 */

const PACKAGE_DIR = join(__dirname, '..');

/** Modules with no production importer, each with the reason it is allowed to stay. */
const DECLARED_UNWIRED: Record<string, string> = {
  'dev/stale-issue-guard.ts':
    'decision logic for scripts/check-stale-issues.mjs, which runs in CI and imports it from dist. ' +
    'A repo-hygiene guard has no caller inside the product by definition; the unit tests are here ' +
    'so the rule is testable without a network or a repo.',
  'session/fake-session.ts':
    'test-only Session factory. Returns a REAL Session with inert defaults so a new method on the ' +
    'class arrives with a working default instead of undefined in seven stub files (#726); ' +
    'imported by specs, which this scan deliberately does not count as production importers.',
  'project/memory-fs.ts':
    'test-only in-memory FileSystemPort. Extracted after a third spec hand-rolled its own copy; ' +
    'imported by specs, which this scan deliberately does not count as production importers.',
  'capsule/minimize.ts':
    'Pure prefix-trim for bug capsules, unit-tested. Ready to wire into capsule save; not yet called.',
  'flows/flow-report.ts':
    'Mermaid confidence report. No caller can produce it today — needs a CLI or tool surface first.',
  'phenomena/phenomena.ts':
    'Phenomenon classification over journal actions. Staged for the deviation reporter; not yet called.',
  'temp-dir.ts':
    'Test-only teardown helper: removing a temp directory tolerantly of Windows’ delayed handle ' +
    'release. Production code never deletes a temp tree, so a production importer would be the ' +
    'surprise here — it is imported by ~30 test files and belongs to src only because that is where ' +
    'the tsconfig can see it.',
  'ee/audit-log.ts':
    'Enterprise audit hook, a self-admitted pass-through stub. Nothing calls it; the license gate that ' +
    'would is real, but this consumer is not implemented.',
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
