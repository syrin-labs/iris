/**
 * `urlContains` must match the request the app made, not the redacted string stored for the agent.
 *
 * Both reported cases were ordinary public REST paths (`/auth/token/refresh-context`,
 * `/verify/CERT_INFY_10`) rewritten because they follow a sensitive segment name and are ≥ 12
 * characters. Matching only `url` reported "the request did not happen".
 */

import { describe, expect, it } from 'vitest';
import { EventType, REDACTED_VALUE, URL_RAW, type ReticleEvent } from '@reticlehq/core';
import { evalNet } from './predicate-eval.js';
import { PredicateKind } from './predicate.js';
import { matchNet, withoutUrlRaw } from './event-filters.js';

function netEvent(data: Record<string, unknown>): ReticleEvent {
  return { type: EventType.NET_REQUEST, t: 1, sessionId: 's', data };
}

const REFRESH = netEvent({
  method: 'POST',
  url: `/auth/token/${REDACTED_VALUE}`,
  [URL_RAW]: '/auth/token/refresh-context',
  status: 200,
  ok: true,
});

describe('urlContains matches the raw request, not the redacted display URL', () => {
  it('finds a public path that redaction rewrote', () => {
    expect(
      evalNet([REFRESH], { kind: PredicateKind.NET, urlContains: 'refresh-context' }).pass,
    ).toBe(true);
  });

  it('still fails when the raw URL does not contain the needle', () => {
    expect(evalNet([REFRESH], { kind: PredicateKind.NET, urlContains: '/api/orders' }).pass).toBe(
      false,
    );
  });

  it('does not put the raw URL in evidence the agent reads', () => {
    const r = evalNet([REFRESH], { kind: PredicateKind.NET, urlContains: 'refresh-context' });
    expect(r.pass).toBe(true);
    expect(r.evidence as Record<string, unknown>).not.toHaveProperty(URL_RAW);
    expect((r.evidence as Record<string, unknown>)['url']).toBe(`/auth/token/${REDACTED_VALUE}`);
  });

  it('tells an older SDK (no urlRaw) that the path was redacted', () => {
    const old = netEvent({
      method: 'GET',
      url: `/verify/${REDACTED_VALUE}`,
      status: 200,
      ok: true,
    });
    const r = evalNet([old], { kind: PredicateKind.NET, urlContains: 'CERT_INFY_10' });
    expect(r.pass).toBe(false);
    expect(r.observed).toContain('this path segment was redacted');
    expect(r.observed).toContain('bodyContains');
  });
});

describe('matchNet and withoutUrlRaw', () => {
  it('matchNet uses the raw URL the same way the predicate does', () => {
    expect(matchNet(REFRESH, undefined, 'refresh-context', undefined)).toBe(true);
    expect(matchNet(REFRESH, undefined, '/api/orders', undefined)).toBe(false);
  });

  it('strips urlRaw so an observe timeline cannot leak it', () => {
    const stripped = withoutUrlRaw(REFRESH) as ReticleEvent;
    expect(stripped.data[URL_RAW]).toBeUndefined();
    expect(stripped.data['url']).toBe(`/auth/token/${REDACTED_VALUE}`);
  });
});
