import {
  EventType,
  PredicateKind,
  StreamDirection,
  isDevToolingUrl,
  urlForMatch,
  REDACTED_VALUE,
  type ReticleEvent,
} from '@reticlehq/core';
import { describeObserved } from './observed-in-window.js';
import { withoutUrlRaw } from './event-filters.js';
import type { Predicate } from './predicate-schema.js';

// The predicate SHAPE — the discriminated union, its aliases and its zod schema — lives in
// predicate-schema.ts. Re-exported here so every existing importer of this module is unaffected:
// the two halves are one public surface, split only because the file outgrew the size backstop.
export * from './predicate-schema.js';

export interface EvalResult {
  pass: boolean;
  /**
   * For a TIME-based failure: how long until this predicate could first become true, if nothing else
   * changes. Purely a scheduling hint for `waitForPredicate` — it replaces a blind poll tick with one
   * timed to the moment that matters, and never decides anything. Absent when the wait is on an
   * external event (a request in flight settles when the server answers, not on a clock).
   */
  retryAfterMs?: number;
  /**
   * Set when the assertion could not be EVALUATED — the call was under-specified or there was
   * nothing instrumented to read — rather than evaluated and found false. Carries the sentence that
   * names what is missing.
   *
   * `pass` stays false because nothing was proven, but a false that nobody could have made true is
   * not a defect in the user's app, and reporting it as one puts agent mistakes into the bug count.
   */
  inconclusive?: string;
  /**
   * No later event in this window can change this answer, so waiting out the rest of the budget
   * buys nothing.
   *
   * Set ONLY where that is provable, which is rarer than it looks. "The toast never appeared" is not
   * decided — it is only knowable when the budget ends, and ending early there would manufacture the
   * false negative the budget exists to prevent. Exact cardinality IS decided once exceeded, because
   * a window only accumulates matches and a count cannot come back down.
   *
   * A scheduling fact, never a verdict: `pass` already says what the answer is, and this only says
   * that it is final.
   */
  decided?: boolean;
  evidence?: unknown;
  failureReason?: string;
  /**
   * The wait ended because the TAB went away, not because the app did anything observable.
   *
   * A sibling of `inconclusive` and for the same reason: `pass` is false because nothing was
   * proven, but nobody could have made it true, so grading it as a defect in the user's app is a
   * false claim. Without this the verdict rule saw only `pass: false` and answered
   * `assertion_failed` — "the declared consequence did not hold" — naming the component the agent
   * had just clicked. See VerifiedReason.OBSERVATION_LOST.
   */
  observationLost?: boolean;
  /**
   * The failure, structured — what was seen, what was required, and which oracle judged it.
   *
   * `failureReason` says the same thing in prose, and prose is the WRONG shape for this: measured on
   * three seeded bugs, an agent handed observed/expected/assertion alongside the source pointer used
   * fewer tool calls than one handed the pointer alone, and the repair literature has structured
   * feedback beating rich natural-language feedback by 10.5pp. The prose stays for humans reading a
   * log; these three fields are for the agent.
   *
   * Optional because they are populated per oracle, not globally — see the note in predicate.ts on
   * which classes carry them today.
   */
  observed?: string;
  expected?: string;
  assertion?: string;
}

export function str(value: unknown): string | undefined {
  return 'string' === typeof value ? value : undefined;
}
function num(value: unknown): number | undefined {
  return 'number' === typeof value ? value : undefined;
}

/**
 * Match one value against a pattern. Supports `*` (present), strict equality, and operators:
 * `{$gte,$lte,$gt,$lt}` (numbers), `{$contains}` (array membership or substring), `{$length}`.
 */
export function matchValue(got: unknown, want: unknown): boolean {
  if ('*' === want) return got !== undefined;
  // An object is an OPERATOR container only if it actually carries a `$`-prefixed operator. An empty
  // `{}` (or an object with no `$` key) used to enter this branch, iterate zero recognized operators,
  // and `return true` — so `equals: {}` / `dataMatches: {status: {}}` was a green assertion that
  // passed against ANYTHING, undefined included: the exact false green the oracle exists to catch.
  // Without an operator it is a literal to compare, and falls through to strict equality below.
  const ops =
    'object' === typeof want && want !== null && !Array.isArray(want)
      ? Object.entries(want as Record<string, unknown>)
      : undefined;
  if (ops !== undefined && ops.some(([op]) => op.startsWith('$'))) {
    for (const [op, val] of ops) {
      const n = 'number' === typeof got ? got : NaN;
      switch (op) {
        case '$gte':
          if (!(n >= (val as number))) return false;
          break;
        case '$lte':
          if (!(n <= (val as number))) return false;
          break;
        case '$gt':
          if (!(n > (val as number))) return false;
          break;
        case '$lt':
          if (!(n < (val as number))) return false;
          break;
        case '$contains':
          if (Array.isArray(got)) {
            if (!got.includes(val)) return false;
          } else if ('string' === typeof got) {
            if (!got.includes(String(val))) return false;
          } else {
            return false;
          }
          break;
        case '$length':
          if (!((Array.isArray(got) || 'string' === typeof got) && got.length === val)) {
            return false;
          }
          break;
        default:
          return false;
      }
    }
    return true;
  }
  return structurallyEqual(got, want);
}

/**
 * Value equality for the leaf comparison, because `===` could never match a literal.
 *
 * The expected side of a predicate is parsed out of the agent's JSON, so it is a fresh object every
 * time — reference equality made `equals: ["a", "b"]` false against a store holding exactly
 * `["a", "b"]`, and there was no value of the app's state that could have made it true. The mirror of
 * a false green: an assertion nobody could satisfy, on the commonest thing there is to assert about.
 *
 * Deliberately strict about shape. An array is not an object, an extra key is a difference, and order
 * is part of a list's value — `equals` means equals; `dataMatches` is the field-by-field one.
 */
function structurallyEqual(got: unknown, want: unknown): boolean {
  if (got === want) return true;
  if (null === got || null === want) return false;
  if ('object' !== typeof got || 'object' !== typeof want) return false;
  if (Array.isArray(got) !== Array.isArray(want)) return false;
  if (Array.isArray(got) && Array.isArray(want)) {
    return got.length === want.length && got.every((v, i) => structurallyEqual(v, want[i]));
  }
  const a = got as Record<string, unknown>;
  const b = want as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => k in b && structurallyEqual(a[k], b[k]));
}

/** Shallow JSON pattern match: each key in `pattern` must match (see matchValue). */
function dataMatches(actual: Record<string, unknown>, pattern: Record<string, unknown>): boolean {
  for (const [key, want] of Object.entries(pattern)) {
    if (!matchValue(actual[key], want)) return false;
  }
  return true;
}

/**
 * Did this call succeed, as the app experienced it?
 *
 * `ok` is authoritative when present — IPC sets it explicitly, because an IPC call has no status
 * code and the 200/500 Reticle derives is a convenience, not a fact. Falling back to the HTTP status
 * keeps ordinary web requests working without the observer having to set the field everywhere.
 *
 * This exists so an agent can assert on the OUTCOME rather than on a number Reticle invented.
 */
function callSucceeded(data: Record<string, unknown>): boolean {
  if ('boolean' === typeof data['ok']) return data['ok'];
  const status = num(data['status']);
  return status === undefined || status < 400;
}

/**
 * One call, as the failure report should name it: `POST /api/generate-script → 500`.
 *
 * The status used to be dropped here, which made the most common net failure unreadable. Asserting
 * `{status: 200}` against a call that returned 500 reported only `POST /api/generate-script` — the
 * very field the predicate filtered on was missing from the account of what was seen, so the agent
 * is told the call happened and left to guess why it did not match.
 *
 * The arrow is OMITTED when there is no status. An in-flight or aborted request genuinely has none,
 * and `→ undefined` would be a fabricated fact about the wire.
 */
function describeCall(e: ReticleEvent): string {
  const head = `${str(e.data['method']) ?? 'GET'} ${str(e.data['url']) ?? ''}`;
  const status = num(e.data['status']);
  return status === undefined ? head : `${head} → ${String(status)}`;
}

/**
 * What a miss should say when the displayed URL was redacted. Matching uses `urlRaw` when present;
 * an older SDK has no copy, and this is the sentence both reporters asked for.
 */
const REDACTED_PATH_HINT =
  'this path segment was redacted — the literal you matched may be here, try bodyContains';

function observedNetCalls(
  events: readonly ReticleEvent[],
  urlContains: string | undefined,
): string {
  const calls = events.filter((e) => e.type === EventType.NET_REQUEST);
  const base = describeObserved('calls', calls.map(describeCall));
  if (urlContains === undefined) return base;
  const encoded = encodeURIComponent(REDACTED_VALUE);
  const redacted = calls.some((e) => {
    const url = str(e.data['url']) ?? '';
    return url.includes(REDACTED_VALUE) || url.includes(encoded);
  });
  return redacted ? `${base}; ${REDACTED_PATH_HINT}` : base;
}

function netEvidence(data: Record<string, unknown>): unknown {
  return (withoutUrlRaw({ data }) as { data: unknown }).data;
}

/**
 * How much of a response body a failure may quote. Enough to see the value that differed on the
 * bodies this field is used against (a JSON answer), and not a whole payload in every verdict.
 */
const MAX_BODY_IN_FAILURE = 200;

/** Enough of a body to see what differed, without paying for a whole payload in the verdict. */
function clipBody(body: string): string {
  return body.length <= MAX_BODY_IN_FAILURE ? body : `${body.slice(0, MAX_BODY_IN_FAILURE)}…`;
}

/**
 * The filter as APPLIED, every field of it.
 *
 * The count failure used to print `{method, urlContains, status}` while `ok` and `bodyContains` were
 * applied too, so the caller was shown a predicate it had not written and told nothing matched it.
 * A printed filter that is narrower than the real one is worse than none: it is believed.
 */
function describeNetFilter(p: Extract<Predicate, { kind: typeof PredicateKind.NET }>): string {
  const { kind: _kind, count: _count, since: _since, ...filter } = p;
  return JSON.stringify(filter);
}

/** Same, for a signal: the matcher as applied, with the cardinality and the floor taken out. */
function describeSignalFilter(
  p: Extract<Predicate, { kind: typeof PredicateKind.SIGNAL }>,
): string {
  const { kind: _kind, count: _count, since: _since, ...filter } = p;
  return JSON.stringify(filter);
}

/**
 * Exact cardinality, once, for every channel that can count its matches.
 *
 * `net` and `signal` are the same assertion over different evidence — "this happened EXACTLY n
 * times" — and the interesting half is the same on both: an over-count is `decided`, because a
 * window only accumulates and a count cannot come back down, so waiting out the rest of the budget
 * to report a double-fire buys nothing but latency.
 *
 * `noun` names the population in prose ("network call(s)", "signal(s)"), `filter` is the matcher as
 * applied, and `assertion` is the oracle that judged it.
 */
function evalExactCount(args: {
  matched: number;
  want: number;
  noun: string;
  filter: string;
  assertion: string;
}): EvalResult {
  const { matched, want, noun, filter, assertion } = args;
  if (matched === want) return { pass: true, evidence: { matched } };
  return {
    pass: false,
    ...(matched > want ? { decided: true } : {}),
    failureReason: `expected ${String(want)} ${noun} matching ${filter}, saw ${String(matched)}`,
    observed: `${String(matched)} matching ${noun}`,
    expected: `exactly ${String(want)} matching ${filter}`,
    assertion,
  };
}

/**
 * URL suffixes only the DOCUMENT fetches, which the network observer therefore never records.
 *
 * `network.ts` patches `fetch` and `XMLHttpRequest` and nothing else, so `<link rel=icon>`,
 * `<link rel=manifest>`, stylesheets, fonts and `<img src>` are invisible to it. "No matching call"
 * and "that class of call is not observed" are then indistinguishable, and the miss graded
 * `assertion_failed` — a false RED. Reported from the field: an assert over `/favicon.ico`,
 * `/site.webmanifest` and `/apple-touch-icon.png` returned `verified:"no"` while curl showed all
 * three answering 200. A false negative here is worse than an unknown, because an agent that trusts
 * it goes and "fixes" working code.
 *
 * Deliberately NOT here: `.js` and `.json`. Both are routinely fetched via `fetch`/XHR — a module
 * preload and an API call can share a suffix — so downgrading them would hide real misses. This list
 * is only the suffixes for which the document is the sole plausible initiator.
 *
 * This began as the smaller half of #447: it did not make these requests observable, it stopped
 * Reticle claiming they did not happen. The other half, observing them via resource timing, has
 * since landed in the browser SDK, so the two halves are no longer independent and this downgrade is
 * now GATED: when the event stream carries at least one document-initiated record, the observer is
 * demonstrably live and a miss over these suffixes is real evidence, graded a plain failure. Only a
 * page whose stream holds no resource entry at all keeps the honest "cannot tell apart" answer,
 * because there the observer may simply not exist.
 */
const DOCUMENT_ONLY_SUFFIXES: readonly string[] = [
  '.ico',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.avif',
  '.bmp',
  '.css',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.webmanifest',
];

/**
 * Does this filter target a class of request the observer cannot see?
 *
 * Read off `urlContains` only, and only when the pattern ENDS in one of the suffixes — a filter of
 * `/api/` that happens to contain `.css` somewhere in a query string is still an ordinary XHR
 * target. Query strings and fragments are stripped first, since `favicon.ico?v=2` is the same asset.
 */
function targetsUnobservedChannel(
  p: Extract<Predicate, { kind: typeof PredicateKind.NET }>,
): boolean {
  if (p.urlContains === undefined) return false;
  const path = (p.urlContains.split('#')[0] ?? '').split('?')[0]?.toLowerCase() ?? '';
  return DOCUMENT_ONLY_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/**
 * Initiator types the browser SDK's resource-timing observer stamps onto document-initiated records
 * (packages/browser/src/observers/network.ts). The patched transports sign themselves `fetch`,
 * `xhr` or `beacon`, so any NET_REQUEST carrying one of these came from a `resource` entry, and its
 * mere presence is proof the PerformanceObserver is alive on this page. Mirrors the wire; keep in
 * sync with the browser package.
 */
const DOCUMENT_INITIATORS: ReadonlySet<string> = new Set([
  'link',
  'css',
  'img',
  'script',
  'manifest',
  'other',
]);

/**
 * Did the observer actually report a document-initiated load?
 *
 * This is the gate on the unobserved-channel downgrade above. Once subresource observation landed,
 * a miss over `.ico`/`.css`/`.woff2` is no longer inherently unknowable: if the observer is live it
 * would have seen the favicon load, so seeing none is evidence it never fired. But the observer is
 * opt-in-by-engine, not guaranteed: on a renderer without `PerformanceObserver` (or before any
 * resource entry exists) nothing distinguishes "not requested" from "not visible", and the honest
 * answer stays inconclusive. Liveness is inferred from the same events being judged: one
 * document-initiated record anywhere in the window proves the channel works.
 */
function observerSawSubresources(events: ReticleEvent[]): boolean {
  return events.some((e) => {
    if (e.type !== EventType.NET_REQUEST) return false;
    const initiator = str(e.data['initiator']);
    return initiator !== undefined && DOCUMENT_INITIATORS.has(initiator);
  });
}

/** The sentence both zero-match branches hand to `inconclusive`. */
function unobservedChannelReason(
  p: Extract<Predicate, { kind: typeof PredicateKind.NET }>,
): string {
  return (
    `no call matched ${describeNetFilter(p)}, and no document-initiated load was recorded either, ` +
    `so this page exposed no resource timing to read: Reticle observes fetch and XMLHttpRequest ` +
    `directly, while a request the document initiates (<link rel=icon|manifest|preload>, a ` +
    `stylesheet, a font, <img src>) leaves no record, and that state cannot be told apart from the ` +
    `request having been made. ` +
    `Nothing here says the app is wrong. Check it outside the browser, or assert something the ` +
    `document does not fetch on its own`
  );
}

/**
 * Appended to a zero-match `net` negative whose window starts at SDK attach.
 *
 * Every event's `t` is stamped `performance.now() - #start`, where `#start` is taken when the SDK
 * is constructed, so `t` is never negative and a window with `since === 0` begins AT attach — never
 * before it. Whatever the page did between navigation start and attach left no event at all, so
 * "no matching call" over such a window cannot be told apart from "the call was made while nothing
 * was watching yet".
 *
 * The gap is routine rather than exotic: a `fetch` from an effect in a root provider, or a classic
 * `<script>` at the end of `<body>`, fires before a deferred module script has run. Reported from
 * the field, the verdict then read as proof the request was never made, and reporters went looking
 * for the defect in code that was working — restarting dev servers and re-reading providers to
 * establish the request was invisible rather than absent.
 *
 * Same argument as DOCUMENT_ONLY_SUFFIXES one axis over: that one is a channel Reticle does not
 * watch, this is a stretch of TIME it was not yet watching.
 *
 * The grade is deliberately NOT downgraded to `inconclusive`. A missing API call is the finding this
 * oracle exists to make, and it is the strongest grade available for the startup class — session
 * restore, feature flags, bootstrap config — which is exactly the class that silently breaks on
 * reload. Every window an action opens carries `since > 0` and is untouched. What changes is only
 * what the negative CLAIMS: it stops asserting the request never happened, and names the assertion
 * that can settle it, because the state such a request produces IS observable after attach.
 */
const PRE_ATTACH_CAVEAT =
  ' — note that this window starts where the SDK attached, and requests made before that are never ' +
  'captured, so a miss here cannot tell a call that was never made apart from one made before the ' +
  'page connected; if the call is expected during startup, assert on the state it produces instead';

export function evalNet(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: typeof PredicateKind.NET }>,
): EvalResult {
  const since = p.since ?? 0;
  /**
   * Computed once: the gate every zero-match downgrade below reads. True means the resource-timing
   * observer is demonstrably live in this window, so a miss is evidence rather than blindness.
   */
  const sawSubresources = observerSawSubresources(events);
  /**
   * Did any call match everything EXCEPT the body assertion, while carrying no recorded body?
   *
   * Bodies are opt-in, so without them a body predicate can never hold — and "no call matched" would
   * send the caller to check the url and the method, which are both fine, instead of to the one
   * setting that makes the assertion possible. Tracked while filtering rather than recomputed after,
   * because it is the same pass over the same events.
   */
  let matchedButUnrecorded = false;
  /** A call matched url/method but carried NO readable status (document-initiated subresource). */
  let unobservableStatus = false;
  /**
   * The response body of a call that matched everything EXCEPT the body assertion, and HAD one.
   *
   * Reported by the first field user of `bodyContains`: a body mismatch was formatted as
   * "expected 1 network call(s) matching {method, urlContains, status}, saw 0" — the body assertion
   * was applied but not printed — so the verdict read "the request never fired" and sent them hunting
   * a UI wiring bug that did not exist, when the defect was the value the server answered with.
   */
  let bodyMismatch: string | undefined;
  /**
   * The prefix of a TRUNCATED body the needle was not found in. Held apart from `bodyMismatch`
   * because the two are different verdicts: a full body without the needle decides the assertion,
   * a truncated one cannot (#614).
   */
  let truncatedBody: string | undefined;
  const matches = events.filter((e) => {
    if (e.type !== EventType.NET_REQUEST || e.t < since) return false;
    const d = e.data;
    if (p.method !== undefined && str(d['method'])?.toUpperCase() !== p.method.toUpperCase()) {
      return false;
    }
    if (p.urlContains !== undefined && !urlForMatch(d).includes(p.urlContains)) {
      return false;
    }
    if (p.status !== undefined) {
      const status = num(d['status']);
      if (status === undefined) {
        // Document-initiated subresources (link/css/img/manifest via resource timing) carry no
        // readable status on engines without responseStatus. A failed assertion here would read
        // "your change is broken" and send the caller to fix working code — the exact false
        // negative the oracle exists to prevent. Downgrade to unknown instead.
        unobservableStatus = true;
        return false;
      }
      if (status !== p.status) return false;
    }
    if (p.ok !== undefined && callSucceeded(d) !== p.ok) return false;
    if (p.bodyContains !== undefined) {
      // The RESPONSE body only, and this is the whole point of the field. Searching the request too
      // would let `bodyContains: "1187.01"` pass on the very defect it exists to catch: the app SENT
      // that number, so it is in the request whatever the server then did with it. The server's answer
      // is the one channel a UI cannot fake.
      const response = str(d['responseBody']);
      if (response === undefined) {
        matchedButUnrecorded = true;
        return false;
      }
      if (!response.includes(p.bodyContains)) {
        // A needle missing from a body we only hold the FIRST N BYTES of is undecidable, not
        // absent: the rest of the response was never recorded, so nothing here can say whether it
        // was in there (#614). Grading it `pass: false` with "the response value is what differed"
        // is the inversion the honesty rules exist to prevent — an unknown reported as decided,
        // against a response that was very likely correct.
        if (true === d['responseBodyTruncated']) {
          truncatedBody ??= response;
          return false;
        }
        bodyMismatch ??= response;
        return false;
      }
    }
    return true;
  });
  if (unobservableStatus && 0 === matches.length) {
    // The url/method matched a document-initiated subresource whose engine could not read a status.
    // "No matching call" would be a lie in both directions: it may have succeeded, it may have 404'd
    // on exactly the path mistake the caller is hunting. Say the truth — not observable here.
    return {
      pass: false,
      inconclusive: `a document-initiated request matching ${describeNetFilter(p)} was observed, but this engine does not expose its status code (resource timing without responseStatus) — assert on the element or route instead, or check the network tab`,
      observed: 'a matching request with no readable status',
      expected: `a status of ${String(p.status)} on ${JSON.stringify(p.urlContains ?? '*')}`,
      assertion: 'net.unobservable-status',
    };
  }
  if (matchedButUnrecorded && 0 === matches.length) {
    return {
      pass: false,
      failureReason: `a call matched but its body was not recorded, so \`bodyContains\` could not be checked — enable it where the app calls connect(): reticle({ captureNetworkBodies: true })`,
      observed: 'a matching call with no recorded body',
      expected: `a body containing ${JSON.stringify(p.bodyContains)}`,
      assertion: 'net.bodyContains',
    };
  }
  // Ranked ABOVE the mismatch branch: when both a truncated and a full body missed the needle,
  // the honest verdict is the undecidable one. Deciding on the full body would report a failure
  // the truncated call may well contradict.
  if (truncatedBody !== undefined && 0 === matches.length) {
    return {
      pass: false,
      inconclusive: `a call matching ${describeNetFilter(p)} was answered with a body that was TRUNCATED before it was recorded, and ${JSON.stringify(p.bodyContains)} is not in the part that was kept — so this is undecidable, not a failure. Raise the capture cap or assert on something inside the recorded prefix`,
      observed: `the first ${String(truncatedBody.length)} characters of a truncated response body ${JSON.stringify(clipBody(truncatedBody))}`,
      expected: `a response body containing ${JSON.stringify(p.bodyContains)}`,
      assertion: 'net.bodyContains',
    };
  }
  if (bodyMismatch !== undefined && 0 === matches.length) {
    // The call is there and its body is there; only the VALUE differs. Counting it as zero matches
    // points at the wiring, which is the one place the defect is not.
    return {
      pass: false,
      failureReason: `a call matching ${describeNetFilter(p)} was made and answered ${JSON.stringify(clipBody(bodyMismatch))}, which does not contain ${JSON.stringify(p.bodyContains)} — the request fired, the response value is what differed`,
      observed: `response body ${JSON.stringify(clipBody(bodyMismatch))}`,
      expected: `a response body containing ${JSON.stringify(p.bodyContains)}`,
      assertion: 'net.bodyContains',
    };
  }
  // `count` (exact) turns presence into a cardinality assertion — catches the double-submit /
  // useEffect-double-fire / retry-storm regression class, where the request DID fire (presence passes)
  // but fired the WRONG number of times. Without `count`, the matcher is presence-only (≥1).
  if (p.count !== undefined) {
    if (
      matches.length !== p.count &&
      0 === matches.length &&
      targetsUnobservedChannel(p) &&
      !sawSubresources
    ) {
      return {
        pass: false,
        failureReason: unobservedChannelReason(p),
        inconclusive: unobservedChannelReason(p),
        assertion: 'net.count',
      };
    }
    const counted = evalExactCount({
      matched: matches.length,
      want: p.count,
      noun: 'network call(s)',
      filter: describeNetFilter(p),
      assertion: 'net.count',
    });
    // Same blind head, second door: "saw 0" over a whole-session window is the same claim the
    // presence branch makes, and just as unable to see a startup call. A `count: 0` assertion is
    // left alone on purpose — it PASSES here, and turning that green into a non-pass is a grade
    // change, not a wording one.
    return 0 === matches.length && 0 === since && counted.failureReason !== undefined
      ? { ...counted, failureReason: `${counted.failureReason}${PRE_ATTACH_CAVEAT}` }
      : counted;
  }
  const hit = matches[0];
  if (hit === undefined && targetsUnobservedChannel(p) && !sawSubresources) {
    const reason = unobservedChannelReason(p);
    return {
      pass: false,
      failureReason: reason,
      inconclusive: reason,
      observed: observedNetCalls(events, p.urlContains),
      expected: `at least one call matching ${describeNetFilter(p)}`,
      assertion: 'net.unobserved-channel',
    };
  }
  return hit !== undefined
    ? { pass: true, evidence: netEvidence(hit.data) }
    : {
        pass: false,
        failureReason: `no network call matched ${JSON.stringify(p)}${0 === since ? PRE_ATTACH_CAVEAT : ''}`,
        // Same reasoning as the signal miss: "no matching call" cannot be told apart from "the app
        // made no calls at all", and those need different fixes.
        observed: observedNetCalls(events, p.urlContains),
        expected: `at least one call matching ${JSON.stringify(p)}`,
        assertion: 'net.present',
      };
}

/** The only console levels Reticle instruments (console.info/debug/trace are NOT patched). */
const CONSOLE_LEVEL_TYPE: Readonly<Record<string, EventType>> = {
  log: EventType.CONSOLE_LOG,
  warn: EventType.CONSOLE_WARN,
  error: EventType.CONSOLE_ERROR,
};

export function evalConsole(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: typeof PredicateKind.CONSOLE }>,
): EvalResult {
  const since = p.since ?? 0;
  // Reticle only instruments console.log/warn/error. A level outside that set is never captured,
  // so its events can't exist — and an `absent` assertion on it would verify NOTHING while
  // reporting green. Fail loudly instead of false-passing.
  if (p.level !== undefined && p.level !== 'error' && CONSOLE_LEVEL_TYPE[p.level] === undefined) {
    return {
      pass: false,
      failureReason: `console level '${p.level}' is not captured — Reticle instruments console.log, console.warn, console.error only`,
      observed: `level '${p.level}' is not instrumented, so no event of it can ever exist`,
      expected: 'a level Reticle captures: log, warn, or error',
      assertion: 'console.uninstrumented-level',
    };
  }
  const matches = events.filter((e) => {
    if (e.t < since) return false;
    const isErr = e.type === EventType.CONSOLE_ERROR || e.type === EventType.ERROR_UNCAUGHT;
    if (p.level === undefined) {
      return (
        e.type === EventType.CONSOLE_LOG ||
        e.type === EventType.CONSOLE_WARN ||
        e.type === EventType.CONSOLE_ERROR ||
        e.type === EventType.ERROR_UNCAUGHT
      );
    }
    if ('error' === p.level) return isErr;
    return e.type === CONSOLE_LEVEL_TYPE[p.level];
  });
  // A text match narrows the population to entries whose captured message contains the substring.
  // With `absent: true` this is the whole point: "THIS message did not appear", not "no messages
  // appeared" — the difference between a regression check and a fragile one that any unrelated
  // warning anywhere in the app breaks.
  const wanted = 'contains' in p ? p.contains : undefined;
  // Captured messages are strings (stringifyArgs in the browser observer), but a malformed or
  // foreign event must not crash the evaluator: non-strings stringify defensively, and objects
  // go through JSON.stringify rather than a default toString that would print '[object Object]'.
  const asText = (v: unknown): string => {
    if ('string' === typeof v) return v;
    try {
      return JSON.stringify(v) ?? '';
    } catch {
      return '';
    }
  };
  const matching =
    wanted !== undefined
      ? matches.filter((e) => asText(e.data['message']).includes(wanted))
      : matches;
  if (true === p.absent) {
    if (wanted !== undefined && 0 === matching.length && matches.length > 0) {
      // Other entries exist but none carries the substring: exactly the pass an absence-with-match
      // asserts. Name both counts so the caller can tell this from a silent window.
      return {
        pass: true,
        evidence: { absent: true, contains: wanted },
      };
    }
    return 0 === matching.length
      ? { pass: true, evidence: { absent: true } }
      : {
          pass: false,
          failureReason:
            wanted !== undefined
              ? `expected no ${p.level ?? 'console'} entry containing ${JSON.stringify(wanted)} but found ${String(matching.length)}`
              : `expected no ${p.level ?? 'console'} entries but found ${String(matches.length)}`,
          observed:
            wanted !== undefined
              ? `${String(matching.length)} ${p.level ?? 'console'} entr${1 === matching.length ? 'y' : 'ies'} containing ${JSON.stringify(wanted)}`
              : `${String(matches.length)} ${p.level ?? 'console'} entr${1 === matches.length ? 'y' : 'ies'}`,
          expected:
            wanted !== undefined
              ? `no ${p.level ?? 'console'} entry containing ${JSON.stringify(wanted)}`
              : `no ${p.level ?? 'console'} entries`,
          assertion: wanted !== undefined ? 'console.absent-contains' : 'console.absent',
          evidence: matching.map((e) => e.data),
        };
  }
  return matching.length > 0
    ? { pass: true, evidence: matching.map((e) => e.data) }
    : {
        pass: false,
        failureReason:
          wanted !== undefined
            ? `no ${p.level ?? 'console'} entry containing ${JSON.stringify(wanted)} found`
            : `no ${p.level ?? 'console'} entries found`,
        observed:
          wanted !== undefined
            ? `no ${p.level ?? 'console'} entry containing ${JSON.stringify(wanted)} in the window`
            : `no ${p.level ?? 'console'} entries in the window`,
        expected:
          wanted !== undefined
            ? `at least one ${p.level ?? 'console'} entry containing ${JSON.stringify(wanted)}`
            : `at least one ${p.level ?? 'console'} entry`,
        assertion: 'console.present',
      };
}

export function evalAnimation(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: typeof PredicateKind.ANIMATION }>,
): EvalResult {
  const wantType = true === p.completed ? EventType.ANIM_END : EventType.ANIM_START;
  const hit = events.find((e) => {
    if (e.type !== wantType) return false;
    if (p.name !== undefined && str(e.data['name']) !== p.name) return false;
    if (p.target !== undefined && e.ref !== p.target) return false;
    return true;
  });
  return hit !== undefined
    ? { pass: true, evidence: hit.data }
    : {
        pass: false,
        failureReason: `no animation matched ${JSON.stringify(p)}`,
        observed: 'no matching animation in the window',
        expected: `an animation matching ${JSON.stringify(p)}`,
        assertion: 'animation.present',
      };
}

export function evalSignal(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: typeof PredicateKind.SIGNAL }>,
): EvalResult {
  const isMatch = (e: ReticleEvent): boolean => {
    if (e.type !== EventType.SIGNAL) return false;
    if (p.name !== undefined && str(e.data['name']) !== p.name) return false;
    if (p.dataMatches !== undefined) {
      const payload = (e.data['data'] ?? {}) as Record<string, unknown>;
      if (!dataMatches(payload, p.dataMatches)) return false;
    }
    return true;
  };

  // `count` (exact) turns presence into a cardinality assertion, exactly as it does on `net`. The
  // double-fire is invisible to every state-only oracle — a handler wired twice leaves the store in
  // the right shape and fires the signal twice — and so is the wrong-name fire, where the intended
  // signal fires once beside a mistyped sibling and a presence check cannot say which is which.
  // Counting only what the MATCHER matched is what separates them. Omit = presence (≥1).
  if (p.count !== undefined) {
    return evalExactCount({
      matched: events.filter(isMatch).length,
      want: p.count,
      noun: 'signal(s)',
      filter: describeSignalFilter(p),
      assertion: 'signal.count',
    });
  }

  const hit = events.find(isMatch);
  if (hit !== undefined) return { pass: true, evidence: hit.data };

  // Near-miss: show signals that fired with the same name (so the agent sees the real data).
  const sameName = events
    .filter(
      (e) =>
        e.type === EventType.SIGNAL && (p.name === undefined || str(e.data['name']) === p.name),
    )
    .map((e) => e.data['data'] ?? e.data);
  return {
    pass: false,
    failureReason:
      sameName.length > 0
        ? `signal '${p.name ?? '(any)'}' fired ${String(sameName.length)}x but data didn't match`
        : `no signal matched ${JSON.stringify(p)}`,
    observed:
      sameName.length > 0
        ? `signal '${p.name ?? '(any)'}' fired ${String(sameName.length)}x, payload: ${JSON.stringify(sameName[0])}`
        : // Name what DID fire: a typo'd signal name and a genuinely dead action produce the same
          // sentence otherwise, and the agent cannot tell them apart. See observed-in-window.ts.
          `signal '${p.name ?? '(any)'}' never fired; ${describeObserved(
            'signals',
            events.filter((e) => e.type === EventType.SIGNAL).map((e) => str(e.data['name']) ?? ''),
          )}`,
    expected:
      p.dataMatches === undefined
        ? `signal '${p.name ?? '(any)'}' to fire`
        : `signal '${p.name ?? '(any)'}' with payload matching ${JSON.stringify(p.dataMatches)}`,
    // Two distinct failures behind one prose line: never fired at all, versus fired with the wrong
    // payload. They call for different fixes, so the agent should not have to tell them apart by
    // reading the sentence.
    assertion: sameName.length > 0 ? 'signal.payload' : 'signal.absent',
    evidence: sameName.length > 0 ? { nearMiss: sameName } : undefined,
  };
}

/**
 * Assert a value inside a registered store — the deterministic source of truth no DOM/network read
 * can reach. Reads the store (STATE_READ), walks `path` (dot-path, numeric array indices), and matches
 * the value against `equals` (a literal, `*` for presence, or a `{$gte,$contains,$length,…}` operator
 * pattern — same matcher as signal `dataMatches`). This is what turns "the UI lies about the store"
 * from a manual three-step catch into a one-line, LLM-free regression invariant a flow can carry.
 */

/**
 * Activity that resets the "quiet" timer for a `settled` predicate: network calls and STRUCTURAL DOM
 * mutations (nodes added/removed, attributes changed). Deliberately EXCLUDES `dom.text` and animation
 * frames: a count-up counter, a spinner, a pulsing dot, or any looping CSS animation emits a text/anim
 * event every frame forever, so an app with ambient motion would NEVER go quiet (observed live: one
 * login flooded 319 dom.text events from the dashboard's count-up animations). That is the same trap
 * that got Playwright's `networkidle` deprecated. Network + structural DOM are the real "the app is
 * still doing work" signals; for an outcome gated on an animation finishing, assert that specific
 * consequence (signal/net) instead of relying on settle.
 */
const SETTLE_ACTIVITY: ReadonlySet<EventType> = new Set([
  EventType.NET_REQUEST,
  EventType.DOM_ADDED,
  EventType.DOM_REMOVED,
  EventType.DOM_ATTR,
]);

/** The three net-shaped event types a URL can be read off — the only ones dev tooling can produce. */
const NET_TYPES: ReadonlySet<EventType> = new Set([
  EventType.NET_PENDING,
  EventType.NET_REQUEST,
  EventType.NET_STREAM,
]);

/** Default quiet window — enough to absorb a render+xhr settle without waiting on slow polls. */
const DEFAULT_QUIET_MS = 500;

/**
 * "The page has gone quiet": no network/DOM/animation activity for at least `quietMs`. Needs the
 * wall-clock `now` (in the buffer's time base) because "no activity in the last N ms" is relative to
 * now, not to any buffered event — so `now` is injected (CLAUDE.md rule 7), and the wait loop's
 * poll interval is what eventually flips this to pass once activity stops.
 */
export function evalSettled(
  allEvents: ReticleEvent[],
  p: Extract<Predicate, { kind: typeof PredicateKind.SETTLED }>,
  now: number,
): EvalResult {
  const quietMs = p.quietMs ?? DEFAULT_QUIET_MS;

  // Dev-tooling traffic is the framework talking about ITSELF (see DevToolingChannel) and says
  // nothing about whether the app finished its work — but it was holding settle open. Dropped from
  // both halves of the calculation below (in-flight AND the quiet timer) and DISCLOSED on the
  // evidence, never silently swallowed.
  const ignoredDevTooling: string[] = [];
  const events = allEvents.filter((e) => {
    if (!NET_TYPES.has(e.type)) return true;
    const url = str(e.data['url']);
    if (!isDevToolingUrl(url)) return true;
    if (url !== undefined && !ignoredDevTooling.includes(url)) ignoredDevTooling.push(url);
    return false;
  });
  const disclosure = 0 === ignoredDevTooling.length ? {} : { ignoredDevTooling };

  // A request that STARTED (NET_PENDING) but never completed (NET_REQUEST with the same id) is
  // still in flight — the page is NOT settled no matter how quiet the DOM has gone. Without this,
  // a slow save reads as "settled" the instant its spinner stops mutating the DOM: the exact
  // false-green `settled` exists to prevent.
  //
  // COUNT per id, don't just set-membership: a retry that reuses a request id (two NET_PENDING, one
  // NET_REQUEST) would mark the id "done" and hide the second, still-flying request — an in-flight
  // UNDERCOUNT that greens settle while a request is live. In-flight for an id is pendings minus
  // completions (floored at 0); unkeyed pendings each count as one.
  const pendingById = new Map<string, number>();
  const doneById = new Map<string, number>();
  let unkeyedPending = 0;
  for (const e of events) {
    if (e.type === EventType.NET_PENDING) {
      const id = str(e.data['id']);
      if (id === undefined) unkeyedPending += 1;
      else pendingById.set(id, (pendingById.get(id) ?? 0) + 1);
    } else if (e.type === EventType.NET_REQUEST) {
      const id = str(e.data['id']);
      if (id !== undefined) doneById.set(id, (doneById.get(id) ?? 0) + 1);
    }
  }
  let inFlight = unkeyedPending;
  for (const [id, pending] of pendingById) {
    inFlight += Math.max(0, pending - (doneById.get(id) ?? 0));
  }

  // A completed request whose BODY is still streaming is not a finished request. `fetch` resolves at
  // HEADERS, so on a Next.js App Router page the RSC payload reported complete 16 ms in while the
  // Suspense boundary's content arrived 889 ms later — and the silence between them read as a settled
  // page with a loading spinner still on screen. An OPEN with no CLOSE is in flight, counted the same
  // way as a pending with no completion.
  const openStreams = new Set<string>();
  for (const e of events) {
    if (e.type !== EventType.NET_STREAM) continue;
    const id = str(e.data['id']);
    if (id === undefined) continue;
    const direction = str(e.data['direction']);
    if (StreamDirection.OPEN === direction) openStreams.add(id);
    else if (StreamDirection.CLOSE === direction) openStreams.delete(id);
  }
  const streaming = openStreams.size;

  if (inFlight + streaming > 0) {
    const what =
      0 === streaming
        ? `${String(inFlight)} request(s) still in flight`
        : 0 === inFlight
          ? `${String(streaming)} response body(ies) still streaming`
          : `${String(inFlight)} request(s) in flight and ${String(streaming)} response body(ies) still streaming`;
    return {
      pass: false,
      failureReason: `not settled: ${what}`,
      observed: what,
      expected: 'no requests in flight and no response bodies still streaming',
      assertion: 'settled.in-flight',
      evidence: {
        settled: false,
        inFlight,
        ...(streaming > 0 ? { streaming } : {}),
        ...disclosure,
      },
    };
  }

  let lastT = -1;
  let lastType: EventType | undefined;
  for (const e of events) {
    if (SETTLE_ACTIVITY.has(e.type) && e.t > lastT) {
      lastT = e.t;
      lastType = e.type;
    }
  }
  if (lastT < 0) {
    return {
      pass: true,
      evidence: { settled: true, quietForMs: null, note: 'no activity to settle', ...disclosure },
    };
  }
  const quietForMs = now - lastT;
  if (quietForMs >= quietMs) {
    return {
      pass: true,
      evidence: { settled: true, quietForMs, lastActivity: lastType, ...disclosure },
    };
  }
  return {
    pass: false,
    failureReason: `not settled: last activity (${String(lastType)}) ${String(quietForMs)}ms ago, need ${String(quietMs)}ms quiet`,
    observed: `last activity was ${String(lastType)}, ${String(quietForMs)}ms ago`,
    expected: `${String(quietMs)}ms of quiet`,
    assertion: 'settled.quiet',
    evidence: { quietForMs, lastActivity: lastType, ...disclosure },
    // The one failure in this file that knows exactly when it could stop being one: if nothing else
    // happens, the window closes in this many ms. A waiter that re-checks THEN instead of on its next
    // blind tick stops paying up to a full poll interval on the hottest call in the product. Only a
    // hint — the predicate is still evaluated at that moment, and can still fail.
    retryAfterMs: quietMs - quietForMs,
  };
}
