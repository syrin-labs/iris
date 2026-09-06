/**
 * One ledger per project, not one per daemon.
 *
 * The bug this pins, measured against a real deployment: with the daemon rooted at repo A, two
 * verdicts driven against app B landed in A's `impact.json` — B's own ledger never moved at all —
 * and A's cloud link then carried them to a PRODUCTION dashboard belonging to a different account
 * than B was linked to. The impact ledger is what the whole dashboard is computed from, so this was
 * the one artifact whose misrouting was certain to be seen and billed.
 *
 * `artifactRootFor` had existed for exactly this reason, and nine modules already used it. The
 * recorder was a module singleton whose comment described first-root-wins as a design decision.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  impactSnapshot,
  impactStore,
  initImpact,
  recordImpact,
  resetImpactForTest,
} from './impact-recorder.js';

const root = (): string => mkdtempSync(join(tmpdir(), 'impact-root-'));

/**
 * Verdicts recorded against one root, read from the in-memory scope.
 *
 * Deliberately NOT read back off disk: the store debounces its flush, so a file read would be an
 * assertion about a timer rather than about routing, and would fail only under load. The scope is
 * the same value the flush eventually writes.
 */
const verdictsIn = (dir: string): number =>
  impactStore(dir)?.snapshot().project.counts.verdicts ?? 0;

afterEach(() => {
  resetImpactForTest();
});

describe('impact is recorded per project root', () => {
  it("keeps two projects' ledgers apart when one daemon serves both", () => {
    const daemonRoot = root();
    const otherApp = root();
    initImpact({ reticleRoot: daemonRoot });

    recordImpact({ calls: 1, verdicts: 1, passed: 1 }, {}, daemonRoot);
    recordImpact({ calls: 1, verdicts: 1, failed: 1 }, {}, otherApp);

    expect(verdictsIn(daemonRoot)).toBe(1);
    expect(verdictsIn(otherApp)).toBe(1);
  });

  it("does NOT write another app's verdict into the daemon's own ledger", () => {
    // The exact failure, stated as the thing that must not happen. Before the fix the daemon root
    // took both and the other app's ledger stayed at zero.
    const daemonRoot = root();
    const otherApp = root();
    initImpact({ reticleRoot: daemonRoot });

    recordImpact({ calls: 1, verdicts: 1, passed: 1 }, {}, otherApp);

    expect(verdictsIn(daemonRoot)).toBe(0);
    expect(verdictsIn(otherApp)).toBe(1);
  });

  it('falls back to the daemon root when a call cannot name its project', () => {
    // Not every counter has a session to ask. Those keep the old behaviour rather than being
    // dropped: an unattributed count is worth less than an attributed one and more than none.
    const daemonRoot = root();
    initImpact({ reticleRoot: daemonRoot });

    recordImpact({ calls: 1, verdicts: 1, passed: 1 });

    expect(verdictsIn(daemonRoot)).toBe(1);
  });

  it('reads back the snapshot for the root asked for, not whichever was first', () => {
    const daemonRoot = root();
    const otherApp = root();
    initImpact({ reticleRoot: daemonRoot });
    recordImpact({ calls: 1, verdicts: 1, passed: 1 }, {}, daemonRoot);
    recordImpact({ calls: 2, verdicts: 2, failed: 2 }, {}, otherApp);

    expect(impactSnapshot(daemonRoot)?.project.counts.verdicts).toBe(1);
    expect(impactSnapshot(otherApp)?.project.counts.verdicts).toBe(2);
    // Omitted still means the daemon's own, so a caller that never learned about roots is unchanged.
    expect(impactSnapshot()?.project.counts.verdicts).toBe(1);
  });

  it('records nothing, and throws nothing, when no root is known at all', () => {
    // Programmatic callers and test doubles are not obliged to carry a root, and a courtesy counter
    // must never be the reason a tool call fails.
    expect(() => recordImpact({ calls: 1 })).not.toThrow();
    expect(impactSnapshot()).toBeUndefined();
  });

  it('keeps the daemon root stable once set, so a later init cannot move the fallback', () => {
    const first = root();
    const second = root();
    initImpact({ reticleRoot: first });
    initImpact({ reticleRoot: second });

    recordImpact({ calls: 1, verdicts: 1, passed: 1 });

    expect(verdictsIn(first)).toBe(1);
    expect(verdictsIn(second)).toBe(0);
  });
});
