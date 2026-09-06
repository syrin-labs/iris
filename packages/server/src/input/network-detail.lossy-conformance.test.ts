import { EventType, type ReticleEvent } from '@reticlehq/core';
import { describe, expect, it } from 'vitest';
import { buildNetworkDetail, mergeNetworkDetail } from './network-detail.js';

/**
 * Conformance for the lossy-transform rule on the driven network capture.
 *
 * `buildNetworkDetail` bounds the request body it takes off the wire, and that bound is reached by
 * ordinary payloads: a bulk save, a base64 attachment, a form with a rich-text field. The in-page
 * observer caps the same body and says so with `requestBodyTruncated`, so the two capture routes
 * disagreed about whether a shortened body announces itself, and the driven one is the route whose
 * body OVERWRITES the other in the merge.
 *
 * The fixture is a body guaranteed to exceed the bound. What is asserted is that the loss is
 * declared, never a particular length.
 */
const OVERSIZED = `{"note":"${'a'.repeat(20_000)}"}`;
const SMALL = '{"note":"ok"}';

describe('buildNetworkDetail: a bounded request body declares the bound', () => {
  it('reports the truncation when the body is cut', () => {
    const detail = buildNetworkDetail({
      url: 'https://api.example/save',
      method: 'POST',
      status: 200,
      headers: {},
      requestBody: OVERSIZED,
    });
    expect(detail.requestBody?.length).toBeLessThan(OVERSIZED.length);
    expect(detail.requestBodyTruncated).toBe(true);
  });

  it('says nothing when the whole body fits, so the caveat means something when it appears', () => {
    const detail = buildNetworkDetail({
      url: 'https://api.example/save',
      method: 'POST',
      status: 200,
      headers: {},
      requestBody: SMALL,
    });
    expect(detail.requestBody).toBe(SMALL);
    expect('requestBodyTruncated' in detail).toBe(false);
  });
});

/**
 * The merge is where a silent cut does real damage. The wire body is the one field that OVERWRITES
 * rather than filling a gap, so a truncated capture replacing a complete in-page one left an event
 * that read as a whole body and was not, and a complete capture replacing a truncated one left a
 * caveat attached to a body that no longer needed it.
 */
describe('mergeNetworkDetail: the truncation flag follows the body that won', () => {
  const request = (data: Record<string, unknown>): ReticleEvent =>
    ({
      t: 1,
      type: EventType.NET_REQUEST,
      data: { method: 'POST', url: 'u', ...data },
    }) as unknown as ReticleEvent;

  const detailFor = (requestBody: string): ReticleEvent =>
    ({
      t: 2,
      type: EventType.NET_DETAIL,
      data: buildNetworkDetail({
        url: 'u',
        method: 'POST',
        status: 200,
        headers: {},
        requestBody,
      }) as unknown as Record<string, unknown>,
    }) as unknown as ReticleEvent;

  it('marks the merged event truncated when the wire body that replaced the page body was cut', () => {
    const merged = mergeNetworkDetail([request({ requestBody: SMALL }), detailFor(OVERSIZED)]);
    expect(merged[0]?.data['requestBodyTruncated']).toBe(true);
  });

  it('clears a stale caveat when the wire body that replaced the page body is whole', () => {
    const merged = mergeNetworkDetail([
      request({ requestBody: 'cut', requestBodyTruncated: true }),
      detailFor(SMALL),
    ]);
    expect(merged[0]?.data['requestBody']).toBe(SMALL);
    expect('requestBodyTruncated' in (merged[0]?.data ?? {})).toBe(false);
  });
});
