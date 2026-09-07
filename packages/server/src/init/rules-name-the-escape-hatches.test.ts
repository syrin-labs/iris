/**
 * The one file an agent re-reads every turn must name the values and tools it will actually meet.
 *
 * `RULE_BODY` is written into CLAUDE.md / AGENTS.md / the Cursor rule, so it is the only Reticle
 * text that survives a compaction. Everything else — SKILL.md, the cheat sheet, usage.md, the MCP
 * handshake — is paid once and lost. Measured on this branch, it named nine tools out of the
 * forty-five callable, and did not name:
 *
 *   `no-fault`      a verdict value that is NOT a pass
 *   `reticle_run`   the only route to the ~30 tools the default surface does not advertise
 *   `reticle_context` the run's own memory, which is what an agent needs precisely when its own is gone
 *   `reticle_intent`  what a change was meant to do, captured while somebody still knows
 *
 * `no-fault` became urgent with the undeclared-verdict fix. Before it, an `act_and_wait` with no
 * `until` returned `verified:"yes"`; it now correctly returns `no-fault`. That moves a value an
 * agent had rarely seen onto the most common path in the product — so a rules file that explains
 * `unknown` and not `no-fault` now hands the agent a verdict it has no instruction for, and the
 * plain-English reading of "no fault" is "nothing wrong", i.e. a pass. That is the exact
 * misreading this file exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import { RULE_BODY } from './agent-rules.js';

describe('the every-turn rules name the verdict values an agent will meet', () => {
  it('names `no-fault`, now that the undeclared path returns it', () => {
    expect(RULE_BODY).toContain('no-fault');
  });

  it('says plainly that no-fault is not a pass', () => {
    // The words matter: "no fault" reads as "nothing wrong" to anyone who has not been told.
    const near = RULE_BODY.slice(RULE_BODY.indexOf('no-fault'));
    expect(near.slice(0, 400)).toMatch(/not a pass|never as working|is not verification/i);
  });

  it('still covers `unknown`', () => {
    expect(RULE_BODY).toContain('unknown');
  });
});

describe('the every-turn rules name the escape hatches', () => {
  /**
   * Without this, a "tool not found" is terminal: the agent has no way to learn that the capability
   * exists behind another name.
   */
  it('names `reticle_run` as the route to unadvertised tools', () => {
    expect(RULE_BODY).toContain('reticle_run');
  });

  it('names `reticle_context` for re-entry after losing context', () => {
    expect(RULE_BODY).toContain('reticle_context');
  });

  it('names `reticle_intent`', () => {
    expect(RULE_BODY).toContain('reticle_intent');
  });
});

describe('it stays short enough to be re-read every turn', () => {
  /**
   * The budget is the reason this file is valuable and the reason it must not grow without limit —
   * it is paid on every turn of every session, unlike every other document Reticle ships.
   */
  it('is under 12KB', () => {
    expect(RULE_BODY.length).toBeLessThan(12_000);
  });
});
