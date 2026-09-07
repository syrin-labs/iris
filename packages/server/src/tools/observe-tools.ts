/**
 * Observe / wait / assert tools — reticle_observe, reticle_wait_for, reticle_assert, reticle_network,
 * reticle_console, reticle_animations. Split out of tools.ts; assembled back via...OBSERVE_TOOLS.
 */
import { noteEmptyRead } from './observed-nothing.js';
import { z } from 'zod';
import { aliasParam } from './alias-args.js';
import {
  CONSOLE_LEVELS,
  ReticleCommand,
  DEFAULT_ASSERT_TIMEOUT_MS,
  PredicateKind,
  Verified,
} from '@reticlehq/core';
import { ReticleTool } from './tool-names.js';
import {
  countSchema,
  cursorSchema,
  httpStatusSchema,
  timeoutMsSchema,
  windowMsSchema,
} from './numeric-bounds.js';
import { buildReactionReport } from '../events/reaction.js';
import { findContradictions } from '../events/contradictions.js';
import { evaluatePredicate, waitForPredicate, PredicateSchema } from '../events/predicate.js';
import { resolveSessionWithin } from '../session/resolve-within.js';
import { WALL_CLOCK } from '../session/wall-clock.js';
import { parsePredicate } from '../events/predicate-parse.js';
import {
  matchNet,
  matchConsole,
  isConsoleEvent,
  eventMatchesFilters,
  netEmptyHint,
  consoleEmptyHint,
  reconcileNet,
  projectNetCall,
  projectConsoleLog,
  withoutUrlRaw,
} from '../events/event-filters.js';
import {
  applyEventBudget,
  costHint,
  withSizeCost,
  DEFAULT_QUERY_LIMIT,
} from '../session/output-budget.js';
import {
  annotateStarvedFailure,
  healthEnvelope,
  bufferEnvelope,
} from '../session/session-health.js';
import type { Session } from '../session/session.js';
import type { Predicate } from '../events/predicate.js';
import {
  assertsDerivedIpcStatus,
  DERIVED_IPC_STATUS_ADVICE,
  isPresenceOnlyAssertion,
  PRESENCE_ONLY_ADVICE,
} from './assert-grade.js';
import { assertVerdict } from './assert-verdict.js';
import { assertSource } from './assert-source.js';
import { isChangeUndeclared } from '../honesty/undeclared-change.js';
import { openSessionIntents } from '../intent/open-intents.js';
import {
  dischargeInlineIntent,
  inlineVerdictId,
  linkInlineIntent,
} from '../intent/inline-intent.js';
import { bodiesNotCaptured } from '../honesty/uncaptured-bodies.js';
import { withControl } from '../session/control-envelope.js';
import { asString, asNumber, asRecord } from './tools-helpers.js';
import { type ToolDef, intentArg, sessionIdShape, commandOrThrow } from './tool-kit.js';
import { gradeOfPredicate } from './assert-grade.js';

/**
 * Evidence-completeness block: present on observe/network/console only when the ring buffer has
 * evicted events, so a "no such event" answer is distinguishable from "I dropped it" (issue #27).
 */
const bufferOutputShape = {
  buffer: z
    .object({ held: z.number(), dropped: z.number(), note: z.string() })
    .optional()
    .describe(
      'Present only when the event buffer evicted events — a negative result may then be a false negative.',
    ),
};

/**
 * The file:line an assertion may report — see `assertSource`.
 *
 * Neither `reticle_assert` nor `reticle_wait_for` drives anything, so the last act's source is about
 * some earlier action and not about this verdict. The pointer comes from the assertion's own matched
 * evidence; the last driven control is borrowed only for a RED whose predicate has no DOM clause at
 * all, which is the failure that genuinely has no element to point at.
 */
function assertionSource(
  session: Session,
  predicate: Predicate,
  verdict: { pass: boolean; evidence?: unknown },
): { source?: string } {
  const source = assertSource({
    predicate,
    evidence: verdict.evidence,
    pass: verdict.pass,
    lastActSource: session.lastAct.source(),
  });
  return source === undefined ? {} : { source };
}

/**
 * Drop `sessionId` from an event in a response the caller scoped to ONE session.
 *
 * The caller passed that id in the request, so echoing it on every event is the request quoted back
 * once per row. Measured on a live app it was 25% of a four-event `reticle_observe` payload, and it
 * grows linearly with the timeline — a fifty-event window spends ~2.5KB restating a fact the caller
 * supplied. The id stays on the wire between SDK and bridge, where events from different sessions
 * really do interleave; it is only redundant at this boundary.
 */
function withoutConstantSessionId(event: unknown): unknown {
  if (typeof event !== 'object' || null === event) return event;
  const { sessionId: _sessionId, ...rest } = event as Record<string, unknown>;
  return rest;
}

/**
 * The console levels, derived from core's console EventTypes — see CONSOLE_LEVELS.
 *
 * A free string here filtered by building `console.${level}`, so `level:'ERROR'` or `level:'fatal'`
 * matched nothing and returned an empty log list. On a page that HAS logs the zero-match hint saves
 * it (it reports which levels are present), but on a quiet page the answer is identical to a genuine
 * all-clear. Refusing the value outright is the only reading with no ambiguity.
 */
const CONSOLE_LEVEL_LIST = CONSOLE_LEVELS.join(' | ');
const consoleLevelEnum = z.enum(CONSOLE_LEVELS as [string, ...string[]]);

export const OBSERVE_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.OBSERVE,
    example: { since: 0 },
    description:
      'Return the timeline of everything the app did in a window (DOM/network/route/console/animation/signal), with a summary. Use after an action. Pass `max_events` to cap the timeline to the most recent N (older events are dropped and counted in cost.droppedOldest). Every result carries a `cost:{events,bytes}` hint so you can self-budget your next call.',
    inputSchema: {
      window_ms: windowMsSchema
        // A non-positive window silently produced a FUTURE cursor, so the tool returned zero events
        // and echoed the nonsense value back — indistinguishable from a genuinely quiet page. An
        // agent that fumbles this argument gets a clean "nothing happened" instead of being told the
        // question was malformed, which is the exact confusion this layer exists to refuse.
        .optional()
        .describe(
          'Time window to look back, in ms (must be > 0). Default: 2000. Ignored when `since` is provided.',
        ),
      since: cursorSchema
        .optional()
        .describe(
          'Cursor from a prior reticle_act or reticle_observe call. Scopes the event window to exactly that span.',
        ),
      until: cursorSchema
        .optional()
        .describe('Upper cursor bound. With `since`, returns the span "between action A and B".'),
      actionId: z
        .string()
        .optional()
        .describe(
          'Keep only events attributed to this action — answers "what did action N cause".',
        ),
      filters: z
        .array(z.string())
        .optional()
        .describe(
          'Event type allowlist — the cheapest way to shrink a large timeline. Use a bucket name — ' +
            'dom | net | route | console | animation | signal | perf | state | storage — or a raw ' +
            'type (e.g. "net.request"). Omit to return all types.',
        ),
      max_events: countSchema
        .optional()
        .describe(
          'Cap the timeline to the most recent N events. Older events are counted in cost.droppedOldest.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      // The observed window's duration — buildReactionReport returns it on every call; without it in
      // the schema, a validating profile stripped it and the agent lost "over how long" the counts hold.
      window_ms: z.number(),
      events: z.array(z.unknown()),
      summary: z.object({
        total: z.number(),
        network: z.number(),
        domAdded: z.number(),
        domRemoved: z.number(),
        domChanged: z.number(),
        routeChanges: z.number(),
        consoleErrors: z.number(),
        animations: z.number(),
        signals: z.number(),
      }),
      // Cross-channel disagreement in this window. Omitted when there is none, so a clean action
      // costs zero tokens and a contradiction is impossible to scroll past.
      contradictions: z
        .array(
          z.object({
            kind: z.string(),
            claim: z.string(),
            counter: z.string(),
            detail: z.string(),
          }),
        )
        .optional()
        .describe(
          'Channels that DISAGREE about this action — e.g. the UI advanced while its request failed. Each is a false green: the screen looks right and the app is wrong.',
        ),
      cost: z.object({
        events: z.number(),
        bytes: z.number(),
        droppedOldest: z.number().optional(),
        recommendation: z
          .string()
          .optional()
          .describe(
            'Present when the timeline is large — scope your next call (filters/max_events).',
          ),
      }),
      session: z
        .object({ lastSeenMs: z.number(), throttled: z.boolean(), focused: z.boolean() })
        .optional(),
      ...bufferOutputShape,
    },
    handler: async (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const explicitSince = asNumber(args['since']);
      const windowMs = asNumber(args['window_ms']) ?? 2000;
      // Explicit since wins; else look back one window. Journal-backed so it survives buffer eviction.
      const since = explicitSince ?? Math.max(0, session.elapsed() - windowMs);
      const events = await session.queryEvents({
        since,
        until: asNumber(args['until']),
        actionId: asString(args['actionId']),
      });
      const filters = Array.isArray(args['filters']) ? (args['filters'] as string[]) : undefined;
      const filtered =
        filters === undefined ? events : events.filter((e) => eventMatchesFilters(e, filters));
      // Output budget: cap to the most recent N (no silent caps — droppedOldest is surfaced in cost).
      const { events: budgeted, droppedOldest } = applyEventBudget(
        filtered,
        asNumber(args['max_events']),
      );
      const report = buildReactionReport(budgeted, windowMs);
      // Run over the FILTERED-but-unbudgeted window: a contradiction must not vanish because the
      // timeline was capped for tokens. Detection is cheap; the events are already in hand.
      // The act that opened this window is not in `args` — observe is a separate call — so its action
      // and in-target mutation count are read back off the session. Without them the "this click did
      // nothing" check is unreachable on the ordinary act-then-observe flow, which is most of them.
      // Only when the act actually falls inside the window being judged — judging a click with a
      // window that starts after it would accuse a control of doing nothing during a period it was
      // never asked about.
      const actCursor = session.lastAct.cursor();
      const judgingTheAct = actCursor !== undefined && actCursor >= since;
      const contradictions = findContradictions(filtered, {
        currentDocumentId: session.currentDocumentId,
        currentEditEpoch: session.currentEditEpoch,
        appOrigin: session.url,
        ...(judgingTheAct ? { ...session.lastAct.effect(), actionSince: actCursor } : {}),
      });
      // carry session health — a throttled tab means the observed timeline may be incomplete.
      return withControl(session, {
        ...report,
        events: report.events.map((e) => withoutUrlRaw(withoutConstantSessionId(e))),
        ...(contradictions.length > 0 ? { contradictions } : {}),
        cost: costHint(report, budgeted.length, droppedOldest),
        ...healthEnvelope(session),
        ...bufferEnvelope(session),
      });
    },
  },
  {
    name: ReticleTool.WAIT_FOR,
    example: { predicate: { kind: PredicateKind.STATE, path: 'todos.length', equals: 3 } },
    description:
      'Block until a predicate is satisfied (or already true in the recent buffer), else time out. Returns matching evidence or a near-miss diagnosis. By default it only counts events since your last act, so a signal buffered BEFORE the action can never fake a pass; pass `since` (an observe/act cursor) to widen or narrow that window explicitly.',
    inputSchema: {
      predicate: PredicateSchema.optional().describe(
        'Predicate to wait for: { signal }, { net }, { element }, { kind: "net", ok: false } (assert on the OUTCOME — the honest field for IPC, which has no status code), { kind: "state", store, path, equals } (assert a registered store\'s value directly — the source of truth no DOM read can reach; equals takes a literal or { $gte | $contains | $length } pattern), { kind: "settled", quietMs } (deterministic network + DOM idle — prefer this over a fixed sleep), or a combination via allOf/anyOf.',
      ),
      // Same concept, the neighbouring tool's name. See alias-args.ts.
      until: PredicateSchema.optional().describe("Alias for `predicate` (act_and_wait's name)."),
      timeout_ms: timeoutMsSchema
        .optional()
        .describe(
          'Maximum wait in milliseconds. Default: 4000. Capped at 55000: your MCP client aborts the request before a longer wait can return, so a bound above this would be advertised and not deliverable. To outlast it, poll — several short waits, each of which returns a verdict.',
        ),
      since: cursorSchema
        .optional()
        .describe('Cursor from a prior reticle_act — scopes the wait to events after that act.'),
      ...sessionIdShape,
    },
    outputSchema: {
      pass: z.boolean(),
      evidence: z.unknown().optional(),
      failureReason: z.string().optional(),
      observationLost: z
        .boolean()
        .optional()
        .describe(
          'The tab disconnected mid-wait, so this was never observed — the verdict is UNKNOWN, not a failure of the app.',
        ),
      inconclusive: z
        .string()
        .optional()
        .describe(
          'The wait could not be graded as a product failure — e.g. the tab is throttled and may never have rendered. The verdict is UNKNOWN, not "the UI is absent".',
        ),
      session: z
        .object({ lastSeenMs: z.number(), throttled: z.boolean(), focused: z.boolean() })
        .optional(),
      buffer: z
        .object({ held: z.number(), dropped: z.number(), note: z.string() })
        .optional()
        .describe(
          'Present ONLY when the ring buffer evicted events during this window. A passing assertion — especially an absence one — may then be a false negative: the evidence that would have failed it could have been dropped. Absence of this block means the buffer was intact and the verdict is trustworthy.',
        ),
      observed: z
        .string()
        .optional()
        .describe(
          'What was actually seen — the structured half of failureReason, for the agent rather than a log.',
        ),
      expected: z.string().optional().describe('What the oracle required.'),
      assertion: z
        .string()
        .optional()
        .describe(
          'Which oracle judged it, e.g. element.state — lets an agent branch on the failure KIND without parsing prose.',
        ),
      source: z
        .string()
        .optional()
        .describe(
          'Where the code behind this verdict lives, as `file:line`. For an element/text assertion it is the matched element itself; for a FAILING signal/net/state assertion — which has no element to point at — it is the control last acted on, where the handler that should have fired lives. OMITTED when neither is known: this tool never borrows an unrelated location.',
        ),
    },
    handler: async (deps, args) => {
      const waitBudget = asNumber(args['timeout_ms']) ?? DEFAULT_ASSERT_TIMEOUT_MS;
      // Spend the budget waiting for the APP as well as for the predicate. See resolve-within.
      const session = await resolveSessionWithin(
        deps.sessions,
        asString(args['sessionId']),
        waitBudget,
        WALL_CLOCK,
      );
      // `until` is act_and_wait's name for this — see alias-args.ts.
      const predicate = parsePredicate(aliasParam(args, 'predicate', ['until'])['predicate']);
      // Honesty: explicit since wins; else default to the last act's cursor; else the whole buffer.
      const since = asNumber(args['since']) ?? session.lastAct.cursor() ?? 0;
      const verdict = await waitForPredicate(session, predicate, waitBudget, since);
      // match reticle_assert — wrap with control + session health (throttle matters most while blocking)
      // and the buffer envelope, so a verdict reached over an evicted window says so.
      return withControl(session, {
        // #537's starved-wait note wraps the verdict (it RETURNS the verdict), so it stands where
        // `...verdict` did. The source line is #533's `assertionSource`, which superseded
        // `lastActSourceOnFailure` — an assert used to be blamed on the previous act's file:line.
        ...annotateStarvedFailure(session, verdict),
        ...assertionSource(session, predicate, verdict),
        ...healthEnvelope(session),
        ...bufferEnvelope(session),
      });
    },
  },
  {
    name: ReticleTool.ASSERT,
    example: { predicate: { kind: PredicateKind.SIGNAL, name: 'todos:loaded' } },
    description:
      'Evaluate a predicate (optionally waiting up to timeout_ms). Returns { pass, evidence, failureReason? }. The end of every verify loop. CHECKING SEVERAL THINGS? Put them in ONE call with { kind: "allOf", predicates: [...] } — it returns one verdict naming whichever member failed, and one call costs one round trip where N calls cost N. Prefer a { signal } or { net } consequence over { element }/{ text } presence — a passing presence-only assertion returns `advice` because a wrong/healed element can fake it. By default it only counts events since your last act, so a stale buffered signal can never fake a pass; pass `since` (an observe/act cursor) to set the window explicitly.',
    inputSchema: {
      predicate: PredicateSchema.optional().describe(
        // Every kind, each with the field that carries its argument. Five of the nine were
        // undocumented here, including `route` — and "did submitting the login form navigate away"
        // is the most common thing an agent wants to assert. A field report reached us from an agent
        // that guessed `urlContains` on route (net's spelling) and got unrecognized_keys.
        'Predicate to evaluate. Kinds: { signal, name|dataMatches|count } ' +
          '{ net, urlContains|method|status|count|bodyContains } ' +
          '{ state, path|equals } { route, pathname (exact) | contains (path+query+hash) } ' +
          '{ element, testid|role|text } { text } { console, level|contains|absent } { animation, name } ' +
          '{ settled } — combine with { allOf | anyOf | not }. Prefer a signal/net/state consequence ' +
          'over element/text presence.',
      ),
      until: PredicateSchema.optional().describe("Alias for `predicate` (act_and_wait's name)."),
      timeout_ms: timeoutMsSchema
        .optional()
        .describe(
          'If > 0, wait up to this many milliseconds before failing. Default: 0 (evaluate once). Capped at 55000: your MCP client aborts the request before a longer wait can return, so a bound above this would be advertised and not deliverable. To outlast it, poll — several short waits, each of which returns a verdict.',
        ),
      since: cursorSchema
        .optional()
        .describe(
          'Cursor from a prior reticle_act — scopes the assertion to events after that act.',
        ),
      intent: intentArg,
      ...sessionIdShape,
    },
    outputSchema: {
      pass: z.boolean(),
      evidence: z.unknown().optional(),
      failureReason: z.string().optional(),
      observationLost: z
        .boolean()
        .optional()
        .describe(
          'The tab disconnected mid-wait, so this was never observed — the verdict is UNKNOWN, not a failure of the app.',
        ),
      inconclusive: z
        .string()
        .optional()
        .describe(
          'The assertion could not be graded as a product failure — e.g. the tab is throttled and may never have rendered. The verdict is UNKNOWN, not "the UI is absent".',
        ),
      advice: z
        .string()
        .optional()
        .describe('Present on a PASSING presence-only assertion — nudges toward a consequence.'),
      observed: z
        .string()
        .optional()
        .describe(
          'What was actually seen — the structured half of failureReason, for the agent rather than a log.',
        ),
      expected: z.string().optional().describe('What the oracle required.'),
      assertion: z
        .string()
        .optional()
        .describe(
          'Which oracle judged it, e.g. element.state — lets an agent branch on the failure KIND without parsing prose.',
        ),
      session: z
        .object({ lastSeenMs: z.number(), throttled: z.boolean(), focused: z.boolean() })
        .optional(),
      buffer: z
        .object({ held: z.number(), dropped: z.number(), note: z.string() })
        .optional()
        .describe(
          'Present ONLY when the ring buffer evicted events during this window. A passing assertion — especially an absence one — may then be a false negative: the evidence that would have failed it could have been dropped. Absence of this block means the buffer was intact and the verdict is trustworthy.',
        ),
      source: z
        .string()
        .optional()
        .describe(
          'Where the code behind this verdict lives, as `file:line`. For an element/text assertion it is the matched element itself; for a FAILING signal/net/state assertion — which has no element to point at — it is the control last acted on, where the handler that should have fired lives. OMITTED when neither is known: this tool never borrows an unrelated location.',
        ),
      coverage: z
        .string()
        .optional()
        .describe(
          'Present ONLY when part of the page was unobservable (cross-origin iframe, closed shadow root). A PASSING assertion is then scoped to what could be seen — treat it as "no failure found in the observed region", never as "the page is correct".',
        ),
      coverage_spots: z
        .array(z.object({ kind: z.string(), count: z.number() }))
        .optional()
        .describe('Which regions were unobservable, when coverage is partial.'),
      instrumentationGaps: z
        .array(z.unknown())
        .optional()
        .describe(
          'What the APP did not tell Reticle, and the one change that would fix it — each entry is { kind, missing, cost, fix, source?, ref? }. Reported ONLY where an absence made THIS verdict weaker: a failing assertion with no source to point at, or a state assertion against an app that registers no store. Never a survey of the page, so an entry is always work worth doing now. OMITTED when the app told Reticle everything it needed.',
        ),
    },
    handler: async (deps, args) => {
      const timeout = asNumber(args['timeout_ms']) ?? 0;
      // Spend the budget waiting for the APP as well as for the predicate. See resolve-within.
      const session = await resolveSessionWithin(
        deps.sessions,
        asString(args['sessionId']),
        timeout,
        WALL_CLOCK,
      );
      // `until` is act_and_wait's name for this — see alias-args.ts.
      const predicate = parsePredicate(aliasParam(args, 'predicate', ['until'])['predicate']);
      // Honesty: explicit since wins; else default to the last act's cursor; else the whole buffer.
      const since = asNumber(args['since']) ?? session.lastAct.cursor() ?? 0;
      // Declared BEFORE the verdict, so the undeclared-change read below finds it open and stays
      // quiet on THIS verdict rather than on the next one. Discharged after that read.
      const intentId = await linkInlineIntent(
        deps,
        asString(args['sessionId']),
        asString(args['intent']),
        PredicateKind.SETTLED === predicate.kind ? undefined : predicate,
      );
      const verdict =
        timeout > 0
          ? await waitForPredicate(session, predicate, timeout, since)
          : await evaluatePredicate(session, predicate, since);
      // A GREEN presence-only assertion is the dangerous case (a wrong element can fake it) — nudge
      // toward a consequence. Never on a failing verdict (moot) or when a signal/net is asserted.
      // Two nudges, both only on a GREEN verdict (a failing one is moot): a presence-only assertion
      // a wrong element can fake, and an assertion pinned to a status Reticle derived rather than one
      // a server sent. Neither blocks — the assertion still passes; they steer the next one.
      const advice = !verdict.pass
        ? {}
        : isPresenceOnlyAssertion(predicate)
          ? { advice: PRESENCE_ONLY_ADVICE }
          : assertsDerivedIpcStatus(predicate)
            ? { advice: DERIVED_IPC_STATUS_ADVICE }
            : {};
      // Asked of every verdict drawn after an observed edit, not once per edit — see
      // isChangeUndeclared for why repeating it is disclosure rather than nagging.
      const changeUndeclared = await isChangeUndeclared(session.currentEditEpoch, () =>
        openSessionIntents(deps, asString(args['sessionId'])),
      );
      const { decision, contradictions, coverage, gaps, verdictEffect } = await assertVerdict(
        session,
        predicate,
        verdict.pass,
        verdict.evidence,
        since,
        verdict.inconclusive,
        verdict.observationLost,
        changeUndeclared,
      );
      // The assertion IS the proof attempt, so a green one discharges the intent it was drawn for. A
      // red proved nothing, and an unbound intent refuses discharge anyway — see inline-intent.ts.
      // The id is checked HERE rather than only inside the helper so a caller that declared no intent
      // touches nothing at all, not even the clock.
      if (intentId !== undefined && Verified.YES === decision['verified']) {
        await dischargeInlineIntent(
          deps,
          asString(args['sessionId']),
          intentId,
          {
            verdictId: inlineVerdictId(ReticleTool.ASSERT, deps.now()),
            grade: gradeOfPredicate(predicate),
            at: deps.now(),
          },
          /*
           * An assertion has no element of its own — it observes, it does not act. The file it names
           * is the one the LAST action touched, which is the code path that produced the state being
           * asserted about. Already remembered on the session for exactly this reason: an assertion
           * whose failure has nothing to point at still needs to name a file.
           */
          session.lastAct.source(),
        );
      }
      // Journal the verdict so a LATER turn can read what this one proved. A verdict that lives only
      // in the response lives only in the agent's context window, which is the copy a compaction
      // destroys — see runs/run-context.ts. Recorded WITHOUT an attribution window: this tool drives
      // nothing, so no event it observed was caused by it.
      session.recordAction(ReticleTool.ASSERT, asRecord(args), verdictEffect);
      return withControl(session, {
        ...decision,
        ...annotateStarvedFailure(session, verdict),
        ...(contradictions.length > 0 ? { contradictions } : {}),
        // What the app did not tell Reticle, on the same rule the act path uses.
        ...(gaps.length > 0 ? { instrumentationGaps: gaps } : {}),
        ...advice,
        ...coverage,
        // The SAME pointer the journal keeps, not a second lookup — one verdict, one file:line.
        ...(verdictEffect.source === undefined ? {} : { source: verdictEffect.source }),
        ...healthEnvelope(session),
        ...bufferEnvelope(session),
      });
    },
  },
  {
    name: ReticleTool.NETWORK,
    example: { urlContains: '/api/todos', method: 'POST' },
    description:
      'Filtered list of network calls. Fast path for "did POST /x return 200?". A zero-match filter returns a `hint` { totalInWindow, present[] } of the calls that DID fire, so a miss is diagnosable. Desktop IPC (`ipc://`) has no status code — the 200/500 there is derived, so filter on `ok` for those.',
    inputSchema: {
      since: cursorSchema
        .optional()
        .describe(
          'Cursor from a prior reticle_act — scopes the query to requests fired after that act.',
        ),
      until: cursorSchema
        .optional()
        .describe('Upper cursor bound — with `since`, the span between two acts.'),
      actionId: z
        .string()
        .optional()
        .describe('Keep only requests attributed to this action — "what did action N request".'),
      method: z
        .string()
        .optional()
        .describe('HTTP method filter: GET | POST | PUT | DELETE | PATCH etc.'),
      urlContains: z.string().optional().describe('Substring that the request URL must contain.'),
      status: httpStatusSchema.optional().describe('HTTP status code filter (e.g. 200, 404, 500).'),
      ok: z
        .boolean()
        .optional()
        .describe(
          'Outcome filter: false keeps only calls that FAILED, true only those that succeeded. The filter to use for desktop IPC (`ipc://`), whose status code is derived. A still-pending call matches neither.',
        ),
      limit: countSchema
        .optional()
        .describe(
          'Keep only the most recent N matching calls (older are dropped and counted in droppedOldest) — cuts tokens on a wide window. Defaults to 200 when omitted; pass a higher number for more, or scope with since/until.',
        ),
      bodies: z
        .boolean()
        .optional()
        .describe(
          'Include request/response bodies (default true). Pass false for a body-free listing — method, url, status, timing only — for the common "did POST /x return 200?" read. Bodies dominate the payload, so this cuts the cheap case by a large factor.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      calls: z.array(z.unknown()),
      total: z
        .number()
        .optional()
        .describe('Total matches before `limit` — present only when capped.'),
      droppedOldest: z.number().optional().describe('How many older matches `limit` dropped.'),
      hint: z.object({ totalInWindow: z.number(), present: z.array(z.string()) }).optional(),
      bodiesNotCaptured: z
        .string()
        .optional()
        .describe(
          'Present when a POST/PUT/PATCH was returned and body capture is OFF — an absent body means unseen, not empty. Carries the one-line fix.',
        ),
      cost: z.object({ bytes: z.number(), tokens: z.number() }).optional(),
      ...bufferOutputShape,
    },
    handler: async (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const since = asNumber(args['since']) ?? 0;
      const method = asString(args['method']);
      const urlContains = asString(args['urlContains']);
      const status = asNumber(args['status']);
      const ok = 'boolean' === typeof args['ok'] ? args['ok'] : undefined;
      const limit = asNumber(args['limit']);
      // Default true keeps the current shape; `bodies: false` returns the body-free listing (#401).
      const bodies = 'boolean' === typeof args['bodies'] ? args['bodies'] : true;
      const buffer = bufferEnvelope(session);
      // Completed calls + unresolved in-flight requests (a hung request shows as pending).
      const allNet = reconcileNet(
        await session.queryEvents({
          since,
          until: asNumber(args['until']),
          actionId: asString(args['actionId']),
        }),
      );
      const matched = allNet.filter((e) => matchNet(e, method, urlContains, status, ok));
      // zero-match filter returns what DID fire, not a bare [].
      if (0 === matched.length && allNet.length > 0) {
        return withSizeCost({ calls: matched, hint: netEmptyHint(allNet), ...buffer });
      }
      // Default the cap so an omitted `limit` can't dump a whole flooded session (since defaults to 0).
      const { events: budgeted, droppedOldest } = applyEventBudget(
        matched,
        limit ?? DEFAULT_QUERY_LIMIT,
      );
      const calls = budgeted.map((e) => projectNetCall(e, bodies));
      // A zero-match FILTER already reports what did fire (netEmptyHint above). Zero calls at all
      // fell through as a bare `[]`, which is indistinguishable from an observer that is not
      // recording — and those need opposite responses. Say the look happened.
      return withSizeCost(
        noteEmptyRead(
          {
            calls,
            ...(droppedOldest > 0 ? { total: matched.length, droppedOldest } : {}),
            ...(bodies ? bodiesNotCaptured(calls) : {}),
            ...buffer,
          },
          'calls',
          { noun: 'network calls' },
        ),
      );
    },
  },
  {
    name: ReticleTool.CONSOLE,
    example: { level: 'error' },
    description:
      'Console/error log. Fast path for "were there any errors during this flow?". When a level filter matches nothing, returns a `hint` { totalInWindow, byLevel } so 0 errors is distinguishable from a silent page.',
    inputSchema: {
      level: consoleLevelEnum
        .optional()
        .describe(`Log level filter: ${CONSOLE_LEVEL_LIST}. Omit to return all levels.`),
      since: cursorSchema
        .optional()
        .describe(
          'Cursor from a prior reticle_act — scopes the query to log entries after that act.',
        ),
      until: cursorSchema
        .optional()
        .describe('Upper cursor bound — with `since`, the span between two acts.'),
      actionId: z
        .string()
        .optional()
        .describe('Keep only log entries attributed to this action — "what did action N log".'),
      limit: countSchema
        .optional()
        .describe(
          'Keep only the most recent N matching entries (older are dropped and counted in droppedOldest) — cuts tokens when a page spams the console. Defaults to 200 when omitted; pass a higher number for more, or scope with since/until.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      logs: z.array(z.unknown()),
      total: z
        .number()
        .optional()
        .describe('Total matches before `limit` — present only when capped.'),
      droppedOldest: z.number().optional().describe('How many older matches `limit` dropped.'),
      hint: z.object({ totalInWindow: z.number(), byLevel: z.record(z.number()) }).optional(),
      cost: z.object({ bytes: z.number(), tokens: z.number() }).optional(),
      ...bufferOutputShape,
    },
    handler: async (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const since = asNumber(args['since']) ?? 0;
      const level = asString(args['level']);
      const limit = asNumber(args['limit']);
      const buffer = bufferEnvelope(session);
      const allConsole = (
        await session.queryEvents({
          since,
          until: asNumber(args['until']),
          actionId: asString(args['actionId']),
        })
      ).filter(isConsoleEvent);
      const matched = allConsole.filter((e) => matchConsole(e, level));
      // zero matches at this level → report what levels ARE present (not a bare []).
      if (0 === matched.length && allConsole.length > 0) {
        return withSizeCost({ logs: matched, hint: consoleEmptyHint(allConsole), ...buffer });
      }
      // Default the cap so an omitted `limit` can't dump a whole flooded session (since defaults to 0).
      const { events: budgeted, droppedOldest } = applyEventBudget(
        matched,
        limit ?? DEFAULT_QUERY_LIMIT,
      );
      const logs = budgeted.map(projectConsoleLog);
      // Say the look HAPPENED when it found nothing. A quiet page and a dead console observer both
      // produced `{ logs: [] }`, and "no console errors" is the claim agents lean on most — see
      // observed-nothing.ts, whose own header names this exact case and which every other array-
      // returning read here was already wired to.
      return withSizeCost(
        noteEmptyRead(
          droppedOldest > 0
            ? { logs, total: matched.length, droppedOldest, ...buffer }
            : { logs, ...buffer },
          'logs',
          { noun: 'console lines' },
        ),
      );
    },
  },
  {
    name: ReticleTool.ANIMATIONS,
    description: 'Currently running + recently completed animations with targets/timing.',
    inputSchema: { ...sessionIdShape },
    outputSchema: {
      animations: z.array(z.unknown()),
    },
    handler: async (deps, args) => {
      const result = await commandOrThrow(
        deps,
        asString(args['sessionId']),
        ReticleCommand.ANIMATIONS,
        {},
      );
      // A page with nothing animating and an observer that is not watching both return `[]`, and the
      // second means the run should not be trusted. Say the look happened.
      return isPlainRecord(result)
        ? noteEmptyRead(result, 'animations', { noun: 'animations running or completed' })
        : result;
    },
  },
];

/** Narrow a command result to something noteEmptyRead can annotate. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return 'object' === typeof value && value !== null && !Array.isArray(value);
}
