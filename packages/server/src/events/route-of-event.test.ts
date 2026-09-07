/**
 * `routeOfEvent` / `routeOfUrl` — the one reading of a ROUTE_CHANGE (or a session URL).
 *
 * Six call sites used to pick `pathname` / `to` / `hash` out of the event by hand, and every one of
 * them was wrong on a hash router (document pathname `/` on every page). The helper returns both
 * the router path and the document parts so a start-path can stay NAVIGABLE (`docPath + hash`)
 * while a predicate still asserts the route the app is actually on.
 */
import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { routeOfEvent, routeOfUrl } from './predicate-route.js';

const change = (data: Record<string, unknown>): ReticleEvent => ({
  t: 1,
  type: EventType.ROUTE_CHANGE,
  sessionId: 's',
  data,
});

describe('routeOfEvent — path router', () => {
  it('routePath and docPath are the document pathname, hash empty', () => {
    const parts = routeOfEvent(change({ pathname: '/cart' }));
    expect(parts).toEqual({
      routePath: '/cart',
      docPath: '/cart',
      hash: '',
      search: '',
      full: '/cart',
    });
  });

  it('keeps search on full, not on routePath', () => {
    const parts = routeOfEvent(change({ pathname: '/login', search: '?next=%2F' }));
    expect(parts?.routePath).toBe('/login');
    expect(parts?.full).toBe('/login?next=%2F');
  });
});

describe('routeOfEvent — hash router', () => {
  it('routePath is the fragment path; docPath stays /; navigable is docPath + hash', () => {
    const parts = routeOfEvent(change({ pathname: '/', search: '', hash: '#/posts/12/show' }));
    expect(parts?.routePath).toBe('/posts/12/show');
    expect(parts?.docPath).toBe('/');
    expect(parts?.hash).toBe('#/posts/12/show');
    expect(`${parts?.docPath}${parts?.hash}`).toBe('/#/posts/12/show');
    expect(parts?.full).toBe('/#/posts/12/show');
  });

  it('strips a query inside the fragment from routePath', () => {
    const parts = routeOfEvent(change({ pathname: '/', hash: '#/posts?x=1' }));
    expect(parts?.routePath).toBe('/posts');
    expect(parts?.hash).toBe('#/posts?x=1');
  });
});

describe('routeOfEvent — field order and absence', () => {
  it('falls back to `to` when pathname is missing', () => {
    const parts = routeOfEvent(change({ to: '/reset-password' }));
    expect(parts?.docPath).toBe('/reset-password');
    expect(parts?.routePath).toBe('/reset-password');
  });

  it('reads a bare data payload the same way as the wrapping event', () => {
    const data = { pathname: '/', hash: '#/cart' };
    expect(routeOfEvent(data)?.routePath).toBe(routeOfEvent(change(data))?.routePath);
  });

  it('is undefined when neither pathname nor to is present', () => {
    expect(routeOfEvent(change({ search: '?q=1' }))).toBeUndefined();
    expect(routeOfEvent({ hash: '#/cart' })).toBeUndefined();
  });

  it('refuses a non-route event rather than reading whatever is in data', () => {
    expect(
      routeOfEvent({
        t: 1,
        type: EventType.SIGNAL,
        sessionId: 's',
        data: { pathname: '/cart' },
      }),
    ).toBeUndefined();
  });
});

describe('routeOfUrl — session URL fallback', () => {
  it('matches the navigable pathname+hash currentPathOf uses on a hard-loaded tab', () => {
    const parts = routeOfUrl('http://localhost:3000/login#/cart');
    expect(parts?.docPath).toBe('/login');
    expect(parts?.hash).toBe('#/cart');
    expect(`${parts?.docPath}${parts?.hash}`).toBe('/login#/cart');
    expect(parts?.routePath).toBe('/cart');
  });

  it('is undefined on an unreadable URL', () => {
    expect(routeOfUrl('')).toBeUndefined();
  });
});
