import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from './contradictions.js';

/**
 * Two axes the contradiction hunter never had, and every rule needed both.
 *
 * ORIGIN. A verdict is about the app under test. An analytics beacon, an ad-blocked SDK bootstrap
 * and a vendor CDN ping are all somebody else's code failing in somebody else's domain, and none of
 * them says anything about whether the caller's action worked. Reported independently from several
 * apps: with any analytics package installed, a correct drive came back `contradicted`, and on one
 * app EVERY assertion did — it fires a branding call on page load. A verdict field that answers
 * "no" to everything is not a verdict field.
 *
 * ATTRIBUTION. A rule that says "the UI moved forward while a request failed" is a claim about
 * CAUSATION, and causation needs a cause. Over a window nothing attributed to an action, the two
 * halves merely co-occurred — a poll and a re-render that have nothing to do with each other, or
 * with the caller.
 *
 * The negative controls matter more than the positives here: the cheap way to silence a false
 * positive is to break the true one, and the true one is the product.
 */

const APP = 'http://localhost:3000/dashboard';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown> = {}, t?: number): ReticleEvent {
  seq += 1;
  return { t: t ?? seq, seq, type, sessionId: 's', data };
}

const domChanged = (t?: number): ReticleEvent => ev(EventType.DOM_REMOVED, { path: 'li' }, t);
const failedCall = (url: string, t?: number): ReticleEvent =>
  ev(
    EventType.NET_REQUEST,
    { id: `n${String(seq)}`, method: 'POST', url, status: 500, ok: false },
    t,
  );

const kinds = (events: ReticleEvent[], options = {}): string[] =>
  findContradictions(events, { actionSince: 0, appOrigin: APP, ...options }).map((c) => c.kind);

describe('contradictions — the first-party/third-party axis', () => {
  it('does not let a failed analytics beacon contradict an assertion the caller proved', () => {
    const beacon = failedCall('https://www.google-analytics.com/g/collect?v=2');
    expect(kinds([domChanged(), beacon])).toEqual([]);
  });

  it('does not let an ad-blocked third-party bootstrap contradict it either', () => {
    // What an extension-blocked request looks like on the wire: no response at all.
    const blocked = ev(EventType.NET_REQUEST, {
      id: 'n-blocked',
      method: 'GET',
      url: 'https://cdn.segment.com/analytics.js/v1/abc/analytics.min.js',
      status: 0,
      ok: false,
      error: 'Failed to fetch',
    });
    expect(kinds([domChanged(), blocked])).toEqual([]);
  });

  it('STILL fires on the app’s own failed request — the true positive, stated three ways', () => {
    // Relative: the overwhelmingly common shape, and first-party by construction.
    expect(kinds([domChanged(), failedCall('/api/todos')])).toEqual([
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    ]);
    // Absolute, same host, DIFFERENT PORT: a dev app on :3000 talking to its API on :8787 is the
    // ordinary local setup, and grading that as somebody else's traffic would silence the detector
    // on the bench app itself.
    expect(kinds([domChanged(), failedCall('http://localhost:8787/api/todos')])).toEqual([
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    ]);
    // A sibling subdomain: `api.example.com` called from `app.example.com` is the app's own backend.
    expect(
      kinds([domChanged(), failedCall('https://api.example.com/todos')], {
        appOrigin: 'https://app.example.com/dashboard',
      }),
    ).toEqual([ContradictionKind.UI_ADVANCED_REQUEST_FAILED]);
  });

  it('judges nothing by origin when nobody could say what the app’s origin is', () => {
    // Same absence rule the document scoping follows: an unknown origin disables the axis rather
    // than guessing, so an older SDK behaves exactly as it did before this existed.
    expect(
      kinds([domChanged(), failedCall('https://www.google-analytics.com/g/collect')], {
        appOrigin: undefined,
      }),
    ).toEqual([ContradictionKind.UI_ADVANCED_REQUEST_FAILED]);
  });
});

describe('contradictions — the attribution floor', () => {
  it('does not contradict a PASSIVE assertion with ambient first-party traffic', () => {
    // No action opened this window, so nothing in it is anybody's consequence: the app polled, the
    // poll failed, and a re-render landed. Neither half caused the other and the caller caused
    // neither.
    expect(kinds([domChanged(), failedCall('/api/branding')], { actionSince: undefined })).toEqual(
      [],
    );
  });

  it('ignores traffic that predates the action', () => {
    const before = [domChanged(30), failedCall('/api/branding', 10)];
    expect(kinds(before, { actionSince: 20 })).toEqual([]);
  });

  it('STILL fires on traffic the action itself caused', () => {
    const after = [domChanged(30), failedCall('/api/todos', 25)];
    expect(kinds(after, { actionSince: 20 })).toEqual([
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    ]);
  });

  it('leaves the app’s OWN claims judged with or without an action', () => {
    // The flagship false green, and the reason the floor is not a blanket "no action, no findings":
    // the app explicitly asserted success while its own request failed. That is a claim the app
    // made, not a consequence anybody inferred, so it stands on a passive assert too.
    const claimed = [
      ev(EventType.SIGNAL, { name: 'compose:generated' }),
      failedCall('/api/generate-script'),
    ];
    expect(kinds(claimed, { actionSince: undefined })).toEqual([
      ContradictionKind.SIGNAL_CONTRADICTED,
    ]);
  });
});

/**
 * What a success signal can and cannot be contradicted BY.
 *
 * The first scoping pass guarded the rules that reason from UI movement and deliberately left the
 * rules that read the app's own claims alone. That was right about the CLAIM — "the app fired
 * `saved`" is a thing the app said, true whoever caused it — and wrong about the COUNTER, which is
 * "N request(s) in the same window failed": a window statement, exactly the shape scoped out
 * everywhere else. Measured on the benchmark's negative cases, two of the three surviving false
 * positives were this rule.
 *
 * The fix is not the attribution floor. Requiring an attributed action would break the flagship
 * false green pinned above, where the app claims success on a PASSIVE assert while its own write
 * failed — and that case is the whole reason this rule exists.
 *
 * The discriminator is what FAILED. A success signal is a claim that a change was made, so a failed
 * MUTATION is evidence against it and a failed READ is not. A background poll, a prefetch, a
 * telemetry GET: those fail constantly in healthy apps and say nothing about whether a write landed.
 * `isMutating` already exists here and encodes exactly that distinction.
 */
describe('a success signal is contradicted by a failed WRITE, not by any failure', () => {
  it('is not contradicted by a failed background READ', () => {
    const poll = ev(EventType.NET_REQUEST, {
      id: 'n-poll',
      method: 'GET',
      url: '/api/poll',
      status: 500,
      ok: false,
    });
    expect(kinds([ev(EventType.SIGNAL, { name: 'item:saved' }), poll])).not.toContain(
      ContradictionKind.SIGNAL_CONTRADICTED,
    );
  });

  // The flagship, restated here so this rule's true positive cannot be lost to a later change.
  it('IS contradicted by the app’s own failed write, on a passive assert', () => {
    const claimed = [
      ev(EventType.SIGNAL, { name: 'compose:generated' }),
      failedCall('/api/generate-script'),
    ];
    expect(kinds(claimed, { actionSince: undefined })).toEqual([
      ContradictionKind.SIGNAL_CONTRADICTED,
    ]);
  });
});

/**
 * A failed READ is not evidence against a claim that something CHANGED.
 *
 * The rule above this one — a success signal contradicted by a failed write — was already scoped to
 * mutations, with the argument written beside it: background polls, prefetches and telemetry GETs
 * fail constantly in healthy apps and say nothing about whether a write landed. "The UI moved
 * forward" is the same kind of claim and was left reading ANY failure, so a first-party poll failing
 * during an action contradicted a verdict the action had genuinely earned.
 *
 * Measured on the observation benchmark: one of two false positives in 47 cells.
 */
describe('contradictions — a failed read is not a failed action', () => {
  const failedRead = (url: string, t?: number): ReticleEvent =>
    ev(
      EventType.NET_REQUEST,
      { id: `r${String(seq)}`, method: 'GET', url, status: 500, ok: false },
      t,
    );

  it('does not let a first-party background poll contradict a UI that moved', () => {
    expect(kinds([domChanged(), failedRead('/api/notifications/poll')])).toEqual([]);
  });

  it('still contradicts when the failure was a WRITE, which is the product', () => {
    expect(kinds([domChanged(), failedCall('/api/items')])).toContain('ui-advanced-request-failed');
  });

  it('reports the write and ignores the read when both failed', () => {
    const found = findContradictions(
      [domChanged(), failedRead('/api/poll'), failedCall('/api/items')],
      { actionSince: 0, appOrigin: APP },
    );
    const advanced = found.find((c) => 'ui-advanced-request-failed' === c.kind);
    expect(advanced?.counter).toContain('1 request');
    expect(advanced?.detail).toContain('/api/items');
    expect(advanced?.detail).not.toContain('/api/poll');
  });
});

/**
 * React StrictMode double-invokes a mount effect in development, so a navigation lands two identical
 * writes inside the action's own window. That is the dev tooling, not a double submit.
 *
 * The structural tell is the ROUTE CHANGE between the action and the writes: the claim
 * `duplicate-request` makes is "one user action was performed", and writes that follow a route
 * change belong to the mount of the view that was navigated TO, not to a user pressing submit twice.
 * A real double submit fires from the view it is already on, with no route change in between.
 *
 * Measured on the observation benchmark: the other of two false positives in 47 cells.
 */
describe('contradictions — a mount effect after navigation is not a double submit', () => {
  const write = (url: string, t: number): ReticleEvent =>
    ev(
      EventType.NET_REQUEST,
      { id: `w${String(t)}`, method: 'POST', url, status: 200, ok: true },
      t,
    );
  const routeChange = (t: number): ReticleEvent =>
    ev(EventType.ROUTE_CHANGE, { from: '/a', to: '/saved-items' }, t);

  it('does not call StrictMode’s doubled mount effect a duplicate write', () => {
    expect(kinds([routeChange(10), write('/api/seen', 20), write('/api/seen', 21)])).not.toContain(
      'duplicate-request',
    );
  });

  it('still catches a double submit on the view it was already on', () => {
    expect(kinds([write('/api/generate', 20), write('/api/generate', 21)])).toContain(
      'duplicate-request',
    );
  });

  it('still catches a double submit that happens BEFORE a later navigation', () => {
    // Order is the whole rule: writes then a route change is a submit that navigated on success.
    expect(
      kinds([write('/api/generate', 20), write('/api/generate', 21), routeChange(30)]),
    ).toContain('duplicate-request');
  });
});
