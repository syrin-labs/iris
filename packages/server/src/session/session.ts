import type { WebSocket } from 'ws';
import type { ImpactSnapshot } from '@reticlehq/core';
import { recordImpact } from '../impact/impact-recorder.js';
import { LastAct } from './last-act.js';
import { GapLedger } from '../honesty/gap-ledger.js';
import { CaptureLedger } from '../honesty/feature-capture.js';
import { commandTimeoutMessage, type PageRuntime } from './command-timeout.js';
import { readHealthEvent, type SessionHealth } from './session-health.js';
import { MIRRORED_COMMANDS, mirroredNarration } from './session-mirror.js';

export type { SessionHealth };

/** The HUD does not need 200 frames to watch a counter climb; the last state always lands. */
const IMPACT_PUSH_DEBOUNCE_MS = 700;

import { PendingCommands, CommandTimeoutError } from './pending-commands.js';
import { span } from '../trace.js';
import {
  AppRuntime,
  EventType,
  HumanControlDataSchema,
  HumanControlKind,
  HumanMarkDataSchema,
  ReticleCommand,
  MessageKind,
  parseEventPayload,
  PresenterTone,
  SESSION_HEALTH,
  SESSION_LEASE,
  SESSION_LIFECYCLE,
  SessionState,
  type BrowserBrand,
  type CommandResult,
  type JournalAction,
  type HelloMessage,
  type HumanControlData,
  type ReticleEvent,
} from '@reticlehq/core';
import { RingBuffer } from '../events/ring-buffer.js';
import type { JournalReader, JournalRecorder } from '../journal/journal-recorder.js';
import {
  filterEvents,
  mergeEventsBySeq,
  type EventQueryOptions,
} from '../journal/journal-query.js';
import { type AmbientCounts } from '../journal/ambient.js';
import { ObservedState } from './observed-state.js';
import { recordBrowserLatency, recordSdkFailure } from '../telemetry/session-metrics.js';
import { LiveControl, type InboxMessage } from './live-control.js';
export type { InboxMessage } from './live-control.js'; // moved; still part of Session's surface
import { ReviewStore, type ReviewMark } from './review-store.js';
import { buildSessionRecommendation } from './session-recommendation.js';
import { buildPresenterArgs } from './presenter-args.js';
import { buildSessionLease, type SessionLease } from './session-lease.js';
import type { SessionInfo } from './session-info.js';
export type { SessionInfo } from './session-info.js';
import { buildSessionInfo } from './session-info.js';

type Clock = () => number;

const DEFAULT_COMMAND_TIMEOUT_MS = 8000;

/** Prefix on correlated command ids (c1, c2, …) — distinguishes them from mark ids. */
const COMMAND_ID_PREFIX = 'c';

/**
 * Commands that may be re-issued against the connection that replaced this session.
 *
 * Reads only, and the boundary is the point. Re-reading a page costs nothing and answers the same
 * question the caller asked. An act cannot be replayed: it may already have been dispatched in the
 * page that went away, and performing it a second time behind the caller's back is a double submit
 * nobody asked for. A replaced act still errors, and the caller's own retry — with the same id,
 * which is still the right one — is the safe path.
 */
/**
 * How far to walk a chain of replacements before giving up.
 *
 * Generous for the real case (a page reloading a handful of times while a call is in flight) and
 * small enough that a cycle costs nothing. The number is a backstop, not a policy: a chain longer
 * than this means something is re-dialling in a loop, and that is a different problem.
 */
const MAX_SUCCESSOR_HOPS = 32;

const REBINDABLE_COMMANDS: ReadonlySet<string> = new Set<string>([
  ReticleCommand.SNAPSHOT,
  ReticleCommand.QUERY,
  ReticleCommand.MATCH,
  ReticleCommand.INSPECT,
  ReticleCommand.STATE_READ,
  ReticleCommand.STORAGE_READ,
  ReticleCommand.CAPABILITIES,
  ReticleCommand.ANIMATIONS,
]);

/** Prefix on minted action ids (a1, a2, …) — the journal's action identity, independent of commands. */
const ACTION_ID_PREFIX = 'a';

/**
 * How many consecutive unanswered commands make a tab unresponsive. One is a page that was merely
 * busy for its budget; two in a row with no reply between them is a wedge, and the cost of being
 * wrong about that is one extra browser tab.
 */
const UNRESPONSIVE_AFTER_TIMEOUTS = 2;

/** ws readyState for an OPEN socket — guard fire-and-forget pushes against a closing tab. */
const WS_OPEN = 1;

/**
 * One connected browser tab. Owns its socket, a ring buffer of observations, and the
 * in-flight command map. `clock` is injected so elapsed-time logic stays testable.
 */
export class Session {
  readonly id: string;
  /** Stable build-stamped project identity; undefined for v1.0 SDKs that omit it. */
  readonly projectId: string | undefined;
  /**
   * The `.reticle` directory this session's evidence belongs in — impact counters AND capsules.
   *
   * Stamped once when the session is created, from the project it declared in HELLO, rather than
   * resolved per call: the answer cannot change while the tab is connected, and resolving it once
   * means every counter that fires for this session agrees about where it goes.
   *
   * Undefined when nothing could name a project — the caller then falls back to the daemon's own
   * root, which is what every counter did unconditionally before this existed.
   */
  artifactRoot: string | undefined;
  url: string;
  title: string;
  adapters: string[];
  hasCapabilities: boolean;
  /** Set when the page's SDK version differs from the daemon's (see version-skew.ts). */
  versionSkew?: string;
  /**
   * Extra key names this app declared sensitive via `connect({ redact: { keys } })`. Held so the
   * DRIVEN path can redact them too — a request body the daemon captures from the network stack
   * never passes through the SDK, so nothing else would.
   */
  readonly redactKeys: readonly string[];

  readonly #socket: WebSocket;
  readonly #clock: Clock;
  readonly #startedAt: number;
  readonly #buffer = new RingBuffer();
  readonly #pending = new PendingCommands();
  readonly #listeners = new Set<(event: ReticleEvent) => void>();
  readonly #disconnectListeners = new Set<() => void>();
  #actionSeq = 0;
  /** Consecutive missed command budgets — free liveness evidence. Any reply resets it. */
  #unansweredCommands = 0;
  #lastSeenAt: number;
  #hidden = false;
  /** Which shell the page reported (PAGE_HEALTH). Undefined until the first report lands. */
  #runtime: PageRuntime | undefined;
  #engine: string | undefined;
  /** Which browser the page said it is (chrome/edge/arc/…). Undefined on an SDK too old to report one. */
  #brand: BrowserBrand | undefined;
  #focused = true;
  /** Liveness: wall-clock of the last AGENT command (distinct from browser chatter / lastSeen). */
  #lastAgentActivityAt: number;
  /** Server-side mirror of the agent-tuned idle window, so the reaper honors reticle_session. */
  #idleEndMs: number = SESSION_LIFECYCLE.IDLE_END_MS;
  /** True when the reaper/disconnect ended this session — such an end is revivable; explicit ends are not. */
  #autoEnded = false;
  readonly #live = new LiveControl();
  /** Human review marks: mistakes the human pinned to elements, for the agent to drain and fix. */
  readonly #review = new ReviewStore();
  /** Whether the session_lease has already been returned (fire-once per session). */
  #firstCommandDone = false;
  /** Durable causal-journal recorder; undefined when journaling is off (opt-out or not yet attached). */
  #journal: JournalRecorder | undefined;
  #activeActionId: string | undefined; // action window, held independently of the journal
  /** Read side of the journal, for queries that must survive ring-buffer eviction. */
  #journalReader: JournalReader | undefined;
  /** What this session has learned by watching its own stream: ambient churn + blind-spot levels. */
  readonly #observed = new ObservedState();
  /**
   * Which document is on screen right now — the one the most recent stamped event was observed under.
   *
   * DERIVED, never announced. The SDK mints a document id once per real document and stamps it on
   * every event, so the stream already carries the answer; asking the page for it separately would be
   * a second source of truth that can disagree with the evidence it is supposed to scope. A full
   * navigation or a reload builds a new document, mints a new id, and the first event carrying it
   * moves this forward — which is exactly the moment the previous document's evidence stops being
   * about the world. An SPA route change keeps the same document and so keeps the same id, which is
   * correct rather than a limitation: same JavaScript context, same in-flight requests, same evidence.
   *
   * An UNSTAMPED event never clears this. An SDK older than the field stamps nothing, and letting one
   * such event blank the current document would make every later comparison vacuous.
   */
  #documentId: string | undefined;
  /**
   * The edit epoch of the most recent stamped event. DERIVED for the same reason `#documentId` is:
   * the stream already carries it, and asking the page separately would be a second source of truth.
   *
   * A hot update advances it INSIDE the same document, which is the case `#documentId` structurally
   * cannot see — no navigation, same page, replaced code. An unstamped event never clears it: most
   * pages have no hot-update channel at all, so absence is "unknown", never "back to no edits".
   */
  #editEpoch: number | undefined;

  constructor(hello: HelloMessage, socket: WebSocket, clock: Clock) {
    this.id = hello.sessionId;
    this.projectId = hello.projectId;
    this.url = hello.url;
    this.title = hello.title;
    this.adapters = hello.adapters;
    this.hasCapabilities = hello.hasCapabilities ?? false;
    this.redactKeys = hello.redactKeys ?? [];
    this.#socket = socket;
    this.#clock = clock;
    this.#startedAt = clock();
    this.#lastSeenAt = clock();
    this.#lastAgentActivityAt = clock();
  }

  /** Milliseconds since this session connected — the authoritative buffer clock. */
  elapsed(): number {
    return this.#clock() - this.#startedAt;
  }

  /** Mark that the SDK was just heard from. Called on every inbound message. */
  touch(): void {
    this.#lastSeenAt = this.#clock();
  }

  /** ms since the SDK last reported anything (distinct from elapsed-since-connect). */
  lastSeenMs(): number {
    return this.#clock() - this.#lastSeenAt;
  }

  /**
   * Record the latest page visibility/focus state from a PAGE_HEALTH event.
   *
   * `runtime` is optional so an older SDK (which does not report it) still works — it simply loses
   * the desktop-specific timeout diagnosis rather than breaking.
   */
  applyHealth(
    hidden: boolean,
    focused: boolean,
    runtime?: string,
    engine?: string,
    brand?: BrowserBrand,
  ): void {
    this.#hidden = hidden;
    this.#focused = focused;
    if (
      AppRuntime.ELECTRON === runtime ||
      AppRuntime.TAURI === runtime ||
      AppRuntime.WEB === runtime
    ) {
      this.#runtime = runtime;
    }
    if (engine !== undefined) this.#engine = engine;
    if (brand !== undefined) this.#brand = brand;
  }

  /** The shell (web/electron/tauri) and rendering engine the SDK reported. Undefined on an older SDK. */
  get runtime(): PageRuntime | undefined {
    return this.#runtime;
  }
  get engine(): string | undefined {
    return this.#engine;
  }
  /** The browser brand the SDK reported. Absent (never guessed) when the page did not say. */
  get brand(): BrowserBrand | undefined {
    return this.#brand;
  }

  /** Throttled if the tab is hidden OR we have not heard from it recently. */
  throttled(): boolean {
    return this.#hidden || this.lastSeenMs() > SESSION_HEALTH.STALE_THRESHOLD_MS;
  }

  /** The attachable health block — single source of truth for the tools. */
  health(): SessionHealth {
    const base: SessionHealth = {
      lastSeenMs: this.lastSeenMs(),
      throttled: this.throttled(),
      focused: this.#focused,
    };
    // attach the escape-hatch hint only when un-scriptable (keeps field absent otherwise).
    const recommendation = buildSessionRecommendation({
      hidden: this.#hidden,
      throttled: base.throttled,
      focused: base.focused,
      // Without this the desktop branch is unreachable in production: every unit test would pass and
      // every real Electron window would still be told to open a browser.
      runtime: this.#runtime,
    });
    return recommendation === undefined ? base : { ...base, recommendation };
  }

  info(): SessionInfo {
    return buildSessionInfo({
      id: this.id,
      url: this.url,
      projectId: this.projectId,
      title: this.title,
      adapters: this.adapters,
      hasCapabilities: this.hasCapabilities,
      runtime: this.#runtime,
      versionSkew: this.versionSkew,
      hidden: this.#hidden,
      health: () => this.health(),
      staleMs: () => this.staleMs(),
      pendingMarkCount: () => this.#review.pendingCount(),
      unresponsive: () => this.unresponsive(),
    });
  }

  /**
   * Attached but not answering. A tab can be `connected` with a fresh `lastSeenMs` and still answer
   * nothing: `lastSeenMs` measures the events the SDK streams, not the commands it replies to. Reuse
   * and auto-selection read that as health, so `reticle open` handed a wedged tab back forever and
   * `reticle_session{action:"end"}` — a flag on the record, not on the page — could not help.
   */
  unresponsive(): boolean {
    return this.#unansweredCommands >= UNRESPONSIVE_AFTER_TIMEOUTS;
  }

  /** Wall-clock age of the session in milliseconds. */
  staleMs(): number {
    return this.#clock() - this.#startedAt;
  }

  /** The document the most recent stamped event was observed under. See `#documentId`. */
  get currentDocumentId(): string | undefined {
    return this.#documentId;
  }

  /** The edit epoch the most recent stamped event was observed under. See `#editEpoch`. */
  get currentEditEpoch(): number | undefined {
    return this.#editEpoch;
  }

  /** Re-stamp an incoming event with server-relative time, buffer it, and fan out. */
  pushEvent(event: ReticleEvent, byteSize?: number): void {
    if (event.documentId !== undefined) this.#documentId = event.documentId;
    if (event.editEpoch !== undefined) this.#editEpoch = event.editEpoch;
    if (event.type === EventType.PAGE_HEALTH) {
      const r = readHealthEvent(event.data);
      this.applyHealth(
        r.hidden ?? this.#hidden,
        r.focused ?? this.#focused,
        r.runtime,
        r.engine,
        r.brand,
      );
    }
    // The in-page half of Reticle reporting its own failure — recorded like a tool error
    // (fingerprinted, variables stripped) so a broken observer is as visible as a broken tool.
    if (event.type === EventType.SDK_FAILED) {
      const sdk = parseEventPayload(EventType.SDK_FAILED, event.data);
      if (sdk.success) recordSdkFailure(sdk.data as { site: string; message: string });
    }
    if (event.type === EventType.HUMAN_CONTROL) {
      // Narrow unknown at the boundary; an invalid/unknown control is ignored (never thrown).
      const parsed = HumanControlDataSchema.safeParse(event.data);
      if (parsed.success) this.applyHumanControl(parsed.data);
    }
    if (event.type === EventType.HUMAN_MARK) {
      // A human pinned a mistake to an element. Narrow at the boundary; an invalid mark is ignored.
      const parsed = HumanMarkDataSchema.safeParse(event.data);
      if (parsed.success) {
        this.#review.add(parsed.data, this.elapsed());
        // The impact record's `marks` field existed and nothing ever wrote it: the report would
        // have shown a permanent zero next to a page covered in pins.
        recordImpact({ marks: 1 }, {}, this.artifactRoot);
      }
    }
    if (event.type === EventType.ROUTE_CHANGE) {
      // Keep the reported URL live across SPA navigation. The SDK already emits route.change on
      // pushState/replaceState/popstate; without this the URL stays frozen at the hello value, and
      // URL-based CDP correlation (real input) silently breaks after the first client-side nav.
      const to = event.data['to'];
      if ('string' === typeof to && to.length > 0) this.url = to;
    }
    const t = this.elapsed();
    const stamped: ReticleEvent = { ...event, t, sessionId: this.id };
    // The recorder attributes the event to the in-flight action (if any) and journals it durably; the
    // returned event carries actionId/attribution so the buffer + all queries see the same causal link.
    // Falls back to the session's own window so attribution survives the journal being switched off.
    const seen = this.#journal?.observe(stamped) ?? stamped;
    const fallback = this.#activeActionId;
    const attributed =
      seen.actionId === undefined && fallback !== undefined
        ? { ...seen, actionId: fallback }
        : seen;
    this.#observed.observe(attributed);
    this.#buffer.push(attributed, t, byteSize);
    // Each subscriber is independent, and this runs inside the websocket's `message` handler — a
    // NON-async callback, so a sync throw here escapes every try/catch the tool call is wrapped in
    // and becomes an uncaughtException, which the daemon answers by exiting. One observer's bug must
    // not cost the fleet its daemon. Same rule the session-ready fan-out already follows.
    for (const listener of this.#listeners) {
      try {
        listener(attributed);
      } catch {
        /* an event observer must never break the session it observes */
      }
    }
  }

  // Passthroughs to ObservedState, which owns the per-session facts that must SURVIVE buffer
  // eviction: refs the agent drove, and what the layer could not see. See observed-state.ts.
  recordActedRef(ref: string): void {
    this.#observed.recordActedRef(ref);
  }
  actedLabels(): ReadonlySet<string> {
    return this.#observed.actedLabels();
  }

  /**
   * Derive the snapshot-shaped label (`button "Deploy"`) from an act reply and remember it.
   *
   * Same shape the interactive snapshot emits, so coverage can match a control the agent drove
   * against the same control after a re-render gave it a different ref.
   */
  private recordActedLabelFrom(result: CommandResult): void {
    const payload = result.result;
    if (typeof payload !== 'object' || null === payload) return;
    const record = payload as Record<string, unknown>;
    // The TESTID first: it is the strongest identity a control has and it survives any re-render.
    // Coverage previously matched only on `role "name"`, so a control with a testid but no accessible
    // name — or on a stack where the act reply carried neither — was unrecognisable after a
    // re-render, and coverage read `exercised: 0` however much work had been done.
    const testid = record['testid'];
    if ('string' === typeof testid && testid.length > 0) this.#observed.recordActedLabel(testid);
    const role = record['role'];
    const name = record['name'];
    if (typeof role !== 'string' || typeof name !== 'string') return;
    if (0 === role.length || 0 === name.length) return;
    this.#observed.recordActedLabel(`${role} "${name}"`);
  }

  actedRefs(): ReadonlySet<string> {
    return this.#observed.actedRefs();
  }
  noteRateLimited(dropped: number): void {
    this.#observed.noteRateLimited(dropped);
  }
  blindSpots(): Readonly<Record<string, number>> {
    return this.#observed.blindSpots();
  }

  /** Learned ambient-churn counts (PredicateSession hook the settle oracle reads). */
  ambientCounts(): AmbientCounts {
    return this.#observed.ambientCounts();
  }

  /** Only what THIS session observed — what teardown accumulates onto the persisted map. */
  ownAmbientCounts(): AmbientCounts {
    return this.#observed.ownAmbientCounts();
  }

  /** Seed the ambient map from the persisted per-app `.reticle/ambient.json` (sharpens across sessions). */
  seedAmbient(counts: AmbientCounts): void {
    this.#observed.seedAmbient(counts);
  }

  /**
   * Attach the durable causal-journal recorder (off by default; wired at session creation). The optional
   * reader is the query fall-through source — pass it to make `queryEvents` survive buffer eviction.
   */
  setJournal(recorder: JournalRecorder, reader?: JournalReader): void {
    this.#journal = recorder;
    this.#journalReader = reader;
  }

  /**
   * Journal-backed event query: the ring buffer's events, merged with the durable journal **only when
   * the buffer has evicted** (so a healthy session pays no disk cost), then filtered by since/until/
   * actionId. This is how "what did action N cause" is answered after the buffer has dropped the
   * evidence — the substrate's whole point. The sync `eventsSince`/`window` stay for the hot path.
   */
  async queryEvents(options: EventQueryOptions): Promise<ReticleEvent[]> {
    if (this.#journalReader !== undefined && this.#buffer.bufferHealth().dropped > 0) {
      const durable = await this.#journalReader.readEvents();
      return filterEvents(mergeEventsBySeq(durable, this.#buffer.since(0)), options);
    }
    return filterEvents(this.#buffer.since(options.since ?? 0), options);
  }

  /**
   * Open an action-attribution window: events observed until finishAction attribute to the returned
   * action id. Ids are minted independently of command correlation ids so the journal is self-contained.
   */
  beginAction(tool: string, args: Record<string, unknown>): string {
    const actionId = this.#mintActionId();
    // Held here, not only in the journal: with the journal off every event was unattributed, and
    // pushEvent reads that as ambient churn the settle oracle then ignores. See action-attribution test.
    this.#activeActionId = actionId;
    this.#journal?.beginAction(actionId, tool, args);
    return actionId;
  }

  /**
   * Record one action WITHOUT opening an attribution window — for a tool that returns a verdict but
   * drives nothing, so no event it observes was caused by it. See `JournalRecorder.recordAction`.
   */
  recordAction(tool: string, args: Record<string, unknown>, effect?: unknown): string {
    const actionId = this.#mintActionId();
    this.#journal?.recordAction(actionId, tool, args, effect);
    return actionId;
  }

  #mintActionId(): string {
    this.#actionSeq += 1;
    return `${ACTION_ID_PREFIX}${String(this.#actionSeq)}`;
  }

  /**
   * How many actions this session has dispatched.
   *
   * The counter that mints journal action ids, not a second one — so it equals the journal's own
   * length, and `reticle_context`'s `step`, whenever this session journals at all.
   */
  get actionCount(): number {
    return this.#actionSeq;
  }

  /** Close the active action window, persisting its action record with the settle outcome. */
  finishAction(effect?: unknown, settled?: boolean, settledInMs?: number): void {
    this.#activeActionId = undefined;
    this.#journal?.finishAction(effect, settled, settledInMs);
  }

  /**
   * The durable action ledger for this session — the ledger the run context is folded out of.
   *
   * `[]` when nothing journals this session (journaling disabled, or an id that is not a safe path
   * segment). An absent ledger reads as an empty run, never as a missing one: the fold simply has
   * nothing to say, which is the honest answer.
   */
  async readJournalActions(): Promise<JournalAction[]> {
    return (await this.#journalReader?.readActions?.()) ?? [];
  }

  /** Flush any buffered journal events to disk (call on session end). */
  async flushJournal(): Promise<void> {
    await this.#journal?.flush();
  }

  eventsSince(cursor: number): ReticleEvent[] {
    return this.#buffer.since(cursor);
  }

  /**
   * What the most recent act was: its cursor, its source, and what it changed inside its target.
   *
   * Exposed as the object rather than six pass-through methods — act writes to it and observe reads
   * from it, and the split between those two tool calls is the whole reason it exists.
   */
  readonly lastAct = new LastAct();
  /**
   * What this app still cannot tell Reticle, as of the most recent verdict.
   *
   * Lives on the session because that is the scope the question belongs to: "am I done with this
   * app" is a session question, and a gap closed halfway through must not follow the agent to the
   * end of it.
   */
  readonly gaps = new GapLedger();
  /**
   * The read-only calls the journal does not keep, so "was `reticle_context` ever called" has
   * something to fold. See honesty/feature-capture.ts — it is the only state that instrument adds.
   */
  readonly capture = new CaptureLedger();

  // ── Server-authoritative liveness (immune to browser-tab throttling) ──────────────

  /**
   * Stamp the wall-clock of the latest AGENT command (called whenever a tool resolves this session).
   * If the reaper had auto-ended the session, a fresh command means the agent is alive again, so the
   * session is REVIVED to ACTIVE. An EXPLICIT end (human/agent reticle_end_session) is terminal and is
   * never revived here.
   */
  markAgentActivity(): void {
    this.#lastAgentActivityAt = this.#clock();
    if (this.#live.isEnded() && this.#autoEnded) {
      this.#autoEnded = false;
      this.setState(SessionState.ACTIVE);
    }
  }

  /** ms since the agent last issued a command against this session (the reaper's idle signal). */
  agentIdleMs(): number {
    return this.#clock() - this.#lastAgentActivityAt;
  }

  /** The agent-idle window after which the reaper ends this session. */
  idleEndMs(): number {
    return this.#idleEndMs;
  }

  /** Tune the idle window (reticle_session). Floored so an agent can't disable the safety net. */
  setIdleEndMs(ms: number): void {
    this.#idleEndMs = Math.max(SESSION_LIFECYCLE.IDLE_END_MIN_MS, Math.floor(ms));
  }

  /**
   * Reaper/disconnect end: terminal like a normal end (pushes PRESENTER ended to the browser, which a
   * throttled tab still receives) but flagged auto-ended so a returning agent revives it. No-op if
   * already ended.
   */
  autoEnd(text?: string, tone: PresenterTone = PresenterTone.WARN): void {
    if (this.#live.isEnded()) return;
    this.#autoEnded = true;
    this.setState(SessionState.ENDED, text, tone);
  }

  eventsInWindow(windowMs: number): ReticleEvent[] {
    return this.#buffer.window(windowMs, this.elapsed());
  }

  /** Buffer honesty: events currently held + cumulative evictions since connect (for false-negative detection). */
  bufferHealth(): { total: number; dropped: number } {
    return this.#buffer.bufferHealth();
  }

  /**
   * Did the buffer lose scarce evidence from a window opened at `cursor`? The input to whether a
   * verdict's capture was clean — see `RingBuffer.lostSince`, and never the raw drop counter, which
   * moves for the age and churn evictions that every live page produces continuously.
   */
  lostSince(cursor: number): boolean {
    return this.#buffer.lostSince(cursor);
  }

  onEvent(listener: (event: ReticleEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  /** Send a command to the browser and await its reply (or time out). */
  command(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<CommandResult> {
    // Recorded HERE rather than at the tool call sites: this is the one place every driven action
    // passes through, so act_sequence and flow replay count too. Doing it per-tool missed both, and
    // an under-counted "exercised" reports worse coverage than reality — the safe direction, but
    // still wrong, and it made the number depend on which tool the agent happened to use.
    if (name === ReticleCommand.ACT) {
      const ref = args['ref'];
      if ('string' === typeof ref) this.recordActedRef(ref);
    }
    // The page already re-dialled under this same id. Nothing has been sent yet, so handing the
    // command to the live connection cannot perform anything twice — it is the call the agent would
    // have made itself after a `reticle_sessions` round trip, minus the round trip.
    const successor = this.#liveSuccessor();
    if (successor !== undefined) return successor.command(name, args, timeoutMs);
    const id = this.#pending.nextId(COMMAND_ID_PREFIX);
    const payload = JSON.stringify({
      kind: MessageKind.COMMAND,
      id,
      sessionId: this.id,
      name,
      args,
    });
    // The timeout message is built LAZILY: health can change while a command is in flight, and the
    // diagnosis should describe the page as it was when the command actually gave up.
    const awaited = this.#pending.track(id, timeoutMs, () =>
      commandTimeoutMessage(name, timeoutMs, {
        url: this.url,
        hidden: this.#hidden,
        lastSeenMs: this.lastSeenMs(),
        ...(this.#runtime === undefined ? {} : { runtime: this.#runtime }),
      }),
    );
    this.#socket.send(payload);
    const sentAt = Date.now(); // browser-leg timing; see recordBrowserLatency for why it is split out
    // Traced because this is the boundary that decides whether a slow tool call is OUR overhead or
    // the app taking its time — the split telemetry reports in aggregate, made visible per call.
    return span('browser.command', { command: name, sessionId: this.id }, () => awaited)
      .then((result) => {
        // Answered — whatever the reply said, the command channel is alive.
        this.#unansweredCommands = 0;
        // The label is only knowable from the REPLY — the request carries a ref, and a ref dies with
        // the next re-render. Recorded here so coverage survives frameworks that replace nodes.
        if (name === ReticleCommand.ACT) this.recordActedLabelFrom(result);
        return result;
      })
      .finally(() => recordBrowserLatency(Date.now() - sentAt))
      .catch((error: unknown) => {
        // The replacement landed while this command was on the wire, which is the reported case:
        // `reticle_navigate` reloads the page, the reload sends a fresh HELLO carrying the same id,
        // and the `reticle_snapshot` already in flight is rejected by the displaced session.
        // A TIMEOUT is not a replacement. The catch fired on any rejection, so a command that had
        // simply not been answered in budget was read as "you were replaced, ask again" — and
        // against a page re-dialling in a loop that turned one read into hundreds of commands on the
        // wire, minutes of wall clock, and an answer still quoting the budget it had blown.
        if (error instanceof CommandTimeoutError) this.#unansweredCommands += 1;
        const next = error instanceof CommandTimeoutError ? undefined : this.#liveSuccessor();
        if (next === undefined || !REBINDABLE_COMMANDS.has(name)) throw error;
        // What is LEFT of the caller's budget, not a fresh copy of it. Re-issuing with the original
        // timeout means a caller who granted 8s can wait 16, and across a chain of replacements the
        // total is unbounded — a wait nobody asked for, on the path that exists to save a round trip.
        // A budget already spent means there is nothing left to retry into, so the error stands.
        const remaining = timeoutMs - (Date.now() - sentAt);
        if (remaining <= 0) throw error;
        return next.command(name, args, remaining);
      });
  }

  handleResult(result: CommandResult): void {
    // Any reply at all clears the wedge, including one for a command that already timed out: it is
    // still proof that bridge→page→bridge works right now, which is the only thing being claimed.
    this.#unansweredCommands = 0;
    this.#pending.settle(result);
  }

  /** Reject everything still in flight — used on disconnect. */
  rejectAll(reason: string, replaced = false): void {
    this.#pending.rejectAll(reason, replaced);
    for (const listener of this.#disconnectListeners) listener();
    this.#disconnectListeners.clear();
  }

  /**
   * The connection that took this session's id over, once one has.
   *
   * Set by the bridge at the moment it displaces this session, so the two facts a replaced handle
   * needs — that it was replaced, and by whom — arrive together. Without it, every tool call holding
   * this handle could only report "session replaced by a newer connection claiming the same id", and
   * the caller's only recovery was `reticle_sessions` plus a retry: two round trips to rediscover an
   * id the daemon was already holding, and which had not even changed.
   */
  #successor: Session | undefined;

  succeededBy(next: Session): void {
    // A session is never its own replacement; guarding here keeps `command` from recursing forever
    // if a registry ever re-adds the same object.
    if (next !== this) this.#successor = next;
  }

  /**
   * The replacement, but only while it can actually answer.
   *
   * A successor is recorded once and never cleared, so without this a session that was replaced an
   * hour ago keeps handing commands to a socket that has since closed — and the caller pays the full
   * timeout to learn it, turning an instant "session replaced" into a wait. The point of delegating
   * was to save the caller a round trip; delegating to a dead socket costs them more than the error
   * did.
   */
  #liveSuccessor(): Session | undefined {
    // Walked, not just read one hop. Two replacements in quick succession — a page that reloads
    // twice — leave a CHAIN, and the handle the caller holds points at a session that is itself
    // already displaced. Stopping at the first dead link fails safe and also fails: the open page is
    // one hop further on, and the caller gets back exactly the error this exists to remove.
    //
    // Bounded, because `succeededBy` refuses self-succession but nothing prevents a cycle, and an
    // unbounded walk over one is a hang — which is worse than the error it was trying to avoid.
    let next = this.#successor;
    for (let hops = 0; next !== undefined && hops < MAX_SUCCESSOR_HOPS; hops += 1) {
      if (next.#socket.readyState === WS_OPEN) return next;
      next = next.#successor;
    }
    return undefined;
  }

  /** End this transport without letting a stale socket remove its replacement session. */
  disconnect(reason: string, replaced = false): void {
    // "Longest run" means the longest SESSION, and it used to be fed a single tool call's duration
    // - so the report's superlative was a number in milliseconds that never grew past a click.
    recordImpact({}, { runMs: this.elapsed() }, this.artifactRoot);
    this.rejectAll(reason, replaced);
    try {
      this.#socket.close(1008, reason);
    } catch {
      // A fake or already-closed socket needs no further cleanup.
    }
  }

  // ── Live-control: state machine + human→agent inbox (server-owned) ───────────────

  getState(): SessionState {
    return this.#live.state();
  }

  isPaused(): boolean {
    return this.#live.isPaused();
  }

  isEnded(): boolean {
    return this.#live.isEnded();
  }

  /**
   * Set the lifecycle state and echo it to the panel in ONE PRESENTER push. The SOLE pusher of
   * PRESENTER for a transition. Optional `text` rides the same push (e.g. an end-of-session
   * summary) so a transition never emits two PRESENTER commands.
   */
  setState(next: SessionState, text?: string, tone?: PresenterTone): void {
    this.#live.setState(next);
    this.pushPresenter(next, text, tone);
  }

  /** Push a human note onto the inbox (see LiveControl). */
  pushMessage(text: string): void {
    this.#live.push(text, this.elapsed());
  }

  /** Queued human notes, cleared as they are read (delivered-once). */
  drainInbox(): InboxMessage[] {
    return this.#live.drain();
  }

  /** Diagnostic read of the inbox depth (does not clear). */
  inboxSize(): number {
    return this.#live.size();
  }

  /** Everything the human has said this session, delivered or not. Never clears. */
  inboxHistory(): readonly InboxMessage[] {
    return this.#live.history();
  }

  // ── Human review marks: the "annotate the bug where you see it" inbox (server-owned) ──────────

  /** Human marks still awaiting a fix (oldest first). Reading does not consume — resolveMark does. */
  pendingMarks(): ReviewMark[] {
    return this.#review.pending();
  }

  /** Full mark history (pending + resolved), oldest first. */
  allMarks(): ReviewMark[] {
    return this.#review.all();
  }

  /** Count of pending marks — surfaced as the panel badge / a session-health hint. */
  pendingMarkCount(): number {
    return this.#review.pendingCount();
  }

  /** Retire a mark the agent fixed. True on a real pending → resolved transition; false otherwise. */
  resolveMark(id: string): boolean {
    return this.#review.resolve(id);
  }

  /**
   * Apply a narrowed human control. LiveControl decides the transition; this applies it, so a real
   * change pushes exactly one PRESENTER command and a no-op pushes none.
   */
  applyHumanControl(data: HumanControlData): void {
    const next = this.#live.nextStateFor(data);
    if (next !== undefined) this.setState(next);
    if (data.kind === HumanControlKind.MESSAGE && data.text !== undefined) {
      this.pushMessage(data.text);
    }
  }

  /**
   * Push a lifecycle state to the panel with optional human-facing `text`. State changes still flow
   * through `setState`; an auto-ended session rides a `warn` tone so the panel can shout "agent stopped".
   */
  /**
   * Push the impact record to this tab's HUD.
   *
   * Debounced: the record changes on every tool call, and the panel does not need 200 frames to
   * show a counter going up. The LAST state always lands, because the timer re-reads the store
   * when it fires rather than capturing a snapshot when it was scheduled.
   */
  pushImpact(read: () => ImpactSnapshot | undefined, immediate = false): void {
    if (immediate) {
      // A tab that just connected has nothing to show yet, so its first record goes out at once -
      // waiting a debounce here is a report that reads "nothing recorded" over a month of history.
      const first = read();
      if (first !== undefined) this.#post(ReticleCommand.IMPACT, { snapshot: first });
      return;
    }
    if (this.#impactTimer !== undefined) return;
    this.#impactTimer = setTimeout(() => {
      this.#impactTimer = undefined;
      const snapshot = read();
      if (snapshot !== undefined) this.#post(ReticleCommand.IMPACT, { snapshot });
    }, IMPACT_PUSH_DEBOUNCE_MS);
    this.#impactTimer.unref?.();
  }

  pushPresenter(state: SessionState, text?: string, tone?: PresenterTone): void {
    this.#post(ReticleCommand.PRESENTER, buildPresenterArgs(state, text, tone));
  }
  /** Fire-and-forget a narration row to the live panel (so a resolved mark shows "✓ fixed"). */
  #impactTimer: ReturnType<typeof setTimeout> | undefined;

  pushNarration(text: string): void {
    this.#post(ReticleCommand.NARRATE, { text, level: 'info' });
  }

  /** The one-time lease block on the first agent command, then undefined forever after. */
  takeSessionLease(): SessionLease | undefined {
    if (this.#firstCommandDone) return undefined;
    this.#firstCommandDone = true;
    return buildSessionLease(this.id, this.#startedAt);
  }

  /**
   * Returns a human-readable age warning after SESSION_LEASE.WARN_AFTER_MS (10 min), else undefined.
   * Spliced onto every session-bound tool result so the agent is passively reminded to clean up
   * without needing an explicit polling loop.
   */
  ageWarning(): string | undefined {
    const ageMs = this.#clock() - this.#startedAt;
    if (ageMs < SESSION_LEASE.WARN_AFTER_MS) return undefined;
    const minutes = Math.floor(ageMs / 60_000);
    return `Session ${this.id} has been open for ${String(minutes)} minutes. If your task is complete, call reticle_session{action:"end"} now.`;
  }

  /**
   * The tabs that should SEE what this session is told, supplied by the SessionManager.
   *
   * `reticle drive` attaches to the running daemon and is handed a pooled HEADLESS context, so the
   * whole HUD feed — the narration, the counters, the bug that was just raised — went to a browser
   * with nobody in front of it, while the developer's own tab showed nothing. The feed is now a
   * per-project broadcast: the driven tab is still the only one DRIVEN, and any other tab of the
   * same app is a viewer.
   */
  #viewers: (() => Session[]) | undefined;

  /** Wired by SessionManager.add, the one place every session registers. */
  setViewers(read: () => Session[]): void {
    this.#viewers = read;
  }

  /**
   * Fire-and-forget command send — NOT registered in #pending (no correlated result expected).
   *
   * Mirrored to this project's other tabs, for the two commands that are a REPORT of what happened
   * (narration, impact). PRESENTER is deliberately not among them: it is the glow and the lifecycle
   * that say "the agent is driving THIS tab", and a viewer that showed it would be claiming
   * something untrue about itself.
   */
  #post(name: string, args: Record<string, unknown>): void {
    this.#send(name, args);
    if (!MIRRORED_COMMANDS.has(name)) return;
    for (const viewer of this.#viewers?.() ?? []) {
      if (viewer === this) continue;
      // Straight to the raw send, so a mirrored row is never mirrored again.
      viewer.#send(name, name === ReticleCommand.NARRATE ? this.#labelled(args) : args);
    }
  }

  /** A narration row re-addressed to a tab that is watching rather than being driven. */
  #labelled(args: Record<string, unknown>): Record<string, unknown> {
    const text = args['text'];
    if ('string' !== typeof text) return args;
    return { ...args, text: mirroredNarration(this.id, text) };
  }

  #send(name: string, args: Record<string, unknown>): void {
    if (this.#socket.readyState !== WS_OPEN) return;
    // Shares the same counter as tracked commands, so a fire-and-forget id can never collide with
    // one that IS awaiting a reply.
    // Recorded HERE rather than at the tool call sites: this is the one place every driven action
    // passes through, so act_sequence and flow replay count too. Doing it per-tool missed both, and
    // an under-counted "exercised" reports worse coverage than reality — the safe direction, but
    // still wrong, and it made the number depend on which tool the agent happened to use.
    if (name === ReticleCommand.ACT) {
      const ref = args['ref'];
      if ('string' === typeof ref) this.recordActedRef(ref);
    }
    const id = this.#pending.nextId(COMMAND_ID_PREFIX);
    const payload = JSON.stringify({
      kind: MessageKind.COMMAND,
      id,
      sessionId: this.id,
      name,
      args,
    });
    try {
      this.#socket.send(payload);
    } catch {
      // A closing/closed tab must never break event routing for the session.
    }
  }
}

/**
 * Re-exported from session-manager.ts so the public import path (`./session.js`) is unchanged for
 * the many call sites that resolve a target session. The class lives in its own file to keep both
 * units under the file-size cap.
 */
export { SessionManager } from './session-manager.js';
