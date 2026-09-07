import { describe, expect, it } from 'vitest';
import { EventType, PerfMetric, type ReticleEvent } from '@reticlehq/core';
import { causalSummary, MAX_SUMMARY_ENTRIES } from './causal-summary.js';

let seq = 0;
function e(type: EventType, data: Record<string, unknown>): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 'demo', data };
}

/**
 * A store that ends consistent can have been inconsistent on the way there, and a from→to pair
 * cannot say so. Measured on a real merchant dashboard: an account switch moved `accountId`
 * immediately and `payments` 160 ms later, so for 160 ms the header named one tenant while the rows
 * belonged to another. Both diffs were reported and nothing said they were 160 ms apart — and
 * waiting for the page to settle is, by construction, waiting for that evidence to disappear.
 */
describe('state diffs carry WHEN, so settling cannot hide a transient', () => {
  const at = (t: number, path: string, from: unknown, to: unknown): ReticleEvent => ({
    t,
    seq: t,
    type: EventType.STATE_CHANGE,
    sessionId: 'demo',
    data: { name: 'dashboard', path, old: from, value: to },
  });

  it('reports the gap between two paths of the same store', () => {
    const summary = causalSummary([
      at(12, 'accountId', 'acc_002', 'acc_001'),
      at(172, 'payments', '[old rows]', '[new rows]'),
    ]);
    expect(summary.stateDiffs.map((d) => [d.path, d.atMs])).toEqual([
      ['accountId', 12],
      ['payments', 172],
    ]);
    // The 160 ms in which the UI showed a MIXTURE — the whole signature of the defect.
    expect(summary.stateSettleMs).toBe(160);
  });

  it('omits the span when the store moved atomically', () => {
    // An app that updates every path in one tick pays nothing, so the field's PRESENCE is the signal.
    const summary = causalSummary([
      at(12, 'accountId', 'acc_002', 'acc_001'),
      at(12, 'payments', '[old]', '[new]'),
    ]);
    expect(summary.stateSettleMs).toBeUndefined();
  });

  it('omits the span for a single change — there is no interval to describe', () => {
    expect(causalSummary([at(12, 'accountId', 'a', 'b')]).stateSettleMs).toBeUndefined();
  });
});

describe('causalSummary', () => {
  it('composes counts, diffs, route, signals, and perf from the window', () => {
    const summary = causalSummary([
      e(EventType.NET_REQUEST, { method: 'GET', url: '/api/ok', status: 200, ok: true }),
      e(EventType.NET_REQUEST, { method: 'POST', url: '/api/order', status: 500, ok: false }),
      e(EventType.CONSOLE_ERROR, { message: 'boom' }),
      e(EventType.STATE_CHANGE, { name: 'cart.count' }),
      e(EventType.STORAGE_CHANGE, { area: 'local', key: 'cart' }),
      e(EventType.ROUTE_CHANGE, { pathname: '/thanks' }),
      e(EventType.SIGNAL, { name: 'order:placed' }),
      e(EventType.PERF, { metric: PerfMetric.CLS, value: 0.12, at: 1 }),
      e(EventType.PERF, { metric: PerfMetric.LONGTASK, value: 80, at: 1 }),
    ]);
    expect(summary.net).toEqual({ total: 2, errors: 1, headline: 'POST /api/order 500' });
    expect(summary.consoleErrors).toBe(1);
    expect(summary.statePathsChanged).toEqual(['cart.count']);
    expect(summary.storageKeysChanged).toEqual(['cart']);
    expect(summary.route).toBe('/thanks');
    expect(summary.signals).toEqual(['order:placed']);
    expect(summary.layoutShift).toBe(0.12);
    expect(summary.longTasks).toBe(1);
  });

  it('reports state/storage as before→after DIFFS, using the shape the observers really emit', () => {
    // STATE_CHANGE is emitted by the store observer as { name, path, value, old } — `value` is the AFTER
    // side. An earlier version of this test invented an {old,new} shape, so stateDiffs silently stayed
    // empty against a live app even though the unit test passed. Assert the REAL wire shape.
    const summary = causalSummary([
      e(EventType.STATE_CHANGE, { name: 'app', path: 'cart.count', old: 0, value: 1 }),
      e(EventType.STORAGE_CHANGE, { area: 'local', key: 'token', old: 'a', new: 'b' }),
    ]);
    expect(summary.stateDiffs).toMatchObject([{ path: 'cart.count', from: 0, to: 1 }]);
    expect(summary.storageDiffs).toEqual([{ key: 'token', from: 'a', to: 'b' }]);
    // The lean name lists stay for the compact index.
    expect(summary.statePathsChanged).toEqual(['app']); // the store name, as the observer emits it
    expect(summary.storageKeysChanged).toEqual(['token']);
  });

  it('caps long diff values so the per-act summary stays bounded', () => {
    const big = 'x'.repeat(500);
    const summary = causalSummary([
      e(EventType.STORAGE_CHANGE, { area: 'local', key: 'blob', old: '', new: big }),
    ]);
    const to = summary.storageDiffs[0]?.to;
    expect(typeof to).toBe('string');
    expect((to as string).length).toBeLessThanOrEqual(140);
  });

  it('omits optional fields on a quiet green act', () => {
    const summary = causalSummary([
      e(EventType.NET_REQUEST, { method: 'GET', url: '/api/ok', status: 200, ok: true }),
    ]);
    expect(summary.net).toEqual({ total: 1, errors: 0 });
    expect(summary.route).toBeUndefined();
    expect(summary.layoutShift).toBeUndefined();
    expect(summary.signals).toEqual([]);
  });
});

/**
 * The verdict must not be the field that gets truncated.
 *
 * Reported from an MCP session: one `reticle_act_and_wait` click returned ~363KB of single-line JSON
 * and blew the client's per-result limit twice, so `verified` / `verifiedReason` / `because` — the
 * only fields the call exists to produce — were unreachable and had to be dug out of a spill file.
 * Each diff VALUE was capped; the NUMBER of diffs was not, and a registered TanStack Query store
 * emits one state change per cache key. The better instrumented the app, the bigger the payload:
 * registering a store is the thing we ask users to do, and it is what makes this fire.
 */
describe('summary size does not depend on how much the app did', () => {
  const stateChanges = (count: number): ReticleEvent[] =>
    Array.from({ length: count }, (_unused, i) =>
      e(EventType.STATE_CHANGE, {
        name: 'queryCache',
        path: `queries.${String(i)}`,
        old: 'x'.repeat(500),
        value: 'y'.repeat(500),
      }),
    );

  it('caps the number of state diffs and says how many it dropped', () => {
    const summary = causalSummary(stateChanges(400));
    expect(summary.stateDiffs.length).toBe(MAX_SUMMARY_ENTRIES);
    expect(summary.elided?.stateDiffs).toBe(400 - MAX_SUMMARY_ENTRIES);
  });

  it('caps the name list too — a store per cache key is the same unbounded shape', () => {
    const summary = causalSummary(
      Array.from({ length: 400 }, (_unused, i) =>
        e(EventType.STATE_CHANGE, { name: `cache-${String(i)}`, old: 1, value: 2 }),
      ),
    );
    expect(summary.statePathsChanged.length).toBe(MAX_SUMMARY_ENTRIES);
    expect(summary.elided?.statePathsChanged).toBe(400 - MAX_SUMMARY_ENTRIES);
  });

  it('caps storage diffs and signals on the same rule', () => {
    const summary = causalSummary([
      ...Array.from({ length: 60 }, (_unused, i) =>
        e(EventType.STORAGE_CHANGE, { key: `k${String(i)}`, old: 'a', new: 'b' }),
      ),
      ...Array.from({ length: 60 }, (_unused, i) => e(EventType.SIGNAL, { name: `s${String(i)}` })),
    ]);
    expect(summary.storageDiffs.length).toBe(MAX_SUMMARY_ENTRIES);
    expect(summary.storageKeysChanged.length).toBe(MAX_SUMMARY_ENTRIES);
    expect(summary.signals.length).toBe(MAX_SUMMARY_ENTRIES);
    expect(summary.elided?.storageDiffs).toBe(60 - MAX_SUMMARY_ENTRIES);
  });

  it('says nothing about elision when nothing was elided', () => {
    const summary = causalSummary(stateChanges(2));
    expect(summary.elided).toBeUndefined();
  });

  it('measures the settle window over EVERY diff, not just the ones it kept', () => {
    // The interval is the whole point of the field: capping the evidence must not shrink the fact.
    const diffs = stateChanges(400);
    const summary = causalSummary(diffs);
    expect(summary.stateSettleMs).toBe((diffs.at(-1)?.t ?? 0) - (diffs[0]?.t ?? 0));
  });
});

/**
 * An empty `stateDiffs` has two meanings and the wrong one is the default reading: "the app changed
 * no state" is a claim, "nothing was watching state" is a blind spot. The summary is where the
 * agent reads the empty list, so it is where the difference has to be visible.
 */
describe('an unwatched state channel is not an unchanged one', () => {
  it('marks the state channel unwatched when the session says nothing is subscribed', () => {
    const summary = causalSummary([e(EventType.NET_REQUEST, { url: '/api/x', status: 200 })], {
      stateUnwatched: true,
    });
    expect(summary.stateUnwatched).toBe(true);
    expect(summary.stateDiffs).toEqual([]);
  });

  it('says nothing on the common path — a watched channel pays no field', () => {
    const changed = [e(EventType.STATE_CHANGE, { name: 'cart', path: 'total', old: 1, value: 2 })];
    expect(causalSummary(changed).stateUnwatched).toBeUndefined();
    expect(causalSummary(changed, { stateUnwatched: false }).stateUnwatched).toBeUndefined();
  });
});

/**
 * `summary.route` reported the DOCUMENT pathname, which is `/` on every page of a hash-routed app —
 * the same misreading that made `{ kind: 'route', pathname }` unsatisfiable there. An agent reading
 * this field after a navigation would conclude the route never changed. Measured on react-admin
 * under Electron: the app moved to `#/posts/12/show` and the summary said `/`.
 */
describe('the summary reports the route the router is on', () => {
  it('reads the fragment on a hash-routed app', () => {
    const s = causalSummary([
      {
        t: 1,
        type: EventType.ROUTE_CHANGE,
        sessionId: 's',
        data: { pathname: '/', search: '', hash: '#/posts/12/show' },
      },
    ]);
    expect(s.route).toBe('/posts/12/show');
  });

  it('still reports the pathname on a path-routed app', () => {
    const s = causalSummary([
      { t: 1, type: EventType.ROUTE_CHANGE, sessionId: 's', data: { pathname: '/dashboard' } },
    ]);
    expect(s.route).toBe('/dashboard');
  });
});
