/**
 * The in-process session accumulator — the reason Reticle's telemetry bill does not scale with how
 * hard people use it.
 *
 * The old design emitted one event per MCP tool call. That reads as harmless until you multiply it
 * out: a single agent verification loop is 50–200 tool calls, so a thousand daily users would push
 * millions of events a day, and PostHog bills per ingested event. Worse, it was millions of events
 * answering a question that ONE property answers better — `{reticle_act: 40, reticle_assert: 12}`
 * tells you the session was a real verification loop, where 52 separate rows tell you only that 52
 * things happened, with the shape scattered across them.
 *
 * So counts live here, in memory, and leave as a single `daemon_stopped` event.
 *
 * Everything recorded is a COUNT or a fingerprint. No tool arguments, no results, no selectors, no
 * URLs, no error messages — the accumulator has no way to hold them, which is a stronger guarantee
 * than a rule saying it shouldn't.
 */
import {
  BrowserLaunchKind,
  type ConnectFailure,
  type ConnectionStats,
  type ErrorShape,
  type SessionSummary,
  type ToolTiming,
} from '@reticlehq/core';
import { errorSkeleton, fingerprintError } from './error-fingerprint.js';
import { describeToolParams } from './argument-shape.js';
import { machineSnapshot } from './machine-snapshot.js';
import { classifyError } from './error-class.js';

/** Cap the distinct error shapes held in memory — a pathological loop must not grow unbounded. */
const MAX_ERROR_KINDS = 40;
/** Distinct tool names whose repeat-runs are tracked. Its own cap: the tool surface, not error shapes. */
const MAX_REPEAT_TOOLS = 64;

/**
 * Tool errors that all mean the same thing to a user: the agent asked, and there was no app it could
 * reach. Three different messages, one experience — "nothing is connected" — and it is the error
 * that ends most sessions before a single verification happens.
 *
 * `multiple sessions connected` belongs here too: the agent could not reach AN app because it could
 * not tell which one, and the outcome is identical.
 */
const NO_SESSION_ERROR =
  /no browser session connected|no connected session with id|multiple sessions connected/i;
/** Cap distinct MCP clients recorded; more than a handful on one daemon is already the story. */
const MAX_CLIENTS = 8;
/** Bounds on the parameter map. Our own schemas are already finite; these are a belt-and-braces cap. */
const MAX_PARAM_TOOLS = 60;
const MAX_PARAMS_PER_TOOL = 24;
/**
 * How many recent tool calls to remember for the crash breadcrumb.
 *
 * Twelve is roughly one verification loop — enough to see the APPROACH (`snapshot → act → act →
 * assert`) rather than just the last step, which is what turns "it crashed in act-tools" into "it
 * crashed acting on a page it had just navigated away from". Names only, so this is a dozen short
 * strings and costs nothing to hold.
 */
const BREADCRUMB_LENGTH = 12;
/**
 * Actions driven with no verdict before Reticle asks for one.
 *
 * Three, because the median verdict-less session made FOUR tool calls (2026-08-10/11). A higher
 * threshold never fires for the sessions that need it most.
 */
const UNVERIFIED_ACTION_NUDGE_AT = 3;

/**
 * Mutable counters for one daemon lifetime. A plain class, not a store: it is process-local, it never
 * persists, and it dies with the daemon.
 */
export class SessionMetrics {
  #toolCalls = 0;
  #toolErrors = 0;
  #verifications = 0;
  /**
   * Session-LIFETIME totals for the four numbers the funnel is computed from.
   *
   * `reset()` zeroes every window counter on each periodic flush, but `durationMs` is measured from
   * `#startedAt` and is never reset. So the FINAL summary — the one whose docstring promises "the
   * whole session in a single event" — reported a 30-minute session containing zero tool calls,
   * because it only ever carried the residue since the last flush.
   *
   * In the field almost every `daemon_stopped` row had `toolCalls: 0`, at a median
   * duration of 30.5 minutes, while `session_progress` for the same daemons carried real tool
   * histograms. Anyone computing "did this session use Reticle" off the event named for the end of
   * the session got `no` essentially always. That is not a small skew — it is the funnel reading
   * zero at the exact step this release exists to raise.
   *
   * Window semantics are unchanged: `session_progress` still reports its own window, so nothing that
   * already sums those events double-counts. Only `final: true` swaps in the lifetime numbers.
   */
  #lifetimeToolCalls = 0;
  #lifetimeToolErrors = 0;
  #lifetimeVerifications = 0;
  #lifetimeBugsFound = 0;
  readonly #toolCounts = new Map<string, number>();
  readonly #toolParams = new Map<string, Map<string, number>>();
  /** Ring of the most recent tool NAMES — the agent's approach run, for a crash report. */
  readonly #breadcrumb: string[] = [];
  /** The tool currently in flight, so a crash can name its trigger point. */
  #inFlight: string | undefined;
  #sdkFailures = 0;
  readonly #sdkFailureKinds = new Map<string, ErrorShape>();
  readonly #errorKinds = new Map<string, ErrorShape>();
  readonly #connections = new Map<string, ConnectionStats>();
  readonly #toolTiming = new Map<string, ToolTiming>();
  #busyMs = 0;
  #concurrent = 0;
  #peakConcurrent = 0;
  #unknownToolCalls = 0;
  /**
   * Names the agent guessed at, session-LIFETIME — a guess made early must still be reported at
   * the end, so this is deliberately not cleared by a flush.
   */
  readonly #unknownTools = new Map<string, number>();
  #lifetimeUnknownToolCalls = 0;
  #bugsFound = 0;
  #browserMs = 0;
  #browserCommands = 0;
  readonly #bugKinds = new Map<string, number>();
  /**
   * Kinds already reported this session — the dedup key, deliberately SEPARATE from `#bugKinds`.
   *
   * `#bugKinds` is capped at MAX_ERROR_KINDS, and once full a genuinely new kind is never inserted,
   * so asking it "have I seen this?" answers no forever and marks every later occurrence as first —
   * inflating the distinct-defect count precisely where a session got interesting. This set is not
   * capped: the kind vocabulary is a bounded enum plus oracle names, not user data.
   */
  readonly #seenBugKinds = new Set<string>();
  /**
   * Tool errors meaning "the agent could not reach an app at all" — the single biggest drop-off in
   * the funnel, and until now reachable only by unpacking `errors[]` in HogQL. 74% of daemons never
   * call a tool, and of the sessions that made exactly one call, most bounced on this.
   */
  #noSessionErrors = 0;
  /** Connection-level MCP POST failures the SSE stream cannot see. See SessionSummary. */
  #postSocketFailures = 0;
  #lifetimePostSocketFailures = 0;
  /** Retries of those POSTs that then delivered. */
  #postRetriesSaved = 0;
  #lifetimePostRetriesSaved = 0;
  /** Longest back-to-back run per tool — a retry loop, which `toolCounts` cannot distinguish. */
  readonly #repeatRuns = new Map<string, number>();
  #lastTool: string | undefined;
  #currentRun = 0;
  /**
   * Actions driven since the last verdict — the run that is left hanging if the loop stops here.
   *
   * NOT `actions - verifications`. That difference ignores ORDER, so a verdict that drove nothing
   * (a `flow_verify` over saved flows) silently paid for a genuinely abandoned action elsewhere, and
   * a session could verify first and act after and look settled. What is abandoned is the trailing
   * run, which is exactly what the field claims to mean.
   */
  #unsettledActions = 0;
  /** One-shot latch for the verdict nudge — see takeUnverifiedNudge. */
  #nudgedUnverified = false;
  /** The agent detached. The one part of `endReason` a query cannot derive. */
  #clientLeft = false;
  /** Feedback invitations shown, session-lifetime — the denominator for feedback_submitted. */
  #feedbackPrompted = 0;
  /** Error buckets by whose defect. Session-lifetime: the mix is a fact about the session. */
  readonly #errorClasses = new Map<string, number>();
  /**
   * The recovery hinge. A call's outcome is only known once the NEXT one starts, so the verdict for
   * call N-1 is resolved at the start of call N (and for the last call, at summarize).
   */
  #currentCallErrored = false;
  #priorCallErrored = false;
  #errorsRecovered = 0;
  #errorsRepeated = 0;
  /**
   * App SDK connections, session-lifetime. NOT reset by a flush: "did an app ever connect" is a
   * fact about the session, and a page reload after a flush must not erase it.
   */
  #appConnects = 0;
  #firstAppAt: number | undefined;
  readonly #clients = new Set<string>();
  /** Client name -> version, session-lifetime. Never cleared: who drove is a fact about the session. */
  readonly #clientVersions = new Map<string, string>();
  /** Which tool surface the daemon advertised. */
  #surface: string | undefined;
  readonly #startedAt: number;
  readonly #now: () => number;

  /** Clock injected — this file must stay testable without a real one, per the repo's clock rule. */
  constructor(now: () => number) {
    this.#now = now;
    this.#startedAt = now();
  }

  /**
   * Record a call starting. Returns a function to call when it finishes — that closure is what makes
   * timing correct under CONCURRENCY: several agents can be inside `runTool` at once, so a single
   * "last start time" field would attribute one tool's duration to another. Each call carries its own.
   */
  startToolCall(tool: string, args?: Record<string, unknown>): (durationMs: number) => void {
    this.recordToolCall(tool, args);
    this.#concurrent += 1;
    if (this.#concurrent > this.#peakConcurrent) this.#peakConcurrent = this.#concurrent;
    let settled = false;
    return (durationMs: number) => {
      if (settled) return; // a double-settle would corrupt the concurrency count
      settled = true;
      this.#concurrent = Math.max(0, this.#concurrent - 1);
      this.#busyMs += durationMs;
      const timing = this.#toolTiming.get(tool) ?? { totalMs: 0, maxMs: 0 };
      timing.totalMs += durationMs;
      timing.maxMs = Math.max(timing.maxMs, durationMs);
      this.#toolTiming.set(tool, timing);
    };
  }

  /**
   * Time spent waiting on the BROWSER, across all commands.
   *
   * Compared against `busyMs` this answers the question a single total cannot: of the time an agent
   * spends inside Reticle, how much is us and how much is the app under test? Without the split a
   * 4-second `reticle_act` is unattributable — it could be our overhead or the app taking 4 seconds
   * to settle, and those have opposite fixes. A high ratio here is a finding about their app; a low
   * one alongside a high `busyMs` is a performance bug of ours.
   */
  recordBrowserLatency(ms: number): void {
    this.#browserMs += ms;
    this.#browserCommands += 1;
  }

  /** A call for a tool that does not exist. Non-zero means our surface is confusing the agent. */
  /**
   * An agent reached for a tool that does not exist — and WHAT it reached for.
   *
   * The name is the point. A count says the surface confused someone; the name says which
   * capability they expected us to have, in their own vocabulary. Safe to keep: it is a name from
   * our own namespace, never app data. Bounded and truncated, because a guess is a short
   * identifier and anything longer is not one.
   */
  recordUnknownTool(name?: string): void {
    this.#unknownToolCalls += 1;
    this.#lifetimeUnknownToolCalls += 1;
    if (name === undefined || 0 === name.length) return;
    const key = name.slice(0, 64);
    const seen = this.#unknownTools.get(key);
    if (seen !== undefined) {
      this.#unknownTools.set(key, seen + 1);
      return;
    }
    // Stop growing once full: a pathological loop must not balloon the payload. The head is what
    // gets built; the tail is noise.
    if (this.#unknownTools.size >= MAX_ERROR_KINDS) return;
    this.#unknownTools.set(key, 1);
  }

  recordToolCall(tool: string, args?: Record<string, unknown>): void {
    // `recordToolCall` runs BEFORE a handler and `recordToolError` after it fails, so a call's
    // outcome is only known once the NEXT call starts. Resolve the one before it here; the final
    // call is resolved in summarize.
    this.#resolveRecovery();
    // A run of the same tool back to back. Five calls to reticle_act is engagement; five in a row
    // after four failures is an agent stuck, and toolCounts reports both as "5".
    this.#currentRun = tool === this.#lastTool ? this.#currentRun + 1 : 1;
    this.#lastTool = tool;
    if (this.#currentRun > 1) {
      const best = this.#repeatRuns.get(tool) ?? 0;
      if (
        this.#currentRun > best &&
        (this.#repeatRuns.has(tool) || this.#repeatRuns.size < MAX_REPEAT_TOOLS)
      )
        this.#repeatRuns.set(tool, this.#currentRun);
    }
    this.#toolCalls += 1;
    this.#lifetimeToolCalls += 1;
    bump(this.#toolCounts, tool);
    this.#inFlight = tool;
    this.#breadcrumb.push(tool);
    if (this.#breadcrumb.length > BREADCRUMB_LENGTH) this.#breadcrumb.shift();
    if (args === undefined) return;
    // Which PARAMETERS get used, per tool — names only (plus a short allowlist of our own enums).
    // Bounded by our own schemas: a tool has a fixed handful of declared parameters, so this map
    // cannot grow with traffic the way a value-carrying one would.
    let perTool = this.#toolParams.get(tool);
    if (perTool === undefined) {
      if (this.#toolParams.size >= MAX_PARAM_TOOLS) return;
      perTool = new Map<string, number>();
      this.#toolParams.set(tool, perTool);
    }
    for (const param of describeToolParams(args)) {
      if (perTool.size < MAX_PARAMS_PER_TOOL || perTool.has(param)) bump(perTool, param);
    }
  }

  /**
   * One failed tool call. Grouped by fingerprint, but stored WITH its skeleton message and the tool
   * that produced it — a bare fingerprint could be ranked and never diagnosed, which made the top
   * error in the dashboard a number nobody could act on.
   */
  recordToolError(message: string, tool?: string): void {
    this.#toolErrors += 1;
    this.#lifetimeToolErrors += 1;
    // Whose defect. Only the `schema` bucket is fixable by writing better descriptions, and it was
    // indistinguishable from the rest inside one `toolErrors` count.
    bump(this.#errorClasses, classifyError(message));
    this.#currentCallErrored = true;
    if (NO_SESSION_ERROR.test(message)) this.#noSessionErrors += 1;
    const fingerprint = fingerprintError(message);
    const existing = this.#errorKinds.get(fingerprint);
    if (existing !== undefined) {
      existing.count += 1;
      return;
    }
    // Stop growing once the cap is hit; the tail is noise and the head is what gets fixed.
    if (this.#errorKinds.size >= MAX_ERROR_KINDS) return;
    this.#errorKinds.set(fingerprint, {
      fingerprint,
      count: 1,
      message: errorSkeleton(message),
      ...(tool !== undefined ? { tool } : {}),
    });
  }

  /**
   * A failure reported by the IN-PAGE half of Reticle, over the bridge.
   *
   * Kept in its own bucket rather than mixed into tool errors: a broken observer and a failing tool
   * call are different defects with different owners, and merging them would hide the browser-side
   * one inside a much larger pile. Same treatment otherwise — fingerprinted, variables stripped.
   */
  recordSdkFailure(site: string, message: string): void {
    this.#sdkFailures += 1;
    const fingerprint = fingerprintError(`${site}|${message}`);
    const existing = this.#sdkFailureKinds.get(fingerprint);
    if (existing !== undefined) {
      existing.count += 1;
      return;
    }
    if (this.#sdkFailureKinds.size >= MAX_ERROR_KINDS) return;
    this.#sdkFailureKinds.set(fingerprint, {
      fingerprint,
      count: 1,
      message: errorSkeleton(message),
      tool: site,
    });
  }

  /**
   * The MCP proxy could not POST a tool call because the TCP socket itself failed (`ENOBUFS`,
   * `EMFILE`, `ECONNREFUSED` before any bytes left). The SSE stream is still up, so this is
   * invisible to `mcp_connection_lost`, and the handler never ran, so it is invisible to
   * `tool_refused`. Counted so a dashboard can see it without a new event kind.
   */
  recordPostSocketFailure(): void {
    this.#postSocketFailures += 1;
    this.#lifetimePostSocketFailures += 1;
  }

  /**
   * A bounded retry of an unsent POST then delivered. The pair against `recordPostSocketFailure`:
   * the retry that quietly saved a call is a different fact from the one that never ran.
   */
  recordPostRetrySaved(): void {
    this.#postRetriesSaved += 1;
    this.#lifetimePostRetriesSaved += 1;
  }

  /** The agent's recent approach run + the call in flight — context for a crash report. */
  get trail(): { breadcrumb: string[]; inFlight: string | undefined } {
    return { breadcrumb: [...this.#breadcrumb], inFlight: this.#inFlight };
  }

  /**
   * Ask the agent for a verdict, once, when it has driven the page without asking for one.
   *
   * In the field most sessions that made a tool call produced no verdict — and
   * **almost all of those never called a verdict-producing tool even once.** They drove the app
   * with `reticle_act` and never asked whether it worked. This counter already existed
   * (`abandonedActions`); it was reported to US and never to the agent.
   *
   * Three is the threshold because the median verdict-less session made four tool calls: any higher
   * and it never fires for the sessions that need it. Re-arms after a verdict, so a second
   * abandoned run is caught — the loop can break more than once in a long session.
   */
  takeUnverifiedNudge(): string | undefined {
    if (this.#unsettledActions < UNVERIFIED_ACTION_NUDGE_AT || this.#nudgedUnverified) {
      return undefined;
    }
    this.#nudgedUnverified = true;
    return (
      `you have driven this page ${String(this.#unsettledActions)} times without asking for a ` +
      'verdict. Only reticle_act_and_wait and reticle_assert produce one — everything else moves ' +
      'or reads the app and proves nothing. Name the consequence you expect and check it: ' +
      'reticle_assert({ sessionId, since, predicate }), or use reticle_act_and_wait({ ref, ' +
      'action, until }) for the next step so the action and its check are one call.'
    );
  }

  /**
   * An app's SDK dialled this daemon.
   *
   * Zero of these at shutdown means the daemon ran and no app ever connected — a broken install.
   * Non-zero with no tool calls is the opposite problem. See SessionSummary.appConnects.
   */
  recordAppConnected(): void {
    this.#appConnects += 1;
    this.#firstAppAt ??= this.#now();
  }

  /** One action driven at the page. Settled by the next verdict; see #unsettledActions. */
  recordAction(): void {
    this.#unsettledActions += 1;
  }

  recordVerification(): void {
    this.#verifications += 1;
    this.#lifetimeVerifications += 1;
    // A verdict settles whatever was outstanding, however many actions it took to get there.
    this.#unsettledActions = 0;
    // Re-arm the nudge: the loop can break more than once in an 11-hour session, and an agent that
    // complied once and then drifted again is exactly the case worth catching.
    this.#nudgedUnverified = false;
  }

  /**
   * One defect found in the app under test — the outcome number, kept broken down by kind.
   *
   * Returns TRUE when this kind is new to the session. Every occurrence is still counted; the flag
   * only lets a reader separate "how many distinct defects" from "how often they were hit", which
   * are different claims and were previously indistinguishable in the data.
   */
  recordBug(kind: string): boolean {
    this.#bugsFound += 1;
    this.#lifetimeBugsFound += 1;
    if (this.#bugKinds.size < MAX_ERROR_KINDS || this.#bugKinds.has(kind))
      bump(this.#bugKinds, kind);
    const first = !this.#seenBugKinds.has(kind);
    this.#seenBugKinds.add(kind);
    return first;
  }

  /**
   * One connection ATTEMPT. Call before the attempt; settle it with the outcome.
   *
   * The previous version counted only successes, and counted them inconsistently — incrementing
   * before the await on the CDP path and after it on the launch path — so one number meant attempts,
   * the others meant successes, and nothing in the data said which. A connection metric that cannot
   * express failure misses the only question worth asking: how often can people not get a browser?
   */
  recordConnectAttempt(kind: BrowserLaunchKind): (failure?: ConnectFailure) => void {
    const stats = this.#connections.get(kind) ?? { attempts: 0, successes: 0 };
    stats.attempts += 1;
    this.#connections.set(kind, stats);
    let settled = false;
    return (failure?: ConnectFailure) => {
      if (settled) return;
      settled = true;
      if (failure === undefined) {
        stats.successes += 1;
        return;
      }
      stats.failures ??= {};
      stats.failures[failure] = (stats.failures[failure] ?? 0) + 1;
    };
  }

  recordClient(name: string, version?: string): void {
    const key = name.slice(0, 64);
    if (this.#clients.size < MAX_CLIENTS) this.#clients.add(key);
    // The version was already in the handshake and was being dropped. A regression in agent
    // behaviour is usually a client version, and without this it is unattributable.
    if (version !== undefined && '' !== version && this.#clientVersions.size < MAX_CLIENTS) {
      this.#clientVersions.set(key, version.slice(0, 32));
    }
  }

  /**
   * The agent's client went away.
   *
   * This is the only part of `endReason` that a query cannot derive from the counters: "the client
   * detached" and "the agent stopped asking" produce identical numbers and are different findings —
   * one is the task ending, the other is us losing them.
   */
  recordClientLeft(): void {
    this.#clientLeft = true;
  }

  /** How many times in a row the current tool has been called. Read by the friction invite. */
  get currentRun(): number {
    return this.#currentRun;
  }

  /** Reticle invited the agent to send feedback. The denominator for feedback_submitted. */
  recordFeedbackPrompt(): void {
    this.#feedbackPrompted += 1;
  }

  /** Which tool surface was advertised to agents this session. */
  recordSurface(surface: string): void {
    this.#surface = surface.slice(0, 32);
  }

  /**
   * Roll the counters into the event payload. `final` marks a clean shutdown; a periodic flush passes
   * false so a session killed before it can exit is not lost entirely (see the flush note in cli.ts).
   */
  summarize(final: boolean, exit?: SessionSummary['exit']): SessionSummary {
    // The last call has no successor to resolve it, so resolve it here. Only on a FINAL summary:
    // a periodic flush is not the end of anything and would resolve a call still in flight.
    if (final) this.#resolveRecovery();
    const machine = machineSnapshot();
    // A FINAL summary reports the session; a periodic flush reports its window. `durationMs` was
    // always session-lifetime, so a windowed count next to it described a 30-minute session that
    // made no calls. The histograms below stay windowed by design — summing them across a session's
    // events is correct, and duplicating every map to make them lifetime would double the memory
    // this class exists to keep small.
    const scalars = final
      ? {
          toolCalls: this.#lifetimeToolCalls,
          toolErrors: this.#lifetimeToolErrors,
          verifications: this.#lifetimeVerifications,
          bugsFound: this.#lifetimeBugsFound,
          postSocketFailures: this.#lifetimePostSocketFailures,
          postRetriesSaved: this.#lifetimePostRetriesSaved,
        }
      : {
          toolCalls: this.#toolCalls,
          toolErrors: this.#toolErrors,
          verifications: this.#verifications,
          bugsFound: this.#bugsFound,
          postSocketFailures: this.#postSocketFailures,
          postRetriesSaved: this.#postRetriesSaved,
        };
    return {
      durationMs: Math.max(0, this.#now() - this.#startedAt),
      toolCalls: scalars.toolCalls,
      toolCounts: Object.fromEntries(this.#toolCounts),
      toolErrors: scalars.toolErrors,
      ...(this.#errorKinds.size > 0 ? { errors: [...this.#errorKinds.values()] } : {}),
      sdkFailures: this.#sdkFailures,
      ...(this.#sdkFailureKinds.size > 0 ? { sdkErrors: [...this.#sdkFailureKinds.values()] } : {}),
      verifications: scalars.verifications,
      bugsFound: scalars.bugsFound,
      ...(this.#bugKinds.size > 0 ? { bugKinds: Object.fromEntries(this.#bugKinds) } : {}),
      ...(this.#noSessionErrors > 0 ? { noSessionErrors: this.#noSessionErrors } : {}),
      ...(scalars.postSocketFailures > 0 ? { postSocketFailures: scalars.postSocketFailures } : {}),
      ...(scalars.postRetriesSaved > 0 ? { postRetriesSaved: scalars.postRetriesSaved } : {}),
      ...(this.#repeatRuns.size > 0
        ? { consecutiveRepeats: Object.fromEntries(this.#repeatRuns) }
        : {}),
      // Absent rather than zero, so the PRESENCE of the field is the signal on a dashboard.
      ...(this.#unsettledActions > 0 ? { abandonedActions: this.#unsettledActions } : {}),
      ...(this.#toolParams.size > 0
        ? {
            toolParams: Object.fromEntries(
              [...this.#toolParams].map(([tool, params]) => [tool, Object.fromEntries(params)]),
            ),
          }
        : {}),
      ...(this.#connections.size > 0 ? { connections: Object.fromEntries(this.#connections) } : {}),
      ...(this.#toolTiming.size > 0 ? { toolTiming: Object.fromEntries(this.#toolTiming) } : {}),
      busyMs: this.#busyMs,
      browserMs: this.#browserMs,
      browserCommands: this.#browserCommands,
      peakConcurrentTools: this.#peakConcurrent,
      unknownToolCalls: final ? this.#lifetimeUnknownToolCalls : this.#unknownToolCalls,
      ...(this.#unknownTools.size > 0
        ? { unknownTools: Object.fromEntries(this.#unknownTools) }
        : {}),
      ...(machine !== undefined ? { machine } : {}),
      ...(this.#clients.size > 0 ? { clients: [...this.#clients] } : {}),
      ...(this.#clientVersions.size > 0
        ? { clientVersions: Object.fromEntries(this.#clientVersions) }
        : {}),
      ...(this.#surface === undefined ? {} : { surface: this.#surface }),
      ...(final ? { endReason: this.#endReason() } : {}),
      // The headline metric, as a FIELD. Read off the lifetime counter, because every other
      // verification number in this payload is windowed and a reader who summed the wrong one got a
      // different question's answer. `false` is sent, not omitted: a session that drove an app and
      // never asked whether it worked is the whole finding.
      ...(final ? { endedWithVerdict: this.#lifetimeVerifications > 0 } : {}),
      ...(this.#feedbackPrompted > 0 ? { feedbackPrompted: this.#feedbackPrompted } : {}),
      ...(this.#errorClasses.size > 0
        ? { errorClasses: Object.fromEntries(this.#errorClasses) }
        : {}),
      ...(this.#errorsRecovered > 0 ? { errorsRecovered: this.#errorsRecovered } : {}),
      ...(this.#errorsRepeated > 0 ? { errorsRepeated: this.#errorsRepeated } : {}),
      // Always present, including zero: absence and "no app ever connected" must not look alike,
      // because zero IS the finding here.
      appConnects: this.#appConnects,
      ...(this.#firstAppAt === undefined
        ? {}
        : { msToFirstApp: Math.max(0, this.#firstAppAt - this.#startedAt) }),
      final,
      // Only on a real exit. A periodic flush carrying `exit: "unknown"` would read as a daemon that
      // died without a shutdown path, which is the one thing this field exists to make visible.
      ...(final && exit !== undefined ? { exit } : {}),
    };
  }

  /**
   * Decide whether the error before the previous call was recovered from or repeated.
   *
   * Called at the start of each new call (resolving the one before it) and once at summarize (for
   * the last call). Shifting rather than counting on the spot is what makes "the agent tried
   * something else and it worked" distinguishable from "it failed the same way again" — an earlier
   * version counted a recovery the moment a call STARTED, so a call that then failed was recorded
   * as a success.
   */
  #resolveRecovery(): void {
    if (this.#priorCallErrored) {
      if (this.#currentCallErrored) this.#errorsRepeated += 1;
      else this.#errorsRecovered += 1;
    }
    this.#priorCallErrored = this.#currentCallErrored;
    this.#currentCallErrored = false;
  }

  /**
   * What state the agent's work was in at the end. Ordered by which fact outranks which: a client
   * that left explains everything after it, and a verdict settles whatever preceded it.
   */
  #endReason(): NonNullable<SessionSummary['endReason']> {
    if (0 === this.#lifetimeToolCalls) return 'never_used';
    if (this.#clientLeft) return 'client_left';
    if (this.#unsettledActions > 0) return 'abandoned';
    if (this.#lifetimeVerifications > 0) return 'verified';
    return 'explored';
  }

  /**
   * Has an agent ever attached to this daemon?
   *
   * Read by the stall clock, which needs to tell two very different silences apart:
   * a daemon nobody is using, and a daemon with an agent sitting on it that has no app to drive.
   * The second is the funnel's failure case and the first is not a problem at all.
   */
  get agentEverAttached(): boolean {
    return this.#clients.size > 0;
  }

  /** True when nothing at all happened — a flush of an idle daemon is not worth an event. */
  get empty(): boolean {
    return (
      0 === this.#toolCalls &&
      0 === this.#verifications &&
      0 === this.#toolErrors &&
      0 === this.#bugsFound &&
      0 === this.#sdkFailures &&
      0 === this.#postSocketFailures &&
      0 === this.#postRetriesSaved
    );
  }

  /** Zero the counters after a non-final flush so the next flush reports the NEXT window, not a total. */
  reset(): void {
    this.#toolCalls = 0;
    this.#toolErrors = 0;
    this.#verifications = 0;
    this.#noSessionErrors = 0;
    this.#postSocketFailures = 0;
    this.#postRetriesSaved = 0;
    this.#repeatRuns.clear();
    this.#lastTool = undefined;
    this.#currentRun = 0;
    this.#unsettledActions = 0;
    this.#toolCounts.clear();
    this.#toolParams.clear();
    this.#errorKinds.clear();
    this.#sdkFailures = 0;
    this.#sdkFailureKinds.clear();
    this.#connections.clear();
    this.#toolTiming.clear();
    this.#busyMs = 0;
    this.#browserMs = 0;
    this.#browserCommands = 0;
    this.#peakConcurrent = 0;
    this.#unknownToolCalls = 0;
    this.#bugsFound = 0;
    this.#bugKinds.clear();
    // #seenBugKinds is deliberately NOT cleared. It is not a window counter — it is the
    // session-lifetime memory behind `repeat` on bug_found, and zeroing it made the same defect,
    // found again after a flush, report as a newly distinct one. Sessions run to 11.5 hours in the
    // data, so that was up to 23 chances to count one defect many times.
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * The process-wide accumulator. A module singleton because the two call sites that feed it — the tool
 * chokepoint and the MCP error boundary — are far apart in the graph and threading a metrics object
 * through every ToolDeps would be a large, purely mechanical change for no added safety.
 */
let current: SessionMetrics | undefined;

export const getSessionMetrics = (now: () => number = () => Date.now()): SessionMetrics =>
  (current ??= new SessionMetrics(now));

/** Record one browser round-trip. Free-function form so the session hot path is a single call. */
export const recordBrowserLatency = (ms: number): void => {
  getSessionMetrics().recordBrowserLatency(ms);
};

/** Narrow-and-record one in-page failure. Keeps the session hot path to a single call. */
export const recordSdkFailure = (failure: { site: string; message: string }): void => {
  getSessionMetrics().recordSdkFailure(failure.site, failure.message);
};

/** Tests only — drop the singleton so each case starts from zero. */
export const resetSessionMetrics = (): void => {
  current = undefined;
};
