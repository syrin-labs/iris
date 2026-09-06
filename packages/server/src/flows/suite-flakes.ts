/**
 * Accrue a suite run's outcomes into the flake ledger, and report what the ledger knows.
 *
 * This existed twice — once in `flow_verify`'s sequential branch and once, after #240, in its
 * parallel branch. That duplication is not incidental: the parallel branch shipped WITHOUT it, so an
 * agent verifying in parallel built no flake evidence at all and never saw the quarantine set, and
 * nothing went red because the other copy was still correct. One function both branches call is what
 * makes that miss impossible on one side only.
 *
 * It is also what makes the behaviour testable. The handler itself needs a live browser session, so
 * both branches were only ever pinned by tests that RE-IMPLEMENTED this loop — which passed with the
 * shipped code reverted (measured on #240: 4/4 green with the fix absent). Extracted, the real thing
 * runs in a unit test.
 *
 * Best-effort on both halves, deliberately: a flake ledger is memory, not a gate. A full disk must
 * never turn a working verification into an error.
 */
import { ReplayStatus } from '@reticlehq/core';
import { FlakeStore } from './flake-store.js';
import type { FileSystemPort } from '../project/fs-port.js';

/** Just the shape this needs from a replay — so a test does not have to build a whole result. */
interface FlakeOutcome {
  readonly name: string;
  readonly status: ReplayStatus;
}

/**
 * Record every outcome, then ask which flows are intermittent.
 *
 * Anything that is not `OK` — `ERROR` or `DRIFT` — counts as a failure for the ledger. That is the
 * rule both call sites already used, preserved rather than chosen here.
 */
export async function recordSuiteFlakes(
  fs: FileSystemPort,
  reticleRoot: string,
  runs: readonly { readonly replay: FlakeOutcome }[],
): Promise<readonly string[]> {
  const flakes = new FlakeStore(fs, reticleRoot);
  for (const { replay } of runs) {
    await flakes.record(replay.name, ReplayStatus.OK === replay.status).catch(() => undefined);
  }
  return flakes.flakyFlows().catch(() => []);
}
