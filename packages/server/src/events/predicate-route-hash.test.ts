/**
 * `pathname` on a hash-routed app.
 *
 * This file already fixed `contains` for hash routers, with the reason written down: "A hash router
 * keeps the entire route in the fragment, so matching pathname alone made `contains` unsatisfiable
 * for every HashRouter app; that is the standard router for a packaged Electron/Tauri renderer."
 *
 * `pathname` has the same disease and was left with it. On a HashRouter the document pathname is
 * always `/`, so `{ kind: 'route', pathname: '/posts/12/show' }` could never pass — and that is the
 * shape the tool's own refusal message offers as the canonical example. Measured against react-admin
 * under Electron, sitting at `#/posts/12/show`:
 *
 *   failureReason: "route changed to is '/', expected '/posts/12/show'"
 *
 * A guaranteed false red, Reticle telling a user their working app is broken — the same failure this
 * file's other test was written for, on the router that desktop actually uses.
 */
import { describe, expect, it } from 'vitest';
import { evalRoute } from './predicate-route.js';
import { EventType, PredicateKind, type ReticleEvent } from '@reticlehq/core';

const hashChange = (hash: string): ReticleEvent[] => [
  { t: 1, type: EventType.ROUTE_CHANGE, sessionId: 's', data: { pathname: '/', search: '', hash } },
];

const route = (fields: Record<string, unknown>) =>
  ({ kind: PredicateKind.ROUTE, ...fields }) as Parameters<typeof evalRoute>[1];

describe('route.pathname reads the hash route on a hash-routed app', () => {
  it('passes when the hash path is what was asserted', () => {
    const r = evalRoute(hashChange('#/posts/12/show'), route({ pathname: '/posts/12/show' }));
    expect(r.pass).toBe(true);
  });

  it('fails when the hash path is a different route', () => {
    const r = evalRoute(hashChange('#/posts/12/show'), route({ pathname: '/comments' }));
    expect(r.pass).toBe(false);
  });

  // The document pathname is `/` on every hash-routed page, so honouring it would make a `/`
  // assertion trivially true everywhere — a green that says nothing about where the app is.
  it('does not let the document pathname stand in for the route', () => {
    const r = evalRoute(hashChange('#/posts/12/show'), route({ pathname: '/' }));
    expect(r.pass).toBe(false);
  });

  it('ignores a query inside the fragment', () => {
    const r = evalRoute(hashChange('#/posts?page=2'), route({ pathname: '/posts' }));
    expect(r.pass).toBe(true);
  });

  it('falls back to the current url when the window holds no change', () => {
    const r = evalRoute(
      [],
      route({ pathname: '/posts/12/show' }),
      'http://localhost:8000/#/posts/12/show',
    );
    expect(r.pass).toBe(true);
  });

  // A path-routed app must be untouched: no hash, so the pathname is the route.
  it('leaves a path-routed app alone', () => {
    const events: ReticleEvent[] = [
      { t: 1, type: EventType.ROUTE_CHANGE, sessionId: 's', data: { pathname: '/dashboard' } },
    ];
    expect(evalRoute(events, route({ pathname: '/dashboard' })).pass).toBe(true);
    expect(evalRoute(events, route({ pathname: '/other' })).pass).toBe(false);
  });

  // "route changed to is '/'" — the clause and the verb were both in the sentence.
  it('reads as a sentence when it fails', () => {
    const r = evalRoute(hashChange('#/posts'), route({ pathname: '/comments' }));
    expect(r.failureReason).not.toContain('to is');
  });
});
