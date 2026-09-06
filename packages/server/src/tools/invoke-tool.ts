import { healthEnvelope } from '../session/session-health.js';
import { verifyNextBaton, SUPPRESS_VERIFY_NEXT_ENV } from './verify-next-baton.js';
import {
  type BrowserBrand,
  TelemetryActor,
  TelemetryEventKind,
  TRANSPORT_LIMITS,
  fingerprintFinding,
} from '@reticlehq/core';
import { getSessionMetrics } from '../telemetry/session-metrics.js';
import { getTelemetry } from '../telemetry/telemetry.js';
import { takeUpdateNudge } from '../update/update-nudge.js';
import { takeVersionSkew } from '../version/version-nudge.js';
import { rewriteClosedAsSkew } from '../version/version-skew.js';
import { noteToolCall } from '../daemon/daemon-usefulness.js';
import { bugsInResult, routeOf } from '../telemetry/bug-found.js';
import { noteToolServed, reportToolRefused } from '../telemetry/tool-refused.js';
import { buildErrorPayload, refusalReasonFor } from './error-recovery.js';
import { resultIsError } from '../mcp/mcp-is-error.js';
import { verificationOf } from '../telemetry/verification-of.js';
import { asString, sessionIdFromArgs, spentRefFromArgs } from './tools-helpers.js';
import { EnvelopeKey } from './tool-kit.js';
import { ReticleTool } from './tool-names.js';
import { takeFeedbackPrompt } from './feedback-tools.js';
import { takeFeedbackUndelivered } from '../telemetry/feedback-delivery.js';
import type { Session } from '../session/session.js';
import { noteRefsMinted, wrongTabRefusal } from '../session/ref-provenance.js';
import {
  CAPTURED_TOOLS,
  noteCapturedCall,
  noteToolDispatched,
} from '../honesty/feature-capture.js';
import { span } from '../trace.js';
import {
  defectForToolResult,
  deltaForToolResult,
  impactSnapshot,
  initImpact,
  recordImpact,
} from '../impact/impact-recorder.js';
import { type FrictionKind, frictionOf, inviteFor } from './feedback-invite.js';
import type { ToolDef, ToolDeps } from './tools.js';

/**
 * The live-session tools whose result MUST carry the
 * session-health envelope. Owned in ONE place — not retrofitted per handler — so a throttled tab
 * can never return a healthy-looking result from any of these. `runTool` is the single choke point
 * (mcp.ts + tool-invoker.ts) that splices health on; the guard test asserts the set is exhaustive.
 */
/**
 * Tools that DRIVE the page. An action with no verdict after it is the signature of the loop
 * breaking mid-task — see `abandonedActions`. `act_and_wait` is one of these AND a verification, so
 * it settles its own action, which is exactly right: it is the tool that does both.
 */
const ACTION_TOOLS: ReadonlySet<string> = new Set([
  ReticleTool.ACT,
  ReticleTool.ACT_SEQUENCE,
  ReticleTool.ACT_AND_WAIT,
]);

/**
 * Tools that go through Playwright CDP rather than the page SDK.
 *
 * Under version skew these fail with "Target page, context or browser has been closed" while every
 * DOM tool against the same tab still works (#688). They are session-EXEMPT (own result contracts),
 * so the bound-tool resolve above never runs for them — resolve again here so we can refuse with
 * the skew sentence before Playwright lies about a closed page.
 */
const CDP_TOOLS: ReadonlySet<string> = new Set([
  ReticleTool.SCREENSHOT,
  ReticleTool.VISUAL_DIFF,
  ReticleTool.NETWORK_MOCK,
  ReticleTool.VIEWPORT,
]);

/**
 * Tools whose result hands the agent refs. The tab they were minted in is remembered, so the call
 * that spends one cannot be routed to a different tab without saying so — see ref-provenance.ts.
 *
 * Over-inclusion is the safe direction here and under-inclusion is not dangerous either: both ends
 * produce a REFUSAL naming the two tabs, never a silent drive against the wrong one.
 */
const REF_MINTING_TOOLS: ReadonlySet<string> = new Set([
  ReticleTool.SNAPSHOT,
  ReticleTool.QUERY,
  ReticleTool.INSPECT,
  ReticleTool.EXPLORE,
  // `crawl` mints refs for the controls it drives and `coverage` for the ones it reports untouched.
  // Both are actions on the merged verify tool now.
  ReticleTool.VERIFY,
]);

export const SESSION_BOUND_TOOLS: ReadonlySet<string> = new Set([
  ReticleTool.SNAPSHOT,
  ReticleTool.QUERY,
  ReticleTool.INSPECT,
  // Merged change/flows/affected/coverage/crawl. Its members were SPLIT across bound and exempt —
  // coverage/change/crawl bound, flow_verify exempt because it returns its own suite contract — and
  // a merged tool has to be one or the other. Bound is the right side: `crawl` drives the app
  // itself, so a throttled or event-dropping tab is exactly the condition its verdict depends on,
  // and dropping the health disclosure there to protect a sibling's output shape would trade an
  // honesty signal for a formatting preference.
  ReticleTool.VERIFY,
  ReticleTool.ACT,
  ReticleTool.ACT_SEQUENCE,
  ReticleTool.ACT_AND_WAIT,
  ReticleTool.OBSERVE,
  ReticleTool.WAIT_FOR,
  ReticleTool.ASSERT,
  // Reads the live page as well as the event window, so a throttled tab can make it compare a stale
  // render against fresh data — exactly the case the health envelope exists to disclose.
  ReticleTool.RECONCILE,
  ReticleTool.NETWORK,
  ReticleTool.CONSOLE,
  ReticleTool.ANIMATIONS,
  ReticleTool.BASELINE, // merged save/list/diff — save+diff are live reads
  ReticleTool.RECORD, // merged start/stop — both live
  ReticleTool.REPLAY,
  ReticleTool.CLOCK,
  ReticleTool.STATE,
  ReticleTool.STORAGE,
  ReticleTool.EXPLORE,
  ReticleTool.SCROLL_TO,
  ReticleTool.NAVIGATE,
]);

/**
 * Tools that carry a `sessionId` arg but are NOT live-session-health tools — they read/write
 * disk (capabilities/contract/flow/project), drain a buffer, or steer session lifecycle. They are
 * exempt from the health splice ON PURPOSE. Kept explicit so the guard test can force every new
 * `sessionId`-bearing tool to be classified into exactly one set (bound XOR exempt).
 */
export const SESSION_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  ReticleTool.CAPABILITIES, // has a fromDisk mode with no live session
  ReticleTool.CONTRACT_SAVE, // persists the registry to disk
  ReticleTool.FLOW_SAVE, // sessionId only scopes the write to the app's flow subdir; disk-side
  ReticleTool.FLOW, // merged list/load/delete — sessionId only scopes the project; all disk-side
  ReticleTool.FLOW_REPLAY, // returns its own FlowReplayResult contract (+ auto-records a run)
  ReticleTool.FLOW_SAVE_RECORDED, // reads the recording buffer, writes disk
  ReticleTool.FLOW_HEAL, // returns its own FlowHealResult contract
  ReticleTool.INTENT, // reads/writes .reticle/intent.json; sessionId only picks the project
  ReticleTool.CONTEXT, // folds the journal + intent ledger; must still answer when nothing is connected
  ReticleTool.PROJECT, // reads .reticle/project.json
  // Reads the team's shared memory over HTTP; sessionId only resolves WHICH project's link file to
  // use. It must answer with no tab connected — "what does this project know?" is a question an
  // agent asks before it has opened anything.
  ReticleTool.MEMORY,
  ReticleTool.RUN_EXPORT, // reads .reticle/runs/<id>.json (verification-run artifact)
  ReticleTool.SESSION, // merged lifecycle/human-channel family (tune/yield/end/resume/messages/review/narrate)
  ReticleTool.SCREENSHOT, // own contract; provider-driven, not a live-DOM-health read
  ReticleTool.VISUAL_DIFF, // own contract (matched/ratio/region)
  ReticleTool.NETWORK_MOCK, // own contract (applied/count); provider-driven, not a live-DOM read
  ReticleTool.VIEWPORT, // own contract (applied/width/height); provider-driven, not a live-DOM read
  ReticleTool.ANNOTATE, // annotates a recording's steps; pure disk-side metadata, no live DOM read
  ReticleTool.LEASE, // merged acquire/release — its sessionId is a pool lease id, not a live session
  // Its sessionId only enriches the report with the tab's runtime/engine, and it must stay callable
  // when NO session exists — "nothing ever connected" is feedback we especially want.
  ReticleTool.FEEDBACK,
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return 'object' === typeof value && value !== null && !Array.isArray(value);
}

/**
 * Emit `verification_completed` when a verification tool produced a verdict.
 *
 * Read off the RESULT here rather than emitted from `decideVerified`, which is where the verdict is
 * actually decided: that function is pure, and the repo's rules keep clocks, IO and side effects out
 * of pure logic for good reason. Reading the result also means all the verification tools are covered
 * by one site instead of N handler edits, and the next one is covered the moment it joins the set.
 *
 * The RULE itself lives in verification-of.ts, because getting it wrong is silent and it feeds the
 * one number shown to investors — see that file for the two ways it was wrong.
 */
function recordVerification(
  toolName: string,
  result: Record<string, unknown>,
  durationMs: number,
  brand: BrowserBrand | undefined,
): void {
  const verification = verificationOf(toolName, result, durationMs, brand);
  if (verification === undefined) return;
  getSessionMetrics().recordVerification();
  void getTelemetry().emit(TelemetryEventKind.VERIFICATION_COMPLETED, {
    actor: TelemetryActor.AGENT,
    verification,
  });
}

/**
 * Emit one `bug_found` per defect in a tool result, and count it into the session.
 *
 * The outcome metric: everything else measures whether Reticle is used, this measures whether it
 * works. Discrete events rather than only a counter, because the KIND distribution is the argument —
 * "we found 4,000 bugs" is a claim, "1,200 were greens that lied" is evidence.
 */
function reportBugsFound(toolName: string, result: Record<string, unknown>): void {
  const bugs = bugsInResult(toolName, result);
  if (0 === bugs.length) return;
  const metrics = getSessionMetrics();
  const route = routeOf(result);
  for (const bug of bugs) {
    // `recordBug` answers whether this kind is new to the session, which is the only thing that
    // separates "another defect" from "the same defect again". Counting instances as defects is how
    // a published number inflates itself.
    const first = metrics.recordBug(bug.kind);
    const identity =
      route !== undefined
        ? { kind: bug.kind, source: bug.source, route }
        : { kind: bug.kind, source: bug.source };
    const fingerprint = fingerprintFinding(identity);
    void getTelemetry().emit(TelemetryEventKind.BUG_FOUND, {
      actor: TelemetryActor.AGENT,
      bug: { ...bug, repeat: !first, fingerprint },
    });
  }
}

/**
 * Report a refused call, at the one place both dispatch paths cross.
 *
 * A refusal arrives two ways and they are the same event: the handler THROWS (the common case — no
 * session, a stale ref, a schema rejection), or it RETURNS `{ error }`, which is this codebase's
 * refusal convention and just as much a refusal. Both are classified by the same table the agent's
 * recovery advice comes from, so the reason we record and the advice it got cannot describe
 * different things.
 *
 * `reticle_run` is skipped for the same reason `bugsInResult` skips it: it is a WRAPPER whose
 * handler calls `runTool` on the real tool, which already reported that refusal under the real
 * tool's name, and then hands the same failure back out to be reported a second time as
 * `reticle_run`. A count that doubles because of HOW a tool was reached is not a measurement.
 */
function reportRefusal(toolName: string, message: string): void {
  if (toolName === ReticleTool.RUN) return;
  reportToolRefused(toolName, refusalReasonFor(message));
}

/**
 * Which friction this result represents, counting the invitation if there is one.
 *
 * Feedback is the highest-yield channel this product has, and `feedbackPrompted` is the denominator
 * that says whether inviting mid-task works or is decoration. It read as near-empty because the
 * count sat behind the session-bound early return, so a session-EXEMPT tool never invited and a tool
 * that THREW never got there — and a throw is the commonest refusal there is.
 *
 * `reticle_run` is skipped for the same reason it is skipped for refusals and defects: the wrapper's
 * handler calls `runTool` on the real tool, which already invited under the real tool's name, and
 * the failure is then handed back out to be counted a second time. A doubled denominator makes the
 * feedback rate read half.
 */
function frictionInviteFor(toolName: string, raw: unknown): FrictionKind | undefined {
  if (!isPlainObject(raw) || toolName === ReticleTool.RUN) return undefined;
  const friction = frictionOf({
    unknownTool: false,
    verifiedUnknown: 'unknown' === raw['verified'],
    repeatRun: getSessionMetrics().currentRun,
    errored: resultIsError(raw),
    // A verdict is progress. Without this, three successful act_and_wait calls in a row — the exact
    // loop this release exists to encourage — get told they are stuck.
    producedVerdict: 'verified' in raw,
  });
  if (friction !== undefined) getSessionMetrics().recordFeedbackPrompt();
  return friction;
}

/**
 * The single entry point both the MCP server and the programmatic invoker call instead of
 * `tool.handler` directly. Runs the handler, then — for a live-session tool returning a plain
 * object that did not already include `session` — splices the health envelope on. Idempotent
 * (handlers that already add health are left untouched) and never alters non-object results.
 */
/**
 * The name of the first argument whose string value exceeds the transport bound, if any.
 *
 * One level of nesting is searched because that is where callers put payloads — `reticle_act`'s
 * `args.value`, and the fuzz's own `huge-string` shape. Deeper recursion would cost more than it
 * buys: the failure is a single huge string, not a deeply nested structure of small ones.
 */
function firstOversizedArg(args: Record<string, unknown>): string | undefined {
  const tooLong = (value: unknown): boolean =>
    'string' === typeof value && value.length > TRANSPORT_LIMITS.MAX_STRING_LENGTH;
  for (const [key, value] of Object.entries(args)) {
    if (tooLong(value)) return key;
    if ('object' === typeof value && null !== value && !Array.isArray(value)) {
      for (const [inner, nested] of Object.entries(value as Record<string, unknown>)) {
        if (tooLong(nested)) return `${key}.${inner}`;
      }
    }
  }
  return undefined;
}

export async function runTool<Ext>(
  tool: ToolDef<Ext>,
  deps: ToolDeps<Ext>,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Both dispatch paths (MCP + programmatic) pass through here — the one place "which tool is mostly
  // used" can be counted. This used to EMIT an event per call; it now increments an in-process counter
  // that leaves once, with the session summary. A verification loop is 50–200 calls, and PostHog bills
  // per event — so the old design made the telemetry bill scale with how hard people used the product,
  // to answer a question the histogram answers better. Counting is also free: no network, no promise,
  // nothing to fail on a tool call's hot path.
  // Started/settled as a pair rather than a bare counter: several agents can be inside runTool at
  // once, so a single "last start" field would attribute one tool's duration to another. The returned
  // closure carries this call's own identity, which is also what makes peak-concurrency measurable.
  // A daemon that has served even one tool call is doing a job for somebody; see daemon-usefulness.
  noteToolCall();
  // The impact record needs the project's own `.reticle` root, and this is the first place every
  // call knows it. Idempotent: the first root wins for the daemon's lifetime.
  initImpact({ reticleRoot: deps.reticleRoot });
  // An oversized argument is refused BEFORE the handler deserialises it.
  //
  // tool-fuzz failed CI on the invariant that matters most — `every tool answers every hostile call`
  // — for a ~100KB string. Seen twice with different tools; the earlier one came back
  // `-32001 sse_aborted` with the tool surface dropping 48→17, which is a RESTARTED daemon. The
  // shape is: oversized argument → the daemon dies → the proxy answers the in-flight call with
  // transport loss, and the next assertion is talking to a different daemon.
  //
  // `TRANSPORT_LIMITS.MAX_STRING_LENGTH` already bounds what crosses the bridge; a tool argument
  // arrives over MCP stdio and never met it. Here, because this is the one place every invocation
  // routes through, so a tool added later inherits the bound instead of having to remember it.
  //
  // A refusal is a normal answer. An UNANSWERED call is a hung agent, and that is the failure this
  // prevents: the agent learns its argument was too big, which is something it can fix.
  const oversized = firstOversizedArg(args);
  if (oversized !== undefined) {
    const error =
      `argument '${oversized}' is larger than ${String(TRANSPORT_LIMITS.MAX_STRING_LENGTH)} ` +
      'characters, which is the most Reticle moves in one call. Nothing ran. Send a smaller ' +
      'value — a selector or an id rather than a document, or a slice of the text you need.';
    // Refused before the handler was ever entered, and still a refusal the agent has to recover
    // from. Reported here rather than at the return below, which this branch never reaches.
    reportRefusal(tool.name, error);
    return { error };
  }
  // An ACTION is what gets abandoned. Counted here, against verifications, so "the agent drove the
  // page and then wandered off" becomes a number instead of an impression.
  if (ACTION_TOOLS.has(tool.name)) getSessionMetrics().recordAction();
  const settleTiming = getSessionMetrics().startToolCall(tool.name, args);
  const startedAt = Date.now();
  const rawSessionId = sessionIdFromArgs(args);
  const bound = SESSION_BOUND_TOOLS.has(tool.name);

  // Resolve the session identity ONCE, up front, for a live-session tool. The lease heartbeat must
  // target the session the handler will ACTUALLY drive — which, when the agent omits sessionId, is the
  // auto-selected one, NOT the raw (undefined) arg. Touching the raw arg meant an auto-selected drive
  // never refreshed its pool lease, so the reaper could reclaim the session mid-operation. Resolve
  // before the handler so a long ACT_AND_WAIT is protected for its whole duration; on failure leave it
  // to the handler to throw the canonical no-session error.
  let session: Session | undefined;
  if (bound || CDP_TOOLS.has(tool.name)) {
    try {
      session = deps.sessions.resolve(rawSessionId);
    } catch {
      session = undefined;
    }
  }
  // CDP tools against a skewed session: refuse with the sentence reticle_sessions already knows,
  // before Playwright invents a closed page. ready:true leases still hit this path.
  if (session?.versionSkew !== undefined && CDP_TOOLS.has(tool.name)) {
    const message = session.versionSkew;
    reportRefusal(tool.name, message);
    throw new Error(message);
  }
  // The read-only calls the journal never keeps, recorded HERE because this is the one dispatch
  // point every call routes through — a second recording site is a second thing to forget, and this
  // instrument exists precisely because nothing was recorded before. Recorded before the handler
  // runs: a read dispatches no action, so the counter reads the same either side.
  //
  // `reticle_context` is session-EXEMPT, so `session` above is undefined for it and it needs its own
  // lenient resolve. Failing that resolve is silent by design: a call made with nothing connected
  // has no per-session ledger to land in, and an instrument must never be why a tool call fails.
  //
  // EVERY tool is counted here, not just the read set: which of the 70-odd names in the table an
  // agent actually reaches for is the question a decision about cutting or consolidating the surface
  // turns on, and it had no answer. `reticle_run` is the one exclusion, for the same reason
  // `reportRefusal` and `bugsInResult` exclude it — its handler calls `runTool` on the real tool, so
  // the inner call is already counted under the name that RAN, and counting the wrapper too would
  // both double the total and hide the run-only tier behind a single wrapper name. That tier is
  // precisely the one the decision hinges on. See honesty/tool-hit-rate.ts.
  if (ReticleTool.RUN !== tool.name) {
    let target = session;
    if (target === undefined) {
      try {
        target = deps.sessions.resolve(rawSessionId);
      } catch {
        target = undefined;
      }
    }
    if (target !== undefined) {
      noteToolDispatched(target, tool.name);
      if (CAPTURED_TOOLS.has(tool.name)) {
        const subject = asString(args['ref']) ?? asString(args['target']);
        noteCapturedCall(target, {
          tool: tool.name,
          ...(subject === undefined ? {} : { subject }),
        });
      }
    }
  }
  // A ref that was handed out by a DIFFERENT tab, on a call that named no session. Refused here, at
  // the one point that knows both the ref and the tab resolution picked — the handler only learns
  // that the ref missed, and answers that with "the DOM re-rendered", which is a confident diagnosis
  // of the wrong thing. The other half is worse: the same ref can resolve to a different element in
  // the guessed tab and return a green about a page nobody asked about.
  if (session !== undefined) {
    const wrongTab = wrongTabRefusal({
      ref: spentRefFromArgs(args),
      explicitSessionId: rawSessionId,
      chosenSessionId: session.id,
      connected: () => deps.sessions.list(),
    });
    if (wrongTab !== undefined) {
      // Refused before the handler was entered, so it is reported here — the same shape as the
      // oversized-argument refusal above.
      reportRefusal(tool.name, wrongTab);
      return { error: wrongTab };
    }
  }
  const leaseId = session?.id ?? rawSessionId;
  if (leaseId !== undefined) deps.pool?.touch(leaseId);

  let raw: unknown;
  try {
    // The one dispatch point every tool call passes through, so it is where the trace's root span
    // belongs: with RETICLE_TRACE on, every stage that runs underneath inherits this call's id and
    // nests under it. Free when off — see trace.ts.
    raw = await span('tool.handler', { tool: tool.name, session: session?.id }, () =>
      tool.handler(deps, args),
    );
  } catch (error) {
    // The commonest refusal shape by far, and the one nothing could see: the message is built, handed
    // to the agent by the MCP boundary, and discarded. Reported here rather than at that boundary
    // because there are two of them (mcp.ts and the reticle_run hatch) and this is the one place both
    // go through — a third would otherwise be invisible from the day it was added.
    //
    // Under version skew, Playwright's "Target page has been closed" is the wrong cause (#688): the
    // page is still dialled in. Prefer the session's skew sentence when we already know the pair is
    // mismatched — including for tools that are not in CDP_TOOLS (real-input fallbacks that throw).
    let skewText = session?.versionSkew;
    if (skewText === undefined) {
      try {
        skewText = deps.sessions.resolve(rawSessionId).versionSkew;
      } catch {
        skewText = undefined;
      }
    }
    const rewritten = rewriteClosedAsSkew(error, skewText);
    const toThrow = rewritten ?? error;
    const message = toThrow instanceof Error ? toThrow.message : String(toThrow);
    reportRefusal(tool.name, message);
    // The invitation on THIS path is the one `buildErrorPayload` attaches when it does not recognise
    // the error, and it was never counted — so the denominator excluded the commonest friction there
    // is. Gated on the payload actually carrying the ask, because a recognised error gets a recovery
    // instead and counting an invitation nobody was shown breaks the ratio in the other direction.
    if (tool.name !== ReticleTool.RUN && buildErrorPayload(message).feedback !== undefined) {
      getSessionMetrics().recordFeedbackPrompt();
    }
    throw toThrow;
  } finally {
    // In a `finally` so a THROWN call still settles: otherwise every failing tool would leak a
    // concurrency slot and peakConcurrentTools would climb forever on an unhealthy session.
    settleTiming(Date.now() - startedAt);
  }
  // The human-feedback ask rides out on the first VERIFICATION that completes — the one moment the
  // experience is fresh and there is something concrete to react to. It is spliced BEFORE the
  // session-bound early return, because two of the four verification tools (flow_verify,
  // verify_change) are session-EXEMPT and would otherwise never carry it.
  if (isPlainObject(raw)) {
    // The brand comes from the session's own PAGE_HEALTH report, so it is present for the four
    // session-bound verification tools and absent for flow_verify (session-exempt) — which replays
    // into a browser Reticle launched, where `browser` already says what happened.
    recordVerification(tool.name, raw, Date.now() - startedAt, session?.brand);
    reportBugsFound(tool.name, raw);
  }
  // The other half of the refusal surface. A top-level `error` string IS this codebase's refusal
  // convention, so half the tools refuse by RETURNING one rather than throwing — and reading only the
  // throw path would have measured half the wall and called it the whole of it, the same way `isError`
  // once did. A call that was served clears the retry chain, so the next refusal after it is a first
  // refusal rather than a retry of something unrelated.
  // The user's own record of what Reticle did for them. Same chokepoint as everything else that
  // counts, for the same reason: a second recording site is a second thing to forget. Separate
  // store from telemetry - this one never leaves the machine.
  const finishedAt = Date.now();
  const defect = defectForToolResult(raw, finishedAt);
  // Which project's ledger this call belongs to. Resolved from the SESSION being driven, not from
  // wherever the daemon happens to stand: one daemon serves many projects, and recording every
  // call against its own cwd is how one app's verdicts ended up on another account's dashboard.
  // Falls back to the daemon root when no session can be named, which is the old behaviour.
  const artifactRoot = session?.artifactRoot ?? deps.reticleRoot;
  recordImpact(
    deltaForToolResult(raw, finishedAt - startedAt, resultIsError(raw)),
    { ...(defect === undefined ? {} : { defect }) },
    artifactRoot,
  );
  // ...and the tab being driven is told, so the report is live rather than a thing you reload.
  // Optional-call, not optional-chain-on-the-object: a test double is a partial Session, and a
  // courtesy push must never be the reason a tool call throws.
  // Bound to THIS session's root: a tab must be shown its own project's numbers, not whichever
  // project the daemon was started in.
  session?.pushImpact?.(() => impactSnapshot(artifactRoot));
  if (resultIsError(raw)) reportRefusal(tool.name, (raw as { error: string }).error);
  else {
    noteToolServed();
    // Which tab these refs belong to. Recorded on the way OUT, so the next call that spends one is
    // measured against the tab that actually produced it.
    if (session !== undefined && REF_MINTING_TOOLS.has(tool.name)) noteRefsMinted(session.id);
  }
  const prompt = isPlainObject(raw) ? takeFeedbackPrompt(tool.name) : undefined;
  // Same one-shot channel as the feedback ask: the agent is mid-task, so anything it would have to go
  // and ASK for is something it will never ask for. Spliced on ANY tool result, not just a
  // verification, because an out-of-date install is worth mentioning whatever the agent is doing.
  const update = isPlainObject(raw) ? takeUpdateNudge() : undefined;
  // Same one-shot channel, for the same reason. Skew was only ever reported in
  // reticle_sessions.versionSkew and a CLI log line — two places an agent driving a flow never
  // looks — so it could work a whole session against a mismatched pair and never learn the one fact
  // that explains the behaviour. It rides out here on whatever tool it happens to be calling.
  const skew = isPlainObject(raw) ? takeVersionSkew() : undefined;
  // A feedback report that was accepted and then failed to send. Same one-shot channel, because the
  // reporter is the only person who can act on it and they are not reading the daemon log — and a
  // report announced as accepted and then silently lost is the failure the awaited send existed to
  // prevent. See feedback-delivery.ts.
  const undelivered = isPlainObject(raw) ? takeFeedbackUndelivered() : undefined;
  // Invite feedback at the moment of friction, worded for what just happened. Counted, because
  // `feedback_submitted / feedbackPrompted` is the only thing that says whether the invitation works
  // at all rather than being decoration.
  //
  // This used to sit below the session-bound early return, which put it behind two conditions that
  // exclude most friction there is. A session-EXEMPT tool never reached it, and neither did a tool
  // that THREW — and throwing is the commonest refusal shape by a wide margin, i.e. exactly the
  // `refused` friction the line is written for. `errored` could only ever see the handlers that
  // RETURN an error. So the denominator was counting a small, unrepresentative slice of the
  // invitations and reading near-empty, which looks identical to a nudge that never fires.
  const friction = frictionInviteFor(tool.name, raw);
  const result =
    prompt === undefined &&
    update === undefined &&
    skew === undefined &&
    undelivered === undefined &&
    friction === undefined
      ? raw
      : {
          ...(raw as object),
          ...(friction !== undefined ? { [EnvelopeKey.FEEDBACK_INVITE]: inviteFor(friction) } : {}),
          ...(prompt !== undefined ? { [EnvelopeKey.FEEDBACK_PROMPT]: prompt } : {}),
          ...(update !== undefined ? { [EnvelopeKey.UPDATE_AVAILABLE]: update } : {}),
          ...(skew !== undefined ? { [EnvelopeKey.VERSION_SKEW]: skew } : {}),
          ...(undelivered !== undefined
            ? {
                [EnvelopeKey.FEEDBACK_UNDELIVERED]: `your earlier report did NOT send: ${undelivered}. Tell the human what you found so it is not lost.`,
              }
            : {}),
        };
  if (!bound || !isPlainObject(result)) return result;
  // Reuse the session resolved above so the health envelope describes the SAME session the handler
  // drove; only re-resolve if the up-front attempt failed but the handler somehow succeeded.
  const resolved = session ?? deps.sessions.resolve(rawSessionId);
  const envelope: Record<string, unknown> = {};
  // The health block is idempotent: add it only when the handler didn't already include a `session`.
  if (!('session' in result)) Object.assign(envelope, healthEnvelope(resolved));
  // Lease + age-warning are INDEPENDENT of the health block. Previously the `'session' in result`
  // early-return skipped them whenever a handler returned its own health (which a throttled tab always
  // does) — so a long-running backgrounded session, the case most likely to leak, never got the
  // one-time pool-lease reminder or the age cleanup nudge. Splice them regardless.
  const lease = resolved.takeSessionLease();
  if (lease !== undefined) envelope[EnvelopeKey.SESSION_LEASE] = lease;
  const warning = resolved.ageWarning();
  if (warning !== undefined) envelope[EnvelopeKey.SESSION_AGE_WARNING] = warning;
  // Ask for a verdict when the agent has driven the page and not asked for one. Almost every
  // verdict-less session in the field never called a verdict-producing tool ONCE;
  // the counter behind this already existed and was reported only to us. One-shot per abandoned
  // run, same discipline as the pool lease — a hint on every call is noise that gets tuned out.
  // The A/B control, and the reason it exists as an env flag rather than a code edit.
  //
  // `verify_next` is described in this repo's own changelog as "the largest known lever on whether a
  // session produces a verdict at all", and it has never been measured — it was once built, fired
  // and silently dropped by schema-strict clients for a whole release, which is exactly what an
  // unmeasured lever looks like from the inside. "The payload now arrives" and "the agent acts on
  // it" are different claims and only the first was ever verified.
  //
  // Suppressing it for a control arm has to leave the ONLY difference being the baton: same build,
  // same surface, same counters. So the nudge is still TAKEN (the counter still resets, so the
  // one-shot cadence is identical) and only the envelope key is withheld.
  const suppressBaton = '1' === process.env[SUPPRESS_VERIFY_NEXT_ENV];
  const unverified = getSessionMetrics().takeUnverifiedNudge();
  // Carry the CALL, not just the sentence. The prose has to be translated back into arguments, and
  // that translation is where agents were already going wrong — `until` omitted, action arguments
  // flat instead of nested under `args`. `ref` and `action` come from the act that actually
  // dispatched, so the suggestion is about the element the agent touched. See verify-next-baton.
  if (unverified !== undefined && !suppressBaton)
    // `lastAct` read defensively: this envelope is built on EVERY tool call, so a session shape
    // without it would turn a missing field into a crash on the whole surface rather than a missing
    // suggestion. The baton degrades to prose, which is what it carried before.
    envelope[EnvelopeKey.VERIFY_NEXT] = verifyNextBaton(
      unverified,
      resolved.lastAct?.effect() ?? {},
    );
  return Object.keys(envelope).length > 0 ? { ...result, ...envelope } : result;
}
