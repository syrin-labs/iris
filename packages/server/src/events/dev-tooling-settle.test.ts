import { describe, it, expect } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { evalSettled } from './predicate-eval.js';
import { findContradictions } from './contradictions.js';
import { causalSummary } from '../capsule/causal-summary.js';

/**
 * A dev-tooling request in flight must not hold settle open, and must not read as "the UI advanced
 * over a request that never settled".
 *
 * Reproduced twice on a real drive: a CORRECT Next.js navigation graded `verified: "no"` because the
 * dev overlay was resolving a source map for an unrelated React key warning
 * (`POST /__nextjs_original-stack-frames`). The control click, on a page that logged no warning,
 * graded "yes". Every Next app that logs one dev warning got a false negative on every action.
 *
 * The other half of every test here is the over-exclusion guard: a REAL app request in the same
 * position must still block. Excluding too much would turn this false negative into a false green.
 */

let seq = 0;
function ev(type: EventType, data: Record<string, unknown>, t = ++seq): ReticleEvent {
  return { t, seq, type, sessionId: 's', data };
}
const pending = (url: string, id = `n${String(++seq)}`): ReticleEvent =>
  ev(EventType.NET_PENDING, { id, method: 'POST', url });
const domChanged = (): ReticleEvent => ev(EventType.DOM_REMOVED, { path: 'li' });

const OVERLAY = 'http://localhost:3000/__nextjs_original-stack-frames';
const HMR = '/_next/static/webpack/633457081244afec.webpack.hot-update.json';
const VITE = '/@vite/client';
const APP = '/api/save';

describe('settle — dev-tooling traffic does not count', () => {
  it('settles while only the Next dev overlay is in flight', () => {
    const r = evalSettled([pending(OVERLAY)], { kind: 'settled', quietMs: 500 }, 100_000);
    expect(true).toBe(r.pass);
  });

  it.each([HMR, VITE])('settles while only %s is in flight', (url) => {
    const r = evalSettled([pending(url)], { kind: 'settled', quietMs: 500 }, 100_000);
    expect(true).toBe(r.pass);
  });

  it('DISCLOSES what it ignored rather than hiding it', () => {
    const r = evalSettled([pending(OVERLAY)], { kind: 'settled', quietMs: 500 }, 100_000);
    expect([OVERLAY]).toEqual((r.evidence as { ignoredDevTooling?: string[] }).ignoredDevTooling);
  });

  it('does not claim to have ignored anything on an ordinary window', () => {
    const events = [
      ev(EventType.NET_PENDING, { id: 'r1', url: APP }, 100),
      ev(EventType.NET_REQUEST, { id: 'r1', url: APP, status: 200 }, 200),
    ];
    const r = evalSettled(events, { kind: 'settled', quietMs: 500 }, 1000);
    expect(undefined).toBe((r.evidence as { ignoredDevTooling?: string[] }).ignoredDevTooling);
  });

  // ── over-exclusion guard ──────────────────────────────────────────────────────────────────────
  it('a REAL request still blocks settle, dev tooling alongside it or not', () => {
    const r = evalSettled(
      [pending(OVERLAY), pending(APP)],
      { kind: 'settled', quietMs: 500 },
      100_000,
    );
    expect(false).toBe(r.pass);
    expect(1).toBe((r.evidence as { inFlight: number }).inFlight);
  });

  it('a dev-tooling request does not reset the quiet timer either', () => {
    // Completed overlay fetch 10ms ago: the page is quiet, the toolchain is not.
    const events = [ev(EventType.NET_REQUEST, { id: 'd1', url: OVERLAY, status: 200 }, 990)];
    expect(true).toBe(evalSettled(events, { kind: 'settled', quietMs: 500 }, 1000).pass);
    const appEvents = [ev(EventType.NET_REQUEST, { id: 'a1', url: APP, status: 200 }, 990)];
    expect(false).toBe(evalSettled(appEvents, { kind: 'settled', quietMs: 500 }, 1000).pass);
  });
});

describe('contradictions — dev-tooling traffic is not evidence about the app', () => {
  it('does not report the dev overlay as a request the UI advanced over', () => {
    const found = findContradictions([pending(OVERLAY), domChanged()]);
    expect([]).toEqual(found.map((c) => c.kind));
  });

  it('still reports a REAL request the UI advanced over, and says what it ignored', () => {
    const found = findContradictions([pending(OVERLAY), pending(APP), domChanged()], {
      actionSince: 0,
    });
    expect([ContradictionKind.REQUEST_NEVER_SETTLED]).toEqual(found.map((c) => c.kind));
    expect(true).toBe(found[0]?.detail.includes(APP));
    expect(true).toBe(found[0]?.detail.includes('dev tooling'));
  });

  it('does not judge a FAILED dev-tooling call as the app failing', () => {
    // The overlay 404s all the time (a source map that is not there). That is not the app's write.
    const failedOverlay = ev(EventType.NET_REQUEST, {
      id: 'd2',
      method: 'POST',
      url: OVERLAY,
      status: 404,
      ok: false,
    });
    expect([]).toEqual(findContradictions([failedOverlay, domChanged()]).map((c) => c.kind));
  });
});

describe('causal summary — the ignored calls are counted, not hidden', () => {
  it('reports dev-tooling calls separately from the app own traffic', () => {
    const summary = causalSummary([
      ev(EventType.NET_REQUEST, { id: 'd1', method: 'POST', url: OVERLAY, status: 200, ok: true }),
      ev(EventType.NET_REQUEST, { id: 'a1', method: 'POST', url: APP, status: 200, ok: true }),
    ]);
    expect({ total: 1, errors: 0, ignoredDevTooling: 1 }).toEqual(summary.net);
  });

  it('says nothing about dev tooling when there was none', () => {
    const summary = causalSummary([
      ev(EventType.NET_REQUEST, { id: 'a1', method: 'POST', url: APP, status: 200, ok: true }),
    ]);
    expect({ total: 1, errors: 0 }).toEqual(summary.net);
  });
});
