import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from './contradictions.js';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown> = {}): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 's', data };
}

const domChanged = (): ReticleEvent => ev(EventType.DOM_REMOVED, { path: 'li' });
const stateChanged = (): ReticleEvent =>
  ev(EventType.STATE_CHANGE, { store: 'app', path: 'todos' });
const okCall = (method = 'POST', url = '/api/x'): ReticleEvent =>
  ev(EventType.NET_REQUEST, { id: `n${String(seq)}`, method, url, status: 200, ok: true });
const failedCall = (method = 'POST', url = '/api/x'): ReticleEvent =>
  ev(EventType.NET_REQUEST, { id: `n${String(seq)}`, method, url, status: 500, ok: false });

const kinds = (events: ReticleEvent[]): string[] => findContradictions(events).map((c) => c.kind);

/**
 * The same window, stated as an ACTION's window.
 *
 * Every rule that reasons from "the UI moved forward" now requires an action to have moved it: over
 * a window nothing is attributed to, a re-render and a failed poll merely co-occurred, and calling
 * that a contradiction is how an app with any background traffic came to fail every verdict. These
 * cases were always about a click's window — they simply never had to say so.
 */
const causedKinds = (events: ReticleEvent[]): string[] =>
  findContradictions(events, { actionSince: 0 }).map((c) => c.kind);

describe('findContradictions — cross-channel disagreement', () => {
  /**
   * The archetype, and the exact bug both desktop demo apps plant: the row disappears, the status
   * line reads "archived", and the IPC call rejected. Screenshot, DOM assertion and human glance all
   * agree the feature works. Only the disagreement BETWEEN channels reveals it.
   */
  /**
   * A one-way `ipcRenderer.send` reports NO verdict — neither `ok` nor `status` — because the
   * renderer never learns whether the main process handled it. Reading that absence as failure
   * raised `ui-advanced-request-failed` against every fire-and-forget send in a healthy app, which
   * is a false red, and false reds cost trust as fast as false greens do.
   */
  it('does not call a verdictless one-way send a failure', () => {
    const verdictlessSend = ev(EventType.NET_REQUEST, {
      id: 'n-oneway',
      method: 'IPC',
      url: 'ipc://invoices:seen',
      oneWay: true,
    });
    expect(kinds([domChanged(), verdictlessSend])).not.toContain(
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    );
  });

  it('catches a UI that advanced while its request failed', () => {
    const found = findContradictions([domChanged(), failedCall('IPC', 'ipc://todos:archive')], {
      actionSince: 0,
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
    expect(found[0]?.detail).toContain('ipc://todos:archive');
  });

  /**
   * The discriminator that keeps the headline rule honest. A handler that CATCHES the rejection and
   * renders "could not add" also moves the UI while a request failed — identical at the level of
   * "DOM changed + request failed". What separates correct code from a swallowed error is whether
   * the app recorded the failure anywhere in the state the UI renders from.
   */
  it('stays silent when the app recorded the failure in its own state', () => {
    const acknowledgedByPath = [
      ev(EventType.STATE_CHANGE, { name: 'app', path: 'lastError', value: 'title is required' }),
      failedCall(),
    ];
    expect(kinds(acknowledgedByPath)).toEqual([]);

    const acknowledgedByValue = [
      ev(EventType.STATE_CHANGE, { name: 'app', path: 'status', value: 'stats failed' }),
      failedCall(),
    ];
    expect(kinds(acknowledgedByValue)).toEqual([]);
  });

  it('still reports when the state moved but never mentioned the failure', () => {
    const silent = [
      ev(EventType.STATE_CHANGE, { name: 'app', path: 'status', value: 'archived' }),
      failedCall(),
    ];
    expect(causedKinds(silent)).toEqual([ContradictionKind.UI_ADVANCED_REQUEST_FAILED]);
  });

  /**
   * A console error does NOT count as acknowledging it. console.error is invisible to the user, so
   * an app that logs and then shows success is still lying to whoever is looking at the screen.
   */
  it('does not accept a console error as surfacing the failure', () => {
    const logged = [
      domChanged(),
      ev(EventType.CONSOLE_ERROR, { message: 'save failed' }),
      failedCall(),
    ];
    expect(causedKinds(logged)).toEqual([ContradictionKind.UI_ADVANCED_REQUEST_FAILED]);
  });

  it('treats a store mutation as the UI advancing, not just the DOM', () => {
    expect(causedKinds([stateChanged(), failedCall()])).toEqual([
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    ]);
  });

  /**
   * Strongest form: the app did not merely LOOK right, it fired its own success signal while its
   * request failed. That outranks the generic UI-advanced claim, so only the sharper one is
   * reported — two entries for one fact would be noise.
   */
  it('reports a contradicted signal instead of the weaker UI claim', () => {
    const found = findContradictions([
      domChanged(),
      ev(EventType.SIGNAL, { name: 'todo:archived' }),
      failedCall(),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe(ContradictionKind.SIGNAL_CONTRADICTED);
    expect(found[0]?.claim).toContain('todo:archived');
  });

  it('catches a successful write that changed nothing on the client', () => {
    expect(causedKinds([okCall('POST', '/api/save')])).toEqual([
      ContradictionKind.RESPONSE_IGNORED,
    ]);
  });

  /**
   * A GET that fires without moving the UI is a prefetch, not a lost write. Restricting the rule to
   * mutating methods is what stops it crying wolf on every ordinary read.
   */
  it('does not treat a GET with no UI change as an ignored response', () => {
    expect(kinds([okCall('GET', '/api/list')])).toEqual([]);
  });

  it('catches the same write firing twice in one action', () => {
    const events = [okCall('POST', '/api/order'), okCall('POST', '/api/order'), domChanged()];
    const found = findContradictions(events, { actionSince: events[0]?.t ?? 0 });
    expect(found.map((c) => c.kind)).toContain(ContradictionKind.DUPLICATE_REQUEST);
    expect(found.find((c) => c.kind === ContradictionKind.DUPLICATE_REQUEST)?.detail).toContain(
      '2',
    );
  });

  /**
   * The claim this finding makes is "ONE user action was performed" — so it needs to know which one.
   * Reported from the field: `reticle_observe` takes a caller-supplied window that can be arbitrarily
   * wide, two legitimate separate saves to the same endpoint read as a double submit, and the tab's
   * verdicts went permanently unknown behind a repeat that was never a repeat. A false accusation
   * from the instrument is worse than a miss.
   */
  it('does not call two separate actions a double submit', () => {
    const first = okCall('POST', '/api/order');
    const later = okCall('POST', '/api/order');
    expect(
      findContradictions([first, later, domChanged()], { actionSince: later.t }).map((c) => c.kind),
    ).not.toContain(ContradictionKind.DUPLICATE_REQUEST);
  });

  it('says nothing about repeats in a window no action is attributed to', () => {
    expect(
      kinds([okCall('POST', '/api/order'), okCall('POST', '/api/order'), domChanged()]),
    ).not.toContain(ContradictionKind.DUPLICATE_REQUEST);
  });

  it('does not call two DIFFERENT writes a duplicate', () => {
    expect(
      findContradictions([okCall('POST', '/api/a'), okCall('POST', '/api/b'), domChanged()], {
        actionSince: 0,
      }).map((c) => c.kind),
    ).toEqual([]);
  });

  /**
   * A command-bus API sends every mutation to ONE URL and discriminates on a JSON body field.
   * Reported from the field: one click firing three genuinely different commands read as "the same
   * write fired 3 times", nearly every act_and_wait in the session was flagged, and otherwise-clean
   * verdicts degraded to unknown behind repeats that were never repeats. The bodies that
   * disambiguate the calls ride on the events already; folding them into the identity costs
   * nothing and saves the accusation for writes that are actually identical.
   */
  describe('writes distinguished only by their captured request body', () => {
    const commandBus = (command: string): ReticleEvent =>
      ev(EventType.NET_REQUEST, {
        id: `n${String(seq)}`,
        method: 'POST',
        url: '/api/v0/studies/1/command',
        status: 200,
        ok: true,
        requestBody: JSON.stringify({ command }),
      });

    it('are not a duplicate when the bodies differ', () => {
      const events = [
        commandBus('study.stage.set'),
        commandBus('mesh.controls.set'),
        commandBus('mesh.plan'),
        domChanged(),
      ];
      expect(
        findContradictions(events, { actionSince: events[0]?.t ?? 0 }).map((c) => c.kind),
      ).not.toContain(ContradictionKind.DUPLICATE_REQUEST);
    });

    it('are still a duplicate when the bodies are identical', () => {
      const events = [commandBus('mesh.plan'), commandBus('mesh.plan'), domChanged()];
      expect(
        findContradictions(events, { actionSince: events[0]?.t ?? 0 }).find(
          (c) => c.kind === ContradictionKind.DUPLICATE_REQUEST,
        )?.detail,
      ).toContain('/api/v0/studies/1/command');
    });

    it('stay un-compared, and therefore un-flagged, when only one side carried a body', () => {
      const withBody = commandBus('study.stage.set');
      const withoutBody = ev(EventType.NET_REQUEST, {
        id: `n${String(seq)}`,
        method: 'POST',
        url: '/api/v0/studies/1/command',
        status: 200,
        ok: true,
      });
      expect(
        findContradictions([withBody, withoutBody, domChanged()], {
          actionSince: withBody.t,
        }).map((c) => c.kind),
      ).not.toContain(ContradictionKind.DUPLICATE_REQUEST);
    });
  });

  it('catches the UI advancing over a request that never settled', () => {
    const pending = ev(EventType.NET_PENDING, { id: 'n99', method: 'POST', url: '/api/slow' });
    expect(causedKinds([pending, domChanged()])).toEqual([ContradictionKind.REQUEST_NEVER_SETTLED]);
  });

  it('does not flag an in-flight request when the UI did not move (the app is still waiting)', () => {
    const pending = ev(EventType.NET_PENDING, { id: 'n98', method: 'POST', url: '/api/slow' });
    expect(kinds([pending])).toEqual([]);
  });

  it('does not flag a request that settled inside the window', () => {
    const pending = ev(EventType.NET_PENDING, { id: 'n1', method: 'POST', url: '/api/x' });
    const settled = ev(EventType.NET_REQUEST, {
      id: 'n1',
      method: 'POST',
      url: '/api/x',
      status: 200,
      ok: true,
    });
    expect(kinds([pending, settled, domChanged()])).toEqual([]);
  });

  it('is silent on a healthy action — UI moved, the write succeeded', () => {
    expect(kinds([okCall('POST', '/api/save'), domChanged()])).toEqual([]);
  });

  it('is silent on an empty window', () => {
    expect(findContradictions([])).toEqual([]);
  });

  /** A failed request with NO UI movement is an honest failure — the app did not lie about it. */
  it('does not flag a failed request the UI never pretended succeeded', () => {
    expect(kinds([failedCall()])).toEqual([]);
  });
});

/**
 * A click that lands on nothing must not read as a clean run.
 *
 * Measured on a real merchant dashboard: `reticle_query { by: 'text' }` resolved a `styled.div`
 * instead of the button beside it, the click produced zero events, the store did not move — and
 * `until: { kind: 'settled' }` PASSED, giving `verified: "yes", because: "…no channel disagreeing"`.
 * Settle is the trap: a page that did nothing is quiet, and quiet is what settle tests for.
 */
describe('the action landed on something that does not react', () => {
  it('an empty window after a click is a contradiction, not a clean run', () => {
    const found = findContradictions([], { action: 'click' });
    expect(found.map((c) => c.kind)).toEqual([ContradictionKind.ACTION_HAD_NO_EFFECT]);
    expect(found[0]?.counter).toContain('no channel observed anything');
  });

  it('covers the other actions that are supposed to do something', () => {
    for (const action of ['dblclick', 'submit', 'CLICK']) {
      expect(findContradictions([], { action })).toHaveLength(1);
    }
  });

  it('says nothing when the action DID something', () => {
    expect(findContradictions([domChanged()], { action: 'click' })).toHaveLength(0);
    // A window that is NOT empty falls through to the ordinary rules — a successful write with no
    // client movement is still `response-ignored`, and must not be relabelled as "no effect".
    expect(
      findContradictions([okCall()], { action: 'click', actionSince: 0 }).map((c) => c.kind),
    ).toEqual([ContradictionKind.RESPONSE_IGNORED]);
  });

  it('does not fire for actions that can legitimately move nothing', () => {
    // Noise is the opposite failure and just as bad: a hover that changes no DOM is ordinary, and
    // fill/type change an input value without necessarily mutating the tree.
    for (const action of ['hover', 'focus', 'scrollIntoView', 'fill', 'type']) {
      expect(findContradictions([], { action })).toHaveLength(0);
    }
  });

  it('does not fire when no action opened the window', () => {
    // reticle_observe passes a bare window with no action; an empty one there means "nothing
    // happened lately", not "something failed to react".
    expect(findContradictions([])).toHaveLength(0);
  });
});

/**
 * A nav link that routes to a blank page.
 *
 * The class every dead-control heuristic misses, because the control worked — it navigated. Measured
 * on a real merchant dashboard with nine such links: `reticle_crawl` drove all nine and reported
 * `deadControls: 0`, correctly by its own definition. The discriminator below came from executing
 * both cases side by side: a working nav emitted `domAdded: 1, network: 2`, a blank one
 * `domAdded: 0, domRemoved: 0, network: 0`.
 */
describe('the route moved and nothing was rendered for it', () => {
  const routeChange = (): ReticleEvent => ev(EventType.ROUTE_CHANGE, { pathname: '/invoices' });
  const attrOnly = (): ReticleEvent => ev(EventType.DOM_ATTR, { path: 'a', name: 'aria-current' });

  it('flags a navigation that neither rendered nor fetched', () => {
    // The only DOM mutation is the nav link marking itself active — the destination stayed empty.
    const found = findContradictions([routeChange(), attrOnly()]);
    expect(found.map((c) => c.kind)).toEqual([ContradictionKind.ROUTE_RENDERED_NOTHING]);
  });

  it('stays silent when the destination rendered', () => {
    expect(kinds([routeChange(), ev(EventType.DOM_ADDED, { role: 'table' })])).toEqual([]);
  });

  it('stays silent when the destination fetched its data', () => {
    // A page that asks for data has arrived somewhere, even if the rows land after this window.
    // It still trips `request-never-settled` (the route moved over an in-flight call), which is a
    // separate and correct finding — what must be absent is the blank-destination claim.
    const pending = ev(EventType.NET_PENDING, { id: 'n1', method: 'GET', url: '/api/invoices' });
    expect(kinds([routeChange(), pending])).not.toContain(ContradictionKind.ROUTE_RENDERED_NOTHING);
  });

  it('does not fire without a route change — a quiet window is not a bad navigation', () => {
    expect(kinds([attrOnly()])).toEqual([]);
  });

  /**
   * The window below is COPIED FROM A MEASUREMENT, not invented: three ordinary sidebar navigations
   * on the bench app, read back through reticle_observe. Every one of them emitted
   *
   *   { perf, focus.change, state.change, signal, route.change, dom.attr:2, dom.text:2, render.commit }
   *
   * and ZERO dom.added / dom.removed — React reconciled the destination in place. The rule looked
   * only for added/removed nodes, so all three were flagged `route-rendered-nothing`, which made
   * `verified` come back "no" on a correct green and emitted a `bug_found` for a navigation that
   * worked. On a React app that reconciles in place — the common case — this fires on essentially
   * every navigation, which is noise in the one metric that is supposed to mean something.
   *
   * `dom.text` is the discriminator that separates the two: the destination produced content. It is
   * deliberately NOT `dom.attr` (the nav link marks itself active whether or not anything rendered —
   * that is the true positive above) and deliberately NOT `render.commit` (React commits a render for
   * a component that returns null, which is precisely one of the bugs this is meant to catch).
   */
  it('stays silent when the destination re-rendered IN PLACE, as React usually does', () => {
    const measured = [
      routeChange(),
      attrOnly(),
      attrOnly(),
      ev(EventType.DOM_TEXT, { path: 'main h1' }),
      ev(EventType.DOM_TEXT, { path: 'main p' }),
      ev(EventType.STATE_CHANGE, { path: 'view', value: 'deployments' }),
    ];
    expect(kinds(measured)).not.toContain(ContradictionKind.ROUTE_RENDERED_NOTHING);
  });

  /**
   * A skip link (`href="#main-content"`) is a same-document hash change: the observable
   * consequences are location.hash, focus, and scroll — not a DOM mutation or a route render.
   * Grading it `route-rendered-nothing` made "did my skip link work" unanswerable.
   */
  it('stays silent for a same-page hash anchor — skip links do not render a new view', () => {
    const skip = ev(EventType.ROUTE_CHANGE, {
      from: 'http://localhost:5173/app',
      to: 'http://localhost:5173/app#main-content',
      pathname: '/app',
      search: '',
      hash: '#main-content',
    });
    expect(kinds([skip])).not.toContain(ContradictionKind.ROUTE_RENDERED_NOTHING);
    expect(kinds([skip, attrOnly()])).not.toContain(ContradictionKind.ROUTE_RENDERED_NOTHING);
  });

  it('stays silent for href="#" (scroll to top), which is also same-document', () => {
    const top = ev(EventType.ROUTE_CHANGE, {
      from: 'http://localhost:5173/app#section',
      to: 'http://localhost:5173/app#',
      pathname: '/app',
      search: '',
      hash: '#',
    });
    expect(kinds([top])).not.toContain(ContradictionKind.ROUTE_RENDERED_NOTHING);
  });

  it('still flags a hash-router navigation to a blank view (`#/invoices`)', () => {
    // Hash routers keep the route in the fragment. That IS a new view, and a blank one is
    // the original true positive — silencing every hash change would hide it.
    const hashRoute = ev(EventType.ROUTE_CHANGE, {
      from: 'http://localhost:5173/#/home',
      to: 'http://localhost:5173/#/invoices',
      pathname: '/',
      search: '',
      hash: '#/invoices',
    });
    expect(kinds([hashRoute])).toContain(ContradictionKind.ROUTE_RENDERED_NOTHING);
  });
});

describe('failure misattributed — the server broke, the app blamed the user', () => {
  const serverFault = (url = '/api/login'): ReticleEvent =>
    ev(EventType.NET_REQUEST, { id: 'n1', method: 'POST', url, status: 500, ok: false });

  /**
   * Found on a bug this project did not write for this feature: bench-app's `swallowed-500-login`
   * forces /api/login to 500, and the app answers `auth:denied` — the user is told their password is
   * wrong while the backend is down. They cannot fix it, and the real fault is never reported.
   */
  it('catches a 5xx answered with a user-fault signal', () => {
    const found = findContradictions([
      serverFault(),
      ev(EventType.SIGNAL, { name: 'auth:denied' }),
    ]);
    expect(found.map((c) => c.kind)).toContain(ContradictionKind.FAILURE_MISATTRIBUTED);
  });

  it('catches it from state as well as from a signal', () => {
    const found = findContradictions([
      serverFault(),
      ev(EventType.STATE_CHANGE, { name: 'app', path: 'error', value: 'Invalid credentials' }),
    ]);
    expect(found.map((c) => c.kind)).toContain(ContradictionKind.FAILURE_MISATTRIBUTED);
  });

  /** A 4xx genuinely IS the user's fault. Blaming them there is correct, not a contradiction. */
  it('stays silent when the status actually blames the client', () => {
    const clientFault = ev(EventType.NET_REQUEST, {
      id: 'n2',
      method: 'POST',
      url: '/api/login',
      status: 401,
      ok: false,
    });
    const found = findContradictions([clientFault, ev(EventType.SIGNAL, { name: 'auth:denied' })]);
    expect(found.map((c) => c.kind)).not.toContain(ContradictionKind.FAILURE_MISATTRIBUTED);
  });

  it('stays silent when a 5xx is reported honestly as a server problem', () => {
    const found = findContradictions([
      serverFault(),
      ev(EventType.STATE_CHANGE, { name: 'app', path: 'error', value: 'Server error, try again' }),
    ]);
    expect(found.map((c) => c.kind)).not.toContain(ContradictionKind.FAILURE_MISATTRIBUTED);
  });

  /**
   * A failure-shaped signal is not a success claim. Reporting SIGNAL_CONTRADICTED here would say
   * "the app claimed success" about an app that plainly did not — the finding would be true in
   * outline and wrong in its reasoning, which is how a checker loses trust.
   */
  it('does not call a failure signal a contradicted success claim', () => {
    const found = findContradictions([
      serverFault(),
      ev(EventType.SIGNAL, { name: 'auth:denied' }),
    ]);
    expect(found.map((c) => c.kind)).not.toContain(ContradictionKind.SIGNAL_CONTRADICTED);
  });

  /**
   * An app that RETRACTED has not claimed success, whenever it fired the optimistic signal.
   *
   * The archetype of correct optimistic UI: announce immediately, meet a 500, then say so and roll
   * back. Reporting SIGNAL_CONTRADICTED against that is the strongest accusation this file makes,
   * levelled at code doing exactly the right thing — and on the fixture suite the FIXED twin produced
   * the same finding as the build that swallowed the failure, which makes the finding worthless on
   * the one suite that measures precision.
   *
   * Ordering cannot decide this. An optimistic UI legitimately fires its success signal BEFORE the
   * response, so "the claim must follow the failure" would miss the real defect. What separates them
   * is not when the app spoke, it is whether it took it back.
   */
  it('does not accuse an app that announced optimistically and then RETRACTED', () => {
    const found = findContradictions([
      ev(EventType.SIGNAL, { name: 'ack:requested' }),
      failedCall(),
      ev(EventType.SIGNAL, { name: 'ack:failed' }),
      domChanged(),
    ]);
    expect(found.map((c) => c.kind)).not.toContain(ContradictionKind.SIGNAL_CONTRADICTED);
  });

  it('still accuses an app that announced success and never took it back', () => {
    // The negative control for the rule above. Without this, "consult failureAcknowledged" could be
    // widened until the rule never fires, and the suite would not notice.
    const found = findContradictions([
      ev(EventType.SIGNAL, { name: 'ack:saved' }),
      failedCall(),
      domChanged(),
    ]);
    expect(found.map((c) => c.kind)).toContain(ContradictionKind.SIGNAL_CONTRADICTED);
  });
});

describe('one fact, one finding', () => {
  /**
   * A misattributed failure and "the UI advanced while a request failed" describe the SAME failed
   * call. Reporting both makes the output read as two problems and buries the sharper one, which is
   * how a report stops being actionable.
   */
  it('reports only the sharper misattribution, not the generic UI-advanced claim too', () => {
    const found = findContradictions([
      ev(EventType.NET_REQUEST, {
        id: 'n1',
        method: 'POST',
        url: '/api/login',
        status: 500,
        ok: false,
      }),
      ev(EventType.SIGNAL, { name: 'auth:denied' }),
      domChanged(),
    ]);
    expect(found.map((c) => c.kind)).toEqual([ContradictionKind.FAILURE_MISATTRIBUTED]);
  });

  it('treats a failure-shaped signal as the app acknowledging the failure', () => {
    const found = findContradictions([
      failedCall(),
      ev(EventType.SIGNAL, { name: 'save:failed' }),
      domChanged(),
    ]);
    expect(found).toEqual([]);
  });
});

describe('acknowledgement without relying on English', () => {
  const failed500 = (): ReticleEvent =>
    ev(EventType.NET_REQUEST, {
      id: 'n1',
      method: 'POST',
      url: '/api/save',
      status: 500,
      ok: false,
      error: 'Datenbank nicht erreichbar',
    });

  /**
   * The lexical patterns are English-only, so a German or Japanese app that surfaces its failure
   * perfectly well would still be reported as hiding it. The structural signal costs nothing and is
   * language-independent: if the app put the FAILED CALL'S OWN error text into its state, it plainly
   * knows the call failed, whatever language it says so in.
   */
  it('accepts the failed call’s own error text echoed into state, in any language', () => {
    const found = findContradictions([
      failed500(),
      ev(EventType.STATE_CHANGE, {
        name: 'app',
        path: 'meldung',
        value: 'Datenbank nicht erreichbar',
      }),
      domChanged(),
    ]);
    expect(found).toEqual([]);
  });

  it('still reports when the state moved but never echoed the failure', () => {
    const found = findContradictions(
      [
        failed500(),
        ev(EventType.STATE_CHANGE, { name: 'app', path: 'zustand', value: 'gespeichert' }),
        domChanged(),
      ],
      { actionSince: 0 },
    );
    expect(found.map((c) => c.kind)).toEqual([ContradictionKind.UI_ADVANCED_REQUEST_FAILED]);
  });

  it('does not match on a trivially short error string', () => {
    const shortErr = ev(EventType.NET_REQUEST, {
      id: 'n2',
      method: 'POST',
      url: '/api/save',
      status: 500,
      ok: false,
      error: 'no',
    });
    const found = findContradictions(
      [
        shortErr,
        ev(EventType.STATE_CHANGE, { name: 'app', path: 'x', value: 'now saved' }),
        domChanged(),
      ],
      { actionSince: 0 },
    );
    expect(found.map((c) => c.kind)).toEqual([ContradictionKind.UI_ADVANCED_REQUEST_FAILED]);
  });
});

describe('no-effect under ambient churn', () => {
  // The rule used to require a completely EMPTY window, which is a statement about the page rather
  // than about the action — and no real app has a quiet page. Measured on a console with a background
  // event stream: an inert heading clicked, `domMutatedWithin: 0`, and four ambient events in the
  // window (a scroll position, an unrelated store update, a perf sample). The dead control went
  // unreported because the page was busy with something else.
  const ambient = [
    { type: EventType.STATE_CHANGE, t: 10, data: { path: 'rows', value: 'x' } },
    { type: EventType.SCROLL_POSITION, t: 20, data: {} },
  ] as unknown as ReticleEvent[];

  it('reports a dead click even when the page is busy with something else', () => {
    const found = findContradictions(ambient, { action: 'click', mutatedWithin: 0 });
    expect(found.map((f) => f.kind)).toContain(ContradictionKind.ACTION_HAD_NO_EFFECT);
  });

  it('stays silent when the target itself mutated', () => {
    const found = findContradictions(ambient, { action: 'click', mutatedWithin: 183 });
    expect(found.map((f) => f.kind)).not.toContain(ContradictionKind.ACTION_HAD_NO_EFFECT);
  });

  it('stays silent when the click fired a request instead of mutating', () => {
    const withRequest = [
      ...ambient,
      {
        type: EventType.NET_REQUEST,
        t: 30,
        data: { method: 'POST', url: '/api/dispatch', status: 202 },
      },
    ] as unknown as ReticleEvent[];
    const found = findContradictions(withRequest, { action: 'click', mutatedWithin: 0 });
    expect(found.map((f) => f.kind)).not.toContain(ContradictionKind.ACTION_HAD_NO_EFFECT);
  });

  it('stays silent when the reaction landed OUTSIDE the target — a portalled modal', () => {
    const withDialog = [
      ...ambient,
      { type: EventType.VISIBLE_SHOWN, t: 30, data: { role: 'dialog', name: 'Confirm' } },
    ] as unknown as ReticleEvent[];
    const found = findContradictions(withDialog, { action: 'click', mutatedWithin: 0 });
    expect(found.map((f) => f.kind)).not.toContain(ContradictionKind.ACTION_HAD_NO_EFFECT);
  });

  it('falls back to the empty-window test when nothing measured the target', () => {
    expect(findContradictions(ambient, { action: 'click' }).map((f) => f.kind)).not.toContain(
      ContradictionKind.ACTION_HAD_NO_EFFECT,
    );
    expect(findContradictions([], { action: 'click' }).map((f) => f.kind)).toContain(
      ContradictionKind.ACTION_HAD_NO_EFFECT,
    );
  });
});

describe('a consequence handed to another browsing context', () => {
  /**
   * #508: an OAuth sign-in posts, succeeds, and continues in a popup the in-page SDK cannot
   * follow. The original tab legitimately never changes, so the window looks exactly like a lost
   * write — but response-ignored accuses the client of ignoring a response it handed off. The
   * context-opened event flips the reading.
   */
  it('reports consequence-elsewhere instead of response-ignored when a context opened', () => {
    // Scoped to the attribution window like every rule here: act_and_wait passes its act cursor,
    // so a popup another, older action opened cannot reclassify this one.
    const found = findContradictions(
      [
        okCall('POST', '/api/auth/sign-in/social'),
        ev(EventType.CONTEXT_OPENED, { href: 'https://accounts.google.com/o/oauth2' }),
      ],
      { actionSince: 0 },
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe(ContradictionKind.CONSEQUENCE_ELSEWHERE);
    expect(found[0]?.counter).toContain('another browsing context');
  });

  it('keeps response-ignored when nothing opened', () => {
    expect(causedKinds([okCall('POST', '/api/save')])).toEqual([
      ContradictionKind.RESPONSE_IGNORED,
    ]);
  });
});

describe('the app announced a consequence and nothing else moved', () => {
  const signal = (name: string): ReticleEvent => ev(EventType.SIGNAL, { name });

  /**
   * Measured on the bench fixture with `missing-modal` injected, driven by hand through the MCP.
   *
   * The store commits `newDeployOpen: false` whatever it is asked for, while the signal is emitted
   * from the ARGUMENT — so the app announces `modal:opened` and opens nothing. Reticle returned
   * `verified: "yes"`, `verifiedReason: "proved"`, at `honesty.grade: "signal"`, our strongest
   * evidence class. `reticle_snapshot { mode: "status" }` immediately after showed no such dialog.
   *
   * Every fact needed was already in the payload and nothing crossed them: the healthy run of the
   * same click carries `stateDiffs: newDeployOpen false -> true`, and the broken one carries an
   * empty `stateDiffs` and no DOM movement at all. An app whose signal reports the REQUESTED value
   * rather than the COMMITTED one was getting a top-grade green for doing nothing.
   */
  /** Every case here is an ACTION's window — see the scoping test at the end of this block. */
  const afterAction = (events: ReticleEvent[]): string[] =>
    findContradictions(events, { actionSince: 0 }).map((c) => c.kind);

  it('reports a signal that nothing corroborates', () => {
    expect(afterAction([signal('modal:opened')])).toContain(
      ContradictionKind.SIGNAL_WITHOUT_CONSEQUENCE,
    );
  });

  /**
   * The negative control, and the reason the rule is this narrow: the SAME click on the healthy
   * build moves the store. One corroborating channel is enough — the claim is not "the signal must
   * be visual", it is "the signal must not be the only thing that happened".
   */
  it('says nothing when any other channel moved', () => {
    expect(afterAction([signal('modal:opened'), stateChanged()])).not.toContain(
      ContradictionKind.SIGNAL_WITHOUT_CONSEQUENCE,
    );
    expect(afterAction([signal('modal:opened'), domChanged()])).not.toContain(
      ContradictionKind.SIGNAL_WITHOUT_CONSEQUENCE,
    );
  });

  /**
   * A request in the window means the app reached for something, and whether that request settled,
   * failed or was ignored is already three other rules' business. Firing here too would report one
   * fact twice under different names.
   */
  it('leaves a window containing network traffic to the rules that own it', () => {
    expect(afterAction([signal('save:done'), okCall()])).not.toContain(
      ContradictionKind.SIGNAL_WITHOUT_CONSEQUENCE,
    );
    expect(afterAction([signal('save:done'), failedCall()])).not.toContain(
      ContradictionKind.SIGNAL_WITHOUT_CONSEQUENCE,
    );
  });

  /**
   * A failure-shaped signal is the app correctly reporting that nothing happened. Accusing it of
   * announcing a consequence it did not deliver inverts the meaning of the one app doing this right
   * — the same reasoning that already guards SIGNAL_CONTRADICTED.
   */
  it('does not accuse an app that announced a FAILURE', () => {
    expect(afterAction([signal('deploy:failed')])).not.toContain(
      ContradictionKind.SIGNAL_WITHOUT_CONSEQUENCE,
    );
  });

  /**
   * `reticle_assert` OBSERVES. There is no click whose consequence should have corroborated
   * anything, so a quiet window carrying one signal is an ordinary read — not a claim nothing backs.
   * Unscoped, this rule reddened eight existing tests that assert exactly that.
   */
  it('stays silent on a window no action is attributed to', () => {
    expect(kinds([signal('modal:opened')])).not.toContain(
      ContradictionKind.SIGNAL_WITHOUT_CONSEQUENCE,
    );
  });
});
