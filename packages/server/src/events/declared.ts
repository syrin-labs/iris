/**
 * What the caller DECLARED before acting — the oracle, read back.
 *
 * `act_and_wait` asks the agent to name the expected consequence BEFORE the action, and that
 * declaration was then thrown away: everything downstream judged the window as if nobody had said
 * what they were expecting. Two measured consequences, one bug:
 *
 *  - An error path can be declared exactly — `{ net, POST, /api/login, status: 500 }` — and the
 *    contradiction hunter still reported `ui-advanced-request-failed`, because a failed request plus
 *    a moved DOM is all it can see. The failure was EXPECTED and said so in the predicate, so a
 *    verdict of "channels disagree" is a statement about a disagreement nobody had.
 *  - A destination whose content was asserted and FOUND was still reported as
 *    `route-rendered-nothing`, a clause the element evidence beside it disproves.
 *
 * Deliberately conservative about what counts as declared. Only what the caller REQUIRED is read:
 * the top level and `allOf` chains. An `anyOf` branch may never have held, and a `not` declares the
 * opposite of a consequence — honouring either would suppress a real finding on the strength of
 * something that never happened. Pure: a predicate in, a description out.
 */

import { PredicateKind, QueryBy, type ElementQuery } from '@reticlehq/core';
import type { Predicate } from './predicate-eval.js';

/** A failing call the caller named in advance — matched against the window's real calls. */
export interface DeclaredNetFailure {
  method?: string;
  urlContains?: string;
  status?: number;
}

interface DeclaredExpectations {
  /** Requests the caller declared would FAIL, so failing is the expected outcome, not a disagreement. */
  netFailures: readonly DeclaredNetFailure[];
  /** The caller required something to be ON SCREEN — an element or text, present rather than absent. */
  rendersContent: boolean;
}

/** Below this, a status is a success or a redirect: not a declared failure. */
const FAILURE_STATUS_MIN = 400;

/** Statuses that mean the caller was refused — the proof of an auth/authz denial, not a fault. */
const AUTH_DENIAL_STATUSES = [401, 403] as const;

/** ARIA roles that ARE the error UI — waiting for an alert is how the first report asserted a 401. */
const DENIAL_ROLES = new Set(['alert', 'alertdialog']);

/**
 * Phrases that name a denial rather than a success. Conservative and multi-word where a short
 * token would match a greeting ("invalid date" is not an auth failure).
 */
const DENIAL_TEXT_MARKERS = [
  'access denied',
  'unauthorized',
  'forbidden',
  'invalid key',
  'invalid credentials',
  'incorrect email',
  'incorrect password',
  'not authorized',
  'permission denied',
  'unauthenticated',
  'not allowed',
] as const;

function isDenialPhrase(text: string): boolean {
  const lower = text.toLowerCase();
  return DENIAL_TEXT_MARKERS.some((marker) => lower.includes(marker));
}

function isDenialRole(role: string): boolean {
  return DENIAL_ROLES.has(role.toLowerCase());
}

function isDenialQuery(query: ElementQuery): boolean {
  if (undefined !== query.role && isDenialRole(query.role)) return true;
  if (QueryBy.ROLE === query.by && undefined !== query.value && isDenialRole(query.value)) {
    return true;
  }
  for (const field of [query.name, query.text, query.value, query.label]) {
    if ('string' === typeof field && isDenialPhrase(field)) return true;
  }
  return false;
}

function pushAuthDenialStatuses(into: DeclaredNetFailure[]): void {
  for (const status of AUTH_DENIAL_STATUSES) {
    into.push({ status });
  }
}

export function declaredExpectations(predicate: Predicate | undefined): DeclaredExpectations {
  const netFailures: DeclaredNetFailure[] = [];
  let rendersContent = false;

  const walk = (p: Predicate): void => {
    switch (p.kind) {
      case PredicateKind.ALL_OF:
        for (const child of p.predicates) walk(child);
        return;
      case PredicateKind.NET: {
        const declaredFailure =
          false === p.ok || (p.status !== undefined && p.status >= FAILURE_STATUS_MIN);
        if (!declaredFailure) return;
        netFailures.push({
          ...(p.method === undefined ? {} : { method: p.method }),
          ...(p.urlContains === undefined ? {} : { urlContains: p.urlContains }),
          ...(p.status === undefined ? {} : { status: p.status }),
        });
        return;
      }
      case PredicateKind.ELEMENT:
        if (true !== p.absent) {
          rendersContent = true;
          if (isDenialQuery(p.query)) pushAuthDenialStatuses(netFailures);
        }
        return;
      case PredicateKind.TEXT:
        if (true !== p.absent) {
          rendersContent = true;
          if (isDenialPhrase(p.contains)) pushAuthDenialStatuses(netFailures);
        }
        return;
      default:
        return;
    }
  };

  if (predicate !== undefined) walk(predicate);
  return { netFailures, rendersContent };
}

/**
 * Did the caller name a consequence that does not depend on the response body?
 *
 * The unread-body clause exists for the case where the body is the ONLY channel that could have
 * contradicted the screen — a 200 with per-item failures inside, a GraphQL error that is also a
 * 200. A declared string on screen, store path, signal, route, or an element located by role /
 * name / testid that held is a different channel, and grading `unknown` there costs a real
 * verdict (measured: a 201 plus the unique row, unread body, agent went to enable capture instead
 * of finishing the drive).
 *
 * Same conservatism as `declaredExpectations`: only the top level and `allOf`. An `anyOf` branch
 * may never have held, and honouring it would skip the unread caveat on the strength of a net
 * success that was the branch that actually matched. An `absent` element is not a consequence the
 * body cannot own.
 */
export function declaresBodyIndependentChannel(predicate: Predicate | undefined): boolean {
  if (predicate === undefined) return false;

  const walk = (p: Predicate): boolean => {
    switch (p.kind) {
      case PredicateKind.ALL_OF:
        return p.predicates.some(walk);
      case PredicateKind.TEXT:
        return true !== p.absent;
      case PredicateKind.SIGNAL:
      case PredicateKind.STATE:
      case PredicateKind.ROUTE:
        return true;
      case PredicateKind.ELEMENT:
        return (
          true !== p.absent &&
          (p.query.value !== undefined ||
            p.query.text !== undefined ||
            p.query.role !== undefined ||
            p.query.name !== undefined ||
            p.query.testid !== undefined)
        );
      default:
        return false;
    }
  };

  return walk(predicate);
}

/**
 * Does a call the window recorded match a failure the caller declared?
 *
 * Every field the caller named must agree — a declaration about `POST /api/login → 500` says nothing
 * about `POST /api/orders`, and treating it as a blanket amnesty for failed requests would remove
 * the check rather than inform it. Fields the caller left out are not constraints.
 */
export function matchesDeclaredFailure(
  call: { method: string; url: string; matchUrl?: string; status: number | undefined },
  declared: readonly DeclaredNetFailure[],
): boolean {
  return declared.some((d) => {
    if (d.method !== undefined && d.method.toUpperCase() !== call.method.toUpperCase())
      return false;
    const haystack = call.matchUrl ?? call.url;
    if (d.urlContains !== undefined && !haystack.includes(d.urlContains)) return false;
    if (d.status !== undefined && d.status !== call.status) return false;
    return true;
  });
}
