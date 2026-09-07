/**
 * A known parameter with a nonsense value must be refused, not silently dropped.
 *
 * Reticle already refuses an UNKNOWN parameter with the strongest sentence in the product:
 * "They were NOT applied — a result computed without them would look like an answer." A KNOWN
 * parameter carrying a value the code cannot honour is the same failure with better manners: the
 * agent asked for something, did not get it, and was told nothing.
 *
 * Measured live on 2026-08-23:
 *
 *   reticle_state { depth: -5 }   -> ACCEPTED, full unscoped state returned
 *   reticle_network { limit: -1 } -> refused (`.nonnegative()`)
 *   reticle_network { limit: 0 }  -> accepted
 *
 * Three policies for one class of argument on one surface. `depth` was declared as a bare
 * `z.number()`, so a negative depth passed validation and was then ignored downstream — the agent
 * asked to scope a large read, the scoping silently did not happen, and it paid for the whole store
 * while believing it had asked for two levels.
 *
 * Scoped deliberately to `depth`. A blanket rule across every numeric input would be wrong:
 * `since: 0` is a legitimate cursor, and `threshold` on the visual diff is a ratio between 0 and 1.
 * The remaining input parameters need the same judgement applied one at a time, which is a sweep
 * rather than a one-line change.
 */

import { describe, expect, it } from 'vitest';
import { READ_TOOLS } from './read-tools.js';
import { ReticleTool } from './tool-names.js';

const depth = READ_TOOLS.find((t) => ReticleTool.STATE === t.name)?.inputSchema['depth'];

describe('reticle_state depth', () => {
  it('is declared at all', () => {
    expect(depth).toBeDefined();
  });

  it('refuses a negative depth instead of ignoring it', () => {
    expect(depth?.safeParse(-5).success).toBe(false);
  });

  it('refuses zero — a zero-level read is not a read', () => {
    expect(depth?.safeParse(0).success).toBe(false);
  });

  it('refuses a fractional depth, which has no meaning for tree levels', () => {
    expect(depth?.safeParse(2.5).success).toBe(false);
  });

  it('still takes the value the tool documents', () => {
    // `example: { depth: 2 }` — the documented call must keep working.
    expect(depth?.safeParse(2).success).toBe(true);
  });

  it('still takes a large depth, which is a scope choice and not an error', () => {
    expect(depth?.safeParse(50).success).toBe(true);
  });

  it('stays optional — omitting it reads unscoped, as documented', () => {
    expect(depth?.safeParse(undefined).success).toBe(true);
  });
});
