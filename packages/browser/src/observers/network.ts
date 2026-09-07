import {
  BlindSpotKind,
  EventType,
  RETICLE_WS_PATH,
  StreamTransport,
  StreamDirection,
} from '@reticlehq/core';
import { captureMethod } from '../patching/capture-method.js';
import type { Emit, Teardown } from './types.js';
import { isCapturableType, projectBody, withBodyDeadline } from './network-body.js';
import { redactUrl, netUrlFields } from './network-redact.js';
import { watchStreamedBody } from './network-stream.js';
import { requireCapturedMethod } from '../util/captured-method.js';

// Redaction moved to its own cohesive module (network.ts is at its line cap); re-exported so callers
// and the existing test suite keep importing it from here.
export { redactUrl, netUrlFields };

/** Config for the network observer. Body capture is OFF by default and dev-only opt-in. */
/**
 * Reinterpret a completed request's fields from its response.
 *
 * The seam exists so this observer stays ignorant of desktop IPC. A Tauri `invoke` arrives here as an
 * ordinary fetch to an `ipc://` protocol, and the header that says whether the Rust command
 * succeeded means nothing to a network observer — so the knowledge lives in the IPC observer and is
 * passed IN, rather than this module importing it. Returns undefined to leave the record untouched.
 */
type NetResponseReinterpreter = (
  url: string,
  header: (name: string) => string | null,
) => Record<string, unknown> | undefined;

interface NetworkOptions {
  /** Capture request/response bodies (text-like content only, redacted, per-body capped). */
  captureBodies?: boolean;
  /** Optional hook that reinterprets a completed request — see NetResponseReinterpreter. */
  reinterpret?: NetResponseReinterpreter;
  /**
   * Requests Reticle itself makes, which must never reach the app's evidence.
   *
   * Same seam and same reason as `reinterpret`: this observer knows nothing about desktop IPC, and
   * the SDK's own Tauri screenshot travels as an ordinary fetch through this very patch. Passed in
   * rather than imported, so the knowledge stays in the IPC observer.
   */
  ignore?: (url: string) => boolean;
}

/** The byte size of a binary frame (ArrayBuffer / Blob / typed-array view), or undefined if unknown. */
function binaryFrameBytes(data: unknown): number | undefined {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return undefined;
}

/** Project one SSE/WebSocket frame: byte size + shape; the (capped, redacted) payload only when body
 * capture is on and it is a string frame. Binary frames report their byte size, not just a bare type. */
function frameFields(data: unknown, captureBodies: boolean): Record<string, unknown> {
  if (typeof data !== 'string') {
    const bytes = binaryFrameBytes(data);
    return bytes === undefined
      ? { frameType: typeof data }
      : { frameType: 'binary', frameBytes: bytes };
  }
  const out: Record<string, unknown> = { frameBytes: data.length };
  if (captureBodies) {
    const { body, truncated } = projectBody(data, 'application/json');
    out['frame'] = body;
    if (truncated) out['frameTruncated'] = true;
  }
  return out;
}

/**
 * The request body for the transcript. Plain strings and URLSearchParams are captured (redacted, capped);
 * FormData/Blob/ArrayBuffer/stream aren't text so they get a `requestBodyType` marker (the agent still
 * learns a body existed) rather than being silently dropped. Shared by the fetch and XHR paths.
 */
function projectRequestBody(body: unknown, captureBodies: boolean): Record<string, unknown> {
  if (!captureBodies) return {};
  let text: string | undefined;
  let contentType = 'application/json';
  if ('string' === typeof body) {
    text = body;
  } else if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    text = body.toString();
    contentType = 'application/x-www-form-urlencoded';
  } else if (body !== undefined && body !== null) {
    const shape = (body as { constructor?: { name?: string } }).constructor?.name ?? typeof body;
    return { requestBodyType: shape };
  }
  if (text === undefined || 0 === text.length) return {};
  const { body: out, truncated } = projectBody(text, contentType);
  return truncated ? { requestBody: out, requestBodyTruncated: true } : { requestBody: out };
}

interface XhrMeta {
  id: string;
  method: string;
  url: string;
  start: number;
  rawUrl: string;
  initiatorStack?: string | undefined;
  reqBody?: Document | XMLHttpRequestBodyInit | null;
}

/**
 * Did this response succeed? A REDIRECT DID.
 *
 * The one rule both transports must share. `Response.ok` is true only for 200-299, so reading it
 * straight through stamped every 3xx as a failed request, while the XHR path computed the same field
 * itself and called the identical status a success. Downstream, `ok` is authoritative when present —
 * so a POST-redirect-GET login, the first flow anyone verifies in an app with auth, produced a
 * `ui-advanced-request-failed` contradiction citing its own success path, and the agent had to
 * overrule the verdict by hand. A verdict that gets manually overruled is not deciding anything.
 *
 * 3xx is normal successful navigation. An opaque (no-cors) response reports status 0 and is correctly
 * excluded here, exactly as `Response.ok` excluded it.
 */
function statusIsOk(status: number): boolean {
  return status >= 200 && status < 400;
}

/**
 * Response metadata that needs no body capture: HTTP status text, content-type, and byte size (from
 * content-length when the server sent it). Lets an agent tell an HTML error page served as 200 from
 * real JSON, and spot empty/oversized responses. Fields are omitted when absent so a clean call stays
 * token-flat.
 */
function netResponseMeta(
  statusText: string,
  contentType: string | null,
  contentLength: string | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (statusText !== '') out['statusText'] = statusText;
  if (contentType !== null && contentType !== '') out['contentType'] = contentType;
  const size = contentLength !== null ? Number.parseInt(contentLength, 10) : Number.NaN;
  if (Number.isFinite(size)) out['responseSize'] = size;
  return out;
}

function urlOf(input: RequestInfo | URL): string {
  if ('string' === typeof input) return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  if (init?.method !== undefined) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

/**
 * The first app-code frame that fired a request — the in-page answer to a CDP initiator, as file:line.
 * Captured from a fresh Error.stack at call time, skipping Reticle's own wrapper frames. Feeds the
 * causal chain (which code path made this request). Capped; undefined when no stack is available.
 * ponytail: one stack unwind per request — cheap next to fetch itself; revisit only if a profiler flags it.
 */
/**
 * Frames to skip: Reticle's own wrappers + engine-internal frames with no app source location.
 * Anchored to Reticle's actual module paths (`@reticlehq/…`, the SDK's own `.ts` files) — a bare
 * `reticle` alternative matched ANY app whose bundle URL merely contained the word (including this
 * repo's own dogfood fixtures served under `/reticle/`), silently dropping their initiatorStack.
 */
const NON_APP_FRAME =
  /@reticlehq|reticle\.ts|network\.ts|transport\.ts|<anonymous>|new Promise|node:internal/i;

/** Pure: the first real app-code frame in a stack string, capped. Exported for unit testing. */
export function firstAppFrame(stack: string | undefined): string | undefined {
  if (stack === undefined) return undefined;
  for (const line of stack.split('\n').slice(1)) {
    if (NON_APP_FRAME.test(line)) continue;
    const trimmed = line.trim();
    if (0 === trimmed.length) continue;
    return trimmed.slice(0, 300);
  }
  return undefined;
}

function initiatorFrame(): string | undefined {
  return firstAppFrame(new Error().stack);
}

/** The timing fields we lift from a resource entry — TTFB is the perf signal a duration alone hides. */
interface NetTiming {
  ttfbMs?: number;
  transferSize?: number;
}

/**
 * Pure: derive TTFB + transfer size from a PerformanceResourceTiming entry. TTFB = responseStart -
 * requestStart; cross-origin responses zero those (Timing-Allow-Origin), so we omit rather than report a
 * bogus 0. Exported for unit testing (jsdom doesn't post real resource entries).
 */
export function extractTiming(entry: PerformanceResourceTiming | undefined): NetTiming {
  if (entry === undefined) return {};
  const timing: NetTiming = {};
  if (entry.responseStart > 0 && entry.requestStart > 0) {
    timing.ttfbMs = Math.round(entry.responseStart - entry.requestStart);
  }
  if (entry.transferSize > 0) timing.transferSize = entry.transferSize;
  return timing;
}

/** Best-effort lookup of the most-recent resource-timing entry for a URL. */
function resourceTiming(rawUrl: string): NetTiming {
  try {
    const entries = performance.getEntriesByName(rawUrl, 'resource');
    return extractTiming(entries[entries.length - 1] as PerformanceResourceTiming | undefined);
  } catch {
    return {};
  }
}

/** Patch fetch + XMLHttpRequest to emit net.request events. Fully reversible. */
/**
 * True for Reticle's OWN bridge connection, which must never be instrumented.
 *
 * The transport resolves `WebSocket` at call time, so a reconnect after instrumentation constructs a
 * PATCHED socket. From then on emitting an event calls transport.send -> the patched send emits a
 * NET_STREAM event -> which calls transport.send again, until the stack blows and the page is dead.
 * Keyed on the bridge PATH rather than the host: an app's own socket on the same origin must still be
 * observed, otherwise this guard would blind the stream category it exists to protect.
 */
function isBridgeSocket(url: string): boolean {
  try {
    return new URL(url, location.href).pathname === RETICLE_WS_PATH;
  } catch {
    return url.includes(RETICLE_WS_PATH);
  }
}

/**
 * Whether a function is the platform's own fetch rather than someone's wrapper.
 *
 * `Function.prototype.toString` on a built-in yields "[native code]"; a JS wrapper yields its source.
 * Called off the prototype deliberately, so a wrapper cannot hide behind its own `toString`.
 *
 * Two known limits, both stated in tests rather than left to be discovered:
 *   - a BOUND wrapper (`window.fetch = mine.bind(x)`) also reports "[native code]", so it is missed.
 *     Nothing in the platform separates the two.
 *   - a POLYFILLED fetch reads as wrapped and IS reported — correctly, since a polyfill is a layer we
 *     cannot see through, though it will look like a false positive to anyone triaging it.
 *
 * Both failure modes are safe: we under-report on the first and over-report on the second, and
 * over-reporting a coverage caveat is the direction this library errs in everywhere else.
 */
function isNativeFetch(fn: typeof window.fetch): boolean {
  try {
    return Function.prototype.toString.call(fn).includes('native code');
  } catch {
    return false;
  }
}

/** Wrappers this module installed, so a re-install does not report itself as a foreign wrapper. */
const OURS = new WeakSet<typeof window.fetch>();

export function installNetwork(emit: Emit, opts: NetworkOptions = {}): Teardown {
  const captureBodies = true === opts.captureBodies;
  const reinterpret = opts.reinterpret;
  // Keep the true original for teardown identity, plus a window-bound copy to invoke
  // (fetch throws "Illegal invocation" if called with the wrong `this`).
  const origFetch = requireCapturedMethod<typeof window.fetch>(window, 'fetch');
  const callFetch = origFetch.bind(window);

  // Declare it if we are not the first to wrap fetch.
  //
  // Wrappers chain outermost-first, and we record `init.body` when OUR wrapper runs — so anything
  // installed EARLIER sits below us and mutates the request after we have read it. That is a real
  // blind spot (an auth/analytics interceptor started before connect(), a polyfill, a service worker
  // is worse still) and it is not fixable from in here: there is no "patch last" primitive, and
  // racing for outermost loses to whatever loads after us.
  //
  // So it is reported rather than hidden, on the same contract as the cross-origin-iframe sensor —
  // say what we cannot see, so a green verdict never implies we saw it. `isOurs` keeps a re-install
  // from blaming the app for our own wrapper.
  if (!isNativeFetch(origFetch) && !OURS.has(origFetch)) {
    emit(EventType.BLIND_SPOT, { kind: BlindSpotKind.WRAPPED_NETWORK, count: 1 });
  }

  // Correlation id so a NET_PENDING (emitted at request START) can be matched to its
  // NET_REQUEST completion. A request that never completes leaves an unmatched NET_PENDING —
  // that is how a hung/in-flight request becomes observable (it never resolves, so the old
  // completion-only emit saw nothing).
  let seq = 0;
  const nextId = (): string => `n${++seq}`;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = urlOf(input);
    // Reticle's own call: pass it straight through, observed by nobody. Emitting even the PENDING
    // half would be wrong twice over — it lands in the agent's network evidence, and `settle` would
    // wait on the SDK's own screenshot as if the app had a request in flight.
    if (true === opts.ignore?.(rawUrl)) return callFetch(input, init);
    const id = nextId();
    const start = performance.now();
    const method = methodOf(input, init);
    const urlFields = netUrlFields(rawUrl);
    const url = urlFields.url;
    const initiatorStack = initiatorFrame();
    const initiatorFields = initiatorStack === undefined ? {} : { initiatorStack };
    emit(EventType.NET_PENDING, {
      id,
      method,
      ...urlFields,
      initiator: 'fetch',
      ...initiatorFields,
    });
    try {
      const res = await callFetch(input, init);
      // The app's fetch resolves HERE — at headers — like a native fetch. durationMs is measured to
      // headers-received, so it stays honest whether or not we read the body.
      const headersAt = performance.now();
      const contentType = res.headers.get('content-type');
      // The request is done; the BODY may not be. Watch it so settle cannot pass mid-stream.
      watchStreamedBody(emit, res, id, url, contentType, res.headers.get('content-length'));
      reportedNetUrls.add(rawUrl);
      const emitRequest = (responseBodyFields: Record<string, unknown>): void => {
        emit(EventType.NET_REQUEST, {
          id,
          method,
          ...urlFields,
          status: res.status,
          ok: statusIsOk(res.status),
          durationMs: Math.round(headersAt - start),
          initiator: 'fetch',
          ...initiatorFields,
          ...resourceTiming(rawUrl),
          ...netResponseMeta(res.statusText, contentType, res.headers.get('content-length')),
          ...projectRequestBody(init?.body, captureBodies),
          ...responseBodyFields,
          // Applied LAST so a reinterpreted verdict wins over the transport's own fields — a Tauri
          // command that returned Err still travelled down a fetch that answered HTTP 200.
          ...(reinterpret?.(url, (name) => res.headers.get(name)) ?? {}),
        });
      };
      if (captureBodies && isCapturableType(contentType)) {
        // ONLY the body read can make the app wait (a chunked response with no content-length can be
        // arbitrarily long). Clone synchronously so the app's stream is untouched, then read + emit from
        // a DETACHED promise — the app already has res, so our bounded read is invisible to it. Without
        // body capture (the DEFAULT) we emit synchronously below, exactly as before: no latency, no
        // deferral, NET_REQUEST in order.
        //
        // Tradeoff, opt-in path only: under captureBodies the NET_REQUEST for THIS call lands after the
        // bounded body read (≤ the deadline), so it can arrive out of order vs a later request's
        // NET_PENDING, and a BARE `assert { net, count }` fired the instant the app's fetch resolves may
        // see the count not-yet-incremented. Use `wait_for` for count/settle assertions when body
        // capture is on (it already polls until the event lands). The default path has neither caveat.
        let clone: Response | undefined;
        try {
          clone = res.clone();
        } catch {
          /* already consumed/locked — emit the envelope with no body */
        }
        // The whole IIFE is guarded: emit is the SDK's already-try/catch'd sink today, but a detached
        // promise must never be able to surface an unhandledrejection into the host page even if a
        // future caller passes a throwing emit. A body we can't read is simply dropped.
        void (async () => {
          let responseBodyFields: Record<string, unknown> = {};
          if (clone !== undefined) {
            try {
              const text = await withBodyDeadline(clone.text());
              if (text !== undefined) {
                const { body, truncated } = projectBody(text, contentType);
                responseBodyFields = truncated
                  ? { responseBody: body, responseBodyTruncated: true }
                  : { responseBody: body };
              }
            } catch {
              /* body not readable — skip, keep the envelope */
            }
          }
          try {
            emitRequest(responseBodyFields);
          } catch {
            /* observation is best-effort; never reject into the page */
          }
        })().catch(() => undefined);
      } else {
        emitRequest({});
      }
      return res;
    } catch (error) {
      emit(EventType.NET_REQUEST, {
        id,
        method,
        url,
        status: 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(performance.now() - start),
        initiator: 'fetch',
        ...initiatorFields,
      });
      throw error;
    }
  };
  // Remember it, so a later install recognises our own wrapper instead of reporting the app.
  // Our own wrapper, read the same way — it is a value we stored a line ago, not a method call.
  const patchedFetch = requireCapturedMethod<typeof window.fetch>(window, 'fetch');
  OURS.add(patchedFetch);

  const meta = new WeakMap<XMLHttpRequest, XhrMeta>();
  const proto = XMLHttpRequest.prototype;
  const origOpen = captureMethod(proto, 'open');
  const origSend = captureMethod(proto, 'send');
  const callOpen = origOpen as (this: XMLHttpRequest, ...args: unknown[]) => void;

  proto.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ): void {
    meta.set(this, {
      id: nextId(),
      method: method.toUpperCase(),
      url: redactUrl(String(url)),
      rawUrl: String(url),
      start: 0,
    });
    callOpen.call(this, method, url, ...rest);
  };
  const patchedOpen = captureMethod(proto, 'open');

  // A reused XHR calls send repeatedly; attach the completion listener ONCE per instance and read the
  // request identity from `meta` at fire time. Adding a fresh closure each send would leave stale
  // listeners that re-fire on later completions, emitting duplicate, mislabeled events.
  const listenerAttached = new WeakSet<XMLHttpRequest>();
  proto.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const m = meta.get(this);
    if (m !== undefined) {
      m.start = performance.now();
      m.reqBody = body ?? null;
      m.initiatorStack = initiatorFrame(); // the app's xhr.send call site
      const initiatorFields =
        m.initiatorStack === undefined ? {} : { initiatorStack: m.initiatorStack };
      emit(EventType.NET_PENDING, {
        id: m.id,
        method: m.method,
        ...netUrlFields(m.rawUrl),
        initiator: 'xhr',
        ...initiatorFields,
      });
      if (!listenerAttached.has(this)) {
        listenerAttached.add(this);
        this.addEventListener('loadend', () => {
          const cur = meta.get(this);
          if (cur === undefined) return;
          reportedNetUrls.add(cur.rawUrl);
          const xhrContentType = this.getResponseHeader('content-type');
          let responseBodyFields: Record<string, unknown> = {};
          // responseText throws unless responseType is '' or 'text' — guard before reading.
          const textReadable = '' === this.responseType || 'text' === this.responseType;
          if (captureBodies && textReadable && isCapturableType(xhrContentType)) {
            try {
              const { body: rb, truncated } = projectBody(this.responseText, xhrContentType);
              responseBodyFields = truncated
                ? { responseBody: rb, responseBodyTruncated: true }
                : { responseBody: rb };
            } catch {
              /* unreadable body — skip */
            }
          }
          emit(EventType.NET_REQUEST, {
            id: cur.id,
            method: cur.method,
            ...netUrlFields(cur.rawUrl),
            status: this.status,
            ok: statusIsOk(this.status),
            durationMs: Math.round(performance.now() - cur.start),
            initiator: 'xhr',
            ...(cur.initiatorStack === undefined ? {} : { initiatorStack: cur.initiatorStack }),
            ...resourceTiming(cur.rawUrl),
            ...netResponseMeta(
              this.statusText,
              xhrContentType,
              this.getResponseHeader('content-length'),
            ),
            ...projectRequestBody(cur.reqBody, captureBodies),
            ...responseBodyFields,
          });
        });
      }
    }
    origSend.call(this, body ?? null);
  };
  const patchedSend = captureMethod(proto, 'send');

  // SSE + WebSocket frame capture — gated behind body capture, since a chatty stream is the
  // high-volume case. Subclass the native constructors so the app's own usage is unchanged.
  const origEventSource = window.EventSource;
  const origWebSocket = window.WebSocket;
  let patchedEventSource: typeof window.EventSource | undefined;
  let patchedWebSocket: typeof window.WebSocket | undefined;
  if (captureBodies && 'function' === typeof origEventSource) {
    window.EventSource = class extends origEventSource {
      constructor(u: string | URL, init?: EventSourceInit) {
        super(u, init);
        const urlFields = netUrlFields(String(u));
        emit(EventType.NET_STREAM, {
          transport: StreamTransport.SSE,
          direction: StreamDirection.OPEN,
          ...urlFields,
        });
        this.addEventListener('message', (ev: MessageEvent) => {
          emit(EventType.NET_STREAM, {
            transport: StreamTransport.SSE,
            direction: StreamDirection.IN,
            ...urlFields,
            ...frameFields(ev.data, captureBodies),
          });
        });
      }
    };
    patchedEventSource = window.EventSource;
  }
  if (captureBodies && 'function' === typeof origWebSocket) {
    window.WebSocket = class extends origWebSocket {
      /** Reticle's own bridge socket is never observed — see isBridgeSocket. */
      readonly #isBridge: boolean;
      constructor(u: string | URL, protocols?: string | string[]) {
        super(u, protocols);
        this.#isBridge = isBridgeSocket(String(u));
        if (this.#isBridge) return;
        const urlFields = netUrlFields(String(u));
        emit(EventType.NET_STREAM, {
          transport: StreamTransport.WS,
          direction: StreamDirection.OPEN,
          ...urlFields,
        });
        this.addEventListener('message', (ev: MessageEvent) => {
          emit(EventType.NET_STREAM, {
            transport: StreamTransport.WS,
            direction: StreamDirection.IN,
            ...urlFields,
            ...frameFields(ev.data, captureBodies),
          });
        });
      }
      // `override` is required, not decorative: this shadows WebSocket.prototype.send, and without
      // the keyword a rename or signature drift in the base class would silently turn this from an
      // override into a NEW method — the observer would stop intercepting and report no WebSocket
      // traffic at all, which reads as "the app sends none". Caught by noImplicitOverride.
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (this.#isBridge) {
          super.send(data);
          return;
        }
        emit(EventType.NET_STREAM, {
          transport: StreamTransport.WS,
          direction: StreamDirection.OUT,
          ...netUrlFields(this.url),
          ...frameFields(data, captureBodies),
        });
        super.send(data);
      }
    };
    patchedWebSocket = window.WebSocket;
  }

  // navigator.sendBeacon — fire-and-forget analytics/telemetry, invisible to fetch/XHR wrapping. A page
  // that beacons a "checkout completed" event should show it. Patch the instance's prototype (via
  // getPrototypeOf, robust whether or not the Navigator global exists); the descriptor read avoids an
  // unbound-method access; the send is synchronous so we emit one completed NET_REQUEST with its result.
  const navProto = (
    typeof navigator !== 'undefined' ? Object.getPrototypeOf(navigator) : null
  ) as Navigator | null;
  const origBeacon = (
    null === navProto ? undefined : Object.getOwnPropertyDescriptor(navProto, 'sendBeacon')?.value
  ) as BeaconFn | undefined;
  let patchedBeacon: BeaconFn | undefined;
  if (navProto !== null && origBeacon !== undefined) {
    patchedBeacon = function (this: Navigator, url: string | URL, data?: BodyInit | null): boolean {
      const id = nextId();
      const urlFields = netUrlFields(String(url));
      const initiatorStack = initiatorFrame();
      const sent = origBeacon.call(this, url, data);
      // sendBeacon returns whether the payload was QUEUED, not an HTTP result — the response never
      // surfaces to JS. Fabricating status 200 lied to an agent asserting on status. Report status 0
      // (no HTTP response observed) and carry the real signal in `queued`.
      emit(EventType.NET_REQUEST, {
        id,
        method: 'POST',
        ...urlFields,
        status: 0,
        ok: sent,
        queued: sent,
        durationMs: 0,
        initiator: 'beacon',
        ...(initiatorStack === undefined ? {} : { initiatorStack }),
      });
      return sent;
    };
    navProto.sendBeacon = patchedBeacon;
  }

  // Document-initiated subresources (link/css/img/script/manifest): fetch and XHR patches never see
  // these, so a `{net}` predicate over a favicon or manifest used to read `assertion_failed` — "your
  // change is broken" — when the truthful answer is "not observable". A PerformanceObserver over
  // `resource` entries reports them with no CDP. Status is the known gap: entries carry one only on
  // newer Chromium, so the field is emitted ONLY when readable and the evaluation seam downgrades
  // status assertions it cannot verify instead of guessing.
  //
  // Dedup: any URL the patched transports already reported (or later report) is skipped — resource
  // timing also records fetch/XHR loads. The seen-set is filled eagerly here AND at every
  // NET_REQUEST emit below, so both orders of arrival stay single-reported.
  const reportedNetUrls = new Set<string>();
  let subresourceEvents = 0;
  const SUBRESOURCE_CAP = 200;
  let subresourceObserver: PerformanceObserver | undefined;
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const raw of list.getEntries()) {
          const entry = raw as PerformanceResourceTiming;
          if (subresourceEvents >= SUBRESOURCE_CAP) return;
          const type = entry.initiatorType || 'other';
          // Patched transports own their records; only document-initiated types are new here.
          if ('fetch' === type || 'xmlhttprequest' === type) continue;
          const rawUrl = entry.name;
          if (reportedNetUrls.has(rawUrl)) continue;
          reportedNetUrls.add(rawUrl);
          subresourceEvents += 1;
          emit(EventType.NET_REQUEST, {
            id: nextId(),
            method: 'GET',
            ...netUrlFields(rawUrl),
            durationMs: Math.round(entry.duration),
            initiator: type,
            ...(entry.transferSize > 0 ? { transferSize: entry.transferSize } : {}),
            // responseStatus is Chromium-only; omitted entirely when unreadable so the wire never
            // carries a guessed status. Its absence is what the server-side seam reads as unknown.
            ...((entry.responseStatus ?? 0) > 0
              ? {
                  status: entry.responseStatus,
                  ok: (entry.responseStatus ?? 0) >= 200 && (entry.responseStatus ?? 0) < 400,
                }
              : {}),
          });
        }
      });
      subresourceObserver = observer;
      observer.observe({ type: 'resource', buffered: true });
      // Disconnected in the disposer below.
    } catch {
      // No observer support: document-initiated loads stay unobserved, stated rather than guessed.
    }
  }

  return () => {
    subresourceObserver?.disconnect();
    // Restore each slot ONLY if it still holds OUR wrapper. Between connect() and disconnect() the app
    // (or Sentry/analytics/a router) may have wrapped fetch/XHR/EventSource/WebSocket/sendBeacon ON TOP
    // of ours; blindly writing the original back would silently uninstall their instrumentation — the
    // dev-only SDK breaking the app it only meant to observe.
    if (window.fetch === patchedFetch) window.fetch = origFetch;
    if (captureMethod(proto, 'open') === patchedOpen) proto.open = origOpen;
    if (captureMethod(proto, 'send') === patchedSend) proto.send = origSend;
    if (patchedEventSource !== undefined && window.EventSource === patchedEventSource) {
      window.EventSource = origEventSource;
    }
    if (patchedWebSocket !== undefined && window.WebSocket === patchedWebSocket) {
      window.WebSocket = origWebSocket;
    }
    if (navProto !== null && origBeacon !== undefined && navProto.sendBeacon === patchedBeacon) {
      navProto.sendBeacon = origBeacon;
    }
  };
}

type BeaconFn = (this: Navigator, url: string | URL, data?: BodyInit | null) => boolean;
