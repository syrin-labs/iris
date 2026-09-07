/**
 * The always-loaded rules must carry the whole sequence, and say not to stop part-way through it.
 *
 * The `/reticle` skill already holds an excellent recovery ladder — six ordered checks, five
 * guards, and the line "stopping to ask is how a verification turn ends with nothing verified".
 * None of it runs unless somebody invokes the slash command, and after `init` nothing does.
 *
 * What IS always loaded is `RULE_BODY`, and it described the parts without ever naming the whole:
 * verify when you change something, start a dev server if none is listening, setup is not finished
 * until a verdict exists. Each true, none of them telling an agent that it is currently half way
 * through a sequence it is expected to finish by itself.
 *
 * That matters most at the one legitimate pause. `init` asks for a client restart, and an agent
 * that comes back has only this file. If it does not say "you were mid-install, resume", the agent
 * reads a wired project, no session, and no instruction — and stops.
 *
 * This does not duplicate the ladder. It names the sequence, says do not stop, and points at the
 * skill for the detail.
 */

import { describe, expect, it } from 'vitest';
import { RULE_BODY } from './agent-rules.js';

describe('the sequence is named as a sequence', () => {
  it('says setup is not finished until a verdict exists', () => {
    expect(RULE_BODY).toMatch(/not finished until|is not done until/i);
  });

  it('tells the agent not to stop part way', () => {
    expect(RULE_BODY).toMatch(/do not stop|keep going/i);
  });

  it("says the steps are the agent's own, not the user's", () => {
    expect(RULE_BODY).toMatch(/yours to do|without them|do not ask/i);
  });
});

describe('the one legitimate pause has a way back', () => {
  /**
   * The restart is real and unavoidable on a first install. What must not be lost is what to do on
   * the other side of it, because the terminal that said so is gone.
   */
  it('tells the agent to resume after a client restart rather than wait', () => {
    expect(RULE_BODY).toMatch(/resume|pick (it |the sequence )?back up|carry on/i);
  });

  it('points at the full ladder rather than repeating it', () => {
    expect(RULE_BODY).toMatch(/\/reticle/);
  });
});

describe('the every-turn budget still holds', () => {
  it('stays under 8KB', () => {
    expect(RULE_BODY.length).toBeLessThan(8_000);
  });
});
