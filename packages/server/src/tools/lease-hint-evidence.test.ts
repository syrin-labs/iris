/**
 * The daemon contradicted itself inside one response.
 *
 * `reticle_sessions` said "one WAS connected to this daemon earlier, so the wiring is correct", and
 * a lease seconds later said "the usual cause is a PORT MISMATCH". It already held the evidence
 * against its own hint, and the agent that acted on the second sentence went looking for a port that
 * was never wrong. Across a batch of reports on four apps the port was correct every time.
 *
 * So the lease hint stops printing one static differential and reads the same evidence the
 * no-session diagnosis does. What the daemon KNOWS ranks above what is usually true.
 */

import { describe, expect, it } from 'vitest';
import { leaseNotConnectedHint } from './lease-hint.js';

describe('the lease hint is ranked by evidence, not by a static differential', () => {
  it('leads with a recorded refusal, which is the only certain cause there is', () => {
    const hint = leaseNotConnectedHint('http://localhost:5173/', 4400, {
      refusal: 'a browser dialled this daemon and was REFUSED at the origin gate',
    });
    expect(hint).toContain('REFUSED at the origin gate');
    const refusalAt = hint.indexOf('REFUSED');
    const portAt = hint.search(/PORT MISMATCH/);
    expect(-1 === portAt || refusalAt < portAt).toBe(true);
  });

  it('does not blame the port on a project that has demonstrably connected on it', () => {
    const hint = leaseNotConnectedHint('http://localhost:5173/', 4400, {
      previouslyConnected: true,
    });
    expect(hint).not.toContain('PORT MISMATCH');
    expect(hint).toMatch(/connected|initiali[sz]e/i);
  });

  it('does not recommend init on an app that is already wired', () => {
    const hint = leaseNotConnectedHint('http://localhost:5173/', 4400, { initialized: true });
    expect(hint).not.toContain('reticle init');
  });

  it('leads with the dev-server restart for Nuxt, where HMR does not register a new plugin', () => {
    const hint = leaseNotConnectedHint('http://localhost:3000/', 4400, {
      initialized: true,
      framework: 'nuxt',
    });
    expect(hint).toMatch(/Nuxt/);
    expect(hint).toMatch(/HMR|restart/i);
  });

  it('reports that no Reticle marker was found in the served page, when that was checked', () => {
    const hint = leaseNotConnectedHint('http://localhost:5173/', 4400, { sdkMarker: false });
    expect(hint).toMatch(/no Reticle .*marker|marker.*not/i);
  });

  it('reports that a marker WAS found, which rules out "the app ships no SDK"', () => {
    const hint = leaseNotConnectedHint('http://localhost:5173/', 4400, { sdkMarker: true });
    expect(hint).toMatch(/marker/i);
    // The whole point of the bit: it separates "shipped no SDK" from "SDK loaded, cannot reach us".
    expect(hint).not.toMatch(/carries no Reticle SDK at all/);
  });

  it('says nothing about a marker when it could not be checked, rather than guessing', () => {
    const hint = leaseNotConnectedHint('http://localhost:5173/', 4400, {});
    expect(hint).not.toMatch(/marker/i);
  });

  it('keeps the port differential when there is genuinely no other evidence', () => {
    expect(leaseNotConnectedHint('http://localhost:5173/', 4400)).toContain('PORT MISMATCH');
  });
});

describe('a project that has connected before is not proof THIS app is wired', () => {
  /**
   * Measured: an uninstrumented app was driven in a repo where other apps connect on this port
   * every day. `previouslyConnected` is scoped to project + port, not to the app, so the hint took
   * the "wiring is correct" branch and produced four causes — a dev-mode guard, a stale dev server,
   * a missing peer dependency, a non-localhost page. **Every one of them presupposes the SDK is
   * already installed**, and the app in question had never been wired at all.
   *
   * That is the 90% case in one sentence: the users who do not have an instrumented app get a
   * diagnosis written for people who do, and `reticle init` — the only thing that would help — is
   * named nowhere in it. The branch that DOES mention init is the one reached when nothing is
   * known, which is exactly the case a monorepo or a second app never lands in.
   */
  const hint = leaseNotConnectedHint('http://localhost:4320/', 4400, {
    previouslyConnected: true,
  });

  it('does not claim the wiring of an app it has never seen connect', () => {
    expect(hint).not.toMatch(/the port and the wiring are both correct/);
  });

  it('says the earlier connection may have been a different app', () => {
    expect(hint).toMatch(/different app|another app/i);
  });

  it('names `reticle init`, which every listed cause assumes has already happened', () => {
    expect(hint).toMatch(/reticle init/);
  });

  /** The port evidence is still real and must survive: that half of the inference is sound. */
  it('still says the port itself is proven', () => {
    expect(hint).toMatch(/port/);
  });
});
