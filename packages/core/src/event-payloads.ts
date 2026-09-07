import { z } from 'zod';
import { EventType, PerfMetric } from './constants.js';
import { BlindSpotKind } from './verified-constants.js';
import { BrowserBrand } from './telemetry-feedback.js';
import { HumanControlDataSchema, HumanMarkDataSchema } from './messages.js';

/**
 * Per-event-type payload schemas — the typed replacement for the envelope's open `data` record.
 * The envelope (`ReticleEventSchema.data`) stays open on the wire so a richer SDK is never rejected
 * mid-upgrade; narrowing happens here, at the server's inbound boundary and wherever the journal reads
 * an event's fields. `parseEventPayload` is that boundary.
 *
 * Two fidelity tiers by design:
 * - **Precise + closed** for stable observers (dom/route/perf/anim/scroll/signal/health/...).
 * - **Precise on the load-bearing fields + `.passthrough`** for observers / will enrich
 * (network, console, error, state, storage) — today's fields are validated, tomorrow's added
 * fields (stack, TTFB, initiator, path diffs) pass through instead of failing closed. Each closes
 * fully as its observer is rewritten.
 */

/**
 * Wire payload vocabularies. The browser observers EMIT these values and the schemas below VALIDATE
 * them, so a browser-side typo (`'SSE'`) would pass tsc and fail only here, at runtime. Each is a const
 * object — the browser imports the members, the schema derives its z.nativeEnum from the same object —
 * so emitter and validator are one source. Co-located with the schemas (kept constants.ts under its cap).
 */
/**
 * `FETCH` is a response whose BODY is still arriving after the request itself resolved.
 *
 * `fetch` settles at HEADERS, so a streamed response is reported complete while the server is still
 * writing. Measured on a Next.js App Router page: the RSC payload's NET_REQUEST landed 16 ms in, the
 * shell rendered, and the Suspense boundary's content arrived 889 ms later — a window in which
 * nothing at all was observed, so `settled` passed while the fallback was still on screen.
 */
export const StreamTransport = { SSE: 'sse', WS: 'ws', FETCH: 'fetch' } as const;
export type StreamTransport = (typeof StreamTransport)[keyof typeof StreamTransport];

/** `CLOSE` pairs with `OPEN`: until it arrives, the body is still being written. */
export const StreamDirection = { OPEN: 'open', IN: 'in', OUT: 'out', CLOSE: 'close' } as const;
export type StreamDirection = (typeof StreamDirection)[keyof typeof StreamDirection];

export const ScrollDirection = { UP: 'up', DOWN: 'down' } as const;
export type ScrollDirection = (typeof ScrollDirection)[keyof typeof ScrollDirection];

/**
 * The three readable client-side storage areas.
 *
 * `cookies` is plural because that is what the storage tool accepts, what the browser returns and
 * what the docs publish. This member read `cookie` for as long as it had no callers, which is
 * exactly how long a name can disagree with every use of it for free.
 */
export const StorageArea = { LOCAL: 'local', SESSION: 'session', COOKIE: 'cookies' } as const;
export type StorageArea = (typeof StorageArea)[keyof typeof StorageArea];

const elementLabel = z.object({ role: z.string().optional(), name: z.string().optional() });

/**
 * A file the app produced. `preview`/`lines` are present only when body capture is on, for the same
 * reason request bodies are gated: an export is exactly where a customer list lives.
 */
const downloadSchema = z
  .object({
    mimeType: z.string(),
    bytes: z.number(),
    filename: z.string().optional(),
    lines: z.number().optional(),
    preview: z.string().optional(),
    previewTruncated: z.boolean().optional(),
  })
  .passthrough();

const netStreamSchema = z
  .object({
    transport: z.nativeEnum(StreamTransport),
    direction: z.nativeEnum(StreamDirection),
    url: z.string(),
  })
  .passthrough();

const netRequestSchema = z
  .object({
    id: z.string(),
    method: z.string(),
    url: z.string(),
    status: z.number(),
    ok: z.boolean(),
    durationMs: z.number(),
    initiator: z.string(),
    urlRaw: z.string().optional(),
  })
  .passthrough();

const consoleSchema = z.object({ message: z.string() }).passthrough();

/**
 * The registry. `satisfies Record<EventType,...>` makes a missing event type a *compile* error —
 * the wire can never carry a type without a payload contract.
 */
export const EVENT_PAYLOAD_SCHEMAS = {
  [EventType.DOM_ADDED]: elementLabel,
  [EventType.DOM_REMOVED]: elementLabel,
  [EventType.DOM_ATTR]: z
    .object({ attr: z.string(), value: z.string().optional(), old: z.string().optional() })
    .passthrough(),
  [EventType.DOM_TEXT]: z.object({ text: z.string(), old: z.string().optional() }),
  [EventType.NET_REQUEST]: netRequestSchema,
  [EventType.NET_PENDING]: z.object({
    id: z.string(),
    method: z.string(),
    url: z.string(),
    initiator: z.string(),
    urlRaw: z.string().optional(),
  }),
  [EventType.NET_STREAM]: netStreamSchema,
  [EventType.DOWNLOAD]: downloadSchema,
  [EventType.PERF]: z.object({
    metric: z.nativeEnum(PerfMetric),
    value: z.number(),
    at: z.number(),
  }),
  [EventType.ROUTE_CHANGE]: z.object({
    from: z.string(),
    to: z.string(),
    pathname: z.string(),
    search: z.string(),
    hash: z.string(),
  }),
  [EventType.CONSOLE_LOG]: consoleSchema,
  [EventType.CONSOLE_WARN]: consoleSchema,
  [EventType.CONSOLE_ERROR]: consoleSchema,
  [EventType.CONSOLE_INFO]: consoleSchema,
  [EventType.CONSOLE_DEBUG]: consoleSchema,
  [EventType.ERROR_UNCAUGHT]: z
    .object({
      message: z.string(),
      source: z.string().optional(),
      line: z.number().optional(),
      kind: z.string().optional(),
    })
    .passthrough(),
  [EventType.VISIBLE_SHOWN]: elementLabel,
  [EventType.ANIM_START]: z.object({ name: z.string() }),
  [EventType.ANIM_END]: z.object({ name: z.string() }),
  [EventType.SCROLL_POSITION]: z.object({
    x: z.number(),
    y: z.number(),
    percent: z.number(),
    direction: z.nativeEnum(ScrollDirection),
  }),
  [EventType.REVEAL_SHOWN]: elementLabel.passthrough(),
  [EventType.SIGNAL]: z.object({ name: z.string(), data: z.unknown().optional() }),
  [EventType.STATE_CHANGE]: z.object({ name: z.string(), value: z.unknown() }).passthrough(),
  [EventType.STORAGE_CHANGE]: z.object({
    area: z.nativeEnum(StorageArea),
    key: z.string(),
    old: z.string().optional(),
    new: z.string().optional(),
  }),
  [EventType.PAGE_HEALTH]: z
    .object({
      hidden: z.boolean(),
      focused: z.boolean(),
      reason: z.string().optional(),
      /**
       * Which browser the page is, normalised in the SDK to a closed list before it is sent — never
       * a UA string and never a raw `userAgentData` brand. Optional: an older SDK does not report
       * one, and a desktop webview has no brand to report.
       */
      brand: z.nativeEnum(BrowserBrand).optional(),
    })
    .passthrough(),
  // The page called window.open — the clicked consequence may continue in a context the SDK cannot
  // enter (#508). `href` is what the page asked to open, omitted for the blank-tab form.
  [EventType.CONTEXT_OPENED]: z.object({ href: z.string().optional() }).passthrough(),
  [EventType.RENDER_COMMIT]: z.object({ commits: z.number() }),
  [EventType.FOCUS_CHANGE]: z.object({
    to: z.string().optional(),
    from: z.string().optional(),
    toBody: z.boolean(),
  }),
  [EventType.FLOW_RECORDED]: z.object({ name: z.string(), flow: z.unknown() }),
  [EventType.TRANSPORT_OVERFLOW]: z.object({ dropped: z.number() }),
  [EventType.TRUNCATED]: z.object({ channel: z.string(), dropped: z.number() }),
  [EventType.BLIND_SPOT]: z.object({ kind: z.nativeEnum(BlindSpotKind), count: z.number() }),
  [EventType.SDK_FAILED]: z.object({
    /** WHERE in the SDK — a fixed vocabulary of our own module names, never a user path. */
    site: z.string().max(64),
    /** The error message. Stripped of variables server-side before it is ever reported onward. */
    message: z.string().max(500),
    errorType: z.string().max(64).optional(),
  }),
  [EventType.NET_DETAIL]: z
    .object({
      url: z.string(),
      method: z.string().optional(),
      status: z.number(),
      headers: z.record(z.string()),
      resourceType: z.string().optional(),
    })
    .passthrough(),
  [EventType.HUMAN_CONTROL]: HumanControlDataSchema,
  [EventType.HUMAN_MARK]: HumanMarkDataSchema,
} satisfies Record<EventType, z.ZodTypeAny>;

/** Narrow an event's `data` against its type's payload schema. Unknown in, typed-or-error out. */
export function parseEventPayload(
  type: EventType,
  data: unknown,
): z.SafeParseReturnType<unknown, unknown> {
  return EVENT_PAYLOAD_SCHEMAS[type].safeParse(data);
}
