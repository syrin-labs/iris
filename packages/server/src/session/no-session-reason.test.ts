import { describe, expect, it } from 'vitest';
import { NoSessionReason } from '@reticlehq/core';
import { diagnoseNoSession, explainNoSession } from './no-session-diagnosis.js';
import type { NoSessionFacts } from './no-session-diagnosis.js';

/**
 * The diagnosis already ranked its causes well. It just threw the ranking away as prose, so the
 * population that installs Reticle and never connects an app arrived as one undifferentiated
 * silence — "restarted the dev server and it still did not connect" and "never started the app"
 * being the same absence, with opposite fixes (#615).
 *
 * These pin the branch-to-code mapping, and — the case that matters most for a refactor like this —
 * that the SENTENCE is unchanged. A reason is only worth anything if it describes the diagnosis the
 * user was actually shown.
 */
const base: NoSessionFacts = {
  everConnected: false,
  initialized: false,
  listening: [],
  port: 4400,
};

const facts = (over: Partial<NoSessionFacts>): NoSessionFacts => ({ ...base, ...over });

describe('every no-session branch names itself', () => {
  it('a reaped lease, not a closed tab', () => {
    expect(explainNoSession(facts({ everConnected: true, leaseExpired: true })).reason).toBe(
      NoSessionReason.LEASE_EXPIRED,
    );
  });

  it('connected before, and what went was a tab', () => {
    expect(explainNoSession(facts({ everConnected: true })).reason).toBe(NoSessionReason.TAB_GONE);
  });

  it('this project has connected before, but not on this daemon run', () => {
    expect(explainNoSession(facts({ previouslyConnected: true })).reason).toBe(
      NoSessionReason.APP_NOT_REOPENED,
    );
  });

  it('a config outside this directory is a scope problem, not an install one', () => {
    const got = explainNoSession(
      facts({ configsElsewhere: [{ directory: 'apps/web' }], listening: [3000] }),
    );
    expect(got.reason).toBe(NoSessionReason.CONFIG_ELSEWHERE);
  });

  it('nothing listening and no config here', () => {
    expect(explainNoSession(facts({})).reason).toBe(NoSessionReason.NO_LISTENER_NO_CONFIG);
  });

  it('nothing listening, but the project is wired', () => {
    expect(explainNoSession(facts({ initialized: true })).reason).toBe(NoSessionReason.NO_LISTENER);
  });

  it('something listening, but no config in this directory', () => {
    expect(explainNoSession(facts({ listening: [3000] })).reason).toBe(NoSessionReason.NO_CONFIG);
  });

  it('wired and listening, and the SDK still never arrived', () => {
    expect(explainNoSession(facts({ initialized: true, listening: [3000] })).reason).toBe(
      NoSessionReason.SDK_NOT_REACHING_DAEMON,
    );
  });
});

describe('the prose is the prose it always was', () => {
  // The refactor is only safe if the message is untouched: this is the most consequential sentence
  // in the product, and a reason bolted on at the cost of the sentence would be a bad trade.
  const cases: NoSessionFacts[] = [
    facts({ everConnected: true, leaseExpired: true }),
    facts({ everConnected: true }),
    facts({ previouslyConnected: true }),
    facts({ configsElsewhere: [{ directory: 'apps/web' }], listening: [3000] }),
    facts({}),
    facts({ initialized: true }),
    facts({ listening: [3000] }),
    facts({ initialized: true, listening: [3000] }),
  ];

  it('diagnoseNoSession returns exactly explainNoSession().message', () => {
    for (const f of cases) {
      expect(diagnoseNoSession(f)).toBe(explainNoSession(f).message);
    }
  });

  it('still says something on every branch', () => {
    // A branch that returned the empty string would satisfy the equality above and say nothing.
    for (const f of cases) {
      expect(diagnoseNoSession(f).length).toBeGreaterThan(80);
    }
  });

  it('gives a different sentence to each distinct situation', () => {
    // Eight codes over five sentences would be a vocabulary finer than the thing it describes.
    expect(new Set(cases.map((f) => diagnoseNoSession(f))).size).toBe(cases.length);
  });
});
