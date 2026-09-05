import { describe, it, expect } from 'vitest';
import {
  asRef,
  EventType,
  ReticleCommand,
  THROTTLED_STARVED_NOTE,
  type CommandResult,
  type ElementQuery,
  type ReticleEvent,
  type MatchResult,
} from '@reticlehq/core';

import {
  evaluatePredicate,
  waitForPredicate,
  provenExpectedLinks,
  type PredicateSession,
} from './predicate.js';
import { predicateToExpectedLinks } from '../capsule/predicate-to-links.js';
import type { Predicate } from './predicate-eval.js';

/** In-memory session: events from an array, MATCH from a supplied matcher. */
class FakeSession implements PredicateSession {
  constructor(
    private readonly events: ReticleEvent[],
    private readonly matcher: (query: ElementQuery) => MatchResult = () => ({
      matched: false,
      count: 0,
      elements: [],
    }),
    private readonly nowMs = 0,
    private readonly ambient: Record<string, number> = {},
  ) {}

  elapsed(): number {
    return this.nowMs;
  }

  ambientCounts(): Record<string, number> {
    return this.ambient;
  }

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === ReticleCommand.MATCH) {
      const result = this.matcher(args['query'] ?? {});
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }

  eventsSince(cursor = 0): ReticleEvent[] {
    // Mirror RingBuffer.since: only events at/after the cursor (so the `since` floor is exercised).
    return this.events.filter((e) => e.t >= cursor);
  }

  onEvent(): () => void {
    return () => undefined;
  }
}

function ev(type: EventType, data: Record<string, unknown>, t = 1, ref?: string): ReticleEvent {
  return { t, type, sessionId: 's', data, ...(ref !== undefined ? { ref } : {}) };
}

describe('predicate engine', () => {
  it("a signal's own `since` excludes what happened BEFORE the action", async () => {
    // The floor used to be dropped by the schema, so an agent scoping an assertion to the act it just
    // performed was silently asserting "at any point in the window" — our own next-blur-clock e2e
    // spec did exactly this. Evaluated, not asserted: the same predicate flips on the floor alone.
    const session = new FakeSession([ev(EventType.SIGNAL, { name: 'field:committed' }, 5)]);
    const before = await evaluatePredicate(session, {
      kind: 'signal',
      name: 'field:committed',
      since: 3,
    });
    const after = await evaluatePredicate(session, {
      kind: 'signal',
      name: 'field:committed',
      since: 10,
    });
    expect(before.pass, 'fired after the floor').toBe(true);
    expect(after.pass, 'fired BEFORE the floor — must not satisfy the assertion').toBe(false);
  });

  it('a failed status assertion NAMES the status it saw, not just the call', async () => {
    // Driven live against the swallowed-500 fixture: asserting {status:200} on a call that
    // returned 500 reported `observed: "POST http://…/api/generate-script"` — the very field
    // the predicate filtered on was missing from the report of what was seen. The agent is told
    // the call happened and left to guess why it did not match.
    const session = new FakeSession([
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/generate-script', status: 500 }),
    ]);
    const r = await evaluatePredicate(session, {
      kind: 'net',
      urlContains: '/api/generate-script',
      status: 200,
    });
    expect(r.pass).toBe(false);
    expect(r.observed).toContain('500');
  });

  it('omits the arrow when the call has no status yet — never invents one', async () => {
    // An in-flight or aborted request has no status. "→ undefined" would be a fabricated fact.
    const session = new FakeSession([
      ev(EventType.NET_REQUEST, { method: 'GET', url: '/api/slow' }),
    ]);
    const r = await evaluatePredicate(session, { kind: 'net', urlContains: '/api/nope' });
    expect(r.pass).toBe(false);
    expect(r.observed).toContain('/api/slow');
    expect(r.observed).not.toContain('undefined');
    expect(r.observed).not.toContain('→');
  });

  it('matches a network predicate', async () => {
    const session = new FakeSession([
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/order', status: 200 }),
    ]);
    const r = await evaluatePredicate(session, {
      kind: 'net',
      method: 'POST',
      urlContains: '/api/order',
      status: 200,
    });
    expect(r.pass).toBe(true);
  });

  it('net count: exactly-once passes on one match, fails on a double-submit', async () => {
    // The regression class: an action that should fire ONE request fires two (double-submit /
    // useEffect double-fire / a retry storm). Presence-only `net` passes both; `count` catches it.
    const once = new FakeSession([
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/deploy', status: 200 }),
    ]);
    const okPredicate = {
      kind: 'net' as const,
      method: 'POST',
      urlContains: '/api/deploy',
      count: 1,
    };
    expect((await evaluatePredicate(once, okPredicate)).pass).toBe(true);

    const twice = new FakeSession([
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/deploy', status: 200 }),
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/deploy', status: 200 }),
    ]);
    const r = await evaluatePredicate(twice, okPredicate);
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('2');
  });

  it('net count: an unmatched url is not counted (count scoped to the matcher)', async () => {
    const session = new FakeSession([
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/deploy', status: 200 }),
      ev(EventType.NET_REQUEST, { method: 'GET', url: '/api/other', status: 200 }),
    ]);
    expect(
      (await evaluatePredicate(session, { kind: 'net', urlContains: '/api/deploy', count: 1 }))
        .pass,
    ).toBe(true);
  });

  /**
   * Document-initiated subresources (link/css/img/manifest via resource timing) carry no readable
   * status on engines without `responseStatus`. A plain failure would read "your change is broken"
   * and send the agent to fix working code — the false negative the oracle exists to prevent. The
   * honest verdict is unknown: the request WAS seen, its status simply cannot be asserted here.
   */
  it('net status over a status-less subresource downgrades to unknown, never a plain failure', async () => {
    const session = new FakeSession([
      // A document-initiated load: url matches, status unreadable (absent from the record).
      ev(EventType.NET_REQUEST, { method: 'GET', url: '/favicon.ico', initiator: 'link' }),
    ]);
    const result = await evaluatePredicate(session, {
      kind: 'net',
      urlContains: '/favicon.ico',
      status: 200,
    });
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBeDefined();
    expect(result.inconclusive).toContain('does not expose its status');
  });

  it('net status still fails plainly when the status IS readable and differs', async () => {
    const session = new FakeSession([
      ev(EventType.NET_REQUEST, { method: 'GET', url: '/api/data', status: 500 }),
    ]);
    const result = await evaluatePredicate(session, {
      kind: 'net',
      urlContains: '/api/data',
      status: 200,
    });
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBeUndefined();
  });

  it('net count: respects the since floor (a prior-action request is not counted)', async () => {
    const session = new FakeSession([
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/deploy', status: 200 }, 10),
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/deploy', status: 200 }, 30),
    ]);
    const predicate = { kind: 'net' as const, urlContains: '/api/deploy', count: 1 };
    expect((await evaluatePredicate(session, predicate)).pass).toBe(false); // both counted = 2
    expect((await evaluatePredicate(session, predicate, 20)).pass).toBe(true); // floor drops the stale one
  });

  it('since floor: a stale signal before the cursor does NOT fake a pass', async () => {
    // A signal fired at t=10 (e.g. during a PRIOR act). Asserting after a later act (floor=20)
    // must NOT match it — that is the stale-buffer false-pass the honesty fix closes.
    const session = new FakeSession([
      ev(EventType.SIGNAL, { name: 'validation', data: { score: 68 } }, 10),
    ]);
    const predicate = {
      kind: 'signal' as const,
      name: 'validation',
      dataMatches: { score: 68 },
    };
    expect((await evaluatePredicate(session, predicate)).pass).toBe(true); // no floor → legacy behavior
    expect((await evaluatePredicate(session, predicate, 20)).pass).toBe(false); // floor=20 → stale ignored
  });

  it('since floor: a fresh signal at/after the cursor still matches', async () => {
    const session = new FakeSession([
      ev(EventType.SIGNAL, { name: 'validation', data: { score: 78 } }, 25),
    ]);
    const predicate = {
      kind: 'signal' as const,
      name: 'validation',
      dataMatches: { score: 78 },
    };
    expect((await evaluatePredicate(session, predicate, 20)).pass).toBe(true);
  });

  it('console absent passes when no errors, fails when present', async () => {
    const clean = new FakeSession([ev(EventType.CONSOLE_LOG, { message: 'hi' })]);
    expect(
      (await evaluatePredicate(clean, { kind: 'console', level: 'error', absent: true })).pass,
    ).toBe(true);
    const dirty = new FakeSession([ev(EventType.CONSOLE_ERROR, { message: 'boom' })]);
    expect(
      (await evaluatePredicate(dirty, { kind: 'console', level: 'error', absent: true })).pass,
    ).toBe(false);
  });

  /**
   * `absent` + `contains` must mean "THIS message did not appear", not "no messages appeared".
   * A no-op service-worker handler removed means Chrome stops emitting one specific warning; the
   * assertion that matters survives unrelated console chatter. The inverse — a matcher that
   * silently inverted — would be worse than no matcher, so both polarities are pinned.
   */
  it('console absent+contains passes when the message is gone even with other entries', async () => {
    // The targeted warning is gone; an unrelated warn from elsewhere in the app remains.
    const quiet = new FakeSession([ev(EventType.CONSOLE_WARN, { message: 'unrelated chatter' })]);
    const pass = await evaluatePredicate(quiet, {
      kind: 'console',
      level: 'warn',
      contains: 'no-op',
      absent: true,
    });
    expect(pass.pass).toBe(true);

    const loud = new FakeSession([
      ev(EventType.CONSOLE_WARN, { message: 'Fetch event handler is recognized as a no-op...' }),
      ev(EventType.CONSOLE_WARN, { message: 'unrelated chatter' }),
    ]);
    const fail = await evaluatePredicate(loud, {
      kind: 'console',
      level: 'warn',
      contains: 'no-op',
      absent: true,
    });
    expect(fail.pass).toBe(false);
    if (!fail.pass) {
      expect(fail.failureReason).toContain('no-op');
      expect((fail.evidence as unknown[]).length).toBe(1);
    }
  });

  it('console contains asserts presence of a specific message', async () => {
    const hit = new FakeSession([
      ev(EventType.CONSOLE_ERROR, { message: 'save failed: disk full' }),
    ]);
    expect((await evaluatePredicate(hit, { kind: 'console', contains: 'disk full' })).pass).toBe(
      true,
    );
    const miss = new FakeSession([ev(EventType.CONSOLE_ERROR, { message: 'save failed: quota' })]);
    expect((await evaluatePredicate(miss, { kind: 'console', contains: 'disk full' })).pass).toBe(
      false,
    );
  });

  /**
   * A hash router keeps the whole route in the fragment, so `pathname` never moves off '/' (or, in a
   * packaged desktop app on file://, off the long path to index.html). Matching `contains` against
   * pathname alone made a route assertion permanently unsatisfiable for every HashRouter app — and
   * HashRouter is the standard choice for packaged Electron/Tauri renderers, where pushing an
   * absolute path would rewrite the URL to a file that does not exist.
   */
  it('route contains matches the fragment, not just the pathname (hash routers)', async () => {
    const session = new FakeSession([
      ev(EventType.ROUTE_CHANGE, {
        pathname: '/Users/me/app/dist/index.html',
        search: '',
        hash: '#/settings',
        to: 'file:///Users/me/app/dist/index.html#/settings',
      }),
    ]);
    expect((await evaluatePredicate(session, { kind: 'route', contains: 'settings' })).pass).toBe(
      true,
    );
    // A route the app never went to still fails — the match did not become vacuous.
    expect((await evaluatePredicate(session, { kind: 'route', contains: 'billing' })).pass).toBe(
      false,
    );
  });

  it('route contains still matches a query string', async () => {
    const session = new FakeSession([
      ev(EventType.ROUTE_CHANGE, { pathname: '/search', search: '?q=widgets', hash: '' }),
    ]);
    expect((await evaluatePredicate(session, { kind: 'route', contains: 'q=widgets' })).pass).toBe(
      true,
    );
  });

  it('allOf requires every sub-predicate, anyOf requires one', async () => {
    const session = new FakeSession([
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/order', status: 200 }),
      ev(EventType.ROUTE_CHANGE, { pathname: '/success' }),
    ]);
    const all = await evaluatePredicate(session, {
      kind: 'allOf',
      predicates: [
        { kind: 'net', urlContains: '/api/order', status: 200 },
        { kind: 'route', pathname: '/success' },
      ],
    });
    expect(all.pass).toBe(true);

    const allFail = await evaluatePredicate(session, {
      kind: 'allOf',
      predicates: [
        { kind: 'net', urlContains: '/api/order', status: 200 },
        { kind: 'route', pathname: '/nope' },
      ],
    });
    expect(allFail.pass).toBe(false);
    expect(allFail.failureReason).toBeTruthy();

    const any = await evaluatePredicate(session, {
      kind: 'anyOf',
      predicates: [
        { kind: 'route', pathname: '/nope' },
        { kind: 'route', pathname: '/success' },
      ],
    });
    expect(any.pass).toBe(true);
  });

  it('proven links narrow a green anyOf to the branch that actually held (honest grade)', async () => {
    // The OR greens because the app was CLEAN (no console errors), NOT because the signal fired.
    const session = new FakeSession([
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/save', status: 200 }),
    ]);
    const anyOf: Predicate = {
      kind: 'anyOf',
      predicates: [
        { kind: 'signal', name: 'saved' }, // strong branch — this signal never fired
        { kind: 'console', level: 'error', absent: true }, // weak branch — holds (page is clean)
      ],
    };
    // It's green — but only via the clean-console branch.
    expect((await evaluatePredicate(session, anyOf)).pass).toBe(true);
    // Declared links still claim the signal consequence (every branch flattens in).
    expect(predicateToExpectedLinks(anyOf).some((l) => 'signal' === l.kind)).toBe(true);
    // Proven links must NOT — the signal was one of the options and never happened. Grading off these
    // yields PRESENCE, so a minGrade:signal/net gate correctly refuses to trust this green.
    const proven = await provenExpectedLinks(session, anyOf);
    expect(proven.some((l) => 'signal' === l.kind)).toBe(false);
  });

  it('proven links keep every allOf branch (all held for it to be green)', async () => {
    const session = new FakeSession([
      ev(EventType.SIGNAL, { name: 'saved' }),
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/save', status: 200 }),
    ]);
    const allOf: Predicate = {
      kind: 'allOf',
      predicates: [
        { kind: 'signal', name: 'saved' },
        { kind: 'net', urlContains: '/api/save', status: 200 },
      ],
    };
    const proven = await provenExpectedLinks(session, allOf);
    expect(proven.some((l) => 'signal' === l.kind)).toBe(true);
    expect(proven.some((l) => 'net' === l.kind)).toBe(true);
  });

  it('not inverts', async () => {
    const session = new FakeSession([]);
    const r = await evaluatePredicate(session, {
      kind: 'not',
      predicate: { kind: 'console', level: 'error' },
    });
    expect(r.pass).toBe(true);
  });

  it('signal predicate matches name + dataMatches with wildcard', async () => {
    const session = new FakeSession([
      ev(EventType.SIGNAL, { name: 'webhook:received', data: { provider: 'stripe', id: 'pi_1' } }),
    ]);
    const r = await evaluatePredicate(session, {
      kind: 'signal',
      name: 'webhook:received',
      dataMatches: { provider: 'stripe', id: '*' },
    });
    expect(r.pass).toBe(true);
  });

  it('signal dataMatches supports operators and array contains', async () => {
    const session = new FakeSession([
      ev(EventType.SIGNAL, {
        name: 'chat:edit-applied',
        data: { count: 2, sections: ['hook', 'beat'] },
      }),
    ]);
    const pass = await evaluatePredicate(session, {
      kind: 'signal',
      name: 'chat:edit-applied',
      dataMatches: { count: { $gte: 1 }, sections: { $contains: 'hook' } },
    });
    expect(pass.pass).toBe(true);
    const fail = await evaluatePredicate(session, {
      kind: 'signal',
      name: 'chat:edit-applied',
      dataMatches: { count: { $gte: 5 } },
    });
    expect(fail.pass).toBe(false);
  });

  it('signal failure reports a near-miss with what actually fired', async () => {
    const session = new FakeSession([
      ev(EventType.SIGNAL, { name: 'section:added', data: { label: '' } }),
    ]);
    const r = await evaluatePredicate(session, {
      kind: 'signal',
      name: 'section:added',
      dataMatches: { label: 'Beat' },
    });
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('fired');
    expect(r.evidence).toMatchObject({ nearMiss: [{ label: '' }] });
  });

  /**
   * The defect class no state-only oracle can reach: the signal FIRED, so presence is green, but it
   * fired the wrong NUMBER of times. The same cardinality assertion `net` already carries — a
   * double-fired handler and a double-submitted request are one bug seen from two channels.
   */
  it('signal count: exactly-once passes on one fire, and a double-fire is caught', async () => {
    const predicate = { kind: 'signal' as const, name: 'order:placed', count: 1 };
    const once = new FakeSession([ev(EventType.SIGNAL, { name: 'order:placed', data: {} })]);
    expect((await evaluatePredicate(once, predicate)).pass).toBe(true);

    const twice = new FakeSession([
      ev(EventType.SIGNAL, { name: 'order:placed', data: {} }),
      ev(EventType.SIGNAL, { name: 'order:placed', data: {} }),
    ]);
    const r = await evaluatePredicate(twice, predicate);
    expect(r.pass).toBe(false);
    expect(r.assertion).toBe('signal.count');
    expect(r.failureReason).toContain('2');
    // Monotonic, exactly as on net: a window only accumulates, so an over-count is final.
    expect(r.decided).toBe(true);
  });

  it('signal count: a fire under a different name is not counted', async () => {
    // The wrong-name half of the defect class: the right signal fires once while a near-miss name
    // fires alongside it. Counting both would report a double-fire that never happened.
    const session = new FakeSession([
      ev(EventType.SIGNAL, { name: 'order:placed', data: {} }),
      ev(EventType.SIGNAL, { name: 'order:place', data: {} }),
    ]);
    expect(
      (await evaluatePredicate(session, { kind: 'signal', name: 'order:placed', count: 1 })).pass,
    ).toBe(true);
  });

  it('signal count omitted stays presence-only, so a double-fire still passes', async () => {
    // The existing contract, pinned: adding the field must change nothing for callers who omit it.
    const session = new FakeSession([
      ev(EventType.SIGNAL, { name: 'order:placed', data: {} }),
      ev(EventType.SIGNAL, { name: 'order:placed', data: {} }),
    ]);
    expect((await evaluatePredicate(session, { kind: 'signal', name: 'order:placed' })).pass).toBe(
      true,
    );
  });

  it('signal count: 0 asserts the signal never fired', async () => {
    // `count: 0` is an assertion, not an omitted field — the two must not collapse onto each other,
    // or "this handler must NOT fire" would silently become "it must fire at least once".
    const quiet = new FakeSession([ev(EventType.SIGNAL, { name: 'other:thing', data: {} })]);
    expect(
      (await evaluatePredicate(quiet, { kind: 'signal', name: 'order:placed', count: 0 })).pass,
    ).toBe(true);

    const fired = new FakeSession([ev(EventType.SIGNAL, { name: 'order:placed', data: {} })]);
    const r = await evaluatePredicate(fired, { kind: 'signal', name: 'order:placed', count: 0 });
    expect(r.pass).toBe(false);
    expect(r.assertion).toBe('signal.count');
  });

  it('signal count: dataMatches narrows what is counted', async () => {
    const session = new FakeSession([
      ev(EventType.SIGNAL, { name: 'save:done', data: { id: 'a' } }),
      ev(EventType.SIGNAL, { name: 'save:done', data: { id: 'b' } }),
    ]);
    expect(
      (
        await evaluatePredicate(session, {
          kind: 'signal',
          name: 'save:done',
          dataMatches: { id: 'a' },
          count: 1,
        })
      ).pass,
    ).toBe(true);
  });

  it('element predicate reports a near-miss when the name is wrong', async () => {
    const session = new FakeSession([], (query) => {
      // Only a button named "Cancel" exists.
      if ('button' === query.role && query.name === undefined) {
        return {
          matched: true,
          count: 1,
          elements: [
            { ref: asRef('e1'), role: 'button', name: 'Cancel', states: [], visible: true },
          ],
        };
      }
      return { matched: false, count: 0, elements: [] };
    });
    const r = await evaluatePredicate(session, {
      kind: 'element',
      query: { role: 'button', name: 'Submit' },
    });
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('Cancel');
  });

  it('diagnose=false skips the near-miss round-trips (interim-poll fast path)', async () => {
    // The wait loop passes diagnose=false on its interim polls — which read only `pass` — so the extra
    // role-only MATCH scan is not run. Count the MATCH commands to prove the second scan is skipped.
    let matchCalls = 0;
    const session = new FakeSession([], (query) => {
      matchCalls += 1;
      if ('button' === query.role && query.name === undefined) {
        return {
          matched: true,
          count: 1,
          elements: [
            { ref: asRef('e1'), role: 'button', name: 'Cancel', states: [], visible: true },
          ],
        };
      }
      return { matched: false, count: 0, elements: [] };
    });
    const q = { kind: 'element', query: { role: 'button', name: 'Submit' } } as const;

    matchCalls = 0;
    const interim = await evaluatePredicate(session, q, 0, false);
    expect(interim.pass).toBe(false);
    expect(interim.assertion).toBe('element.present'); // plain fail, no near-miss
    expect(matchCalls).toBe(1); // ONE scan, not two

    matchCalls = 0;
    const full = await evaluatePredicate(session, q, 0, true);
    expect(full.assertion).toBe('element.role+name'); // full near-miss on the diagnostic path
    expect(matchCalls).toBe(2); // the extra role-only scan ran
  });

  it('turns a disconnected browser command into a failed wait verdict', async () => {
    const session: PredicateSession = {
      command: () => Promise.reject(new Error('session disconnected')),
      eventsSince: () => [],
      onEvent: () => () => undefined,
      elapsed: () => 0,
    };
    const result = await waitForPredicate(
      session,
      { kind: 'element', query: { text: 'Ready' } },
      100,
    );
    expect(result).toEqual({ pass: false, failureReason: 'session disconnected' });
  });

  it('propagates the STRUCTURED cause (observed/expected/assertion) on a timed-out wait', async () => {
    // The bug: on timeout, waitForPredicate rebuilt the verdict as { pass, evidence, failureReason },
    // discarding observed/expected/assertion that the near-miss oracle computed — the highest-value
    // localization signal, thrown away exactly on the failure path where it matters. A net.count
    // predicate that can never be satisfied must still return the structured near-miss.
    const session = new FakeSession(
      [ev(EventType.NET_REQUEST, { url: '/api/x', status: 200 }, 10)],
      undefined,
      100,
    );
    const result = await waitForPredicate(
      session,
      { kind: 'net', urlContains: '/api/', count: 99 },
      80,
    );
    expect(result.pass).toBe(false);
    expect(result.assertion).toBe('net.count');
    expect(result.observed).toContain('1 matching');
    expect(result.expected).toContain('99');
  });
});

/**
 * A throttled tab's starved reads must not look like a missing render.
 *
 * After a hard reload a backgrounded tab sits on "Loading" forever — the browser never lets the
 * fetch/hydration run — and `waitForPredicate { kind: "text" }` times out as a near-miss. That
 * sentence is identical to "the code did not render", so the agent "fixes" working code. The
 * session already carries `throttled: true` on the health envelope; agents treat the near-miss
 * prose as the verdict. `inconclusive` is the established way to stop that being graded as a
 * product failure (see observationLost).
 */
describe('a throttled tab timeout is not a missing render', () => {
  class ThrottledSession extends FakeSession {
    throttled(): boolean {
      return true;
    }
  }

  it('a timed-out wait on a throttled tab says the tab never got to run, not that the text is absent', async () => {
    const session = new ThrottledSession([]);
    const result = await waitForPredicate(
      session,
      { kind: 'element', query: { text: 'Configuration' } },
      80,
    );
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBe(THROTTLED_STARVED_NOTE);
    // The near-miss is kept whole: this layer sets the FIELD an agent gates on, and the sentence
    // is suffixed one layer up by annotateStarvedFailure so the concrete diagnosis still leads.
    expect(result.failureReason).toBeTypeOf('string');
    expect(result.failureReason).not.toBe(THROTTLED_STARVED_NOTE);
  });

  it('keeps the structured near-miss beside the starved-tab note', async () => {
    const session = new ThrottledSession(
      [ev(EventType.NET_REQUEST, { url: '/api/x', status: 200 }, 10)],
      undefined,
      100,
    );
    const result = await waitForPredicate(
      session,
      { kind: 'net', urlContains: '/api/', count: 99 },
      80,
    );
    expect(result.assertion).toBe('net.count');
    expect(result.observed).toContain('1 matching');
    expect(result.expected).toContain('99');
    expect(result.inconclusive).toBe(THROTTLED_STARVED_NOTE);
  });

  it('a one-shot miss on a throttled tab is inconclusive, not a product failure', async () => {
    const session = new ThrottledSession([]);
    const result = await evaluatePredicate(session, {
      kind: 'element',
      query: { text: 'Configuration' },
    });
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBe(THROTTLED_STARVED_NOTE);
  });

  it('a PASSING wait on a throttled tab is not annotated', async () => {
    const session = new ThrottledSession([], () => ({
      matched: true,
      count: 1,
      elements: [],
    }));
    const result = await waitForPredicate(
      session,
      { kind: 'element', query: { text: 'Configuration' } },
      80,
    );
    expect(result.pass).toBe(true);
    expect(result.inconclusive).toBeUndefined();
  });

  it('an unthrottled timeout still looks like a near-miss, not a starved tab', async () => {
    const session = new FakeSession([]);
    const result = await waitForPredicate(
      session,
      { kind: 'element', query: { text: 'Configuration' } },
      80,
    );
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBeUndefined();
  });
});

/**
 * A response whose BODY is still arriving is not a finished request.
 *
 * `fetch` resolves at HEADERS. Measured on a Next.js App Router page: the RSC payload's NET_REQUEST
 * landed 16 ms in, the shell and a Suspense fallback rendered, and the boundary's real content
 * arrived 889 ms later. In between, NOTHING was observed — and quiet is exactly what `settled` tests
 * for, so it passed with "loading rows…" still on screen and zero rows rendered. A green on every
 * streaming boundary, which on Next is the default rendering path.
 */
describe('settled waits for a streaming response body, not just the request', () => {
  const streamOpen = (id: string, t: number): ReticleEvent =>
    ev(EventType.NET_STREAM, { transport: 'fetch', direction: 'open', url: '/rsc', id }, t);
  const streamClose = (id: string, t: number): ReticleEvent =>
    ev(EventType.NET_STREAM, { transport: 'fetch', direction: 'close', url: '/rsc', id }, t);
  const completed = (id: string, t: number): ReticleEvent =>
    ev(EventType.NET_REQUEST, { id, method: 'GET', url: '/rsc', status: 200, ok: true }, t);

  it('does NOT settle while the body is still open, however quiet the page is', async () => {
    // The exact shape of the Next.js window: request done, shell painted, then silence.
    const session = new FakeSession(
      [completed('n1', 16), streamOpen('n1', 16), ev(EventType.DOM_ADDED, {}, 20)],
      undefined,
      2000, // long since the last event — quiet by any measure
    );
    const r = await evaluatePredicate(session, { kind: 'settled' });
    expect(r.pass).toBe(false);
    expect(r.observed).toContain('streaming');
  });

  it('settles once the body closes', async () => {
    const session = new FakeSession(
      [completed('n1', 16), streamOpen('n1', 16), streamClose('n1', 889)],
      undefined,
      2000,
    );
    expect((await evaluatePredicate(session, { kind: 'settled' })).pass).toBe(true);
  });

  it('reports both causes when a request is in flight AND a body is streaming', async () => {
    const session = new FakeSession(
      [
        completed('n1', 16),
        streamOpen('n1', 16),
        ev(EventType.NET_PENDING, { id: 'n2', method: 'POST', url: '/save' }, 20),
      ],
      undefined,
      2000,
    );
    const r = await evaluatePredicate(session, { kind: 'settled' });
    expect(r.pass).toBe(false);
    expect(r.observed).toContain('in flight');
    expect(r.observed).toContain('streaming');
  });

  it('ignores a stream event with no id rather than blocking forever', async () => {
    // SSE/WebSocket frames carry no request id. They must not be mistaken for an unclosed body, or
    // any app with a live socket could never settle again.
    const session = new FakeSession(
      [ev(EventType.NET_STREAM, { transport: 'sse', direction: 'open', url: '/feed' }, 10)],
      undefined,
      2000,
    );
    expect((await evaluatePredicate(session, { kind: 'settled' })).pass).toBe(true);
  });
});

describe('settled predicate (deterministic waiting)', () => {
  it('passes when there has been no network/DOM/animation activity since the floor', async () => {
    // Only a non-activity event (signal) in the buffer → nothing to settle → quiet.
    const session = new FakeSession([ev(EventType.SIGNAL, { name: 'x' }, 100)], undefined, 1000);
    const r = await evaluatePredicate(session, { kind: 'settled' }, 0);
    expect(r.pass).toBe(true);
  });

  it('fails while the last activity is more recent than quietMs', async () => {
    // Last network call at t=900, now=1000 → 100ms quiet < 200ms required.
    const session = new FakeSession(
      [ev(EventType.NET_REQUEST, { url: '/api/x', status: 200 }, 900)],
      undefined,
      1000,
    );
    const r = await evaluatePredicate(session, { kind: 'settled', quietMs: 200 }, 0);
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('not settled');
    expect((r.evidence as { quietForMs: number }).quietForMs).toBe(100);
  });

  it('passes once the quiet gap reaches quietMs (structural DOM mutation long enough ago)', async () => {
    // Last DOM node added at t=500, now=1000 → 500ms quiet ≥ 200ms required.
    const session = new FakeSession([ev(EventType.DOM_ADDED, {}, 500)], undefined, 1000);
    const r = await evaluatePredicate(session, { kind: 'settled', quietMs: 200 }, 0);
    expect(r.pass).toBe(true);
    expect((r.evidence as { quietForMs: number }).quietForMs).toBe(500);
  });

  it('ignores ambient dom.text / animation frames so an animated page can still settle', async () => {
    // A count-up counter + spinner emit a text/anim event EVERY frame — here at t=995/998, only
    // 2-5ms ago. If these counted as activity the page would never go quiet; they must not.
    const session = new FakeSession(
      [
        ev(EventType.DOM_TEXT, { text: '42' }, 995),
        ev(EventType.ANIM_START, { name: 'spin' }, 996),
        ev(EventType.ANIM_END, { name: 'pulse' }, 998),
      ],
      undefined,
      1000,
    );
    const r = await evaluatePredicate(session, { kind: 'settled', quietMs: 200 }, 0);
    expect(r.pass).toBe(true); // settled despite very recent text/anim churn
  });

  it('excludes learned-ambient regions so a churning chat page still settles', async () => {
    // A real-time chat adds a DOM node every frame on ref "chat-log". Very recent (t=990, 10ms ago),
    // so without ambient learning the page would never go quiet. Once the ref is learned-ambient
    // (>= threshold unattributed churns), its structural churn must not hold `settled` open.
    const churn = [
      ev(EventType.DOM_ADDED, {}, 985, 'chat-log'),
      ev(EventType.DOM_ADDED, {}, 990, 'chat-log'),
    ];
    const notLearned = new FakeSession(churn, undefined, 1000);
    expect((await evaluatePredicate(notLearned, { kind: 'settled', quietMs: 200 }, 0)).pass).toBe(
      false,
    );
    const learned = new FakeSession(churn, undefined, 1000, { 'chat-log': 25 });
    const r = await evaluatePredicate(learned, { kind: 'settled', quietMs: 200 }, 0);
    expect(r.pass).toBe(true); // settled: chat-log churn is ambient, excluded from the settle oracle
  });

  it('a churning FEED (new element each tick, ref-less removals) still settles — the ambient-churn acceptance', async () => {
    // The real hostile shape: every appended row is a NEW element (fresh ref) and each removal has NO
    // ref, so ref-keyed exclusion never applied and settle stayed blocked forever. Keyed on the stable
    // region, the same stream is correctly treated as ambient.
    const churn: ReticleEvent[] = [];
    for (let i = 0; i < 6; i++) {
      churn.push({
        t: 980 + i,
        type: EventType.DOM_ADDED,
        sessionId: 's',
        ref: `e${String(800 + i)}`,
        data: { region: 'hostile-feed' },
      });
      churn.push({
        t: 981 + i,
        type: EventType.DOM_REMOVED,
        sessionId: 's',
        data: { region: 'hostile-feed' },
      });
    }
    const notLearned = new FakeSession(churn, undefined, 1000);
    expect((await evaluatePredicate(notLearned, { kind: 'settled', quietMs: 200 }, 0)).pass).toBe(
      false,
    );

    const learned = new FakeSession(churn, undefined, 1000, { 'hostile-feed': 40 });
    const r = await evaluatePredicate(learned, { kind: 'settled', quietMs: 200 }, 0);
    expect(r.pass).toBe(true); // settles despite a feed that never stops churning
  });

  it('keeps a non-ambient structural change even while an ambient region churns', async () => {
    // The chat churns (ambient) AND a real modal mounts on a different ref → still NOT settled.
    const session = new FakeSession(
      [
        ev(EventType.DOM_ADDED, {}, 990, 'chat-log'),
        ev(EventType.DOM_ADDED, {}, 992, 'modal-root'),
      ],
      undefined,
      1000,
      { 'chat-log': 25 },
    );
    const r = await evaluatePredicate(session, { kind: 'settled', quietMs: 200 }, 0);
    expect(r.pass).toBe(false); // modal-root is real work, holds settle open
  });

  it('respects the since floor: activity before the floor does not count', async () => {
    // A burst at t=100, then quiet. Asserting from floor=900 ignores the old burst → settled.
    const session = new FakeSession(
      [ev(EventType.DOM_ADDED, {}, 100), ev(EventType.ANIM_START, { name: 'spin' }, 100)],
      undefined,
      1000,
    );
    expect((await evaluatePredicate(session, { kind: 'settled', quietMs: 200 }, 900)).pass).toBe(
      true,
    );
    // From the start (floor 0) the burst is in scope but it is 900ms old → still settled.
    expect((await evaluatePredicate(session, { kind: 'settled', quietMs: 200 }, 0)).pass).toBe(
      true,
    );
  });

  it('composes inside allOf with a consequence predicate', async () => {
    const session = new FakeSession(
      [
        ev(EventType.SIGNAL, { name: 'deploy:shipped', data: {} }, 600),
        ev(EventType.NET_REQUEST, { url: '/api/deploy', status: 200 }, 600),
      ],
      undefined,
      1000,
    );
    const r = await evaluatePredicate(
      session,
      {
        kind: 'allOf',
        predicates: [
          { kind: 'signal', name: 'deploy:shipped' },
          { kind: 'settled', quietMs: 300 },
        ],
      },
      0,
    );
    expect(r.pass).toBe(true);
  });
});

/** Session whose STATE_READ returns a fixed `{ stores }` map — exercises the state predicate. */
class StateSession implements PredicateSession {
  constructor(private readonly stores: Record<string, unknown>) {}
  elapsed(): number {
    return 0;
  }
  command(name: string): Promise<CommandResult> {
    if (name === ReticleCommand.STATE_READ) {
      return Promise.resolve({
        kind: 'command_result',
        id: 'x',
        ok: true,
        result: { stores: this.stores, storeNames: Object.keys(this.stores) },
      });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }
  eventsSince(): ReticleEvent[] {
    return [];
  }
  onEvent(): () => void {
    return () => undefined;
  }
}

describe('state predicate — assert store truth', () => {
  const app = {
    app: {
      deployments: [
        { id: 1, status: 'queued' },
        { id: 2, status: 'live' },
      ],
      count: 2,
    },
  };

  it('passes when a dot-path value equals the expected literal', async () => {
    const r = await evaluatePredicate(new StateSession(app), {
      kind: 'state',
      store: 'app',
      path: 'deployments.0.status',
      equals: 'queued',
    });
    expect(r.pass).toBe(true);
  });

  it('fails legibly when the displayed value lies about the store (desync)', async () => {
    // UI showed "live"; the store says "queued". Asserting equals:'live' must fail and name the truth.
    const r = await evaluatePredicate(new StateSession(app), {
      kind: 'state',
      store: 'app',
      path: 'deployments.0.status',
      equals: 'live',
    });
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('queued');
  });

  it('supports operator patterns ($gte, $length)', async () => {
    const session = new StateSession(app);
    expect(
      (
        await evaluatePredicate(session, {
          kind: 'state',
          store: 'app',
          path: 'count',
          equals: { $gte: 2 },
        })
      ).pass,
    ).toBe(true);
    expect(
      (
        await evaluatePredicate(session, {
          kind: 'state',
          store: 'app',
          path: 'deployments',
          equals: { $length: 2 },
        })
      ).pass,
    ).toBe(true);
    expect(
      (
        await evaluatePredicate(session, {
          kind: 'state',
          store: 'app',
          path: 'count',
          equals: { $gte: 5 },
        })
      ).pass,
    ).toBe(false);
  });

  it('presence check passes when equals is omitted and the path resolves', async () => {
    const r = await evaluatePredicate(new StateSession(app), {
      kind: 'state',
      store: 'app',
      path: 'deployments.1.id',
    });
    expect(r.pass).toBe(true);
  });

  it('diagnoses a missing path with the keys that WERE available', async () => {
    const r = await evaluatePredicate(new StateSession(app), {
      kind: 'state',
      store: 'app',
      path: 'deployments.0.nope',
    });
    expect(r.pass).toBe(false);
    expect((r.evidence as { availableKeys?: string[] }).availableKeys).toContain('status');
  });

  it('defaults to the only store when none is named, but flags ambiguity otherwise', async () => {
    const single = await evaluatePredicate(new StateSession({ app: { v: 1 } }), {
      kind: 'state',
      path: 'v',
      equals: 1,
    });
    expect(single.pass).toBe(true);
    // Both stores have to EXPOSE `v` for this to be ambiguous. It used to read `{app:{}, cart:{}}`,
    // where neither did — which is not an ambiguity at all but a path that exists nowhere, and it
    // now reports as the missing path it is. See predicate-store-narrowing.test.ts.
    const ambiguous = await evaluatePredicate(new StateSession({ app: { v: 1 }, cart: { v: 2 } }), {
      kind: 'state',
      path: 'v',
    });
    expect(ambiguous.pass).toBe(false);
    expect(ambiguous.failureReason).toContain('multiple stores');
  });
});

/** Session that lets the test drive events and control when each command resolves, to prove the
 * waiter never fans out one round-trip per event. `command` counts calls (one STATE_READ per eval). */
class CoalesceSession implements PredicateSession {
  commandCount = 0;
  #listener: ((event: ReticleEvent) => void) | null = null;
  #pending: Array<(r: CommandResult) => void> = [];
  elapsed(): number {
    return 0;
  }
  eventsSince(): ReticleEvent[] {
    return [];
  }
  onEvent(listener: (event: ReticleEvent) => void): () => void {
    this.#listener = listener;
    return () => {
      this.#listener = null;
    };
  }
  emit(): void {
    this.#listener?.(ev(EventType.DOM_ADDED, {}));
  }
  command(): Promise<CommandResult> {
    this.commandCount += 1;
    return new Promise((res) => this.#pending.push(res));
  }
  resolveNext(result: unknown): void {
    const res = this.#pending.shift();
    if (res !== undefined) res({ kind: 'command_result', id: 'x', ok: true, result });
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * An exact-cardinality assertion cannot be satisfied EARLY.
 *
 * Found by driving a real merchant dashboard: a Refund confirm fires two POSTs 59 ms apart, and
 * `until: { kind:'net', method:'POST', urlContains:'/refund', count:1 }` returned
 * `pass: true, matched: 1`. `evalNet` counts occurrences correctly — the WAIT had stopped looking,
 * because it resolves the moment a check passes. So `count: 1` silently meant "at least 1", the
 * assertion `count` exists to avoid, in a tool whose product is the absence of false greens.
 */
describe('net count is exact, not "at least" — the double-submit must not pass', () => {
  /** A session whose events arrive over TIME, as a real one's do, rather than all up front. */
  class LiveSession implements PredicateSession {
    readonly #events: ReticleEvent[] = [];
    readonly #listeners = new Set<(event: ReticleEvent) => void>();
    elapsed(): number {
      return 0;
    }
    command(): Promise<CommandResult> {
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
    }
    eventsSince(cursor = 0): ReticleEvent[] {
      return this.#events.filter((e) => e.t >= cursor);
    }
    onEvent(listener: (event: ReticleEvent) => void): () => void {
      this.#listeners.add(listener);
      return () => {
        this.#listeners.delete(listener);
      };
    }
    push(event: ReticleEvent): void {
      this.#events.push(event);
      for (const l of this.#listeners) l(event);
    }
  }

  const post = (t: number): ReticleEvent =>
    ev(
      EventType.NET_REQUEST,
      { method: 'POST', url: '/api/v1/payments/pay_1/refund', status: 200 },
      t,
    );

  it('FAILS when the second POST lands 59ms after the first', async () => {
    const session = new LiveSession();
    const verdict = waitForPredicate(
      session,
      { kind: 'net', method: 'POST', urlContains: '/refund', count: 1 },
      5000,
    );
    session.push(post(10));
    setTimeout(() => session.push(post(69)), 59); // the double-submit, at the gap measured live
    const r = await verdict;

    expect(r.pass).toBe(false);
    expect(r.observed).toContain('2'); // and it says WHAT it saw, not just that it failed
  });

  it('still passes when exactly one really did fire, without burning the timeout', async () => {
    const session = new LiveSession();
    const started = Date.now();
    const verdict = waitForPredicate(
      session,
      { kind: 'net', method: 'POST', urlContains: '/refund', count: 1 },
      10_000,
    );
    session.push(post(10));
    const r = await verdict;

    expect(r.pass).toBe(true);
    // An honest "exactly one" costs one short hold, not 10s of dead wall-clock on the agent's
    // most-used verdict path.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('leaves a presence-only net predicate resolving on the first match', async () => {
    // No `count` means "at least one", which IS satisfiable early. Holding those back would make
    // every ordinary net wait pay the confirmation delay for nothing.
    const session = new LiveSession();
    const verdict = waitForPredicate(
      session,
      { kind: 'net', method: 'POST', urlContains: '/refund' },
      10_000,
    );
    session.push(post(10));
    expect((await verdict).pass).toBe(true);
  });

  it('holds for a count nested inside allOf', async () => {
    const session = new LiveSession();
    const verdict = waitForPredicate(
      session,
      {
        kind: 'allOf',
        predicates: [{ kind: 'net', method: 'POST', urlContains: '/refund', count: 1 }],
      },
      5000,
    );
    session.push(post(10));
    setTimeout(() => session.push(post(69)), 59);
    expect((await verdict).pass).toBe(false);
  });

  /**
   * And having decided, it must STOP — the budget cannot change a count that has already overshot.
   *
   * No clock is asserted here on purpose: a duration assertion is a statement about the machine and
   * fails only under parallel load. The wait is granted a budget far longer than this test's own
   * timeout, so honouring `decided` is the only way it can finish at all, and a regression shows up
   * as this test timing out rather than as a flake.
   */
  it('stops as soon as the count has overshot, instead of spending the budget', async () => {
    const session = new LiveSession();
    const verdict = waitForPredicate(
      session,
      { kind: 'net', method: 'POST', urlContains: '/refund', count: 1 },
      45_000,
    );
    session.push(post(10));
    session.push(post(69));
    const r = await verdict;
    expect(r.pass).toBe(false);
    expect(r.decided).toBe(true);
  }, 5_000);

  /**
   * And through a conjunction, which is how it reaches real calls: an exact count is nearly always
   * asserted alongside the UI change it is supposed to accompany, so a decided clause has to decide
   * the whole `allOf` or the early exit never fires where anyone would notice.
   */
  it('decides the whole allOf when one clause has overshot', async () => {
    const session = new LiveSession();
    const verdict = waitForPredicate(
      session,
      {
        kind: 'allOf',
        predicates: [
          { kind: 'net', method: 'POST', urlContains: '/refund', count: 1 },
          // A clause that is merely NOT YET true: on its own this one would keep waiting for the
          // whole budget, which is what makes the conjunction worth testing.
          { kind: 'net', method: 'GET', urlContains: '/a-call-that-never-comes' },
        ],
      },
      45_000,
    );
    session.push(post(10));
    session.push(post(69));
    const r = await verdict;
    expect(r.pass).toBe(false);
    expect(r.decided).toBe(true);
  }, 5_000);
});

describe('signal count is exact, not "at least" — the double-fire must not pass', () => {
  class LiveSession implements PredicateSession {
    readonly #events: ReticleEvent[] = [];
    readonly #listeners = new Set<(event: ReticleEvent) => void>();
    elapsed(): number {
      return 0;
    }
    command(): Promise<CommandResult> {
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
    }
    eventsSince(cursor = 0): ReticleEvent[] {
      return this.#events.filter((e) => e.t >= cursor);
    }
    onEvent(listener: (event: ReticleEvent) => void): () => void {
      this.#listeners.add(listener);
      return () => {
        this.#listeners.delete(listener);
      };
    }
    push(event: ReticleEvent): void {
      this.#events.push(event);
      for (const l of this.#listeners) l(event);
    }
  }

  const signal = (t: number): ReticleEvent =>
    ev(EventType.SIGNAL, { name: 'order:placed', data: {} }, t);

  it('FAILS when the second signal lands 59ms after the first', async () => {
    const session = new LiveSession();
    const verdict = waitForPredicate(
      session,
      { kind: 'signal', name: 'order:placed', count: 1 },
      5000,
    );
    session.push(signal(10));
    setTimeout(() => session.push(signal(69)), 59);
    const r = await verdict;

    expect(r.pass).toBe(false);
    expect(r.observed).toContain('2');
  });

  it('still passes when exactly one really did fire, without burning the timeout', async () => {
    const session = new LiveSession();
    const started = Date.now();
    const verdict = waitForPredicate(
      session,
      { kind: 'signal', name: 'order:placed', count: 1 },
      10_000,
    );
    session.push(signal(10));
    const r = await verdict;

    expect(r.pass).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('leaves a presence-only signal predicate resolving on the first match', async () => {
    const session = new LiveSession();
    const verdict = waitForPredicate(session, { kind: 'signal', name: 'order:placed' }, 10_000);
    session.push(signal(10));
    expect((await verdict).pass).toBe(true);
  });
});

describe('waitForPredicate disconnect cleanup', () => {
  class DisconnectableSession implements PredicateSession {
    readonly #events: ReticleEvent[] = [];
    readonly #listeners = new Set<(event: ReticleEvent) => void>();
    readonly #disconnectListeners = new Set<() => void>();
    elapsed(): number {
      return 0;
    }
    command(): Promise<CommandResult> {
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
    }
    eventsSince(): ReticleEvent[] {
      return this.#events;
    }
    onEvent(listener: (event: ReticleEvent) => void): () => void {
      this.#listeners.add(listener);
      return () => {
        this.#listeners.delete(listener);
      };
    }
    onDisconnect(listener: () => void): () => void {
      this.#disconnectListeners.add(listener);
      return () => {
        this.#disconnectListeners.delete(listener);
      };
    }
    pushEvent(event: ReticleEvent): void {
      this.#events.push(event);
      for (const l of this.#listeners) l(event);
    }
    disconnect(): void {
      for (const l of this.#disconnectListeners) l();
      this.#disconnectListeners.clear();
    }
    disconnectListenerCount(): number {
      return this.#disconnectListeners.size;
    }
  }

  it('resolves immediately with failure on disconnect, clearing all timers', async () => {
    const session = new DisconnectableSession();
    const verdict = waitForPredicate(session, { kind: 'signal', name: 'never-fires' }, 30_000);
    await new Promise((r) => setTimeout(r, 0));
    session.disconnect();
    const r = await verdict;
    expect(r.pass).toBe(false);
    expect(r.failureReason).toBe('session disconnected');
  });

  it('unsubscribes the disconnect listener when the predicate resolves normally', async () => {
    const session = new DisconnectableSession();
    session.pushEvent(ev(EventType.SIGNAL, { name: 'done' }, 1));
    const verdict = waitForPredicate(session, { kind: 'signal', name: 'done' }, 30_000);
    expect(session.disconnectListenerCount()).toBe(1);
    const r = await verdict;
    expect(r.pass).toBe(true);
    expect(session.disconnectListenerCount()).toBe(0);
  });
});

describe('waitForPredicate coalescing', () => {
  it('a burst of events triggers at most one trailing re-check, not one per event', async () => {
    const session = new CoalesceSession();
    const p = waitForPredicate(
      session,
      { kind: 'state', store: 's', path: 'x', equals: 1 },
      10_000,
    );
    await flush();
    expect(session.commandCount).toBe(1); // initial evaluation, in flight

    for (let i = 0; i < 50; i += 1) session.emit();
    expect(session.commandCount).toBe(1); // 50 events blocked by the single-in-flight guard

    session.resolveNext({ stores: { s: { x: 0 } } }); // not-yet-true → exactly one trailing re-check
    // The trailing recheck is now PACED behind a short cooldown (flood throttle), so poll for it rather
    // than assuming it fires on the next microtask. Coalescing still holds: 50 events → ONE recheck.
    for (let i = 0; i < 100 && session.commandCount < 2; i += 1) await flush();
    expect(session.commandCount).toBe(2);

    session.resolveNext({ stores: { s: { x: 1 } } }); // now true → the wait resolves
    const r = await p;
    expect(r.pass).toBe(true);
  });
});

/**
 * A failure carries its cause as STRUCTURE, not only as prose.
 *
 * `failureReason` already said this in a sentence, and a sentence is the wrong shape for a consumer
 * that has to branch on it. Measured on three seeded bugs, an agent given observed/expected/assertion
 * alongside the source pointer used fewer tool calls than one given the pointer alone; the repair
 * literature separately has structured feedback beating rich natural-language feedback by 10.5pp,
 * with narrative finishing LAST. The prose stays for humans reading a log.
 *
 * Scope, stated so it cannot be mistaken for complete: the ELEMENT oracle carries these today. The
 * other classes (net, state, signal, console, route, settled, animation) still return prose only —
 * that is the remaining work, and the last test here names it rather than leaving it to memory.
 */
describe('element failures carry observed/expected/assertion', () => {
  const session = (elements: { states?: string[]; name?: string }[]): PredicateSession =>
    ({
      eventsSince: () => [],
      elapsed: () => 0,
      // Honours the state filter the way matchQuery does — without that, a state assertion "matches"
      // its own relaxed retry and the near-miss branch is never reached.
      command: (_cmd: string, args?: Record<string, unknown>) => {
        const want = 'string' === typeof args?.['state'] ? args['state'] : undefined;
        const all = elements.map((e, i) => ({
          ref: `e${String(i)}`,
          role: 'button',
          name: e.name ?? 'Save',
          states: e.states ?? ['present', 'visible', 'enabled'],
          visible: true,
        }));
        const hit = want === undefined ? all : all.filter((e) => e.states.includes(want));
        return Promise.resolve({
          kind: 'command_result',
          id: 'c',
          ok: true,
          result: { matched: hit.length > 0, count: hit.length, elements: hit },
        });
      },
    }) as unknown as PredicateSession;

  it('a missing element states what was looked for and what was seen', async () => {
    const r = await evaluatePredicate(session([]), {
      kind: 'element',
      query: { by: 'testid', value: 'new-deploy' },
    });
    expect(r.pass).toBe(false);
    expect(r.assertion).toBe('element.present');
    expect(r.observed).toContain('no matching element');
    expect(r.expected).toContain('new-deploy');
  });

  it('an element present in the wrong state reports the states it actually had', async () => {
    const r = await evaluatePredicate(session([{ states: ['present', 'hidden'] }]), {
      kind: 'element',
      query: { by: 'testid', value: 'new-deploy' },
      state: 'visible',
    });
    expect(r.pass).toBe(false);
    expect(r.assertion).toBe('element.state');
    expect(r.observed).toContain('hidden');
    expect(r.expected).toContain('visible');
  });

  it('an absent-assertion that finds something reports the count', async () => {
    const r = await evaluatePredicate(session([{}, {}]), {
      kind: 'element',
      query: { by: 'testid', value: 'toast' },
      absent: true,
    });
    expect(r.pass).toBe(false);
    expect(r.assertion).toBe('element.absent');
    expect(r.observed).toContain('2');
  });

  it('a MISSING scope SATISFIES an absence check — the scope being gone is the thing you waited for', async () => {
    // The common pattern: wait_for { absent, scope:'#loading-overlay' }. When the overlay is removed
    // (loading done), the scope is gone → the element is trivially absent → PASS. Treating scopeMissing
    // as a hard fail here burned the whole timeout and flipped a correct green to red.
    const scopeGone: PredicateSession = {
      eventsSince: () => [],
      elapsed: () => 0,
      onEvent: () => () => undefined,
      command: () =>
        Promise.resolve({
          kind: 'command_result',
          id: 'c',
          ok: true,
          result: { matched: false, count: 0, elements: [], scopeMissing: true },
        }),
    } as unknown as PredicateSession;
    const r = await evaluatePredicate(scopeGone, {
      kind: 'element',
      query: { by: 'testid', value: 'toast', scope: '#loading-overlay' },
      absent: true,
    });
    expect(r.pass).toBe(true);
    expect(JSON.stringify(r.evidence)).toContain('scopeMissing');
  });

  it('a MISSING scope FAILS a PRESENT assertion with a scope-specific reason (no whole-page widening)', async () => {
    const scopeGone: PredicateSession = {
      eventsSince: () => [],
      elapsed: () => 0,
      onEvent: () => () => undefined,
      command: () =>
        Promise.resolve({
          kind: 'command_result',
          id: 'c',
          ok: true,
          result: { matched: false, count: 0, elements: [], scopeMissing: true },
        }),
    } as unknown as PredicateSession;
    const r = await evaluatePredicate(scopeGone, {
      kind: 'element',
      query: { by: 'testid', value: 'save', scope: '#panel' },
    });
    expect(r.pass).toBe(false);
    expect(r.assertion).toBe('element.present');
    expect(r.failureReason).toContain('scope');
  });

  it('a PASSING assertion carries no failure structure — it is not noise on the green path', async () => {
    const r = await evaluatePredicate(session([{}]), {
      kind: 'element',
      query: { by: 'testid', value: 'new-deploy' },
    });
    expect(r.pass).toBe(true);
    expect(r.assertion).toBeUndefined();
    expect(r.observed).toBeUndefined();
  });

  /**
   * Every oracle now carries the structure, so this asserts COVERAGE rather than a limit.
   *
   * The test this replaces asserted the opposite — that non-element oracles had no `assertion` — and
   * went red the moment they grew one, which is precisely what it was written to do. A gap that
   * reports itself is the only kind that reliably gets closed; this repo lost four e2e specs and a
   * whole tool capability to gaps that did not.
   */
  const NON_ELEMENT: { label: string; predicate: Predicate; expected: string }[] = [
    {
      label: 'net',
      predicate: { kind: 'net', urlContains: '/api/x', count: 1 },
      expected: 'net.count',
    },
    {
      label: 'net presence',
      predicate: { kind: 'net', urlContains: '/api/x' },
      expected: 'net.present',
    },
    {
      label: 'route',
      predicate: { kind: 'route', pathname: '/deployments' },
      expected: 'route.changed',
    },
    {
      label: 'console',
      predicate: { kind: 'console', level: 'error' },
      expected: 'console.present',
    },
    {
      label: 'console absent',
      predicate: { kind: 'console', level: 'error', absent: true },
      expected: undefined as unknown as string,
    },
    {
      label: 'signal',
      predicate: { kind: 'signal', name: 'compose:generated' },
      expected: 'signal.absent',
    },
    {
      label: 'animation',
      predicate: { kind: 'animation', name: 'fade' },
      expected: 'animation.present',
    },
  ];

  for (const { label, predicate, expected } of NON_ELEMENT) {
    if (expected === undefined) continue; // absent-console PASSES on an empty window; nothing to assert
    it(`${label} failures carry an assertion kind`, async () => {
      const r = await evaluatePredicate(session([]), predicate);
      expect(r.pass).toBe(false);
      expect(r.assertion).toBe(expected);
      expect(r.observed).toBeDefined();
      expect(r.expected).toBeDefined();
    });
  }

  it('the assertion kind distinguishes failures that need different fixes', async () => {
    // "never fired" and "fired with the wrong payload" share one prose line but not one fix.
    const never = await evaluatePredicate(session([]), {
      kind: 'signal',
      name: 'compose:generated',
    });
    expect(never.assertion).toBe('signal.absent');
  });
});

describe('net predicate: ok — asserting on outcome, not a fabricated status', () => {
  const ipcFail = ev(EventType.NET_REQUEST, {
    method: 'ipc',
    url: 'ipc://todos:archive',
    ok: false,
    status: 500,
    error: 'archive is not implemented',
  });
  const httpOk = ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/save', status: 200 });

  /**
   * IPC has no status code. Reticle derives 200/500 so existing filters keep working, but making an
   * agent assert `status: 500` means asserting on a number Reticle invented — the assertion is about
   * Reticle's encoding rather than the app's behaviour. `ok` is the honest field.
   */
  it('matches a failed call without naming a status', async () => {
    const session = new FakeSession([ipcFail]);
    expect((await evaluatePredicate(session, { kind: 'net', ok: false })).pass).toBe(true);
    expect((await evaluatePredicate(session, { kind: 'net', ok: true })).pass).toBe(false);
  });

  it('treats a 2xx HTTP call as ok even though it never sets the field', async () => {
    const session = new FakeSession([httpOk]);
    expect((await evaluatePredicate(session, { kind: 'net', ok: true })).pass).toBe(true);
    expect((await evaluatePredicate(session, { kind: 'net', ok: false })).pass).toBe(false);
  });

  it('treats a 4xx/5xx HTTP call as not ok', async () => {
    const session = new FakeSession([
      ev(EventType.NET_REQUEST, { method: 'GET', url: '/api/x', status: 404 }),
    ]);
    expect((await evaluatePredicate(session, { kind: 'net', ok: false })).pass).toBe(true);
  });

  it('composes with the other net filters', async () => {
    const session = new FakeSession([ipcFail, httpOk]);
    const result = await evaluatePredicate(session, {
      kind: 'net',
      urlContains: 'ipc://todos:archive',
      ok: false,
    });
    expect(result.pass).toBe(true);
  });

  it('still honours an explicit status, so nothing that worked before changes', async () => {
    const session = new FakeSession([ipcFail]);
    expect((await evaluatePredicate(session, { kind: 'net', status: 500 })).pass).toBe(true);
  });
});
