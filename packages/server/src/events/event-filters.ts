import { EventType, URL_RAW, urlForMatch, type ReticleEvent } from '@reticlehq/core';
import { asString, asNumber } from '../tools/tools-helpers.js';
import { mergeNetworkDetail } from '../input/network-detail.js';

/**
 * The friendly bucket names reticle_observe's `filters` param advertises → the real event types.
 *
 * The schema promised `dom | net | route | console | animation | signal`, but the handler filtered
 * with `filters.includes(e.type)` against types like `net.request` and `dom.added` — so every
 * documented value matched nothing, and an agent passing `filters:['net']` to trim its payload got an
 * EMPTY timeline instead. Empty reads as "the app did nothing" — a false green produced by using the
 * feature exactly as documented. Mapping the bucket to its member types makes the documented values
 * work; raw types are still accepted (see eventMatchesFilters) so neither spelling surprises a caller.
 */
export const OBSERVE_FILTER_BUCKETS: Record<string, readonly string[]> = {
  dom: [EventType.DOM_ADDED, EventType.DOM_REMOVED, EventType.DOM_ATTR, EventType.DOM_TEXT],
  net: [EventType.NET_REQUEST, EventType.NET_PENDING, EventType.NET_STREAM],
  route: [EventType.ROUTE_CHANGE],
  console: [EventType.CONSOLE_ERROR, EventType.ERROR_UNCAUGHT],
  animation: [EventType.ANIM_START, EventType.ANIM_END],
  signal: [EventType.SIGNAL],
  // perf/state/storage are single-type buckets. They resolve through the raw-type fallback anyway,
  // but naming them keeps the advertised vocabulary and the real one identical — the mismatch between
  // those two is the bug this map exists to fix, so leaving observable types out of it would reopen it.
  perf: [EventType.PERF],
  state: [EventType.STATE_CHANGE],
  storage: [EventType.STORAGE_CHANGE],
};

/**
 * True when an event passes an observe `filters` allowlist. A filter entry matches either as a bucket
 * name (`net` keeps every net.* type) or as a raw event type (`net.request`). Unknown entries match
 * nothing rather than throwing — a typo narrows the result, it never crashes the observe.
 */
export function eventMatchesFilters(e: ReticleEvent, filters: readonly string[]): boolean {
  for (const f of filters) {
    // `Object.hasOwn`, not a bare index: a plain-object map inherits from Object.prototype, so a
    // filter value like "toString" or "hasOwnProperty" would resolve to the inherited FUNCTION and
    // then `.includes` would throw — a crash on an odd-but-harmless agent input. Only an OWN key is a
    // real bucket; anything else falls through to the raw-type comparison.
    const bucket = Object.hasOwn(OBSERVE_FILTER_BUCKETS, f) ? OBSERVE_FILTER_BUCKETS[f] : undefined;
    if (bucket !== undefined ? bucket.includes(e.type) : e.type === f) return true;
  }
  return false;
}

/**
 * Match a net.request event against optional method/url/status/ok filters (reticle_network).
 *
 * `ok` is the filter the tool's own description points at for desktop IPC, whose 200/500 is derived
 * rather than sent by any server. A still-PENDING call never matches an `ok` filter in either
 * direction: unresolved is not the same as failed, and answering "yes, it failed" about a request
 * still in flight is the false green this whole surface exists to prevent.
 */
export function matchNet(
  e: ReticleEvent,
  method: string | undefined,
  urlContains: string | undefined,
  status: number | undefined,
  ok?: boolean,
): boolean {
  const d = e.data;
  if (method !== undefined && asString(d['method'])?.toUpperCase() !== method.toUpperCase()) {
    return false;
  }
  if (urlContains !== undefined && !urlForMatch(d).includes(urlContains)) {
    return false;
  }
  if (status !== undefined && asNumber(d['status']) !== status) return false;
  if (ok !== undefined && d['ok'] !== ok) return false;
  return true;
}

/**
 * Reconcile network events into completed calls + still-in-flight calls. A NET_PENDING whose
 * `id` never gets a matching NET_REQUEST is an unresolved/hung request — the case
 * completion-only logging is blind to. Pending events are annotated `{ status: 'pending',
 * pending: true }` so a numeric `status` filter excludes them but `urlContains`/`method` match.
 */
export function reconcileNet(events: ReticleEvent[]): ReticleEvent[] {
  // Fold CDP-authoritative detail (driven path) onto the matching in-page request first, so the driven
  // view carries the full headers/status the page-side wrapper couldn't see (no-op when none present).
  events = mergeNetworkDetail(events);
  const completed = events.filter((e) => e.type === EventType.NET_REQUEST);
  const doneIds = new Set(
    completed.map((e) => asString(e.data['id'])).filter((id): id is string => id !== undefined),
  );
  const unresolved = events
    .filter((e) => {
      if (e.type !== EventType.NET_PENDING) return false;
      const id = asString(e.data['id']);
      return id === undefined || !doneIds.has(id);
    })
    .map((e): ReticleEvent => ({ ...e, data: { ...e.data, status: 'pending', pending: true } }));
  return [...completed, ...unresolved].sort((a, b) => a.t - b.t);
}

/**
 * Strip the grader-only raw URL before an event is rendered to the agent.
 *
 * `urlRaw` exists so `urlContains` can match a path redaction rewrote. It is a secret-bearing field
 * by construction (the whole reason `url` was redacted) and must never appear in observe, evidence,
 * or a network listing.
 */
export function withoutUrlRaw(event: unknown): unknown {
  if (typeof event !== 'object' || null === event) return event;
  const rec = event as Record<string, unknown>;
  const data = rec['data'];
  if (typeof data !== 'object' || null === data || !(URL_RAW in data)) return event;
  const { [URL_RAW]: _raw, ...rest } = data as Record<string, unknown>;
  return { ...rec, data: rest };
}

/** Compact network-call summary for reticle_network output — drops event plumbing (t, type,
 * sessionId, ref, id, initiator, ok) the agent never needs, keeping only method/url/status/ms.
 * This is the bulk of the token cost: raw ReticleEvent objects are ~5x larger than this. */
interface NetCallView {
  method: string;
  url: string;
  status?: number | string;
  statusText?: string;
  contentType?: string;
  responseSize?: number;
  requestBody?: string;
  responseBody?: string;
  bodyTruncated?: boolean;
  ms?: number;
  /** Authoritative response headers merged from the driven (CDP) path — present only when driven. */
  headers?: Record<string, string>;
  /**
   * A fire-and-forget desktop IPC send (`ipcRenderer.send`): dispatched, outcome unknowable.
   *
   * Carried into the projection on purpose. Such a record has no `status` and no `ok`, and without
   * this flag a reader has no way to tell "the outcome is unknown" from "the fields were dropped" —
   * which is the reading that turns an unverifiable call into an assumed success.
   */
  oneWay?: boolean;
}
export function projectNetCall(e: ReticleEvent, includeBodies = true): NetCallView {
  const status = e.data['status'];
  const ms = asNumber(e.data['durationMs']);
  const statusText = asString(e.data['statusText']);
  const contentType = asString(e.data['contentType']);
  const responseSize = asNumber(e.data['responseSize']);
  const requestBody = asString(e.data['requestBody']);
  const responseBody = asString(e.data['responseBody']);
  const view: NetCallView = {
    method: asString(e.data['method']) ?? '',
    url: asString(e.data['url']) ?? '',
  };
  if ('number' === typeof status || 'string' === typeof status) view.status = status;
  if (statusText !== undefined) view.statusText = statusText;
  if (contentType !== undefined) view.contentType = contentType;
  if (responseSize !== undefined) view.responseSize = responseSize;
  // Bodies dominate the payload of the most-called read tool, and are only occasionally the part
  // anyone wanted — `bodies: false` on reticle_network drops them for a body-free listing (#401).
  if (includeBodies && requestBody !== undefined) view.requestBody = requestBody;
  if (includeBodies && responseBody !== undefined) view.responseBody = responseBody;
  if (
    includeBodies &&
    (true === e.data['requestBodyTruncated'] || true === e.data['responseBodyTruncated'])
  ) {
    view.bodyTruncated = true;
  }
  if (ms !== undefined) view.ms = ms;
  if (true === e.data['oneWay']) view.oneWay = true;
  const headers = e.data['headers'];
  if (headers !== null && 'object' === typeof headers) {
    view.headers = headers as Record<string, string>;
  }
  return view;
}

/**
 * How many stack frames reach the agent.
 *
 * A raw stack is mostly framework internals, and padding a failure report with them is not free —
 * the frames that identify the origin are the first few, and everything after is context the agent
 * has to read past. Four keeps the error line plus the app frames that actually called it.
 */
const MAX_STACK_FRAMES = 4;

/** Trim a stack to the frames that locate the fault. */
function topFrames(stack: string): string {
  return stack.split('\n').slice(0, MAX_STACK_FRAMES).join('\n');
}

/**
 * Compact console-log summary for reticle_console output.
 *
 * `stack`/`source` are the only localization signal a console failure carries — there is no element
 * to map to a component here, so without them "an error was logged" is the whole report and the agent
 * has to go find the origin itself. The browser already keeps this lean by capturing a stack for
 * console.error only; the projection used to discard even that.
 */
interface ConsoleLogView {
  level: string;
  text: string;
  stack?: string;
  source?: string;
}
export function projectConsoleLog(e: ReticleEvent): ConsoleLogView {
  const level = e.type === EventType.ERROR_UNCAUGHT ? 'error' : e.type.replace('console.', '');
  const view: ConsoleLogView = { level, text: asString(e.data['message']) ?? '' };
  const stack = asString(e.data['stack']);
  if (stack !== undefined && stack.length > 0) view.stack = topFrames(stack);
  // An uncaught error reports its origin as discrete fields rather than in a stack; render them in
  // the same file:line form the element descriptors use so the agent reads one shape everywhere.
  const source = asString(e.data['source']);
  const line = e.data['line'];
  if (source !== undefined && source.length > 0) {
    view.source = 'number' === typeof line ? `${source}:${String(line)}` : source;
  }
  return view;
}

/** True for any console.* / uncaught-error event (the reticle_console universe). */
export function isConsoleEvent(e: ReticleEvent): boolean {
  return (
    e.type === EventType.CONSOLE_LOG ||
    e.type === EventType.CONSOLE_WARN ||
    e.type === EventType.CONSOLE_ERROR ||
    e.type === EventType.CONSOLE_INFO ||
    e.type === EventType.CONSOLE_DEBUG ||
    e.type === EventType.ERROR_UNCAUGHT
  );
}

/** Match a console/error event against an optional level filter (reticle_console). */
export function matchConsole(e: ReticleEvent, level: string | undefined): boolean {
  if (!isConsoleEvent(e)) return false;
  if (level === undefined) return true;
  return (
    e.type === `console.${level}` || ('error' === level && e.type === EventType.ERROR_UNCAUGHT)
  );
}

/** How many present calls/levels a zero-match hint samples before truncating. */
const HINT_SAMPLE_MAX = 5;

/** One present network call summarized for a zero-match hint. */
interface NetCallSummary {
  method: string;
  url: string;
  status?: number;
}

/**
 * Near-miss for reticle_network: when a filter matched zero calls, describe what DID fire so the
 * agent self-corrects ("POST /x 200 matched nothing, but these 3 requests happened") instead of
 * reading a bare []. `allNet` is every net.request in the window (pre-filter).
 */
interface NetEmptyHint {
  totalInWindow: number;
  /** Up to HINT_SAMPLE_MAX present calls (most-recent first). */
  present: NetCallSummary[];
}

export function netEmptyHint(allNet: ReticleEvent[]): NetEmptyHint {
  const present = allNet
    .slice(-HINT_SAMPLE_MAX)
    .reverse()
    .map((e): NetCallSummary => {
      const status = asNumber(e.data['status']);
      const base = { method: asString(e.data['method']) ?? '', url: asString(e.data['url']) ?? '' };
      return status === undefined ? base : { ...base, status };
    });
  return { totalInWindow: allNet.length, present };
}

/** Per-level console counts in the window — the body of a zero-match console hint. */
interface ConsoleLevelCounts {
  log: number;
  warn: number;
  error: number;
}

/**
 * Near-miss for reticle_console: when a level filter matched zero logs, report what levels ARE
 * present so the agent knows the page isn't silent ("0 errors, but 3 warns + 5 logs"). `allConsole`
 * is every console/error event in the window (pre-filter).
 */
interface ConsoleEmptyHint {
  totalInWindow: number;
  byLevel: ConsoleLevelCounts;
}

export function consoleEmptyHint(allConsole: ReticleEvent[]): ConsoleEmptyHint {
  const byLevel: ConsoleLevelCounts = { log: 0, warn: 0, error: 0 };
  for (const e of allConsole) {
    if (e.type === EventType.CONSOLE_LOG) byLevel.log += 1;
    else if (e.type === EventType.CONSOLE_WARN) byLevel.warn += 1;
    else if (e.type === EventType.CONSOLE_ERROR || e.type === EventType.ERROR_UNCAUGHT) {
      byLevel.error += 1;
    }
  }
  return { totalInWindow: allConsole.length, byLevel };
}
