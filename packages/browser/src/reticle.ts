import { setPresenterVisible } from './dom/dom-ignore.js';
import {
  EventType,
  RETICLE_DEFAULT_PORT,
  RETICLE_PROTOCOL_VERSION,
  RETICLE_URL_PARAM,
  bridgeWsUrl,
  ReticleCommand,
  MessageKind,
  SESSION_AUTO,
  SessionState,
  TRANSPORT_LIMITS,
  buildRedactionPolicy,
  isLoopbackHostname,
  isLocalPage,
  setActiveRedactionPolicy,
  wireRedactionKeys,
  RETICLE_ROOT_GLOBAL,
  RETICLE_SDK_VERSION_GLOBAL,
  CONTRACT_FINGERPRINT,
  newDocumentId,
  NO_EDITS_OBSERVED,
  type CommandMessage,
  type HelloMessage,
  type RedactionConfig,
  type ReticleEvent,
} from '@reticlehq/core';
import { rememberSessionLabel } from './session-continuity.js';
import { editEpoch } from './edit-epoch.js';
import {
  createCommandRegistry,
  RELOAD_CACHE_BUST_PARAM,
  type CommandHandler,
} from './commands/commands.js';
import { Transport, type CommandOutcome } from './transport/transport.js';
import { unreachableMessage } from './transport/unreachable-message.js';
import { adapterNames } from './registry/adapters.js';
import {
  registerCapabilities,
  setCapabilitiesListener,
  hasCapabilities,
  type CapabilitiesInput,
} from './registry/capabilities.js';
import { installAllObservers } from './observers/install-all.js';
import { installOverlay, type OverlayHandle } from './presenter/overlay.js';
import {
  Presenter,
  LOG_KIND,
  LOG_RESULT,
  type PresenterOptions,
  type LogHandle,
  type ControlIntent,
} from './presenter/presenter.js';
import { getPresenterSettings } from './presenter/presenter-settings.js';
import { actionVerb } from './presenter/presenter-verbs.js';
import { str, refLabel, modeForCommand, presentStatus } from './reticle-presenter-helpers.js';
import { resetClock } from './timers/clock.js';
import { nativeWarn } from './timers/native-console.js';
import { installRecorder, type RecorderHandle } from './recorder/recorder.js';
import { Annotator } from './review/annotator.js';
import type { Teardown } from './observers/types.js';
import type { ReticleConnectOptions } from './connect-options.js';

// Re-exported so every existing importer of the options type is unaffected by the file split.
export type { ReticleConnectOptions };

/**
 * Runtime backstop for the dev-only SDK: block connecting when the build reports production, unless
 * explicitly overridden. Pure so it's testable; connect reads NODE_ENV safely (process may be absent
 * in a raw browser). This is defense-in-depth - the primary guard is the consumer gating the import
 * behind `import.meta.env.DEV` so the SDK is dead-code-eliminated from prod bundles entirely.
 */
export function shouldBlockProduction(
  nodeEnv: string | undefined,
  allowInProduction: boolean,
): boolean {
  return 'production' === nodeEnv && !allowInProduction;
}

export function connectionPolicy(
  pageHostname: string,
  bridgeUrl: string,
  allowNonLocalhost: boolean,
  token: string | undefined,
  /** The page's protocol. Desktop webviews (file:, app:, tauri:) are local despite a non-loopback host. */
  pageProtocol = 'http:',
): { allowed: boolean; reason?: string } {
  let bridge: URL;
  try {
    bridge = new URL(bridgeUrl);
  } catch {
    return { allowed: false, reason: 'invalid Reticle bridge URL' };
  }
  if (bridge.protocol !== 'ws:' && bridge.protocol !== 'wss:') {
    return { allowed: false, reason: 'Reticle bridge URL must use ws:// or wss://' };
  }
  if ((token?.length ?? 0) > TRANSPORT_LIMITS.MAX_TOKEN_LENGTH) {
    return {
      allowed: false,
      reason: `Reticle pairing token exceeds ${String(TRANSPORT_LIMITS.MAX_TOKEN_LENGTH)} characters`,
    };
  }
  const remoteBridge = !isLoopbackHostname(bridge.hostname);
  if (remoteBridge && bridge.protocol !== 'wss:') {
    return { allowed: false, reason: 'a non-local Reticle bridge must use wss://' };
  }
  const remote = !isLocalPage(pageProtocol, pageHostname) || remoteBridge;
  if (!remote) return { allowed: true };
  if (!allowNonLocalhost) {
    return {
      allowed: false,
      reason:
        'Reticle is disabled outside localhost unless allowNonLocalhost is explicitly enabled',
    };
  }
  if (token === undefined || 0 === token.length) {
    return { allowed: false, reason: 'a pairing token is required outside localhost' };
  }
  return { allowed: true };
}

/** HUD summary when the SDK self-ends a session because the bridge (server/agent) became unreachable. */
const BRIDGE_LOST_SUMMARY =
  'Session ended - lost connection to Reticle (the agent is no longer running).';

/**
 * Resolve the session label. An absent label or the `auto` sentinel yields a fresh per-tab id (via
 * the injected generator) so multi-tab / new-tab routes never collide; any other label is used
 * verbatim so tabs can intentionally share a session. `gen` is injected to keep this clock-free.
 */
export function resolveSessionLabel(option: string | undefined, gen: () => string): string {
  return option === undefined || option === SESSION_AUTO ? gen() : option;
}

// Re-exported from the protocol (the wire contract) so callers/tests can import it from the SDK too.
export { RETICLE_URL_PARAM };

/** Remove the `_reticle_reload` cache-buster a hard REFRESH left behind, via a native replaceState. */
function stripReloadCacheBustParam(): void {
  try {
    const current = new URL(window.location.href);
    if (!current.searchParams.has(RELOAD_CACHE_BUST_PARAM)) return;
    current.searchParams.delete(RELOAD_CACHE_BUST_PARAM);
    window.history.replaceState(window.history.state, '', current.toString());
  } catch {
    /* best-effort URL hygiene - never block connect() on it */
  }
}

/**
 * Extract Reticle identity overrides from a `location.search` string. Pure (takes the string, not the
 * window) so it's testable without a DOM. Explicit connect options still win over these.
 */
export function reticleParamsFromSearch(search: string): { session?: string; projectId?: string } {
  const params = new URLSearchParams(search);
  const out: { session?: string; projectId?: string } = {};
  const session = params.get(RETICLE_URL_PARAM.SESSION);
  const projectId = params.get(RETICLE_URL_PARAM.PROJECT);
  if (session !== null && session.length > 0) out.session = session;
  if (projectId !== null && projectId.length > 0) out.projectId = projectId;
  return out;
}

/**
 * Resolve the session + project identity for a connection: an explicit, non-`auto` option wins;
 * otherwise a launcher-stamped URL param is used; otherwise undefined (caller generates a per-tab id).
 * Crucially `auto` is treated like "unset" so an app that passes the auto sentinel still lets a pooled
 * launcher correlate the lease via __reticle_session. Pure for testability.
 */
export function resolveConnectIdentity(
  options: { session?: string; projectId?: string },
  search: string,
): { session: string | undefined; projectId: string | undefined } {
  const url = reticleParamsFromSearch(search);
  const explicitSession =
    options.session !== undefined && options.session !== SESSION_AUTO ? options.session : undefined;
  const projectId = options.projectId ?? url.projectId;
  return {
    session: explicitSession ?? url.session,
    projectId: projectId !== undefined && projectId.length > 0 ? projectId : undefined,
  };
}

/**
 * Assemble an event envelope. Pure: `seq` (monotonic per session) and `t` (elapsed clock) are
 * injected, never read here - so it is unit-testable and honors the clock-injection rule. The
 * causing action's id is attributed server-side by the settle window, so it is not stamped here.
 */
export function buildEvent(args: {
  seq: number;
  t: number;
  type: EventType;
  sessionId: string;
  data: Record<string, unknown>;
  ref?: string | undefined;
  documentId?: string | undefined;
  editEpoch?: number | undefined;
}): ReticleEvent {
  return {
    t: args.t,
    seq: args.seq,
    type: args.type,
    sessionId: args.sessionId,
    ref: args.ref,
    // Which document this was observed under, so the server can refuse evidence minted before a
    // navigation replaced the page. Stamped HERE because it is the one place every event passes
    // through: an observer added later would otherwise emit unstamped events, which read as
    // "current" by design and would reintroduce the defect silently for one event type.
    documentId: args.documentId,
    // Which round of source edits this was observed under. Stamped HERE for exactly the reason
    // documentId is, and omitted while nothing has hot-updated: absence already reads as "current"
    // downstream, so `NO_EDITS_OBSERVED` on the wire would be bytes spent saying "unknown".
    editEpoch: NO_EDITS_OBSERVED === args.editEpoch ? undefined : args.editEpoch,
    data: args.data,
  };
}

/**
 * The browser-side orchestrator. Wires observers -> events -> bridge, and bridge
 * commands -> handlers. Embedded in the host app (dev only).
 */
export class Reticle {
  #transport: Transport | undefined;
  #registry: Map<string, CommandHandler> = new Map();
  #teardowns: Teardown[] = [];
  #connected = false;
  #session = 'default';
  /**
   * Minted once, here, because this class is constructed once per document: a full navigation tears
   * down the JavaScript context and builds a new one, so the id dies with the document it names. An
   * SPA route change does not reconstruct it, which is correct — same context, same in-flight
   * requests, same evidence.
   */
  readonly #documentId = newDocumentId(Math.random);
  #start = 0;
  #overlay: OverlayHandle | undefined;
  #presenter: Presenter | undefined;
  #recorder: RecorderHandle | undefined;
  #annotator: Annotator | undefined;
  #eventCount = 0;
  #token: string | undefined;
  #sdkVersion: string | undefined;
  #projectId: string | undefined;
  /** App-declared extra redaction keys, announced in hello so the driven path honours them too. */
  #redactKeys: string[] = [];
  /** Act-row log handle for the in-flight act/act_sequence, so its outcome stamps the right row. */
  #actHandle: LogHandle | undefined;

  connect(options: ReticleConnectOptions = {}): void {
    if (this.#connected) return;
    if ('undefined' === typeof window || 'undefined' === typeof document) return;

    // Dev-only backstop: refuse to activate in a production build (SSR healthcheck, prod bundle opened
    // on localhost). `process` may not exist in a raw browser, so read NODE_ENV off globalThis.
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const nodeEnv = proc?.env?.['NODE_ENV'];
    if (shouldBlockProduction(nodeEnv, true === options.allowInProduction)) {
      globalThis.console.warn(
        '[Reticle] disabled in production (NODE_ENV=production). Gate the import behind ' +
          'import.meta.env.DEV, or pass allowInProduction:true to override.',
      );
      return;
    }

    // A `hard` REFRESH left a cache-busting `_reticle_reload=<nonce>` in the address bar. Strip it now
    // (before the route observer installs, so it emits no spurious ROUTE_CHANGE) - otherwise every hard
    // reload permanently pollutes the URL the app and the agent see.
    stripReloadCacheBustParam();

    const url = options.url ?? bridgeWsUrl(RETICLE_DEFAULT_PORT);
    const policy = connectionPolicy(
      window.location.hostname,
      url,
      true === options.allowNonLocalhost,
      options.token,
      window.location.protocol,
    );
    if (!policy.allowed) {
      globalThis.console.warn(`[Reticle] ${policy.reason ?? 'connection blocked'}`);
      return;
    }

    // Publish the project root for the adapters' source relativisation. Done HERE, in library code,
    // so the app-side connect stays plain JavaScript - see ReticleConnectOptions.root.
    if (options.root !== undefined && options.root.length > 0) {
      (globalThis as Record<string, unknown>)[RETICLE_ROOT_GLOBAL] = options.root;
    }
    // The build plugin defines this; a hand-wired connect can pass it explicitly. Either way an
    // absent value means UNKNOWN, so the bridge never reports an unknown pair as in sync.
    const declaredVersion =
      options.sdkVersion ?? (globalThis as Record<string, unknown>)[RETICLE_SDK_VERSION_GLOBAL];
    this.#sdkVersion =
      'string' === typeof declaredVersion && declaredVersion.length > 0
        ? declaredVersion
        : undefined;

    // A pooled/headless launcher can stamp identity via namespaced URL params; explicit (non-auto)
    // options win, but the `auto` sentinel defers to the URL param so leases correlate.
    const identity = resolveConnectIdentity(options, window.location.search);
    // Remembered per TAB, so a reload rejoins the same session instead of appearing as a new one and
    // stranding the agent's handle - see session-continuity. An explicit id (connect option, or the
    // lease's URL param) still wins.
    const explicitSession = resolveSessionLabel(identity.session, () => '');
    this.#session = rememberSessionLabel(
      explicitSession.length > 0 ? explicitSession : undefined,
      'undefined' === typeof globalThis.sessionStorage ? undefined : globalThis.sessionStorage,
      () =>
        'function' === typeof globalThis.crypto?.randomUUID
          ? `s${globalThis.crypto.randomUUID()}`
          : `s${Date.now().toString(36)}`,
    );
    this.#token =
      options.token !== undefined && options.token.length > 0 ? options.token : undefined;
    this.#projectId = identity.projectId;
    // Install the redaction rule BEFORE anything can emit. Every observer, the serializer and the
    // snapshot path read it ambiently, so a policy set even one line after installAllObservers would
    // leave the first events of the session redacted by a different rule than the rest.
    this.#applyRedaction(options.redact);
    this.#start = performance.now();
    this.#registry = createCommandRegistry();

    this.#transport = new Transport({
      url,
      hello: () => this.#hello(),
      handleCommand: (command) => this.#handleCommand(command),
      // Show the presenter HUD as soon as the agent bridge connects - the user immediately sees
      // the glow border and narration panel, even before the first tool call lands.
      onConnected: () => this.#presenter?.sessionStart(),
      // Liveness fallback: if the bridge stays unreachable (the agent killed the server process),
      // no server-pushed end can arrive - so end the run we're presenting ourselves. A returning
      // agent revives it via the normal sessionStart path on its next command.
      onConnectionLost: () => {
        // Restore real timers. A frozen clock is driven by the agent through the bridge; once the
        // bridge is gone nothing can ever advance it, so leaving it installed pins Date.now and
        // queues every setTimeout into a scheduler that will never run. Concretely that kills every
        // lodash debounce/throttle in the app (now - lastCall stays 0), so search boxes, autosave
        // and resize handlers stop firing until a reload - with nothing on screen explaining why.
        resetClock();
        if (true === this.#presenter?.sessionActive) {
          this.#presenter.setState(SessionState.ENDED, BRIDGE_LOST_SUMMARY);
        }
      },
      // First-connect never succeeded ⇒ this page's socket is not opening at this URL. Say what the
      // page observed rather than guessing at the daemon, which it cannot see from in here.
      onUnreachable: ({ url: tried, attempts }) => {
        nativeWarn(unreachableMessage(tried, attempts));
        // And on screen, not only in a console nobody has open. An instrumented page with a dead
        // bridge looked exactly like a page with no Reticle in it, so the user could not tell a
        // daemon they forgot to start from an install that did not work.
        this.#presenter?.showUnreachable(tried, attempts);
      },
    });

    // Capabilities registered AFTER connect (which is when they are registered, by design) must
    // reach the bridge, or an app that declared its whole testable surface reads as having none.
    setCapabilitiesListener(() => this.#transport?.reannounce());

    // Contributors only, and reported in capabilities so a verdict drawn with it open is never
    // mistaken for an ordinary one. See connect-options.ts.
    setPresenterVisible(true === options.exposePresenter);

    const emit = this.#emit;
    this.#teardowns = installAllObservers(emit, {
      captureBodies: true === options.captureNetworkBodies,
    });

    if (true === options.overlay) {
      this.#overlay = installOverlay();
      this.#overlay.update({ connected: true, events: 0 });
    }

    if (options.present !== false) {
      const presenterOptions: PresenterOptions = {};
      if (options.pace !== undefined) presenterOptions.paceMs = options.pace;
      if (options.narrationDwellMs !== undefined) {
        presenterOptions.narrationDwellMs = options.narrationDwellMs;
      }
      if (options.border !== undefined) presenterOptions.border = options.border;
      if (options.logMax !== undefined) presenterOptions.logMax = options.logMax;
      if (options.endedFadeMs !== undefined) presenterOptions.endedFadeMs = options.endedFadeMs;
      if (options.idleEndMs !== undefined) presenterOptions.idleEndMs = options.idleEndMs;
      presenterOptions.sessionId = this.#session;
      // The panel calls this when the human pauses/resumes/ends or sends a message. We emit a
      // HUMAN_CONTROL event over the existing transport; #emit stamps `t` from the elapsed clock.
      presenterOptions.onControl = (intent: ControlIntent) =>
        this.#emit(
          EventType.HUMAN_CONTROL,
          intent.text !== undefined
            ? { kind: intent.kind, text: intent.text }
            : { kind: intent.kind },
        );
      this.#presenter = new Presenter(presenterOptions);
      // Mount the overlay. The session (glow + HUD) activates on bridge connect via onConnected,
      // so the presenter is visible as soon as the agent is reachable - not just on first command.
      this.#presenter.mount();
    }

    if (true === options.recorder) {
      this.#recorder = installRecorder({ emit, now: () => Date.now() });
      this.#recorder.mount();
    }

    // The page annotator rides with the presenter (the human surface) unless explicitly off.
    if (options.annotate ?? options.present !== false) {
      const presenter = this.#presenter;
      this.#annotator = new Annotator({
        emit,
        now: () => Date.now(),
        onMark: (mark) =>
          presenter?.log(
            LOG_KIND.HUMAN,
            `🚩 #${String(mark.index)} ${mark.anchor}${mark.source !== undefined ? ` · ${mark.source}` : ''} — ${mark.note}`,
          ),
        shouldBlock: () => getPresenterSettings().blockPageInteractions,
      });
      this.#annotator.mount();
      this.#presenter?.bindAnnotator(this.#annotator);
    }

    this.#transport.connect();
    this.#connected = true;
  }

  /** Whether the in-page SDK is connected to the bridge (read by createReticleEmitter, P5a). */
  get connected(): boolean {
    return this.#connected;
  }

  /** Surface an arbitrary app-domain observation the DOM can't express. */
  signal(name: string, data: Record<string, unknown> = {}): void {
    this.#emit(EventType.SIGNAL, { name, data });
  }

  /** Report a framework/store state change the agent can observe and assert on. */
  state(name: string, value: unknown): void {
    this.#emit(EventType.STATE_CHANGE, { name, value });
  }

  /**
   * Report an aggregated count of React commits (the @reticlehq/react render meter calls this on a
   * throttle). Emits a single RENDER_COMMIT event per window so commit storms are observable without a
   * per-render flood. Dev-only, like the whole SDK.
   */
  renderCommit(commits: number): void {
    if (commits > 0) this.#emit(EventType.RENDER_COMMIT, { commits });
  }

  /** Advertise the app's testable surface so the agent learns it without reading source. */
  describe(input: CapabilitiesInput): void {
    registerCapabilities(input); // the registry notifies the transport - see setCapabilitiesListener
  }

  /** Live-control: end the session programmatically from the host app (drives the panel to ended). */
  endSession(): void {
    this.#presenter?.setState(SessionState.ENDED);
  }

  /**
   * Hand the SDK the page's hot-update channel, so a stale ref can say the code changed underneath it.
   *
   * `unknown` on purpose: the only caller that has one is the build integration, the shape it passes
   * is Vite's `import.meta.hot`, and the SDK must not depend on Vite — it ships to Next, Electron,
   * Tauri and plain pages. Anything that is not a subscribable channel is ignored, which is the
   * normal case: with no channel the epoch stays at `NO_EDITS_OBSERVED`, meaning "no edits OBSERVED",
   * never "no edits happened".
   */
  observeHotUpdates(hot: unknown): void {
    editEpoch.observe(hot);
  }

  disconnect(): void {
    if (!this.#connected) return;
    for (const teardown of this.#teardowns) teardown();
    this.#teardowns = [];
    this.#transport?.close();
    this.#transport = undefined;
    this.#overlay?.destroy();
    this.#overlay = undefined;
    this.#presenter?.sessionEnd(); // fade the border out before tearing the overlay down
    this.#presenter?.destroy();
    this.#presenter = undefined;
    this.#recorder?.destroy();
    this.#recorder = undefined;
    this.#annotator?.destroy();
    this.#annotator = undefined;
    resetClock(); // restore any frozen timers
    this.#connected = false;
  }

  readonly #emit = (type: EventType, data: Record<string, unknown>, ref?: string): void => {
    const event = buildEvent({
      seq: this.#eventCount,
      t: Math.round(performance.now() - this.#start),
      type,
      sessionId: this.#session,
      documentId: this.#documentId,
      editEpoch: editEpoch.current,
      data,
      ref,
    });
    // Guarded because #emit runs INLINE IN THE APP'S CALL STACK: every monkey-patch calls it from
    // inside the function it replaced. An exception here does not surface as an SDK error - it
    // propagates out of history.pushState (crashing a router's navigate), out of localStorage.setItem
    // after the write already succeeded, or out of console.log before the message reaches the console.
    // A dev-only observability SDK must never be able to break the app it is observing.
    try {
      this.#transport?.sendEvent(event);
      this.#eventCount += 1;
      this.#overlay?.update({ connected: true, events: this.#eventCount });
      // On a route change, re-scope the HUD's replay-flow chips to the page we're now on.
      if (type === EventType.ROUTE_CHANGE) this.#presenter?.refilterFlows();
    } catch {
      /* observation is best-effort; the host app's control flow is not */
    }
  };

  /**
   * Resolve the app's redaction config into the ambient policy, and remember the part of it that
   * travels. A config of `undefined` is not "no policy" - it is the DEFAULT policy, installed
   * explicitly so a second connect() in the same page (HMR, a re-mount) cannot inherit a rule the
   * previous one set.
   */
  #applyRedaction(config: RedactionConfig | undefined): void {
    setActiveRedactionPolicy(buildRedactionPolicy(config, nativeWarn));
    this.#redactKeys = wireRedactionKeys(config);
  }

  #hello(): HelloMessage {
    return {
      kind: MessageKind.HELLO,
      protocolVersion: RETICLE_PROTOCOL_VERSION,
      sessionId: this.#session,
      ...(this.#projectId === undefined ? {} : { projectId: this.#projectId }),
      url: location.href,
      title: document.title,
      adapters: adapterNames(),
      ...(this.#token === undefined ? {} : { token: this.#token }),
      hasCapabilities: hasCapabilities(),
      // Absent when no build plugin supplied one - "unknown", never "matching".
      ...(this.#sdkVersion === undefined ? {} : { sdkVersion: this.#sdkVersion }),
      // Always present: derived from THIS build's core, so it needs no build plugin to supply it.
      // It is the half of the skew check that works on a hand-wired connect.
      contract: CONTRACT_FINGERPRINT,
      ...(0 === this.#redactKeys.length ? {} : { redactKeys: this.#redactKeys }),
    };
  }

  async #handleCommand(command: CommandMessage): Promise<CommandOutcome> {
    // NARRATE: the agent tells the human what it's about to do / decide (presenter HUD).
    if (command.name === ReticleCommand.NARRATE) {
      this.#presenter?.sessionStart(); // first agent activity → reveal the glow + panel
      this.#presenter?.narrate(str(command.args['text']), str(command.args['level'], 'info'));
      return { ok: true, result: { shown: this.#presenter !== undefined } };
    }

    // SESSION_CONFIG: the agent tunes the session for the app (currently the idle-end window).
    if (command.name === ReticleCommand.SESSION_CONFIG) {
      const idleEndMs = command.args['idleEndMs'];
      if ('number' === typeof idleEndMs) this.#presenter?.setIdleEndMs(idleEndMs);
      return { ok: true, result: { applied: this.#presenter !== undefined, idleEndMs } };
    }

    // Bridge → browser presenter pushes (PRESENTER state echo / FLOWS replay list). The presenter owns
    // the parsing; here we only report whether a panel was mounted to apply it. setState-only, so a
    // PRESENTER echo of a HUMAN_CONTROL can't loop back into a re-emit.
    if (
      command.name === ReticleCommand.PRESENTER ||
      command.name === ReticleCommand.FLOWS ||
      command.name === ReticleCommand.IMPACT
    ) {
      this.#presenter?.handlePush(command);
      return { ok: true, result: { applied: this.#presenter !== undefined } };
    }

    const handler = this.#registry.get(command.name);
    if (handler === undefined) {
      return { ok: false, error: `unknown command '${command.name}'` };
    }

    this.#presenter?.sessionStart(); // first agent command → reveal the glow + panel
    await this.#presentBefore(command);
    try {
      const result = await handler(command.args);
      this.#actHandle?.result(LOG_RESULT.PASS);
      return { ok: true, result };
    } catch (error) {
      this.#actHandle?.result(LOG_RESULT.FAIL);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.#actHandle = undefined;
      this.#presenter?.scheduleIdle();
    }
  }

  /** Drive the presenter (cursor/effects/status) before the real action runs. */
  async #presentBefore(command: CommandMessage): Promise<void> {
    const p = this.#presenter;
    if (p === undefined) return;
    p.setMode(modeForCommand(command.name)); // paint reading vs acting intent first
    this.#actHandle = undefined;
    if (command.name === ReticleCommand.ACT) {
      const ref = str(command.args['ref']);
      const label = refLabel(ref);
      this.#actHandle = p.log(LOG_KIND.ACT, `${actionVerb(str(command.args['action']))} ${label}`);
      await p.beforeAct(ref, str(command.args['action']), label);
    } else if (command.name === ReticleCommand.ACT_SEQUENCE) {
      const steps = Array.isArray(command.args['steps']) ? command.args['steps'] : [];
      for (const step of steps) {
        const s = step as { ref?: unknown; action?: unknown };
        const ref = str(s.ref);
        const label = refLabel(ref);
        // one log row per step; the last handle carries the sequence outcome glyph
        this.#actHandle = p.log(LOG_KIND.ACT, `${actionVerb(str(s.action))} ${label}`);
        await p.beforeAct(ref, str(s.action), label);
      }
    } else {
      const label = presentStatus(command.name, command.args);
      p.status(label);
      p.log(LOG_KIND.READ, label);
    }
  }
}
