/**
 * Shared bounds for numeric TOOL INPUTS.
 *
 * An unknown parameter is refused with "They were NOT applied — a result computed without them
 * would look like an answer." A known parameter carrying a value the code cannot honour is the
 * same failure: `reticle_state { depth: -5 }` used to return the full unscoped store, because
 * `capDepth` treats a negative budget as "no cap". The agent cannot tell a bound it asked for
 * from a bound that was dropped.
 *
 * A single rule for every number would be wrong (`since: 0` is a real cursor; `timeout_ms: 0`
 * on assert means evaluate now; `threshold` is a 0–1 ratio). Each helper below is one policy,
 * with the sentence for why that bound and not another.
 */
import { z } from 'zod';
import { RING_BUFFER_DEFAULTS, TRANSPORT_LIMITS } from '@reticlehq/core';

/**
 * Hard cap on "return the first N". The ring buffer holds this many events; asking for a billion
 * cannot be honoured from memory we do not keep, and would look like a complete listing.
 */
export const MAX_RESULT_COUNT = RING_BUFFER_DEFAULTS.MAX_EVENTS;

/**
 * Hard cap on a numeric millisecond argument that does NOT block the caller's request.
 * `timeout_ms: 0` stays legal — it means evaluate once, do not wait.
 */
export const MAX_TIMEOUT_MS = 120_000;

/**
 * Hard cap on a wait the CALLER BLOCKS ON, which is a different ceiling from the one above.
 *
 * A blocking wait is bounded by the client's patience, not by ours. The MCP SDK's default request
 * timeout is 60s and clients configure it lower; we advertised 120s. A caller who believed the
 * advertised bound and asked for 90s got a TRANSPORT error at 60s — not a Reticle verdict, not a
 * near-miss diagnosis, nothing to act on. The wait was honoured right up to the point where the
 * only thing that could report it had gone.
 *
 * So the ceiling is set below the SDK default rather than at it: the margin is what lets Reticle's
 * own "timed out, here is the near miss" answer beat the client's abort. A refused argument is a
 * bad ceiling costing one round trip; an accepted one that cannot be delivered costs the drive.
 *
 * This does not make long waits possible, and is not meant to — it makes the ADVERTISED bound one
 * that can actually be honoured. A caller that genuinely needs to outlast this polls: several short
 * waits, each of which returns a verdict. See #601 for the bounded-wait cursor that would let one
 * call do it properly.
 */
const MCP_SDK_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const MAX_BLOCKING_WAIT_MS = MCP_SDK_DEFAULT_REQUEST_TIMEOUT_MS - 5_000;

/**
 * `capDepth` at this many levels is already past any store an agent can read.
 *
 * Not lower: `numeric-args-are-bounded.test.ts` pins depth 50 as legal, because a large depth is a
 * SCOPE choice and not an error. A ceiling that refuses it would turn a working call into a refusal
 * in the name of bounding one that never worked.
 */
export const MAX_STATE_DEPTH = 256;

/** A crawl that clicks forever is not a bound. */
const MAX_CRAWL_STEPS = 500;

/** Scroll-to-find steps. Default is 20; hundreds is searching, thousands is a hang. */
export const MAX_SCROLLS = 200;

/** Fake-clock jump. One day of timers is a test; a billion ms is not. */
const MAX_ADVANCE_MS = 86_400_000;

/** Presenter idle window. One hour is a slow app; larger values never fire. */
const MAX_IDLE_MS = 3_600_000;

/** Viewport CSS px — matches the clamp the handler already applied, now as a refusal. */
export const MIN_VIEWPORT_PX = 64;
export const MAX_VIEWPORT_PX = 10_000;

/**
 * A page cursor. 0 is the start of the buffer, so `.positive()` would refuse a legitimate first
 * page. Negative is not a cursor.
 */
export const cursorSchema = z.number().finite().int().nonnegative();

/**
 * A wait budget in ms. 0 means evaluate now (documented on assert). Negative cannot be honoured.
 */
export const timeoutMsSchema = z.number().finite().int().nonnegative().max(MAX_BLOCKING_WAIT_MS);

/**
 * A count / cap. 0 means "return none", which is a real request. Negative is not.
 * Capped at the ring-buffer size so a `limit: 1e9` cannot pretend the buffer is larger than it is.
 */
export const countSchema = z.number().finite().int().nonnegative().max(MAX_RESULT_COUNT);

/**
 * Store projection depth. Negative used to mean "no cap" inside `capDepth`, which is how
 * `depth: -5` silently returned the full store — that is the defect this bound closes.
 *
 * 0 stays REFUSED, which is the policy already on the surface (a zero-level read is not a read).
 * `capDepth(v, 0)` does return a size marker, so accepting it would be defensible — but that is a
 * change to what the tool answers, not a bound on what it cannot honour, and it belongs in its own
 * change with its own reason.
 */
export const depthSchema = z.number().finite().int().positive().max(MAX_STATE_DEPTH);

/**
 * Pixel-diff ratios (`threshold`, `maxRatio`). pixelmatch's threshold and our pass ratio are both
 * 0..1; `.int()` would refuse 0.01.
 */
export const ratioSchema = z.number().finite().min(0).max(1);

/** HTTP status on a mock or a filter. */
export const httpStatusSchema = z.number().finite().int().min(100).max(599);

/** Viewport CSS px. `.int()` alone still accepted 5 and 999999, then the handler silently clamped. */
export const viewportPxSchema = z.number().finite().int().min(MIN_VIEWPORT_PX).max(MAX_VIEWPORT_PX);

/** Crawl / scroll step budgets. 0 is a documented no-op on crawl ("raise it to crawl at all"). */
export const stepCountSchema = z.number().finite().int().nonnegative().max(MAX_CRAWL_STEPS);

export const scrollCountSchema = z.number().finite().int().nonnegative().max(MAX_SCROLLS);

export const advanceMsSchema = z.number().finite().int().nonnegative().max(MAX_ADVANCE_MS);

export const idleMsSchema = z.number().finite().int().nonnegative().max(MAX_IDLE_MS);

/** Delay before a mocked response. 0 is immediate. */
export const delayMsSchema = z.number().finite().int().nonnegative().max(MAX_TIMEOUT_MS);

/**
 * Observe lookback. Must be > 0 — a non-positive window used to mint a FUTURE cursor, so the
 * tool returned zero events and looked like a quiet page. Capped so `window_ms: 1e12` cannot hang.
 */
export const windowMsSchema = z.number().finite().int().positive().max(MAX_TIMEOUT_MS);

/**
 * Parallelism for suite replay. 0 (and omit) means sequential. Capped at the session/pool ceiling;
 * asking for a thousand workers cannot be honoured.
 */
export const workerCountSchema = z
  .number()
  .finite()
  .int()
  .nonnegative()
  .max(TRANSPORT_LIMITS.MAX_SESSIONS);

/**
 * A row index / list length in a virtualized table. Those lists are large on purpose; the ring
 * buffer's 2000 is the wrong ceiling. A billion-row claim is not a list, it is a hang.
 */
const MAX_LIST_INDEX = 1_000_000;
export const listIndexSchema = z.number().finite().int().nonnegative().max(MAX_LIST_INDEX);
