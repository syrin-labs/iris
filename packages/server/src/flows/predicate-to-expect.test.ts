/**
 * Carrying the assertion an agent MADE into the flow it saved.
 *
 * `reticle_act_and_wait { until }` is how agents assert — 12 of the 14 calls in a day of telemetry
 * carried an `until`. But `compileActStep` recorded only the ACTION, so a flow saved after an
 * asserted drive came back graded `assertion-free`: "performs actions but asserts no observable
 * consequence — it will pass even if the feature is broken."
 *
 * The agent had already said what success meant. Reticle threw it away and then warned the agent
 * that the flow asserts nothing.
 *
 * That is the whole regression-suite story failing at the last step: "record once, verify forever"
 * produces a suite of flows that cannot go red. Locally, 32 of 39 saved flows are assertion-free.
 *
 * Only the kinds FlowExpect can express are carried. `settled`, `route`, `animation`, `anyOf` and
 * `not` have no representation, and inventing one would put an assertion in the file that the agent
 * never made — worse than recording nothing.
 */

import { describe, expect, it } from 'vitest';
import { predicateToExpect, enforcedOnReplay } from './predicate-to-expect.js';

describe('predicateToExpect', () => {
  it('carries a signal assertion, with its payload match', () => {
    expect(predicateToExpect({ kind: 'signal', name: 'deploy:shipped' })).toEqual({
      signal: 'deploy:shipped',
    });
    expect(
      predicateToExpect({ kind: 'signal', name: 'deploy:shipped', dataMatches: { id: '*' } }),
    ).toEqual({ signal: 'deploy:shipped', signalData: { id: '*' } });
  });

  it('carries a signal count, so a saved flow keeps the cardinality the agent asserted', () => {
    // Dropping it would save a strictly WEAKER claim than the one made — presence where the agent
    // said "exactly once" — and the replayed flow would then go green on the double-fire it exists
    // to catch. Same reason net's count is carried.
    expect(predicateToExpect({ kind: 'signal', name: 'order:placed', count: 1 })).toEqual({
      signal: 'order:placed',
      signalCount: 1,
    });
  });

  it('carries a net assertion including the count that catches double-submit', () => {
    expect(
      predicateToExpect({ kind: 'net', method: 'POST', urlContains: '/refund', count: 1 }),
    ).toEqual({ net: { method: 'POST', urlContains: '/refund', count: 1 } });
  });

  it('carries a console assertion, including absent:true', () => {
    expect(predicateToExpect({ kind: 'console', level: 'error', absent: true })).toEqual({
      console: { level: 'error', absent: true },
    });
  });

  it('records NOTHING for a console assertion narrowed by contains', () => {
    // FlowExpect.console has `level` and `absent` and nothing else, so copying the rest through
    // would save "no warn entries at all" for an agent who claimed "THIS warning did not appear":
    // a false red on any unrelated warning, and in the presence direction a strictly weaker
    // assertion than the one chosen. Recording nothing keeps the flow honest.
    expect(
      predicateToExpect({ kind: 'console', level: 'warn', contains: 'no-op', absent: true }),
    ).toBeUndefined();
    // Without the substring the expressible half still records untouched.
    expect(predicateToExpect({ kind: 'console', level: 'warn', absent: true })).toEqual({
      console: { level: 'warn', absent: true },
    });
  });

  it('carries an element assertion by testid', () => {
    expect(predicateToExpect({ kind: 'element', query: { testid: 'reply-modal' } })).toEqual({
      element: { testid: 'reply-modal' },
    });
  });

  it('carries an element assertion by role and name', () => {
    expect(
      predicateToExpect({ kind: 'element', query: { role: 'button', name: '0 Clicks' } }),
    ).toEqual({ element: { role: 'button', name: '0 Clicks' } });
  });

  it('carries a state assertion', () => {
    expect(predicateToExpect({ kind: 'state', path: 'cart.total', equals: 42 })).toEqual({
      state: { path: 'cart.total', equals: 42 },
    });
  });

  it('merges an allOf into one expectation', () => {
    expect(
      predicateToExpect({
        kind: 'allOf',
        predicates: [
          { kind: 'signal', name: 'saved' },
          { kind: 'net', urlContains: '/api/save' },
        ],
      }),
    ).toEqual({ signal: 'saved', net: { urlContains: '/api/save' } });
  });

  it('drops the settled part of an allOf but keeps the real assertion', () => {
    // `settled` is a wait, not a claim about the app — carrying it would say nothing.
    expect(
      predicateToExpect({
        kind: 'allOf',
        predicates: [{ kind: 'settled' }, { kind: 'signal', name: 'saved' }],
      }),
    ).toEqual({ signal: 'saved' });
  });

  it('records NOTHING for predicates FlowExpect cannot express', () => {
    // Inventing an expectation the agent never made is worse than recording none.
    expect(predicateToExpect({ kind: 'settled' })).toBeUndefined();
    expect(predicateToExpect({ kind: 'route', pathname: '/x' })).toBeUndefined();
    expect(predicateToExpect({ kind: 'animation', name: 'fade' })).toBeUndefined();
    expect(
      predicateToExpect({ kind: 'anyOf', predicates: [{ kind: 'signal', name: 'a' }] }),
    ).toBeUndefined();
    expect(
      predicateToExpect({ kind: 'not', predicate: { kind: 'signal', name: 'a' } }),
    ).toBeUndefined();
  });

  it('records nothing for an element assertion with no usable anchor', () => {
    expect(predicateToExpect({ kind: 'element', query: {} })).toBeUndefined();
  });
});

/**
 * The guard against the false green this change nearly introduced.
 *
 * `flow-replay` checks only `expect.element.testid` and `expect.state` per step. A recorded `net` or
 * `signal` expect IS counted by `classifyFlowAssertions` as a consequence assertion — so writing one
 * into a flow file makes it report `grade: "asserted"` while nothing ever evaluates it. A flow that
 * claims to assert something and cannot go red is precisely the false green this product exists to
 * catch, and recording the agent's assertion would have manufactured one.
 */
describe('enforcedOnReplay', () => {
  it('keeps the expectations replay actually checks', () => {
    expect(enforcedOnReplay({ element: { testid: 'reply-modal' } })).toEqual({
      element: { testid: 'reply-modal' },
    });
    expect(enforcedOnReplay({ state: { path: 'cart.total', equals: 42 } })).toEqual({
      state: { path: 'cart.total', equals: 42 },
    });
  });

  it('KEEPS net and signal — replay evaluates every kind of expect now', () => {
    // These used to be dropped, correctly, because replay only checked element+state. It now
    // compiles every remaining kind through successToPredicate, so discarding them made an
    // agent-recorded flow assertion-free BY CONSTRUCTION — `until` is the agent saying what
    // success means, and `net` is overwhelmingly what it says.
    expect(enforcedOnReplay({ net: { urlContains: '/api/save' } })).toEqual({
      net: { urlContains: '/api/save' },
    });
    expect(enforcedOnReplay({ signal: 'saved' })).toEqual({ signal: 'saved' });
    expect(enforcedOnReplay({ console: { level: 'error', absent: true } })).toEqual({
      console: { level: 'error', absent: true },
    });
  });

  it('keeps a signal with the payload and count that qualify it', () => {
    expect(
      enforcedOnReplay({ signal: 'saved', signalData: { id: 1 }, signalCount: 1 }),
    ).toStrictEqual({ signal: 'saved', signalData: { id: 1 }, signalCount: 1 });
  });

  it('keeps every enforceable part of a mixed expectation', () => {
    expect(enforcedOnReplay({ signal: 'saved', element: { testid: 'toast' } })).toEqual({
      signal: 'saved',
      element: { testid: 'toast' },
    });
  });

  it('still drops what successToPredicate cannot compile — the rule never changed', () => {
    // The filter exists so a flow never claims an assertion nothing evaluates. Only its SET moved.
    expect(enforcedOnReplay({})).toBeUndefined();
  });

  it('keeps an element expectation located by role and name — replay compiles those', () => {
    // Dropping this was the hole that made a recorded `until: { kind:"element", query:{ role, name } }`
    // vanish: successToPredicate has always compiled role/name, but this filter still required a
    // testid, so the saved flow was assertion-free while the agent had already proved the control.
    expect(enforcedOnReplay({ element: { role: 'button', name: '0 Clicks' } })).toEqual({
      element: { role: 'button', name: '0 Clicks' },
    });
    expect(enforcedOnReplay({ element: { role: 'dialog' } })).toEqual({
      element: { role: 'dialog' },
    });
  });

  it('keeps a mixed net + role/name expectation, which is the recorded allOf shape', () => {
    expect(
      enforcedOnReplay({
        net: { method: 'GET', urlContains: '/context', status: 200 },
        element: { role: 'button', name: '0 Clicks' },
      }),
    ).toEqual({
      net: { method: 'GET', urlContains: '/context', status: 200 },
      element: { role: 'button', name: '0 Clicks' },
    });
  });
});
