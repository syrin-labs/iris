/**
 * A verdict must be decided by the channel the caller asked about.
 *
 * Both cases here were measured in the field on correct apps:
 *
 *  - an error path verified by declaring the failing request in the oracle — `{ net, POST,
 *    /api/v1/auth/login, status: 500 }` plus the right message present and the wrong one absent —
 *    came back "channels disagree (ui-advanced-request-failed)" every single run, so error handling
 *    was the one thing that could never reach a green verdict;
 *  - a navigation whose destination heading was FOUND, with its source file and line, was reported
 *    as `route-rendered-nothing` — a clause name the evidence beside it disproves.
 *
 * The negative controls are the point of the file: each fix has to leave the real false green it was
 * built for catchable, so every suppression here is paired with a case that must still fire.
 */

import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, PredicateKind, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from './contradictions.js';
import { declaredExpectations } from './declared.js';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown> = {}): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 's', data };
}

const domChanged = (): ReticleEvent => ev(EventType.DOM_ADDED, { path: 'div.alert' });
const failedCall = (method: string, url: string, status: number): ReticleEvent =>
  ev(EventType.NET_REQUEST, { id: `n${String(seq)}`, method, url, status, ok: false });

const kindsOf = (found: { kind: string }[]): string[] => found.map((c) => c.kind);

const loginFailed = (status: number): ReticleEvent[] => [
  domChanged(),
  failedCall('POST', '/api/v1/auth/login', status),
];

describe('a declared expected failure is not a contradiction', () => {
  it('stays silent when the caller declared exactly this failing call', () => {
    const found = findContradictions(loginFailed(500), {
      expectedFailures: [{ method: 'POST', urlContains: '/api/v1/auth/login', status: 500 }],
    });
    expect(kindsOf(found)).not.toContain(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
  });

  it('honours a declaration that named only the url', () => {
    const found = findContradictions(loginFailed(401), {
      expectedFailures: [{ urlContains: '/api/v1/auth/login' }],
    });
    expect(kindsOf(found)).not.toContain(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
  });

  // ── Negative controls ───────────────────────────────────────────────────────────────────────
  // The archetype this rule exists for: the UI moved forward while a request nobody expected to
  // fail, failed. Declaring one failure must never become a blanket amnesty for the window.
  it('still catches a failure the caller did NOT declare', () => {
    const found = findContradictions(
      [...loginFailed(500), failedCall('POST', '/api/v1/orders', 500)],
      {
        expectedFailures: [{ method: 'POST', urlContains: '/api/v1/auth/login', status: 500 }],
        actionSince: 0,
      },
    );
    expect(kindsOf(found)).toContain(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
    expect(found[0]?.detail).toContain('/api/v1/orders');
    expect(found[0]?.detail).not.toContain('/api/v1/auth/login');
  });

  it('still catches a failure whose status is not the declared one', () => {
    const found = findContradictions(loginFailed(503), {
      expectedFailures: [{ urlContains: '/api/v1/auth/login', status: 500 }],
      actionSince: 0,
    });
    expect(kindsOf(found)).toContain(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
  });

  it('still catches it with no declaration at all', () => {
    expect(kindsOf(findContradictions(loginFailed(500), { actionSince: 0 }))).toContain(
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    );
  });

  /**
   * The sharp rule stays sharp. Declaring that a request fails says nothing about the app being
   * entitled to announce success over it — an app that fires `auth:granted` on a 500 is lying
   * whatever the caller expected of the request, and that is the archetype false green.
   */
  it('still catches a success SIGNAL fired over the declared failure', () => {
    const found = findContradictions(
      [...loginFailed(500), ev(EventType.SIGNAL, { name: 'auth:granted' })],
      { expectedFailures: [{ urlContains: '/api/v1/auth/login', status: 500 }] },
    );
    expect(kindsOf(found)).toContain(ContradictionKind.SIGNAL_CONTRADICTED);
  });

  /**
   * Nor does it excuse blaming the user for a server fault. "Incorrect email or password" over a 5xx
   * sends someone to fix something they cannot fix, and the caller expecting the 5xx does not make
   * the message right.
   */
  it('still catches a server fault the app blamed on the user', () => {
    const found = findContradictions(
      [
        ...loginFailed(500),
        ev(EventType.STATE_CHANGE, { path: 'form.error', value: 'Incorrect email or password' }),
      ],
      { expectedFailures: [{ urlContains: '/api/v1/auth/login', status: 500 }] },
    );
    expect(kindsOf(found)).toContain(ContradictionKind.FAILURE_MISATTRIBUTED);
  });
});

describe('a declared denial on screen is proof of the 401, not a contradiction', () => {
  it('stays silent when the caller asserted Access denied over a 401', () => {
    const declared = declaredExpectations({
      kind: PredicateKind.TEXT,
      contains: 'Access denied',
    });
    const found = findContradictions(loginFailed(401), {
      expectedFailures: declared.netFailures,
      actionSince: 0,
    });
    expect(kindsOf(found)).not.toContain(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
  });

  it('stays silent for a 403 the same way — platform-only page, Access denied', () => {
    const declared = declaredExpectations({
      kind: PredicateKind.TEXT,
      contains: 'Access denied',
    });
    const found = findContradictions(loginFailed(403), {
      expectedFailures: declared.netFailures,
      actionSince: 0,
    });
    expect(kindsOf(found)).not.toContain(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
  });

  // ── Negative controls ───────────────────────────────────────────────────────────────────────
  // A 5xx with denial copy on screen is the misattributed-fault shape, not an expected auth
  // denial. Suppressing the heuristic here would hide the one case the other rule exists for.
  it('still catches a 500 — denial copy does not amnesty a server fault', () => {
    const declared = declaredExpectations({
      kind: PredicateKind.TEXT,
      contains: 'Access denied',
    });
    const found = findContradictions(loginFailed(500), {
      expectedFailures: declared.netFailures,
      actionSince: 0,
    });
    expect(kindsOf(found)).toContain(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
  });

  it('still catches a success SIGNAL fired over the 401', () => {
    const declared = declaredExpectations({
      kind: PredicateKind.TEXT,
      contains: 'Access denied',
    });
    const found = findContradictions(
      [...loginFailed(401), ev(EventType.SIGNAL, { name: 'auth:granted' })],
      { expectedFailures: declared.netFailures },
    );
    expect(kindsOf(found)).toContain(ContradictionKind.SIGNAL_CONTRADICTED);
  });
});

describe('a blank destination is not blank when the caller proved its content', () => {
  const navigated = (): ReticleEvent[] => [ev(EventType.ROUTE_CHANGE, { to: '/forgot-password' })];

  it('stays silent when the declared on-screen consequence was found', () => {
    const found = findContradictions(navigated(), { renderProved: true });
    expect(kindsOf(found)).not.toContain(ContradictionKind.ROUTE_RENDERED_NOTHING);
  });

  // ── Negative controls ───────────────────────────────────────────────────────────────────────
  // A route with no view still has to be reportable: nothing was asserted on screen, so nothing
  // witnesses the destination and the absence is the only evidence there is.
  it('still catches a destination nobody asserted content for', () => {
    expect(kindsOf(findContradictions(navigated()))).toContain(
      ContradictionKind.ROUTE_RENDERED_NOTHING,
    );
    expect(kindsOf(findContradictions(navigated(), { renderProved: false }))).toContain(
      ContradictionKind.ROUTE_RENDERED_NOTHING,
    );
  });
});
