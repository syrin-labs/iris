/**
 * What a leased tab that did not connect should say.
 *
 * `reticle_lease` is the highest-value path in the whole product and nobody knows it. Measured over
 * a day: the 5 sessions that used it had a MEDIAN of 30 tool calls and produced 46% of all bugs
 * found, while the 20 active sessions that did not had a median of 1 call. Not one single-call
 * bounce used a lease. It works because it does not wait for the human's tab to dial in — Reticle
 * opens its own.
 *
 * And the plan file listed it as UNVERIFIED, "one acquire returned ready:false", possibly broken.
 * Driven for real it is not broken at all: against a daemon on the port the app was built to dial,
 * `acquire` returns ready:true and the session is immediately driveable. The failing case was a
 * PORT MISMATCH — the leased tab loads the app, and the app's SDK dials whatever port it was built
 * with, which is not necessarily the daemon that issued the lease. (Proof: the tab from the failed
 * cross-port acquire later showed up as a live session on the OTHER daemon.)
 *
 * The hint claimed the opposite: "is <url> running with @reticlehq/core enabled?" — when the app was
 * running, was instrumented, and had already connected somewhere else. Same defect as the old
 * no-session message: it names the one thing that is definitely true and sends the reader away from
 * the cause.
 */

import { describe, expect, it } from 'vitest';
import { leaseNotConnectedHint } from './lease-hint.js';

describe('leaseNotConnectedHint', () => {
  const hint = leaseNotConnectedHint('http://localhost:5173/', 4400);

  it('names the port THIS daemon is on — the other half of the mismatch', () => {
    expect(hint).toContain('4400');
  });

  it('names the url that was opened', () => {
    expect(hint).toContain('http://localhost:5173/');
  });

  it('leads with the mismatch, not with "is your app running"', () => {
    expect(hint).toMatch(/port|different daemon/i);
    // The tab demonstrably loaded — Playwright navigated it — so this question is always answered.
    expect(hint).not.toMatch(/is .* running with/i);
  });

  it('still allows for the app simply not being instrumented, as the SECOND possibility', () => {
    expect(hint).toMatch(/reticle init|SDK/i);
  });

  it('gives the agent something to do', () => {
    expect(hint).toMatch(/check|run |restart|match/i);
  });
});

/**
 * The one cause the hint could never name, because it was the one thing it never asked about.
 *
 * A leased page that dials a DIFFERENT port than the daemon it was leased by produces no refusal
 * here — the dial never arrives, so `lastClosure()` is silent and every ranked branch falls through
 * to a differential that lists the port mismatch last, or not at all. Driven on the bench fixture:
 * the app dialled 4460, the daemon was on 4400, and the hint answered with four causes, all of which
 * presuppose the port is right. It cost a quarter of an hour to find by hand.
 *
 * The page already knows. Its own unreachable warning names the URL it tried, and the pool owns that
 * browser — so the daemon can read the address off the page's console and compare it with the port
 * it is bound to. Neither half can diagnose this alone: the page cannot tell an absent daemon from
 * an unreachable one, and the daemon cannot see a dial that never arrived.
 */
describe('a page that dialled somewhere else', () => {
  it('names both ports instead of listing causes that assume the port is right', () => {
    const hint = leaseNotConnectedHint('http://localhost:4312/', 4400, {
      dialledUrl: 'ws://localhost:4460/reticle',
      previouslyConnected: true,
      initialized: true,
      sdkMarker: true,
    });
    expect(hint).toContain('4460');
    expect(hint).toContain('4400');
  });

  it('outranks every inferred cause, because it is the only one with proof', () => {
    const hint = leaseNotConnectedHint('http://localhost:4312/', 4400, {
      dialledUrl: 'ws://localhost:4460/reticle',
      previouslyConnected: true,
      initialized: true,
    });
    // The four-cause differential presupposes the dial reached this daemon. It did not.
    expect(hint).not.toContain('dev-mode guard');
  });

  it('says nothing when the page dialled this very daemon — then the port is exonerated', () => {
    const hint = leaseNotConnectedHint('http://localhost:4312/', 4400, {
      dialledUrl: 'ws://localhost:4400/reticle',
      initialized: true,
    });
    expect(hint).not.toMatch(/dialled a different|different port/i);
  });
});
