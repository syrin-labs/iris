import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { PredicateSchema } from '../events/predicate.js';
import { proposeConsequences } from './propose-consequences.js';

let seq = 0;
function e(type: EventType, data: Record<string, unknown>): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 'demo', data };
}

describe('proposeConsequences', () => {
  it('ranks a signal above net/state above presence, all deduped', () => {
    const events = [
      e(EventType.DOM_ADDED, { role: 'alert', name: 'Saved' }),
      e(EventType.NET_REQUEST, { method: 'POST', url: 'http://x/api/order', status: 200 }),
      e(EventType.SIGNAL, { name: 'order:placed' }),
      e(EventType.SIGNAL, { name: 'order:placed' }), // dup
    ];
    const proposals = proposeConsequences(events);
    expect(proposals[0]?.predicate).toMatchObject({ kind: 'signal', name: 'order:placed' });
    expect(proposals[0]?.weak).toBe(false);
    expect(proposals[proposals.length - 1]?.weak).toBe(true); // presence last
    // deduped: only one signal proposal
    expect(proposals.filter((p) => 'signal' === p.predicate['kind'])).toHaveLength(1);
  });

  it('extracts the pathname for a net proposal', () => {
    const proposals = proposeConsequences([
      e(EventType.NET_REQUEST, {
        method: 'GET',
        url: 'http://host:3000/api/cart?x=1',
        status: 200,
      }),
    ]);
    expect(proposals[0]?.predicate).toMatchObject({
      kind: 'net',
      method: 'GET',
      urlContains: '/api/cart',
    });
  });

  it('flags a presence-only proposal as weak', () => {
    const proposals = proposeConsequences([e(EventType.DOM_ADDED, { role: 'button', name: 'OK' })]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ weak: true, predicate: { kind: 'element', name: 'OK' } });
  });

  it('returns nothing for an empty window', () => {
    expect(proposeConsequences([])).toEqual([]);
  });
});

/**
 * Every proposal must be a predicate the verdict tools accept.
 *
 * This surface exists to hand an agent an assertion worth making, and it was handing over one that
 * `reticle_assert` refuses: the route proposal emitted `{ kind: 'route', to: '/' }`, and the
 * evaluator answers "unknown field to — route accepts: pathname, contains, since". An agent that
 * copied the proposal got a refusal, and the refusal is the good case; the bad one is concluding the
 * app is broken.
 *
 * Pinned against PredicateSchema rather than against the shape of the route proposal, because the
 * defect is not "route used the wrong key" — it is that nothing checked proposals are evaluable.
 */
describe('a proposed consequence is one the verdict tools accept', () => {
  it('every proposal parses as a predicate', () => {
    const events: ReticleEvent[] = [
      {
        t: 1,
        type: EventType.ROUTE_CHANGE,
        sessionId: 's',
        data: { pathname: '/', search: '', hash: '#/posts/12/show' },
      },
      {
        t: 2,
        type: EventType.NET_REQUEST,
        sessionId: 's',
        data: { method: 'GET', url: 'http://localhost/api/x', status: 200, ok: true },
      },
      { t: 3, type: EventType.SIGNAL, sessionId: 's', data: { name: 'saved' } },
    ];
    const proposals = proposeConsequences(events);
    expect(proposals.length).toBeGreaterThan(0);
    for (const p of proposals) {
      const parsed = PredicateSchema.safeParse(p.predicate);
      expect(parsed.success, `${JSON.stringify(p.predicate)} is not an evaluable predicate`).toBe(
        true,
      );
    }
  });

  // Same hash-router reading as the route predicate itself: the document pathname is `/` on every
  // page of a HashRouter app, so proposing it is proposing an assertion that says nothing.
  it('proposes the route the router is on, not the document path', () => {
    const proposals = proposeConsequences([
      {
        t: 1,
        type: EventType.ROUTE_CHANGE,
        sessionId: 's',
        data: { pathname: '/', search: '', hash: '#/posts/12/show' },
      },
    ]);
    const route = proposals.find((p) => 'route' === p.predicate.kind);
    expect(route?.predicate).toMatchObject({ pathname: '/posts/12/show' });
  });
});
