import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventType, RETICLE_WS_PATH, URL_RAW } from '@reticlehq/core';
import {
  extractTiming,
  firstAppFrame,
  installNetwork,
  redactUrl,
  netUrlFields,
} from './network.js';
import type { Emit, Teardown } from './types.js';
import { requireCapturedMethod } from '../util/captured-method.js';

interface Emitted {
  type: EventType;
  data: Record<string, unknown>;
}

function collect(): { emit: Emit; events: Emitted[] } {
  const events: Emitted[] = [];
  const emit: Emit = (type, data) => {
    events.push({ type, data });
  };
  return { emit, events };
}

/**
 * Select an emitted event by TYPE, not by position.
 *
 * These assertions used to index `events[1]`, which quietly encoded "the observer emits exactly one
 * thing before the completion". Adding an install-time BLIND_SPOT shifted every index and broke nine
 * tests that were not about blind spots at all. Position is not part of the contract; type is.
 */
function eventOf(events: Emitted[], type: EventType): Record<string, unknown> {
  const hit = events.filter((e) => e.type === type).at(-1);
  if (hit === undefined)
    throw new Error(`no ${type} event emitted (got: ${events.map((e) => e.type).join(', ')})`);
  return hit.data;
}

/**
 * With body capture on, the app's fetch resolves at HEADERS and NET_REQUEST is emitted from a detached
 * promise once the (bounded) body read completes — so the app never waits on us. Tests must let that
 * detached emit land before asserting on the completion. One macrotask covers the resolved-clone read.
 */
const flushBody = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A minimal Response stand-in — jsdom does not always expose a usable global Response. */
function fakeResponse(
  status: number,
  opts: { statusText?: string; headers?: Record<string, string> } = {},
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: opts.statusText ?? '',
    headers: new Headers(opts.headers ?? {}),
  } as Response;
}

describe('redactUrl', () => {
  it('redacts credential-bearing query params, keeps the rest', () => {
    expect(redactUrl('http://api/x?access_token=secret&page=2')).toBe(
      'http://api/x?access_token=%5BREDACTED%5D&page=2',
    );
    expect(redactUrl('/magic?api_key=abc')).toBe('/magic?api_key=%5BREDACTED%5D');
  });

  it('leaves URLs with no sensitive params byte-for-byte unchanged', () => {
    expect(redactUrl('http://api/x?page=2&sort=asc')).toBe('http://api/x?page=2&sort=asc');
    expect(redactUrl('http://api/x')).toBe('http://api/x');
  });

  it('preserves a trailing #hash', () => {
    expect(redactUrl('/p?token=t#section')).toBe('/p?token=%5BREDACTED%5D#section');
  });

  it('redacts a path-embedded token after a sensitive segment name', () => {
    expect(redactUrl('https://app.com/reset/AbC123deadbeef99')).toBe(
      'https://app.com/reset/[REDACTED]',
    );
    expect(redactUrl('/invite/aBcD1234EfGh5678?ref=x')).toBe('/invite/[REDACTED]?ref=x');
  });

  it('leaves short non-token segments after a sensitive name alone', () => {
    expect(redactUrl('/reset/form')).toBe('/reset/form');
    expect(redactUrl('/password/reset')).toBe('/password/reset');
  });

  it('still redacts a public-looking segment after a sensitive name — that is the reported miss', () => {
    // These are ordinary REST paths, not tokens. Redaction rewrites them; the grader matches
    // `urlRaw` instead. Pinning the rewrite so a later heuristic change cannot silently drop the
    // companion field.
    expect(redactUrl('/auth/token/refresh-context')).toBe('/auth/token/[REDACTED]');
    expect(redactUrl('/verify/CERT_INFY_10')).toBe('/verify/[REDACTED]');
  });

  it('keeps the raw URL beside the redacted one for the grader', () => {
    expect(netUrlFields('/auth/token/refresh-context')).toEqual({
      url: '/auth/token/[REDACTED]',
      [URL_RAW]: '/auth/token/refresh-context',
    });
    expect(netUrlFields('/api/users')).toEqual({ url: '/api/users' });
  });
  it('redacts credentials embedded in the URL authority (user:pass@host)', () => {
    expect(redactUrl('https://alice:s3cr3t@api.example.com/data')).toBe(
      'https://[REDACTED]@api.example.com/data',
    );
    expect(redactUrl('http://plainhost.com/x')).toBe('http://plainhost.com/x');
  });
  it('redacts the WHOLE userinfo even when the password contains an @', () => {
    // Matching to the first @ left the password tail (`ss@api...`) in the clear.
    const out = redactUrl('https://user:p@ss@api.example.com/data');
    expect(out).toBe('https://[REDACTED]@api.example.com/data');
    expect(out).not.toContain('ss@');
  });
  it('redacts a token in the URL FRAGMENT (OAuth implicit flow) but leaves plain anchors alone', () => {
    expect(redactUrl('https://app.com/cb#access_token=ya29SECRETVAL&token_type=bearer')).toContain(
      'access_token=[REDACTED]',
    );
    expect(redactUrl('https://app.com/cb#access_token=ya29SECRETVAL')).not.toContain(
      'ya29SECRETVAL',
    );
    expect(redactUrl('https://app.com/page#section-two')).toBe('https://app.com/page#section-two');
  });
  it('preserves the query byte-for-byte when only path/userinfo/fragment was redacted', () => {
    expect(
      redactUrl('https://app.example.com/reset/abcdefghijklmnop?next=/a%20b&sort=name%3Aasc'),
    ).toBe('https://app.example.com/reset/[REDACTED]?next=/a%20b&sort=name%3Aasc');
    expect(redactUrl('https://app.example.com/reset/abcdefghijklmnop?debug')).toBe(
      'https://app.example.com/reset/[REDACTED]?debug',
    );
    expect(redactUrl('https://alice:s3cr3t@api.example.com/data?page=1&q=hello%20world')).toBe(
      'https://[REDACTED]@api.example.com/data?page=1&q=hello%20world',
    );
    expect(
      redactUrl('https://app.example.com/callback?next=%2Fdashboard&lang=en#access_token=abc123'),
    ).toBe('https://app.example.com/callback?next=%2Fdashboard&lang=en#access_token=[REDACTED]');
  });
});

describe('extractTiming (PerformanceResourceTiming → TTFB/transferSize)', () => {
  const entry = (over: Partial<PerformanceResourceTiming>): PerformanceResourceTiming =>
    ({ requestStart: 0, responseStart: 0, transferSize: 0, ...over }) as PerformanceResourceTiming;

  it('computes TTFB from responseStart - requestStart', () => {
    expect(
      extractTiming(entry({ requestStart: 100, responseStart: 250, transferSize: 1024 })),
    ).toEqual({
      ttfbMs: 150,
      transferSize: 1024,
    });
  });

  it('omits TTFB for a cross-origin entry that zeroes the timings (no bogus 0)', () => {
    expect(extractTiming(entry({ requestStart: 0, responseStart: 0, transferSize: 0 }))).toEqual(
      {},
    );
  });

  it('returns empty for a missing entry', () => {
    expect(extractTiming(undefined)).toEqual({});
  });
});

describe('firstAppFrame (initiator stack parsing)', () => {
  it('returns the first app frame, skipping Reticle wrappers and engine-internal frames', () => {
    const stack = [
      'Error',
      '    at initiatorFrame (/pkg/browser/src/observers/network.ts:250:20)',
      '    at new Promise (<anonymous>)',
      '    at handleCheckout (/app/src/Checkout.tsx:114:9)',
      '    at onClick (/app/src/Button.tsx:20:3)',
    ].join('\n');
    expect(firstAppFrame(stack)).toBe('at handleCheckout (/app/src/Checkout.tsx:114:9)');
  });

  it('returns undefined when every frame is a wrapper or engine frame', () => {
    const stack = [
      'Error',
      '    at fetch (/pkg/@reticlehq/browser/network.ts:5:1)',
      '    at <anonymous>',
    ].join('\n');
    expect(firstAppFrame(stack)).toBeUndefined();
  });

  it('returns undefined for a missing stack', () => {
    expect(firstAppFrame(undefined)).toBeUndefined();
  });

  it('caps a very long frame', () => {
    const stack = `Error\n    at fn (/app/${'x'.repeat(500)}.ts:1:1)`;
    expect((firstAppFrame(stack) as string).length).toBeLessThanOrEqual(300);
  });
});

describe('installNetwork (sendBeacon)', () => {
  let teardown: Teardown | undefined;
  const navProto = Object.getPrototypeOf(navigator) as Navigator;
  const hadBeacon = Object.getOwnPropertyDescriptor(navProto, 'sendBeacon');

  function setBeacon(fn: (url: string | URL, data?: BodyInit | null) => boolean): void {
    Object.defineProperty(navProto, 'sendBeacon', {
      value: fn,
      configurable: true,
      writable: true,
    });
  }

  afterEach(() => {
    teardown?.();
    teardown = undefined;
    if (hadBeacon !== undefined) Object.defineProperty(navProto, 'sendBeacon', hadBeacon);
    else Reflect.deleteProperty(navProto, 'sendBeacon');
  });

  it('emits a completed NET_REQUEST for a beacon and preserves its boolean result', () => {
    setBeacon(() => true);
    const { emit, events } = collect();
    teardown = installNetwork(emit);
    const result = navigator.sendBeacon('http://localhost:8787/analytics', 'event=checkout');
    expect(result).toBe(true);
    const request = events.find((e) => e.type === EventType.NET_REQUEST);
    // sendBeacon has no observable HTTP response — status 0 (not a fabricated 200); the real signal
    // that it was accepted rides in `queued`.
    expect(request?.data).toMatchObject({
      method: 'POST',
      initiator: 'beacon',
      status: 0,
      ok: true,
      queued: true,
    });
  });

  it('reports ok:false when the beacon is rejected (queue full)', () => {
    setBeacon(() => false);
    const { emit, events } = collect();
    teardown = installNetwork(emit);
    navigator.sendBeacon('http://localhost:8787/analytics');
    const request = events.find((e) => e.type === EventType.NET_REQUEST);
    expect(request?.data).toMatchObject({ ok: false, status: 0 });
  });
});

describe('installNetwork (fetch)', () => {
  let teardown: Teardown | undefined;
  const origFetch = requireCapturedMethod<typeof window.fetch>(window, 'fetch');

  beforeEach(() => {
    // Ensure there is a fetch for the observer to wrap; each test overrides the behavior.
    window.fetch = vi.fn(() => Promise.resolve(fakeResponse(200)));
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
    window.fetch = origFetch;
  });

  function fakeResponseWithBody(status: number, contentType: string, bodyText: string): Response {
    return {
      status,
      ok: status >= 200 && status < 300,
      statusText: 'OK',
      headers: new Headers({ 'content-type': contentType }),
      clone: () => ({ text: () => Promise.resolve(bodyText) }),
    } as unknown as Response;
  }

  /**
   * A redirect is not a failure, and the two transports have to agree that it is not.
   *
   * `Response.ok` is true only for 200-299, so reading it straight through stamped every 3xx as a
   * failed request — while the XHR path, which computes the same field itself, called the identical
   * status a success. Downstream, `ok` is authoritative when present, so a POST-redirect-GET login
   * (the first flow anyone verifies in an app with auth) came back as a contradicted verdict on the
   * strength of its own success path. Pin both transports to the same rule so they cannot drift.
   */
  it.each([301, 302, 303, 307, 308])('does not call a %i redirect a failed request', async (s) => {
    window.fetch = vi.fn(() => Promise.resolve(fakeResponse(s)));
    const { emit, events } = collect();
    teardown = installNetwork(emit);
    await window.fetch('http://localhost:8787/login', { method: 'POST' });
    const data = eventOf(events, EventType.NET_REQUEST);
    expect(data['status']).toBe(s);
    expect(data['ok']).toBe(true);
  });

  it('still calls a 4xx and a 5xx failed', async () => {
    for (const s of [400, 404, 500]) {
      window.fetch = vi.fn(() => Promise.resolve(fakeResponse(s)));
      const { emit, events } = collect();
      teardown = installNetwork(emit);
      await window.fetch('http://localhost:8787/api/x');
      expect(eventOf(events, EventType.NET_REQUEST)['ok']).toBe(false);
      teardown();
      teardown = undefined;
    }
  });

  it('captures + redacts request and response bodies only when opted in (Network 1b)', async () => {
    // Fake credential values held in variables so the object literals do not read as hardcoded
    // secrets to the repo's secret scanner — the point is that the observer redacts them.
    const respTokenValue = 'resp-token-abcdef123';
    const reqPasswordValue = 'req-pass-abcdef123';
    const respBody = JSON.stringify({ items: [{ id: 1 }], token: respTokenValue });
    window.fetch = vi.fn(() =>
      Promise.resolve(fakeResponseWithBody(200, 'application/json', respBody)),
    );
    const { emit, events } = collect();
    teardown = installNetwork(emit, { captureBodies: true });
    await window.fetch('http://localhost:8787/api/data', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@b.com', password: reqPasswordValue }),
    });
    await flushBody();
    const data = eventOf(events, EventType.NET_REQUEST);
    expect(String(data['responseBody'])).toContain('"id":1');
    expect(String(data['responseBody'])).toContain('[REDACTED]'); // token value redacted
    expect(String(data['responseBody'])).not.toContain(respTokenValue);
    expect(String(data['requestBody'])).toContain('[REDACTED]'); // password value redacted
    expect(String(data['requestBody'])).not.toContain(reqPasswordValue);
  });

  it('redacts sensitive key=value pairs in a NON-JSON (form-urlencoded) body', async () => {
    const formPasswordValue = 'form-pass-abcdef123';
    window.fetch = vi.fn(() =>
      Promise.resolve(fakeResponseWithBody(200, 'application/json', '{"ok":true}')),
    );
    const { emit, events } = collect();
    teardown = installNetwork(emit, { captureBodies: true });
    await window.fetch('http://localhost:8787/login', {
      method: 'POST',
      body: `username=alice&password=${formPasswordValue}`,
    });
    await flushBody();
    const data = eventOf(events, EventType.NET_REQUEST);
    expect(String(data['requestBody'])).toContain('username=alice'); // non-sensitive kept
    expect(String(data['requestBody'])).toContain('password=[REDACTED]');
    expect(String(data['requestBody'])).not.toContain(formPasswordValue);
  });

  it('does NOT over-redact prose containing the words Bearer/Basic (no false positive)', async () => {
    const prose =
      'Basic subscription includes support. Bearer capacity exceeded the threshold today.';
    window.fetch = vi.fn(() => Promise.resolve(fakeResponseWithBody(200, 'text/plain', prose)));
    const { emit, events } = collect();
    teardown = installNetwork(emit, { captureBodies: true });
    await window.fetch('http://localhost:8787/docs');
    await flushBody();
    expect(String(eventOf(events, EventType.NET_REQUEST)['responseBody'])).toBe(prose);
  });

  it('scrubs a high-confidence secret sitting in a JSON VALUE under a benign key', async () => {
    const jwt = 'eyJhbGciOi.eyJzdWIiOi.sig123ABCdef';
    const body = JSON.stringify({ note: `token is ${jwt}` });
    window.fetch = vi.fn(() =>
      Promise.resolve(fakeResponseWithBody(200, 'application/json', body)),
    );
    const { emit, events } = collect();
    teardown = installNetwork(emit, { captureBodies: true });
    await window.fetch('http://localhost:8787/api/x');
    await flushBody();
    const rb = String(eventOf(events, EventType.NET_REQUEST)['responseBody']);
    expect(rb).toContain('[REDACTED]');
    expect(rb).not.toContain(jwt);
  });

  it('captures + redacts a URLSearchParams request body (not just strings)', async () => {
    const pw = 'usp-pass-abcdef123';
    window.fetch = vi.fn(() =>
      Promise.resolve(fakeResponseWithBody(200, 'application/json', '{"ok":1}')),
    );
    const { emit, events } = collect();
    teardown = installNetwork(emit, { captureBodies: true });
    await window.fetch('http://localhost:8787/login', {
      method: 'POST',
      body: new URLSearchParams({ user: 'bob', password: pw }),
    });
    await flushBody();
    const rb = String(eventOf(events, EventType.NET_REQUEST)['requestBody']);
    expect(rb).toContain('password=[REDACTED]');
    expect(rb).not.toContain(pw);
  });

  it('marks a non-text request body (FormData) with a type instead of dropping it', async () => {
    window.fetch = vi.fn(() =>
      Promise.resolve(fakeResponseWithBody(200, 'application/json', '{"ok":1}')),
    );
    const { emit, events } = collect();
    teardown = installNetwork(emit, { captureBodies: true });
    const fd = new FormData();
    fd.append('field', 'value');
    await window.fetch('http://localhost:8787/upload', { method: 'POST', body: fd });
    await flushBody();
    expect(eventOf(events, EventType.NET_REQUEST)['requestBodyType']).toBe('FormData');
  });

  it('redacts a credential-shaped Bearer token in a text body', async () => {
    const token = 'AbCd1234EfGh5678IjKl';
    window.fetch = vi.fn(() =>
      Promise.resolve(fakeResponseWithBody(200, 'text/plain', `sent Bearer ${token} today`)),
    );
    const { emit, events } = collect();
    teardown = installNetwork(emit, { captureBodies: true });
    await window.fetch('http://localhost:8787/echo');
    await flushBody();
    const rb = String(eventOf(events, EventType.NET_REQUEST)['responseBody']);
    expect(rb).toContain('Bearer [REDACTED]');
    expect(rb).not.toContain(token);
  });

  it('does not leak the token when the body is a full "Authorization: Bearer <token>" header dump', async () => {
    const token = 'ZzYy9876XxWw5432VvUu';
    window.fetch = vi.fn(() =>
      Promise.resolve(fakeResponseWithBody(200, 'text/plain', `Authorization: Bearer ${token}`)),
    );
    const { emit, events } = collect();
    teardown = installNetwork(emit, { captureBodies: true });
    await window.fetch('http://localhost:8787/echo');
    await flushBody();
    const rb = String(eventOf(events, EventType.NET_REQUEST)['responseBody']);
    expect(rb).not.toContain(token); // the token must not survive, whatever the surrounding shape
    expect(rb).toContain('[REDACTED]');
  });

  // A generous timeout, not the 5s default, because the invariant here is a BOUND — the truncated
  // flag and the 8192-char output — and never a duration. It runs in ~120ms locally and timed out at
  // 5000ms on a contended macOS runner the first time this suite ever executed there: a 40x margin
  // lost to machine load, which is the definition of a test that reports the runner as a defect.
  it('caps an oversized body and sets the truncated flag', async () => {
    const huge = 'x'.repeat(20000);
    window.fetch = vi.fn(() => Promise.resolve(fakeResponseWithBody(200, 'text/plain', huge)));
    const { emit, events } = collect();
    teardown = installNetwork(emit, { captureBodies: true });
    await window.fetch('http://localhost:8787/big');
    await flushBody();
    const data = eventOf(events, EventType.NET_REQUEST);
    expect(data['responseBodyTruncated']).toBe(true);
    expect(String(data['responseBody']).length).toBe(8192); // MAX_BODY_CHARS
  }, 30_000);

  it('does NOT capture bodies by default (opt-in only)', async () => {
    window.fetch = vi.fn(() =>
      Promise.resolve(fakeResponseWithBody(200, 'application/json', '{"x":1}')),
    );
    const { emit, events } = collect();
    teardown = installNetwork(emit);
    await window.fetch('http://localhost:8787/api/x');
    await flushBody();
    expect(eventOf(events, EventType.NET_REQUEST)['responseBody']).toBeUndefined();
  });

  it('captures content-type, response size, and status text without reading the body (Network 1a)', async () => {
    window.fetch = vi.fn(() =>
      Promise.resolve(
        fakeResponse(200, {
          statusText: 'OK',
          headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': '1234' },
        }),
      ),
    );
    const { emit, events } = collect();
    teardown = installNetwork(emit);
    await window.fetch('http://localhost:8787/api/data');
    await flushBody();
    expect(eventOf(events, EventType.NET_REQUEST)).toMatchObject({
      contentType: 'application/json; charset=utf-8',
      responseSize: 1234,
      statusText: 'OK',
    });
  });

  it('emits NET_PENDING at start then NET_REQUEST for a GET that resolves with a 500', async () => {
    window.fetch = vi.fn(() => Promise.resolve(fakeResponse(500)));
    const { emit, events } = collect();
    teardown = installNetwork(emit);

    const res = await window.fetch('http://localhost:8787/api/broken/500');

    expect(res.status).toBe(500);
    // Scoped to NETWORK events: the contract is "a request emits a pending then a completion", not
    // "the observer emits exactly two things ever" — install-time events are not part of it.
    const net = events.filter(
      (e) => e.type === EventType.NET_PENDING || e.type === EventType.NET_REQUEST,
    );
    expect(net).toHaveLength(2);
    expect(net[0]?.type).toBe(EventType.NET_PENDING);
    expect(net[0]?.data).toMatchObject({
      method: 'GET',
      url: 'http://localhost:8787/api/broken/500',
      initiator: 'fetch',
    });
    expect(net[1]?.type).toBe(EventType.NET_REQUEST);
    expect(eventOf(events, EventType.NET_REQUEST)).toMatchObject({
      method: 'GET',
      url: 'http://localhost:8787/api/broken/500',
      status: 500,
      ok: false,
      initiator: 'fetch',
    });
    // The pending and the completion share a correlation id.
    expect(net[1]?.data['id']).toBe(net[0]?.data['id']);
  });

  it('captures the method from init for a POST (completion is the second event)', async () => {
    window.fetch = vi.fn(() => Promise.resolve(fakeResponse(200)));
    const { emit, events } = collect();
    teardown = installNetwork(emit);

    await window.fetch('http://localhost:8787/api/login', { method: 'POST' });
    await flushBody();

    expect(events.filter((e) => e.type === EventType.NET_PENDING)).toHaveLength(1);
    expect(eventOf(events, EventType.NET_REQUEST)).toMatchObject({
      method: 'POST',
      status: 200,
      ok: true,
    });
  });

  it('emits a NET_REQUEST with status 0 and rethrows when the fetch rejects', async () => {
    const boom = new Error('network down');
    window.fetch = vi.fn(() => Promise.reject(boom));
    const { emit, events } = collect();
    teardown = installNetwork(emit);

    await expect(window.fetch('http://localhost:8787/api/x')).rejects.toBe(boom);
    expect(events.filter((e) => e.type !== EventType.BLIND_SPOT)).toHaveLength(2);
    expect(eventOf(events, EventType.NET_REQUEST)).toMatchObject({
      status: 0,
      ok: false,
      error: 'network down',
    });
  });

  it('emits only NET_PENDING for a request that never resolves (the hung-request case)', () => {
    // A fetch whose promise never settles — the regression no completion-only logging can see.
    window.fetch = vi.fn(() => new Promise<Response>(() => {}));
    const { emit, events } = collect();
    teardown = installNetwork(emit);

    void window.fetch('http://localhost:8787/api/broken/timeout');

    expect(events.filter((e) => e.type !== EventType.BLIND_SPOT)).toHaveLength(1);
    expect(events.filter((e) => e.type !== EventType.BLIND_SPOT)[0]?.type).toBe(
      EventType.NET_PENDING,
    );
    expect(events.filter((e) => e.type !== EventType.BLIND_SPOT)[0]?.data).toMatchObject({
      method: 'GET',
      url: 'http://localhost:8787/api/broken/timeout',
      initiator: 'fetch',
    });
  });

  it('restores the original fetch on teardown', () => {
    // Read as stored values on both sides: the assertion is about WHICH FUNCTION OBJECT sits in the
    // slot before and after, which is exactly what a descriptor read returns and what teardown has
    // to put back. See capturedMethod.
    const before = requireCapturedMethod<typeof window.fetch>(window, 'fetch');
    const t = installNetwork(collect().emit);
    expect(requireCapturedMethod(window, 'fetch')).not.toBe(before);
    t();
    expect(requireCapturedMethod(window, 'fetch')).toBe(before);
  });
});

/** Controllable WebSocket double (jsdom has none) that the observer subclass can extend + drive. */
class FakeWebSocket {
  static readonly OPEN = 1;
  #listeners: Record<string, ((ev: unknown) => void)[]> = {};
  readonly url: string;
  constructor(url: string | URL) {
    this.url = String(url);
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    (this.#listeners[type] ??= []).push(cb);
  }
  send(_data: unknown): void {
    /* no-op transport */
  }
  dispatch(type: string, ev: unknown): void {
    (this.#listeners[type] ?? []).forEach((cb) => cb(ev));
  }
}

/** Controllable EventSource double (jsdom has none) that the observer subclass can extend + drive. */
class FakeEventSource {
  #listeners: Record<string, ((ev: unknown) => void)[]> = {};
  readonly url: string;
  constructor(url: string | URL) {
    this.url = String(url);
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    (this.#listeners[type] ??= []).push(cb);
  }
  dispatch(type: string, ev: unknown): void {
    (this.#listeners[type] ?? []).forEach((cb) => cb(ev));
  }
}

describe('installNetwork (WebSocket / SSE frames, Network 1f)', () => {
  const origWS = window.WebSocket;
  const origES = window.EventSource;
  afterEach(() => {
    window.WebSocket = origWS;
    window.EventSource = origES;
  });

  it('reports a binary WS frame by byte size, not a bare object type', () => {
    window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const { emit, events } = collect();
    const teardown = installNetwork(emit, { captureBodies: true });
    const ws = new window.WebSocket('ws://localhost:8787/live') as unknown as FakeWebSocket;
    ws.dispatch('message', { data: new ArrayBuffer(24) });
    teardown();
    const inbound = events.filter((e) => e.type === EventType.NET_STREAM).at(-1);
    expect(inbound?.data['frameType']).toBe('binary');
    expect(inbound?.data['frameBytes']).toBe(24);
  });

  it('captures SSE (EventSource) open + inbound message frames when opted in', () => {
    window.EventSource = FakeEventSource as unknown as typeof EventSource;
    const { emit, events } = collect();
    const teardown = installNetwork(emit, { captureBodies: true });
    const es = new window.EventSource('http://localhost:8787/stream') as unknown as FakeEventSource;
    es.dispatch('message', { data: '{"tick":1}' });
    teardown();
    const streams = events.filter((e) => e.type === EventType.NET_STREAM);
    expect(streams.map((s) => s.data['transport'])).toEqual(['sse', 'sse']);
    expect(streams.map((s) => s.data['direction'])).toEqual(['open', 'in']);
    expect(String(streams[1]?.data['frame'])).toContain('"tick":1');
    expect(window.EventSource).toBe(FakeEventSource); // teardown restored
  });

  it("NEVER instruments the SDK's own bridge socket — that recursion crashes the page", () => {
    // The transport resolves `WebSocket` at call time, so any RECONNECT after instrumentation builds
    // a patched socket. Emitting an event then calls transport.send -> patched send -> emit -> send,
    // until the stack blows. Observed live as an unusable app: "Maximum call stack size exceeded"
    // repeating, with the trace running emit -> sendEvent -> safeStringify -> send.
    window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const { emit, events } = collect();
    const teardown = installNetwork(emit, { captureBodies: true });

    const bridge = new window.WebSocket(
      `ws://localhost:4400${RETICLE_WS_PATH}`,
    ) as unknown as FakeWebSocket;
    bridge.send('{"kind":"hello"}');
    bridge.dispatch('message', { data: '{"kind":"ack"}' });
    teardown();

    expect(events.filter((e) => e.type === EventType.NET_STREAM)).toEqual([]);
  });

  it('still instruments an app socket served from the same origin as the bridge', () => {
    // The guard keys on the bridge PATH, not the host — an app's own socket on the same host must
    // still be observed, or the fix would blind the very category it exists to support.
    window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const { emit, events } = collect();
    const teardown = installNetwork(emit, { captureBodies: true });
    const app = new window.WebSocket('ws://localhost:4400/ws/echo') as unknown as FakeWebSocket;
    app.dispatch('message', { data: '{"channel":"deployments"}' });
    teardown();
    expect(events.filter((e) => e.type === EventType.NET_STREAM).length).toBeGreaterThan(0);
  });

  it('captures open, outbound send, and inbound message frames when opted in', () => {
    window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const { emit, events } = collect();
    const teardown = installNetwork(emit, { captureBodies: true });

    const ws = new window.WebSocket('ws://localhost:8787/live') as unknown as FakeWebSocket;
    ws.send('{"hello":1}');
    ws.dispatch('message', { data: '{"price":42}' });
    teardown();

    const streams = events.filter((e) => e.type === EventType.NET_STREAM);
    expect(streams.map((s) => s.data['direction'])).toEqual(['open', 'out', 'in']);
    expect(String(streams[2]?.data['frame'])).toContain('"price":42');
    expect(window.WebSocket).toBe(FakeWebSocket); // teardown restored the (test's) original
  });

  it('does NOT patch streaming transports when body capture is off', () => {
    window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const { emit } = collect();
    const teardown = installNetwork(emit); // no captureBodies
    expect(window.WebSocket).toBe(FakeWebSocket); // untouched
    teardown();
  });
});

/** A minimal XMLHttpRequest stand-in — jsdom's real XHR would attempt a live network request. */
class FakeXHR {
  #listeners: Record<string, ((ev: unknown) => void)[]> = {};
  status = 0;
  statusText = '';
  responseText = '';
  responseType = '';
  #headers: Record<string, string> = {};
  method = '';
  url = '';
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  send(_body?: unknown): void {
    /* no-op transport */
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    (this.#listeners[type] ??= []).push(cb);
  }
  getResponseHeader(k: string): string | null {
    return this.#headers[k.toLowerCase()] ?? null;
  }
  complete(opts: { status?: number; contentType?: string; responseText?: string } = {}): void {
    this.status = opts.status ?? 200;
    this.statusText = 'OK';
    if (opts.contentType !== undefined) this.#headers['content-type'] = opts.contentType;
    this.responseText = opts.responseText ?? '';
    (this.#listeners['loadend'] ?? []).forEach((cb) => cb({}));
  }
}

describe('installNetwork (XMLHttpRequest)', () => {
  const origXHR = window.XMLHttpRequest;
  afterEach(() => {
    window.XMLHttpRequest = origXHR;
  });

  it('captures an XHR completion with status, redacted url, and initiator', () => {
    window.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
    const { emit, events } = collect();
    const teardown = installNetwork(emit);
    const xhr = new window.XMLHttpRequest() as unknown as FakeXHR;
    xhr.open('GET', '/api/data?access_token=SECRETXHR&page=1');
    xhr.send();
    xhr.complete({ status: 200 });
    teardown();

    const done = events.find((e) => e.type === EventType.NET_REQUEST);
    expect(done?.data['status']).toBe(200);
    expect(done?.data['initiator']).toBe('xhr');
    expect(String(done?.data['url'])).toContain('access_token=%5BREDACTED%5D');
    expect(String(done?.data['url'])).not.toContain('SECRETXHR');
    expect(done?.data[URL_RAW]).toBe('/api/data?access_token=SECRETXHR&page=1');
  });

  it('a REUSED XHR emits exactly one completion per send (no accumulated listeners)', () => {
    window.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
    const { emit, events } = collect();
    const teardown = installNetwork(emit);
    const xhr = new window.XMLHttpRequest() as unknown as FakeXHR;

    xhr.open('GET', '/first');
    xhr.send();
    xhr.complete({ status: 200 });
    xhr.open('GET', '/second');
    xhr.send();
    xhr.complete({ status: 201 });
    teardown();

    const done = events.filter((e) => e.type === EventType.NET_REQUEST);
    expect(done.length).toBe(2); // NOT 3 — the first send's listener must not re-fire on the second
    expect(done.map((e) => e.data['url'])).toEqual(['/first', '/second']);
    expect(done.map((e) => e.data['status'])).toEqual([200, 201]);
  });
});

describe('document-initiated subresources (PerformanceObserver)', () => {
  let teardown: Teardown | undefined;
  type POCallback = (list: { getEntries: () => PerformanceEntry[] }) => void;
  let observedTypes: string[] = [];
  const hadPO = typeof globalThis.PerformanceObserver !== 'undefined';
  const originalPO = globalThis.PerformanceObserver;

  class FakePO {
    static instances: FakePO[] = [];
    callback: POCallback;
    disconnected = false;
    constructor(cb: POCallback) {
      this.callback = cb;
      FakePO.instances.push(this);
    }
    observe(opts: { type: string }): void {
      observedTypes.push(opts.type);
    }
    disconnect(): void {
      this.disconnected = true;
    }
  }

  beforeEach(() => {
    FakePO.instances = [];
    observedTypes = [];
    (globalThis as unknown as { PerformanceObserver: unknown }).PerformanceObserver = FakePO;
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
    if (hadPO)
      (globalThis as unknown as { PerformanceObserver: unknown }).PerformanceObserver = originalPO;
    else Reflect.deleteProperty(globalThis, 'PerformanceObserver');
  });

  function fakeEntry(initiatorType: string, name: string, durationMs = 12): PerformanceEntry {
    return {
      name,
      entryType: 'resource',
      startTime: 100,
      duration: durationMs,
      initiatorType,
      transferSize: 2048,
      responseStatus: 200,
    } as unknown as PerformanceEntry;
  }

  it('emits document-initiated loads as NET_REQUEST with status when readable', () => {
    const { emit, events } = collect();
    teardown = installNetwork(emit);
    expect(observedTypes).toContain('resource');

    const cb = FakePO.instances.at(0)?.callback;
    if (cb === undefined) throw new Error('observer callback missing');
    cb({
      getEntries: () => [
        fakeEntry('link', 'https://app.test/favicon.ico'),
        fakeEntry('link', 'https://app.test/site.webmanifest'),
        fakeEntry('css', 'https://app.test/app.css'),
        // fetch/XHR types belong to the patched transports and must be skipped
        fakeEntry('fetch', 'https://app.test/api/data'),
      ],
    });

    const net = events.filter((e) => e.type === EventType.NET_REQUEST);
    expect(net.length).toBe(3);
    expect(net.map((e) => e.data['url'])).toEqual([
      'https://app.test/favicon.ico',
      'https://app.test/site.webmanifest',
      'https://app.test/app.css',
    ]);
    for (const e of net) {
      expect(e.data['method']).toBe('GET');
      expect(e.data['status']).toBe(200);
      expect(e.data['ok']).toBe(true);
    }
  });

  it('omits the status fields entirely when responseStatus is unreadable', () => {
    const { emit, events } = collect();
    teardown = installNetwork(emit);
    const entry = fakeEntry('img', 'https://app.test/hero.png');
    delete (entry as unknown as Record<string, unknown>).responseStatus;
    FakePO.instances.at(0)?.callback({ getEntries: () => [entry] });

    const net = events.find((e) => e.type === EventType.NET_REQUEST);
    expect(net).toBeDefined();
    if (net === undefined) return;
    expect(net.data).not.toHaveProperty('status');
    expect(net.data).not.toHaveProperty('ok');
    expect(net.data['initiator']).toBe('img');
  });

  it('disconnects the observer on teardown', () => {
    const { emit } = collect();
    teardown = installNetwork(emit);
    const po = FakePO.instances.at(0);
    expect(po).toBeDefined();
    teardown?.();
    teardown = undefined;
    expect(po?.disconnected).toBe(true);
  });
});
