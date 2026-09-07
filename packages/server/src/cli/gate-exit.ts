/**
 * What `reticle gate` means by its exit code.
 *
 * Split out of the handler because two different readers depend on it and they want opposite
 * things. CI wants any problem to be a failure. A Stop hook — the layer that makes verification
 * unskippable — wants to block a real regression and NOT block a project that has simply not
 * recorded a flow yet, which is every project on its first day.
 *
 * `NOTHING_TO_CHECK` stays non-zero deliberately. The gate exits non-zero over an empty suite
 * because "nothing was checked" and "everything passed" are indistinguishable from the outside,
 * and that reasoning does not stop being true just because a second caller appeared.
 */
export const GateExit = {
  /** Affected flows were checked and hold. */
  PASS: 0,
  /** Something is actually wrong: an affected flow with no passing artifact, a downgraded
   * assertion, deleted coverage. A caller should stop here. */
  FAIL: 1,
  /** The gate ran and had nothing to judge — no flows recorded. Non-zero, but not a regression. */
  NOTHING_TO_CHECK: 2,
} as const;
