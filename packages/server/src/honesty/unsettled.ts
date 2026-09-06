/**
 * What an `unsettled` verdict was waiting for, and what its window held instead.
 *
 * `unsettled` is the commonest reason a verdict comes back `unknown`, and all it said was that the
 * page "never settled" — a sentence equally true of a page that polls, a page that animates, and a
 * page whose write is still open. Those need three different next moves, and an agent handed the
 * sentence cannot tell which it is holding, so the drive stops there. An `unknown` that explains
 * itself is a retry; one that does not is a dead end.
 *
 * Two releases already tuned this window and neither is undone here. The budget is still spent in
 * full before anything is called unsettled (settle-in-flight.ts), and the app is still given its
 * reaction window before any accusation (waitForReaction). This only describes what was true at the
 * moment the budget genuinely ran out.
 *
 * It rides in `because`, beside `verifiedReason`, rather than in a field of its own: the verdict has
 * one sentence an agent is known to read, and a caveat parked anywhere else is a caveat nobody reads.
 */

import { PredicateKind } from '@reticlehq/core';
import type { Predicate } from '../events/predicate.js';

/** Enough to recognise the one that is stuck; not so many that a chatty window eats the verdict. */
const MAX_LISTED_REQUESTS = 3;

export interface UnsettledWindow {
  /** What the wait was for, in the caller's own terms — see `describeWaitTarget`. */
  waitedFor: string;
  /** Requests that started in this window and had not come back, as "METHOD url". */
  stillInFlight: readonly string[];
  /**
   * Endpoints called more than once in this window, as "METHOD url ×N" — see `repeatedRequestLabels`.
   *
   * The case `stillInFlight` structurally cannot see: a retry loop against a dead backend completes
   * every attempt, so nothing is ever outstanding, and the verdict fell through to a sentence that
   * blamed unnamed churn on an app whose whole problem was one endpoint being hammered. Optional —
   * a caller that does not supply it gets exactly the sentence that shipped before.
   */
  repeated?: readonly string[];
}

/**
 * The wait, in one phrase.
 *
 * The default matters most: a call that declares no `until` waits for the page to go IDLE, and an
 * agent that never chose that wait cannot be expected to recognise it in a timeout about it.
 */
export function describeWaitTarget(predicate: Predicate): string {
  switch (predicate.kind) {
    case PredicateKind.SETTLED:
      return 'the page to go idle';
    case PredicateKind.SIGNAL:
      return predicate.name === undefined ? 'any signal' : `signal '${predicate.name}'`;
    case PredicateKind.NET:
      return `a request${predicate.method === undefined ? '' : ` ${predicate.method}`}${
        predicate.urlContains === undefined ? '' : ` matching '${predicate.urlContains}'`
      }`;
    case PredicateKind.ROUTE:
      return `a route change${
        predicate.pathname === undefined ? '' : ` to '${predicate.pathname}'`
      }${predicate.contains === undefined ? '' : ` containing '${predicate.contains}'`}`;
    case PredicateKind.STATE:
      return `state at '${predicate.path}'`;
    case PredicateKind.TEXT:
      return `text containing '${predicate.contains}'`;
    case PredicateKind.ELEMENT:
      return `an element matching ${JSON.stringify(predicate.query)}`;
    case PredicateKind.CONSOLE:
      return 'a console message';
    case PredicateKind.ANIMATION:
      return predicate.name === undefined ? 'an animation' : `animation '${predicate.name}'`;
    case PredicateKind.ALL_OF:
      return `all of (${predicate.predicates.map(describeWaitTarget).join('; ')})`;
    case PredicateKind.ANY_OF:
      return `any of (${predicate.predicates.map(describeWaitTarget).join('; ')})`;
    case PredicateKind.NOT:
      return `the absence of ${describeWaitTarget(predicate.predicate)}`;
  }
}

/**
 * Did the assertion name a request that is still open?
 *
 * `waitForPredicate` reports a miss ("no request to /register") the moment the budget ends, even
 * when that same POST is sitting in `stillInFlight`. Grading that miss `no` is a race against the
 * backend, not a defect. Matching is the discriminator: an unrelated poll left open does not pardon
 * a named URL that never started.
 */
export function namedNetIsInFlight(
  predicate: Predicate,
  stillInFlight: readonly string[],
): boolean {
  if (0 === stillInFlight.length) return false;
  const nets: { method?: string; urlContains: string }[] = [];
  const walk = (p: Predicate): void => {
    switch (p.kind) {
      case PredicateKind.ALL_OF:
      case PredicateKind.ANY_OF:
        for (const child of p.predicates) walk(child);
        return;
      case PredicateKind.NET: {
        if (undefined === p.urlContains || 0 === p.urlContains.length) return;
        nets.push({
          ...(undefined === p.method ? {} : { method: p.method }),
          urlContains: p.urlContains,
        });
        return;
      }
      default:
        return;
    }
  };
  walk(predicate);
  return nets.some((net) => stillInFlight.some((label) => inFlightLabelMatchesNet(label, net)));
}

function inFlightLabelMatchesNet(
  label: string,
  net: { method?: string; urlContains: string },
): boolean {
  const space = label.indexOf(' ');
  if (space <= 0) return false;
  const method = label.slice(0, space);
  const url = label.slice(space + 1);
  if (undefined !== net.method && method.toUpperCase() !== net.method.toUpperCase()) return false;
  return url.includes(net.urlContains);
}

/**
 * The `because` sentence for an unsettled verdict: the wait, the observation, the next move.
 *
 * The two branches are the point. An outstanding write is worth waiting for and worth asserting
 * directly; page churn is neither, and telling an agent to raise its timeout on churn sells it a
 * slower dead end. Without the detail the sentence is the one that shipped before, so a caller that
 * cannot supply the facts loses nothing.
 */
export function unsettledBecause(base: string, window: UnsettledWindow | undefined): string {
  if (window === undefined) return `${base} — re-check, or assert a consequence that settles`;
  if (0 === window.stillInFlight.length) {
    const repeated = window.repeated ?? [];
    return (
      `${base}. It waited for ${window.waitedFor}, and no request started in this window was left ` +
      'open — what kept the page busy was its own churn ' +
      (0 === repeated.length
        ? '(a poll, a timer, an animation)'
        : `(these fired repeatedly: ${repeated.join(', ')} — a poll or a retrying query)`) +
      ', so waiting longer will not help. Assert the consequence you care about (a signal, a route ' +
      'change, or store state) instead of waiting for idle, and re-check if the app is genuinely slow'
    );
  }
  const shown = window.stillInFlight.slice(0, MAX_LISTED_REQUESTS);
  const rest = window.stillInFlight.length - shown.length;
  return (
    `${base}. It waited for ${window.waitedFor}, and ${String(window.stillInFlight.length)} ` +
    `request(s) started in this window had not come back: ${shown.join(', ')}` +
    `${rest > 0 ? `, and ${String(rest)} more` : ''} — re-check once they land, raise timeout_ms, ` +
    'or assert the request itself so the wait ends on the response rather than on idle'
  );
}
