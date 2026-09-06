import { EventType, type ReticleEvent, PredicateKind } from '@reticlehq/core';
import { routeOfEvent } from '../events/predicate-route.js';

/**
 * Self-generating oracles, v1. Given the window a recording captured, propose ranked mustHold
 * predicates — the practical answer to "you recorded a flow, now what should it assert?". Ranking
 * follows the moat's tiering: a signal (the app attested it) beats net/state/route (observable
 * consequences) beats presence (a wrong/healed locator can fake it). Deterministic; accepting a
 * proposal is one existing-tool call. The learned RANKING across projects is the paid layer
 * (OSS-VS-SERVER); these local rules are OSS.
 */

interface ProposedConsequence {
  /** A predicate object, directly usable as a mustHold. */
  predicate: Record<string, unknown>;
  /** Ranking tier: 0 strongest (signal) … 2 weakest (presence). */
  tier: number;
  /** Human label for the proposal. */
  label: string;
  /** True for presence-only proposals — flagged because they can be faked. */
  weak: boolean;
}

const TIER = { SIGNAL: 0, CONSEQUENCE: 1, PRESENCE: 2 } as const;

function pathname(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    return new URL(url, 'http://x').pathname;
  } catch {
    return url;
  }
}

/** Propose ranked consequences from a recorded event window. Deduped; strongest first. */
export function proposeConsequences(events: readonly ReticleEvent[]): ProposedConsequence[] {
  const seen = new Set<string>();
  const proposals: ProposedConsequence[] = [];
  const add = (key: string, proposal: ProposedConsequence): void => {
    if (seen.has(key)) return;
    seen.add(key);
    proposals.push(proposal);
  };

  for (const event of events) {
    const data = event.data;
    switch (event.type) {
      case EventType.SIGNAL: {
        const name = data['name'];
        if ('string' === typeof name) {
          add(`signal:${name}`, {
            predicate: { kind: PredicateKind.SIGNAL, name },
            tier: TIER.SIGNAL,
            label: `signal "${name}" fires`,
            weak: false,
          });
        }
        break;
      }
      case EventType.NET_REQUEST: {
        const path = pathname(data['url']);
        const method = 'string' === typeof data['method'] ? data['method'] : 'GET';
        if (path !== undefined) {
          add(`net:${method} ${path}`, {
            predicate: {
              kind: PredicateKind.NET,
              method,
              urlContains: path,
              status: data['status'],
            },
            tier: TIER.CONSEQUENCE,
            label: `${method} ${path} responds`,
            weak: false,
          });
        }
        break;
      }
      case EventType.STATE_CHANGE: {
        const name = data['name'];
        if ('string' === typeof name) {
          add(`state:${name}`, {
            predicate: { kind: PredicateKind.STATE, store: name, path: data['path'] },
            tier: TIER.CONSEQUENCE,
            label: `state "${name}" changes`,
            weak: false,
          });
        }
        break;
      }
      case EventType.ROUTE_CHANGE: {
        const routed = routeOfEvent(data);
        if (routed !== undefined) {
          // `pathname`, not `to`: the evaluator has never accepted `to`, so this surface was handing
          // the agent a predicate reticle_assert refuses with "unknown field to". A proposal that
          // cannot be evaluated is worse than no proposal — see the schema check in the test.
          //
          // And the ROUTER's path, not the document's: under a hash router the document pathname is
          // `/` on every page, so proposing it proposes an assertion that says nothing about where
          // the app went. See routeOfEvent.
          const to = routed.routePath;
          add(`route:${to}`, {
            predicate: { kind: PredicateKind.ROUTE, pathname: to },
            tier: TIER.CONSEQUENCE,
            label: `route changes to ${to}`,
            weak: false,
          });
        }
        break;
      }
      case EventType.DOM_ADDED: {
        const name = data['name'];
        if ('string' === typeof name && name.length > 0) {
          add(`presence:${name}`, {
            predicate: { kind: PredicateKind.ELEMENT, name },
            tier: TIER.PRESENCE,
            label: `"${name}" appears (presence only — prefer a consequence)`,
            weak: true,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  return proposals.sort((a, b) => a.tier - b.tier);
}
