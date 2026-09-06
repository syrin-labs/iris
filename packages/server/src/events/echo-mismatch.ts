import { ContradictionKind, EventType, MUTATING_METHODS, type ReticleEvent } from '@reticlehq/core';
import type { OwnContradiction } from './contradictions.js';

/**
 * A write that returned OK and quietly did not apply part of what it was asked to.
 *
 * Measured on a desktop preferences write: the request asked for `{density:'compact', locale:'fr'}`,
 * the response echoed `{"ok":true,"saved":{"density":"compact","locale":"en"}}`, the UI said
 * "Preferences saved", and every channel agreed. `locale` was silently discarded. Nothing above the
 * payload can see this — the status is 200, the body reports no failure, the UI advanced, the page
 * settled. It is a false green with the evidence already in hand.
 *
 * The shape is ordinary in real backends: a field not in the UPDATE statement, a schema that strips
 * unknown keys, a PATCH that honours a subset, an enum that falls back to a default.
 *
 * ## Why this is narrow on purpose
 *
 * Servers legitimately transform what they echo — trimming, lower-casing, rounding, canonicalising,
 * filling defaults, assigning ids and timestamps. A rule that flagged every echoed field that differs
 * would fire on healthy APIs constantly, and a contradiction kind that cries wolf gets filtered out
 * by the agents reading it, taking the true positives with it. So:
 *
 *  - only requests that are WRITES are considered. Reported from the field: a lookup that sends its
 *    key in the body (`POST /get-branding` with `{workspace_id}`) and gets a record back was graded
 *    as a half-applied write. The gate was on the RESPONSE being a success and never on the REQUEST
 *    being a write, so every successful call carrying a body read as a save — and the same key name
 *    legitimately means different things on the two sides of a request/response pair;
 *  - identity keys (`id`, `*_id`) and create sentinels (`0`, `""`, `null`) are not compared. A
 *    create that sends `sub_category_id: 0` and gets back `19314` assigned the row; two id spaces
 *    that share a field name were never expected to match. Both used to fire on every healthy POST;
 *  - only keys the request actually SENT are considered;
 *  - only scalars, since deep structural diffing is where the false positives live;
 *  - values are compared NORMALISED (trimmed, case-folded, numbers as numbers), so `FR` vs `fr` and
 *    `1` vs `1.0` stay silent while `fr` vs `en` speaks;
 *  - if the key appears anywhere in the response carrying the requested value, it is treated as
 *    applied — an envelope that echoes both the old and the new value is not a dropped write;
 *  - the response must look like a restatement of the request before any key is compared. Reported
 *    from the field: a command bus POSTed `{command:'chat.send', ...}` and the server answered with
 *    the current viewer snapshot. The message arrived over the socket and rendered. `id` in the
 *    snapshot meant the viewer, `id` in the request meant the message, and this kind fired. A
 *    snapshot that shares a key name is not an echo. A discriminator the request carries that the
 *    response does not, or a fat body that shares one coincidental key, is skipped. The existing
 *    single-value / not-echoed-at-all guards still trade false negatives away — this narrows on
 *    shape, not on value types.
 *
 * The residue after those filters is a field the caller set, the server echoed back, and the echoed
 * value is a genuinely different value. That is worth one line of an agent's attention.
 */

/** Bodies larger than this are skipped — a diff over a huge payload is neither cheap nor legible. */
const MAX_ECHO_KEYS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return 'object' === typeof value && value !== null && !Array.isArray(value);
}

/**
 * Any JSON value, not just an object. An HTTP write sends an object; an IPC call sends its ARGUMENT
 * LIST, so `savePrefs({locale})` arrives as `[{"locale":"fr"}]`. Requiring a top-level object here
 * silently excluded every desktop write from this check — the exact platform the finding came from.
 */
function parse(raw: unknown): unknown {
  if (typeof raw !== 'string' || 0 === raw.length) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Comparable form of a scalar. Non-scalars return undefined and are never compared. */
function normalize(value: unknown): string | undefined {
  if ('string' === typeof value) return value.trim().toLowerCase();
  if ('number' === typeof value) return Number.isFinite(value) ? String(value) : undefined;
  if ('boolean' === typeof value) return String(value);
  return undefined;
}

/**
 * Values that mean "server, you decide", not a field the caller asked to persist. A create that
 * sends `0` for the new row's id, or an empty string the backend fills in, is the usual REST shape
 * — not a dropped write.
 */
function isSentinelValue(value: unknown): boolean {
  return 0 === value || '' === value || null === value;
}

/**
 * Keys that name an identity, not a persisted attribute. The server assigns these (create returns a
 * new id; a public id and an internal row id share a field name). Comparing them as echoes is how
 * this kind fired on every healthy POST-create and poisoned later asserts in the same window.
 */
function isIdentityKey(key: string): boolean {
  const lower = key.toLowerCase();
  return 'id' === lower || lower.endsWith('_id');
}

/**
 * Every scalar value the response carries for each key, at any depth.
 *
 * Depth matters because the echo is usually nested — `{ok:true, saved:{...}}`, `{data:{...}}`,
 * `{result:{...}}` — and demanding the same path as the request would miss nearly every real API.
 * Collecting ALL values for a key is what makes the "echoes both old and new" case safe.
 */
function scalarsByKey(
  body: unknown,
  into: Map<string, Set<string>> = new Map(),
  depth = 0,
  omitSentinels = false,
): Map<string, Set<string>> {
  if (depth > 6 || into.size > MAX_ECHO_KEYS) return into;
  if (Array.isArray(body)) {
    for (const item of body) scalarsByKey(item, into, depth + 1, omitSentinels);
    return into;
  }
  if (!isRecord(body)) return into;
  for (const [key, value] of Object.entries(body)) {
    if (omitSentinels && isSentinelValue(value)) continue;
    const scalar = normalize(value);
    if (scalar === undefined) {
      scalarsByKey(value, into, depth + 1, omitSentinels);
      continue;
    }
    const seen = into.get(key) ?? new Set<string>();
    seen.add(scalar);
    into.set(key, seen);
  }
  return into;
}

const OK_MIN = 200;
const OK_MAX = 300;

/**
 * Body keys that name the operation rather than a field being persisted. A command bus puts one of
 * these on the request; a snapshot of the current viewer does not echo it. Their absence on the
 * response is the cheapest honest signal that the body is not a restatement of the write.
 */
const EchoDiscriminator = {
  COMMAND: 'command',
  ACTION: 'action',
  OP: 'op',
  PROCEDURE: 'procedure',
} as const;

/**
 * A response carrying this many times more scalar keys than the request, overlapping on fewer than
 * `MIN_SHARED_KEYS`, is a snapshot that happened to reuse a name — not an echo of the write.
 */
const SNAPSHOT_KEY_RATIO = 3;
const MIN_SHARED_KEYS = 2;

/**
 * True when the response looks like a restatement of the request, so overlapping key names can be
 * read as an echo rather than a coincidence.
 *
 * Half the request's comparable keys must appear in the response. That keeps a partial echo
 * (`{density, locale}` answered with only `locale`) in scope, and drops a three-field command whose
 * snapshot shares one name. A request that names an operation the response does not repeat is not
 * an echo at all, regardless of any other overlap.
 */
function responseRestatesRequest(
  asked: Map<string, Set<string>>,
  echoed: Map<string, Set<string>>,
): boolean {
  const comparable: string[] = [];
  for (const [key, wanted] of asked) {
    if (1 === wanted.size) comparable.push(key);
  }
  if (0 === comparable.length) return false;

  let present = 0;
  for (const key of comparable) {
    if (echoed.has(key)) present += 1;
  }

  let requestHasDiscriminator = false;
  let responseHasDiscriminator = false;
  for (const key of Object.values(EchoDiscriminator)) {
    if (asked.has(key)) requestHasDiscriminator = true;
    if (echoed.has(key)) responseHasDiscriminator = true;
  }
  if (requestHasDiscriminator && !responseHasDiscriminator) return false;

  if (echoed.size > comparable.length * SNAPSHOT_KEY_RATIO && present < MIN_SHARED_KEYS) {
    return false;
  }

  return present * 2 >= comparable.length;
}

/**
 * Contradictions for writes whose response echoes a different value than the request asked for.
 *
 * `actionSince` is the attribution floor `findContradictions` already keeps — the event time the
 * action that opened this window was dispatched. A finding about a request that had already settled
 * before the agent acted otherwise reads as a verdict on the change it just made.
 */
export function findEchoMismatches(
  events: readonly ReticleEvent[],
  actionSince?: number,
): OwnContradiction[] {
  const found: OwnContradiction[] = [];
  for (const event of events) {
    if (event.type !== EventType.NET_REQUEST) continue;
    // `MUTATING_METHODS` is the one definition of "is this a write" in the codebase — the same list
    // `contradictions.ts`'s `isMutating` reads. A read has no fields to half-apply.
    //
    // KNOWN LIMIT, stated because it is easy to read this fix as bigger than it is: POST is in that
    // list, so a lookup that POSTs its key and gets a record back — the shape actually reported —
    // still reaches the comparison below. Method is the only signal available here, and a read-shaped
    // POST is genuinely indistinguishable from a write by method alone.
    //
    // The tempting next step is to skip a pair whose JSON types disagree (a string key sent, a number
    // echoed). Deliberately not taken: that also silences `{"qty":"5"}` answered with `3`, which is a
    // real dropped write. A false negative here is a missed bug in someone's app, and that is not a
    // trade this file makes to quieten a false positive.
    const method = 'string' === typeof event.data['method'] ? event.data['method'] : '';
    if (!MUTATING_METHODS.includes(method.toUpperCase())) continue;
    // IPC reports `ok` rather than a status; HTTP reports a status. Either must say success — a write
    // that already failed is a different (and louder) finding than one that half-applied.
    const status = event.data['status'];
    const httpOk = 'number' === typeof status && status >= OK_MIN && status < OK_MAX;
    if (!httpOk && event.data['ok'] !== true) continue;

    const request = parse(event.data['requestBody']);
    const response = parse(event.data['responseBody']);
    if (request === undefined || response === undefined) continue;

    const echoed = scalarsByKey(response);
    const asked = scalarsByKey(request, new Map(), 0, true);
    if (!responseRestatesRequest(asked, echoed)) continue;
    const dropped: string[] = [];
    for (const [key, wanted] of asked) {
      // More than one requested value for a key (a before/after pair, a list of items) makes "what
      // was asked for" ambiguous, and a guess here is exactly how this kind would earn a reputation
      // for crying wolf.
      if (wanted.size !== 1) continue;
      if (isIdentityKey(key)) continue;
      const values = echoed.get(key);
      // Not echoed at all = no evidence either way. Only a key the server chose to report back can
      // contradict the request, and silence is not a contradiction.
      if (values === undefined || 0 === values.size) continue;
      const [want] = [...wanted];
      if (want !== undefined && !values.has(want))
        dropped.push(`${key}: asked ${want}, got ${[...values].join('/')}`);
    }
    if (0 === dropped.length) continue;

    const url = 'string' === typeof event.data['url'] ? event.data['url'] : '';
    const attribution =
      actionSince !== undefined && event.t < actionSince
        ? ' — this request completed before the action being verified, so the finding is not about that change'
        : '';
    found.push({
      kind: ContradictionKind.WRITE_FIELD_IGNORED,
      claim: 'the write returned success and the page treated it as saved',
      counter: `its own echo shows ${String(dropped.length)} field(s) that differ from the request — ${dropped.join('; ')}`,
      detail: `${method} ${url} — the server answered OK and returned a different value than it was asked to set${attribution}`,
    });
  }
  return found;
}
