/**
 * The dev-server policy is written once and quoted twice, so the copy has to be checked.
 *
 * `DEV_SERVER_POLICY` in `agent-rules.ts` is the source: it is what `init` writes into the user's
 * CLAUDE.md / AGENTS.md, and it is the text an agent re-reads every turn. Four of its nine
 * sentences are ALSO typed by hand into SKILL.md, which is the paste-URL an agent reads once at
 * setup.
 *
 * Two copies of the same instruction with no link between them drift in the direction that is
 * hardest to notice: the constant gets corrected after a field report, and the hand-typed copy
 * keeps telling the older story to every new reader. That is the failure this repo has already
 * had with tool names, surface counts and the "four rules" preamble.
 *
 * The right end state is generation — SKILL.md rendered from the constants it quotes. That is a
 * build step this repo does not have yet, so the next best thing is a guard: if the source moves
 * and the copy does not, this goes red and somebody decides which one is right.
 *
 * Deliberately checks a PREFIX of each sentence rather than the whole file. The two documents are
 * allowed to differ in framing and length; what they may not do is state the same rule in two
 * different ways.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_SERVER_POLICY } from './agent-rules.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const skill = readFileSync(join(REPO, 'SKILL.md'), 'utf8');

/** Sentences long enough to be a rule rather than a connective. */
const sentences = DEV_SERVER_POLICY.split(/\.\s+/)
  .map((s) => s.replace(/\\`/g, '`').trim())
  .filter((s) => s.length > 50);

/** The prefix length that identifies a sentence without demanding the whole of it. */
const KEY = 60;

/**
 * How many policy rules SKILL.md quotes. Pinned so drift cannot shrink the checked set.
 *
 * Was 4. Rose to 11 when the restart branch was promoted from an aside to the head of the policy:
 * the two documents had been stating the same rule in two different ways, this guard caught it, and
 * the fix was to make the constant carry SKILL.md's corrected wording rather than to loosen the
 * check. A higher number is a tighter guard — every additional sentence is one more rule that can no
 * longer drift silently.
 *
 * Briefly 12, when `init` gained the ability to start the dev server itself. It went back to 11
 * because the every-turn budget refused the extra sentence, and the refusal was right: that `init`
 * may start a dev server is SETUP-time information, and this constant is the text an agent re-reads
 * on every turn to decide what to do while working. It lives in SKILL.md instead, which is read
 * once, at the moment it applies.
 */
const QUOTED_TODAY = 11;

describe('the dev-server policy has one source', () => {
  it('the constant still carries the rules, so this guard cannot go vacuous', () => {
    expect(sentences.length).toBeGreaterThan(5);
  });

  /**
   * The COUNT is pinned, not just the matches.
   *
   * The first version of this test asked only that the sentences SKILL.md currently quotes still
   * match. That is vacuous by construction: change the constant and the sentence simply stops
   * being "currently quoted", so it drops out of the set and the test passes greener than before.
   * Verified by doing exactly that — reword one rule in the constant, and a guard written to catch
   * precisely that stayed green.
   *
   * Pinning the number means drift in either direction is visible: reword the constant without
   * SKILL.md and the count falls; drop a quote from SKILL.md and it falls too. A deliberate change
   * to either updates this number and says so in the diff.
   */
  it('SKILL.md still quotes the same rules, word for word', () => {
    const quoted = sentences.filter((s) => skill.includes(s.slice(0, KEY)));
    expect(
      quoted.length,
      'SKILL.md and DEV_SERVER_POLICY have drifted: a rule was reworded in one and not the other. ' +
        'Decide which is right, fix the other, and update this count.',
    ).toBe(QUOTED_TODAY);
  });
});
