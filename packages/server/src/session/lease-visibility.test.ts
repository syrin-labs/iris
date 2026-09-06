/**
 * Who gets told that the agent went somewhere invisible.
 *
 * The bug this exists for: an agent took a lease on the daemon's own recommendation, drove fifteen
 * calls, and the human watching their tab's HUD saw nothing and asked why nothing was running.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_ALREADY_DRIVING_ELSEWHERE,
  shouldGreetWithLeaseNotice,
  AGENT_DRIVING_ELSEWHERE,
  AGENT_DRIVING_HERE_AGAIN,
  watchersToNotify,
} from './lease-visibility.js';

const human = { id: 's-human', projectId: 'app' };
const leased = { id: 'lease-1', projectId: 'app' };

describe('watchersToNotify', () => {
  it("tells the human's tab, which is the only screen that goes dark", () => {
    expect(watchersToNotify([human, leased], ['lease-1'], 'app')).toEqual(['s-human']);
  });

  it('never narrates into the leased tab that is doing the driving', () => {
    // With several leases open they would otherwise talk about each other.
    const second = { id: 'lease-2', projectId: 'app' };
    expect(watchersToNotify([leased, second], ['lease-1', 'lease-2'], 'app')).toEqual([]);
  });

  it('identifies leases from the POOL, not from an id that happens to start with "lease-"', () => {
    // A naming convention is not a fact. A session genuinely named `lease-…` by an app, which the
    // pool does not own, is somebody's real tab and must still be told.
    const impostor = { id: 'lease-looking-but-real', projectId: 'app' };
    expect(watchersToNotify([impostor], [], 'app')).toEqual(['lease-looking-but-real']);
  });

  it('leaves other projects alone — one daemon serves many', () => {
    const otherApp = { id: 's-other', projectId: 'different-app' };
    expect(watchersToNotify([human, otherApp], [], 'app')).toEqual(['s-human']);
  });

  it('still tells a session that declares no project', () => {
    // An older SDK sends no projectId. Dropping those would put the dark HUD back for exactly the
    // people least equipped to work out why.
    const legacy = { id: 's-legacy', projectId: undefined };
    expect(watchersToNotify([legacy], [], 'app')).toEqual(['s-legacy']);
  });

  it('tells everyone when the lease itself names no project', () => {
    expect(watchersToNotify([human, { id: 's-b', projectId: 'b' }], [], undefined)).toEqual([
      's-human',
      's-b',
    ]);
  });

  it('says what it means for the person reading it, not just what happened', () => {
    // "An agent leased a context" is a fact that does not explain a still screen. The consequence
    // is the entire reason to send anything.
    expect(AGENT_DRIVING_ELSEWHERE).toContain('will not appear in this tab');
    // And the HUD is explained in BOTH directions — a tab that went quiet and never got told it was
    // live again is the same confusion arriving later.
    expect(AGENT_DRIVING_HERE_AGAIN).toContain('live again');
  });
});

/**
 * The other direction: a tab that arrives DURING a lease.
 *
 * The acquire-time notice only reaches tabs already connected, so opening the dashboard — or just
 * reloading it — while an agent held a lease landed somebody on a silent HUD with nothing to explain
 * it. Reported exactly that way: "dashboard is being watched, but the agent chat shows nothing."
 */
describe('shouldGreetWithLeaseNotice', () => {
  const tab = { id: 's1', projectId: 'app' };

  it('greets a tab that connects while a lease is open', () => {
    expect(shouldGreetWithLeaseNotice(tab, ['lease-1'], ['app'])).toBe(true);
  });

  it('says nothing when no lease is running', () => {
    expect(shouldGreetWithLeaseNotice(tab, [], [])).toBe(false);
  });

  it('never tells a leased context about itself', () => {
    expect(
      shouldGreetWithLeaseNotice({ id: 'lease-1', projectId: 'app' }, ['lease-1'], ['app']),
    ).toBe(false);
  });

  it('does not tell somebody watching app A about a lease on app B', () => {
    expect(shouldGreetWithLeaseNotice(tab, ['lease-1'], ['other'])).toBe(false);
  });

  it('still greets a session with no projectId — an older SDK sends none', () => {
    // Dropping these would reintroduce the dark HUD for the people least able to work out why.
    expect(
      shouldGreetWithLeaseNotice({ id: 's1', projectId: undefined }, ['lease-1'], ['app']),
    ).toBe(true);
  });

  it('has arrival wording, not change-of-state wording', () => {
    // Nothing just happened from this tab's point of view; it walked in on something.
    expect(AGENT_ALREADY_DRIVING_ELSEWHERE).toContain('already');
  });
});
