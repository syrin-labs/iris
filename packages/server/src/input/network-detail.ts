import {
  EventType,
  REDACTED_VALUE,
  URL_RAW,
  defaultIsSensitiveKey,
  netUrlFields,
  scrubKnownSecrets,
  urlForMatch,
  type RedactionPolicy,
  type ReticleEvent,
} from '@reticlehq/core';
import { drivenRedactionPolicy } from './driven-redaction.js';

/**
 * CDP-authoritative network detail. Wherever the daemon has a CDP connection — whether it launched
 * the browser or attached to one someone else started — `page.on('response')` sees the FULL response:
 * status, mime type, and every response header, including the ones the in-page fetch/XHR wrapper
 * structurally cannot read (CORS-opaque headers, redirects).
 * Capturing it as a NET_DETAIL event and merging it onto the matching in-page NET_REQUEST means the
 * driven view never loses fidelity to an outside-in tool. Pure builder + merge are unit-tested; the
 * `page.on` attachment is thin Playwright glue (exercised e2e, like the pool launcher).
 */

export interface NetworkDetail {
  /**
   * The URL as the agent reads it, redacted by the same rule the in-page observer applies.
   *
   * It arrives raw from the driver, exactly like the headers and the request body below, and it
   * carries credentials just as routinely: a presigned upload, an OAuth callback, a single-use reset
   * link. Redacting the other two and not this one left the one field nobody had to parse to read.
   */
  url: string;
  /**
   * The URL before redaction, present only when redaction rewrote it.
   *
   * The grader-only match haystack, the same field and the same contract as on a NET_REQUEST: it is
   * how `urlContains` still matches a public path segment the heuristic rewrote, and how the merge
   * below pairs this detail with the request the SDK reported. `withoutUrlRaw` strips it before any
   * event is rendered to an agent.
   */
  [URL_RAW]?: string;
  method?: string;
  status: number;
  headers: Record<string, string>;
  resourceType?: string;
  /**
   * The request body as the NETWORK STACK saw it — what actually left, not what the page handed to
   * fetch. Redacted and bounded here because it arrives raw from the driver.
   *
   * This is the one thing in-page instrumentation structurally cannot get: Reticle reads `init.body`
   * inside its own fetch wrapper, and whoever patches fetch last is outermost — app bootstrap
   * decides that, not us. An interceptor initialised after connect(), or a service worker (no
   * window.fetch frame at all), rewrites requests invisibly. Available on the DRIVE path only.
   */
  requestBody?: string;
  /**
   * The document that ISSUED the request, which is what identifies the session it belongs to.
   *
   * Routing used to match the REQUEST's origin against the session's, falling back to the drive
   * URL's. Both miss the ordinary case: an app on one origin calling an API on another produces a
   * detail matching no session, so it was dropped silently — and on the CDP-attach path there is no
   * drive URL, so the fallback matched nothing at all. Cross-origin API calls are most API calls.
   */
  pageUrl?: string;
}

/** Bound on a captured wire body — matches the in-page capture so the two are comparable. */
const MAX_WIRE_BODY_CHARS = 8192;

/**
 * The rule this module redacts by.
 *
 * `defaultIsSensitiveKey`, never the ambient `isSensitiveKey`: a daemon serves many sessions in one
 * process, so an ambient policy here would let one app's config decide another app's redaction.
 * Callers that have a session's declarations pass a policy explicitly; everything else gets the
 * built-in floor, which is exactly what this module did before the rule became configurable.
 */
const DEFAULT_POLICY: RedactionPolicy = { isSensitiveKey: defaultIsSensitiveKey };

/**
 * Redact a sensitive key's value whatever its TYPE — string, number, array, or a nested object.
 *
 * This is the one payload in the system that reaches the journal without having passed through the
 * SDK's sanitizer (Playwright hands it over raw), so its redaction has to be as strong as the SDK's,
 * which is key-based over a parsed object — not string-shaped.
 */
function redactByKey(value: unknown, policy: RedactionPolicy): unknown {
  if (Array.isArray(value)) return value.map((v) => redactByKey(v, policy));
  if (value !== null && 'object' === typeof value) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = policy.isSensitiveKey(k) ? REDACTED_VALUE : redactByKey(v, policy);
    }
    return out;
  }
  return value;
}

function projectWireBody(raw: string, policy: RedactionPolicy): string {
  const bounded = raw.length > MAX_WIRE_BODY_CHARS ? raw.slice(0, MAX_WIRE_BODY_CHARS) : raw;
  const byShape = scrubKnownSecrets(bounded);
  // Prefer a STRUCTURAL pass. A sensitive key must be redacted regardless of its value type — a
  // numeric PIN (`"password": 1234`), a token array, a nested credential object — and the old
  // string-only sweep matched exclusively `"key":"string"`, so every non-string secret leaked
  // straight to the agent's context and the on-disk journal. Parsing and walking redacts them by key
  // whatever the shape.
  try {
    return JSON.stringify(redactByKey(JSON.parse(byShape), policy));
  } catch {
    // Not JSON (a truncated capture, or a form-encoded body — the shape a login form actually POSTs).
    // Two best-effort sweeps, because a password lives in both: the `"key":"string"` JSON fragment a
    // truncated body still contains, and the `key=value` pair of `application/x-www-form-urlencoded`,
    // which neither the JSON path nor the old regex ever touched — so `password=hunter2` leaked.
    return byShape
      .replace(/"([^"]+)"\s*:\s*"([^"]*)"/g, (whole, key: string) =>
        policy.isSensitiveKey(key) ? `"${key}":"${REDACTED_VALUE}"` : whole,
      )
      .replace(/([^&?=\s]+)=([^&\s]*)/g, (whole, key: string) =>
        policy.isSensitiveKey(key) ? `${key}=${REDACTED_VALUE}` : whole,
      );
  }
}

/**
 * Header names are case-insensitive; normalize to lower-case so a merge/compare is stable — and
 * REDACT while we do it. On the CDP/drive path `page.on('response')` sees the full response headers,
 * including `set-cookie` (the session credential), and requests carry `cookie`/`authorization`. These
 * were the one wire payload that reached the journal (cleartext, on disk) and the agent's context
 * window unredacted — every other capture goes through the SDK sanitizer or projectWireBody. A
 * credential HEADER is redacted whole by key; any other header value is still swept for known secret
 * SHAPES (a JWT echoed in a custom header), matching how request bodies are handled.
 */
function projectHeaders(
  headers: Record<string, string>,
  policy: RedactionPolicy,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    out[key] = policy.isSensitiveKey(key) ? REDACTED_VALUE : scrubKnownSecrets(v);
  }
  return out;
}

/**
 * Shape a raw authoritative response into a NET_DETAIL payload (lower-cased headers).
 *
 * `policy` defaults to the built-in rule so this stays a PURE builder — the driven-path union is
 * resolved by `attachNetworkDetail`, at the glue layer, where reading process state is not a lie
 * about the function's inputs.
 */
export function buildNetworkDetail(
  raw: {
    url: string;
    method?: string;
    status: number;
    headers: Record<string, string>;
    resourceType?: string;
    requestBody?: string;
    pageUrl?: string;
  },
  policy: RedactionPolicy = DEFAULT_POLICY,
): NetworkDetail {
  return {
    ...netUrlFields(raw.url, policy.isSensitiveKey),
    ...(raw.method === undefined ? {} : { method: raw.method }),
    status: raw.status,
    headers: projectHeaders(raw.headers, policy),
    ...(raw.resourceType === undefined ? {} : { resourceType: raw.resourceType }),
    ...(raw.requestBody === undefined || 0 === raw.requestBody.length
      ? {}
      : { requestBody: projectWireBody(raw.requestBody, policy) }),
    ...(raw.pageUrl === undefined || 0 === raw.pageUrl.length ? {} : { pageUrl: raw.pageUrl }),
  };
}

/**
 * The merge key: method plus the RAW url when the observation kept one, else the displayed url.
 *
 * Never the displayed url alone. The two sides redact independently, the SDK under the page's own
 * policy and this module under the daemon's, so the one field they were being compared on is the one
 * field redaction is allowed to rewrite. Keying on `urlForMatch` compares what was actually
 * requested, which is identical on both sides by construction.
 */
function keyOf(data: Record<string, unknown>): string {
  const method = data['method'];
  const m = 'string' === typeof method ? method.toUpperCase() : '';
  return `${m} ${urlForMatch(data)}`;
}

/**
 * Fold each NET_DETAIL onto the matching in-page NET_REQUEST (by method+url), enriching it with the
 * authoritative headers/resourceType the page-side wrapper couldn't see — WITHOUT clobbering fields the
 * in-page event already carries. A NET_DETAIL with no matching request is kept as its own event (a
 * response the wrapper missed is signal, never silently dropped). Pure over the event list.
 */
export function mergeNetworkDetail(events: readonly ReticleEvent[]): ReticleEvent[] {
  const requestByKey = new Map<string, ReticleEvent>();
  for (const e of events) {
    if (e.type === EventType.NET_REQUEST) requestByKey.set(keyOf(e.data), e);
  }
  const out: ReticleEvent[] = [];
  const enriched = new Map<ReticleEvent, ReticleEvent>();
  for (const e of events) {
    if (e.type === EventType.NET_DETAIL) {
      const match = requestByKey.get(keyOf(e.data));
      if (match === undefined) {
        out.push(e); // unmatched detail survives on its own
        continue;
      }
      const base = enriched.get(match) ?? match;
      const data = { ...base.data };
      if (data['headers'] === undefined && e.data['headers'] !== undefined) {
        data['headers'] = e.data['headers'];
      }
      if (data['resourceType'] === undefined && e.data['resourceType'] !== undefined) {
        data['resourceType'] = e.data['resourceType'];
      }
      // The ONLY field that overwrites rather than filling a gap. The in-page value is what the app
      // INTENDED to send; this is what actually went. When they disagree, the disagreement is the
      // finding — that is the whole reason for capturing it — so the authoritative one wins and the
      // divergence is flagged rather than silently resolved.
      const wireBody = e.data['requestBody'];
      if ('string' === typeof wireBody) {
        const pageBody = data['requestBody'];
        if ('string' === typeof pageBody && pageBody !== wireBody) {
          data['requestBodyDivergedFromPage'] = true;
        }
        data['requestBody'] = wireBody;
      }
      enriched.set(match, { ...base, data });
      continue; // the detail is absorbed into the request
    }
  }
  for (const e of events) {
    if (e.type === EventType.NET_DETAIL) continue; // handled above
    out.push(enriched.get(e) ?? e);
  }
  return out;
}

/** The minimal Playwright surfaces this attachment reads — kept structural so it's fake-testable. */
export interface ResponseLike {
  url(): string;
  status(): number;
  headers(): Record<string, string> | Promise<Record<string, string>>;
  request(): { method(): string; resourceType?(): string; postData?(): string | null };
}
export interface PageLike {
  url(): string;
  on(event: 'response', handler: (response: ResponseLike) => void): void;
}

/**
 * Attach a response listener to a driven page: every response becomes a NET_DETAIL via `emit`. Thin glue
 * over Playwright's event surface — the daemon routes `emit` to the driven session's pushEvent.
 */
export function attachNetworkDetail(page: PageLike, emit: (detail: NetworkDetail) => void): void {
  page.on('response', (response) => {
    const detailPromise = Promise.resolve(response.headers()).then((headers) => {
      const request = response.request();
      const resourceType = request.resourceType?.();
      // postData is null for GETs and for bodies the driver did not retain; both mean "nothing to say".
      const postData = request.postData?.() ?? null;
      emit(
        buildNetworkDetail(
          {
            url: response.url(),
            method: request.method(),
            status: response.status(),
            headers,
            ...(resourceType === undefined ? {} : { resourceType }),
            ...(null === postData ? {} : { requestBody: postData }),
            pageUrl: page.url(),
          },
          // Resolved per response, not per attachment: a session declaring extra keys can connect
          // after the listener is attached, and capturing the policy once would leave every
          // already-driven page redacting by the rule that was in force before the app said so.
          drivenRedactionPolicy(),
        ),
      );
    });
    // `response.headers()` REJECTS when the page/CDP session is closing — precisely when responses race
    // teardown (navigation, tab close). Without this catch the rejection floats; on the daemon path a
    // global unhandledRejection trap swallows it, but on the stdio `start()` path there is no trap, so
    // one late response would crash the whole MCP server. A detail we can't read is simply dropped.
    void detailPromise.catch(() => undefined);
  });
}
