/**
 * The one document that survives a restart must carry the one job that must be finished.
 *
 * Traced line by line through a real `init` on a real app:
 *
 *   [ℹ] AGENT: finish the capabilities file → src/reticle-dev.ts
 *       Do this now, before driving anything
 *   ...
 *   Then restart your agent so it picks up the new MCP server
 *
 * The notice gives the agent a job. The restart destroys the memory of it. That notice lives only
 * in terminal output, so an agent that follows the instruction comes back with tools and no record
 * that `src/reticle-dev.ts` is unfinished — it sees a wired project, drives something, reads empty
 * state, and moves on.
 *
 * Measured before this change: `RULE_BODY` — the text written into CLAUDE.md and AGENTS.md, the
 * only Reticle prose re-read every turn — mentioned none of `reticle-dev`, `capabilities`,
 * `registerStore`, `hasCapabilities` or `testid`. The guidance existed, in RETICLE.md, framed as a
 * symptom to diagnose after the fact rather than work to do now, and reachable only by following a
 * pointer.
 *
 * So the instruction is not hard to follow. It is written on the one surface guaranteed to be
 * wiped at exactly the moment it matters.
 */

import { describe, expect, it } from 'vitest';
import { RULE_BODY } from './agent-rules.js';

describe('the unfinished capabilities file survives the restart that erases the terminal', () => {
  it('names the file by path, so the agent can find it without the init output', () => {
    expect(RULE_BODY).toContain('reticle-dev');
  });

  it('says what "unfinished" looks like, since a written file looks done', () => {
    expect(RULE_BODY).toMatch(/registers nothing|hasCapabilities/i);
  });

  it('names the call that finishes it', () => {
    expect(RULE_BODY).toContain('registerStore');
  });

  /**
   * The failure mode is silent: an empty state read is indistinguishable from an app with nothing
   * to report. The rule has to say that, or the agent reads the emptiness as success.
   */
  it('says an empty state read is not proof the app is fine', () => {
    expect(RULE_BODY).toMatch(/empty .*(is not|means)|not.*evidence|indistinguishable/i);
  });
});

describe('intent is captured while building, not only while verifying', () => {
  /**
   * A flow saved months ago replays for months. When it breaks it reports "step 3 failed" rather
   * than what stopped being true, unless somebody wrote down what it was FOR — and the only moment
   * anybody knows that is while the change is being made.
   */
  it('tells the agent to record what a change was meant to do, during the build', () => {
    expect(RULE_BODY).toMatch(/reticle_intent/);
    expect(RULE_BODY).toMatch(
      /while you (are )?building|as you build|when you build|during the build/i,
    );
  });

  it('ties intent to the flow at save time, not as a later chore', () => {
    expect(RULE_BODY).toMatch(/flow/i);
  });
});

describe('the every-turn budget is still respected', () => {
  /**
   * This text is paid on every turn of every session, unlike every other document Reticle ships.
   * Growth here is a real cost and the reason to keep the rest of the corpus out of it.
   */
  it('stays under 8KB', () => {
    expect(RULE_BODY.length).toBeLessThan(8_000);
  });
});
