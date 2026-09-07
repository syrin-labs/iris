/**
 * `reticle gate` has to tell "you broke something" apart from "there was nothing to check".
 *
 * The gate exits non-zero over an empty suite on purpose, and the reason is sound: an empty state
 * is otherwise indistinguishable from success, and a CI job that goes green because a project has
 * no flows is the false green this whole product exists to prevent.
 *
 * That is correct for CI and unusable for a Stop hook. A hook that runs the gate when an agent
 * finishes would block a fresh project — no flows recorded yet, which is every project on day one —
 * on every single stop. Measured before building it:
 * `gate` in a git repo with no `.reticle` exits 1 whether or not anything changed.
 *
 * So the two cases get two codes. `1` keeps meaning a real failure: an affected flow with no
 * passing artifact, an assertion downgraded, coverage deleted. `2` means the gate ran and had
 * nothing to judge. Anything treating non-zero as failure — every CI script — is unaffected,
 * because 2 is still non-zero. A caller that wants to distinguish now can.
 */

import { describe, expect, it } from 'vitest';
import { GateExit } from './gate-exit.js';

describe('the gate distinguishes a failure from an absence', () => {
  it('passes with 0', () => {
    expect(GateExit.PASS).toBe(0);
  });

  it('fails with 1, so every `if gate` script keeps working', () => {
    expect(GateExit.FAIL).toBe(1);
  });

  it('reports nothing-to-check with its own code', () => {
    expect(GateExit.NOTHING_TO_CHECK).not.toBe(GateExit.FAIL);
    expect(GateExit.NOTHING_TO_CHECK).not.toBe(GateExit.PASS);
  });

  /**
   * The property that matters for CI: an empty suite must still not read as success. The whole
   * reason the gate exits non-zero there is that "nothing was checked" and "everything passed"
   * look identical from the outside.
   */
  it('keeps nothing-to-check NON-zero, so it can never be mistaken for a pass', () => {
    expect(GateExit.NOTHING_TO_CHECK).toBeGreaterThan(0);
  });
});
