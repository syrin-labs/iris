import { EventType, REDACTED_VALUE, URL_RAW, type ReticleEvent } from '@reticlehq/core';
import { describe, expect, it } from 'vitest';
import { buildNetworkDetail, mergeNetworkDetail } from './network-detail.js';

/**
 * The URL is the third credential-bearing field on a NET_DETAIL, beside the headers and the request
 * body that are already redacted here. It arrives raw from the driver, the same as those two, and it
 * is the one an app is most likely to put a credential in without meaning to: a presigned upload, an
 * OAuth callback, a password-reset link the agent was asked to follow.
 */
describe('buildNetworkDetail: the URL is redacted by the same rule as the in-page path', () => {
  const detailFor = (url: string): string =>
    buildNetworkDetail({ url, method: 'GET', status: 200, headers: {} }).url;

  it('redacts a credential query parameter', () => {
    expect(detailFor('https://api.example/x?access_token=s3cret&page=2')).toBe(
      `https://api.example/x?access_token=${encodeURIComponent(REDACTED_VALUE)}&page=2`,
    );
  });

  it('redacts a presigned upload URL', () => {
    const out = detailFor(
      'https://bucket.s3.amazonaws.com/f.png?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260906&X-Amz-Signature=deadbeef&X-Amz-Expires=900',
    );
    expect(out).not.toContain('deadbeef');
    expect(out).toContain('X-Amz-Expires=900');
  });

  it('redacts a single-use token embedded in the path', () => {
    expect(detailFor('https://app.example/reset/AbC123deadbeef99')).toBe(
      `https://app.example/reset/${REDACTED_VALUE}`,
    );
  });

  it('redacts userinfo credentials in the authority', () => {
    expect(detailFor('https://alice:s3cr3t@api.example/data')).not.toContain('s3cr3t');
  });

  it('leaves an ordinary URL byte-for-byte, and carries no urlRaw for it', () => {
    const detail = buildNetworkDetail({
      url: 'https://api.example/orders?page=2',
      method: 'GET',
      status: 200,
      headers: {},
    });
    expect(detail.url).toBe('https://api.example/orders?page=2');
    expect(URL_RAW in detail).toBe(false);
  });

  it('keeps the raw URL beside the redacted one, so a grader can still match it', () => {
    const detail = buildNetworkDetail({
      url: 'https://api.example/x?access_token=s3cret',
      method: 'GET',
      status: 200,
      headers: {},
    });
    expect(detail.urlRaw).toBe('https://api.example/x?access_token=s3cret');
  });
});

/**
 * The merge keys on the URL, so an unredacted detail could never match the request the SDK reported
 * with a redacted one. The requests that carry a credential are exactly the requests whose
 * authoritative headers and wire body were being dropped, and a duplicate of each was surviving into
 * the timeline with the credential still in it.
 */
describe('mergeNetworkDetail: a redacted request still finds its detail', () => {
  const RAW = 'https://api.example/upload?X-Amz-Signature=deadbeef';
  const REQUEST: ReticleEvent = {
    t: 1,
    type: EventType.NET_REQUEST,
    data: {
      method: 'PUT',
      url: `https://api.example/upload?X-Amz-Signature=${encodeURIComponent(REDACTED_VALUE)}`,
      [URL_RAW]: RAW,
    },
  } as unknown as ReticleEvent;

  it('folds the detail onto the request instead of leaving both in the timeline', () => {
    const detail: ReticleEvent = {
      t: 2,
      type: EventType.NET_DETAIL,
      data: buildNetworkDetail({
        url: RAW,
        method: 'PUT',
        status: 200,
        headers: { 'x-trace': 'abc' },
      }) as unknown as Record<string, unknown>,
    } as unknown as ReticleEvent;

    const merged = mergeNetworkDetail([REQUEST, detail]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.type).toBe(EventType.NET_REQUEST);
    expect(merged[0]?.data['headers']).toEqual({ 'x-trace': 'abc' });
  });
});

/**
 * The fragment sweep runs in the daemon now, over URLs read off the network stack rather than URLs
 * the app vouched for. A key pattern allowed to start at any index rescans a long run of key-legal
 * characters from every one of them, which is quadratic; anchoring it to the delimiter that must
 * precede a key makes the number of start positions a function of the delimiters, not the length.
 */
describe('buildNetworkDetail: a pathological fragment does not blow up the redaction pass', () => {
  it('returns a long delimiter-free fragment unchanged, in linear time', () => {
    const url = `https://app.example/page#${'-'.repeat(60_000)}`;
    const started = Date.now();
    const detail = buildNetworkDetail({ url, method: 'GET', status: 200, headers: {} });
    expect(detail.url).toBe(url);
    // A bound on behaviour, not a benchmark: the quadratic form took seconds on this input.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('still redacts an OAuth implicit-flow token in the fragment, and keeps the plain params', () => {
    const detail = buildNetworkDetail({
      url: 'https://app.example/cb#access_token=ya29SECRETVAL&state=abc123&expires_in=3600',
      method: 'GET',
      status: 200,
      headers: {},
    });
    expect(detail.url).not.toContain('ya29SECRETVAL');
    expect(detail.url).toContain('state=abc123');
    expect(detail.url).toContain('expires_in=3600');
  });

  it('leaves a plain anchor alone', () => {
    const url = 'https://app.example/page#section-two';
    expect(buildNetworkDetail({ url, method: 'GET', status: 200, headers: {} }).url).toBe(url);
  });
});
