import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  EventType,
  FLOW_FILE_VERSION,
  type FlowFile,
  type ReticleEvent,
} from '@reticlehq/core';
import { startPathMismatchHint } from './flow-replay-run.js';

const flow = (startPath?: string): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name: 'checkout',
  createdAt: 1,
  steps: [{ tool: 'reticle_act', anchor: { kind: AnchorKind.TESTID, value: 'pay' } }],
  ...(startPath === undefined ? {} : { startPath }),
});

const onRoute = (pathname: string): { eventsSince(c: number): ReticleEvent[] } => ({
  eventsSince: () => [{ t: 1, type: EventType.ROUTE_CHANGE, sessionId: 's', data: { pathname } }],
});

const noRoute = (): { eventsSince(c: number): ReticleEvent[] } => ({ eventsSince: () => [] });

describe('startPathMismatchHint — wrong-page drift becomes an actionable next move', () => {
  it('names the navigate target when the tab is on a different route', () => {
    const hint = startPathMismatchHint(flow('/cart'), onRoute('/home'));
    expect(hint).toContain('/cart');
    expect(hint).toContain('reticle_navigate');
  });

  it('is silent when the tab is already on the start page', () => {
    expect(startPathMismatchHint(flow('/cart'), onRoute('/cart'))).toBeUndefined();
  });

  it('is silent when the flow has no startPath (back-compat)', () => {
    expect(startPathMismatchHint(flow(), onRoute('/home'))).toBeUndefined();
  });

  it('never false-alarms when the current route is unobservable', () => {
    expect(startPathMismatchHint(flow('/cart'), noRoute())).toBeUndefined();
  });

  it('falls back to the session URL when no route event was observed (hard-loaded tab)', () => {
    const session = { url: 'http://localhost:3000/reset-password', eventsSince: () => [] };
    const hint = startPathMismatchHint(flow('/login'), session);
    expect(hint).toContain('/login');
    expect(hint).toContain('/reset-password');
  });

  it('is silent when the session URL already sits on the start page', () => {
    const session = { url: 'http://localhost:3000/login?next=%2F', eventsSince: () => [] };
    expect(startPathMismatchHint(flow('/login'), session)).toBeUndefined();
  });

  it('treats a trailing slash as the same page, not as elsewhere', () => {
    const session = { url: 'http://localhost:3000/login/', eventsSince: () => [] };
    expect(startPathMismatchHint(flow('/login'), session)).toBeUndefined();
  });
});

/**
 * On a hash router the document pathname is `/` on every page, and BOTH sides of this comparison
 * read only the pathname — so `samePath('/', '/')` was always true and the hint never fired,
 * whatever route the tab had drifted to. Symmetrically blind, so it produced no WRONG hint; it
 * produced no hint at all, on the router a packaged Electron/Tauri renderer uses by default.
 *
 * `startPath` has to stay NAVIGABLE — the hint tells the caller to `reticle_navigate` to it — so the
 * value is `pathname + hash`, not the bare router path.
 */
const onHashRoute = (hash: string): { eventsSince(c: number): ReticleEvent[] } => ({
  eventsSince: () => [
    { t: 1, type: EventType.ROUTE_CHANGE, sessionId: 's', data: { pathname: '/', hash } },
  ],
});

describe('startPathMismatchHint sees a hash router', () => {
  it('fires when the tab drifted to a different hash route', () => {
    const hint = startPathMismatchHint(flow('/#/cart'), onHashRoute('#/home'));
    expect(hint).toContain('/#/cart');
    expect(hint).toContain('/#/home');
  });

  it('stays quiet when the tab is on the recorded hash route', () => {
    expect(startPathMismatchHint(flow('/#/cart'), onHashRoute('#/cart'))).toBeUndefined();
  });

  // A path-routed app must behave exactly as before.
  it('leaves a path-routed app alone', () => {
    expect(startPathMismatchHint(flow('/cart'), onRoute('/home'))).toContain('/cart');
    expect(startPathMismatchHint(flow('/cart'), onRoute('/cart'))).toBeUndefined();
  });
});
