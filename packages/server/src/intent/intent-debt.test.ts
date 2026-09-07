/**
 * What a verdict should say the run still owes.
 *
 * Two failure modes, opposite directions. Counting the raw ledger blames a verdict for the intent it
 * just proved — measured live: an inline intent was declared, asserted and proved by one call, and
 * the result still said "1 declared intent(s) are still unproved". And reporting a bare count makes
 * a week-old backlog read exactly like a fresh omission, so the honest gap gets filtered out with
 * the noise.
 */
import { describe, expect, it } from 'vitest';
import { intentDebt } from './open-intents.js';
import type { Intent } from '@reticlehq/core';

const NOW = Date.parse('2026-08-26T12:00:00Z');
const DAY = 86_400_000;

const intent = (id: string, declaredAt: number): Intent => ({
  id,
  statement: `do ${id}`,
  state: 'declared',
  declaredAt,
});

describe('the debt a verdict reports', () => {
  it('is zero when the ledger is empty', () => {
    expect(intentDebt([], undefined, NOW)).toEqual({ openIntentCount: 0 });
  });

  it('does NOT count the intent this verdict just proved', () => {
    const debt = intentDebt([intent('a', NOW), intent('b', NOW)], 'a', NOW);
    expect(debt.openIntentCount).toBe(1);
  });

  it('counts everything when this verdict discharged nothing', () => {
    expect(intentDebt([intent('a', NOW), intent('b', NOW)], undefined, NOW).openIntentCount).toBe(
      2,
    );
  });

  it('reports no age when nothing is left open', () => {
    expect(intentDebt([intent('a', NOW)], 'a', NOW).oldestOpenIntentAgeMs).toBeUndefined();
  });

  it('reports the age of the OLDEST, not the newest', () => {
    const debt = intentDebt(
      [intent('new', NOW - 1000), intent('old', NOW - 5 * DAY)],
      undefined,
      NOW,
    );
    expect(debt.oldestOpenIntentAgeMs).toBe(5 * DAY);
  });

  it('ignores the discharged one when finding the oldest', () => {
    // Otherwise proving the oldest intent leaves the report still quoting its age.
    const debt = intentDebt([intent('old', NOW - 5 * DAY), intent('new', NOW - 1000)], 'old', NOW);
    expect(debt.oldestOpenIntentAgeMs).toBe(1000);
  });

  it('handles a ledger of one, discharged', () => {
    expect(intentDebt([intent('only', NOW)], 'only', NOW)).toEqual({ openIntentCount: 0 });
  });

  it('does not go negative on a clock that moved backwards', () => {
    // A declaredAt in the future is a machine whose clock was corrected mid-session, not a bug here.
    const debt = intentDebt([intent('future', NOW + 1000)], undefined, NOW);
    expect(debt.openIntentCount).toBe(1);
    expect(debt.oldestOpenIntentAgeMs).toBe(-1000);
  });
});
