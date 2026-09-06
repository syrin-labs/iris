import {
  ActionType,
  ReticleCommand,
  PresenterMode,
  SessionState,
  isPresenterTone,
  isSessionState,
  type PresenterTone,
} from '@reticlehq/core';
import { refs } from '../dom/refs.js';
import { unreachableStripText } from '../transport/unreachable-message.js';
import { actionVerb } from './presenter-verbs.js';
import { nativeSetTimeout, nativeClearTimeout, nativeNow } from '../timers/native-timers.js';
import {
  LOG_KIND,
  CHIP_LABEL,
  DATA_RETICLE_LOG,
  clampLogMax,
  formatElapsed,
  humanDuration,
  appendLogRow,
  type LogKind,
  type LogResult,
  type LogHandle,
} from './presenter-log.js';
import { PRESENTER_CSS } from './presenter-styles.js';
import { HudShell } from './presenter-shell.js';
import { parseImpactSnapshot } from './presenter-report-copy.js';
import {
  BorderMode,
  DEFAULT_BORDER_MODE,
  DATA_BUSY,
  BUSY_OFF,
  effectivePaceMs,
  IDLE_AFTER_MS,
  HEARTBEAT_MS,
  IDLE_NOTICE_MS,
  IDLE_END_MS,
  IDLE_END_MIN_MS,
  ACT_STRIP,
  STATE_ATTR,
  UNREACHABLE_STATE,
  GLOW_FADE_MS,
  GLOW_ON,
  GLOW_OFF,
  DATA_ON,
  THROTTLED_ATTR,
  LIVENESS_ATTR,
  MARKERS_BTN_ATTR,
  CLEAR_MARKS_ATTR,
  MARK_COUNT_ATTR,
  type PresenterOptions,
} from './presenter-config.js';
import { buildRunState, type PresenterRunState } from './presenter-run-state.js';
import { moveCursor, ringAround, spawnRipple, pace } from './presenter-effects.js';
import { GlowController } from './presenter-glow.js';
import { PresenterIcon, PRESENTER_ICON_SIZE, hiIcon } from './presenter-icons.js';
import { renderTally } from './presenter-tally.js';
import {
  CONTROLS_BANNER_HTML,
  CONTROLS_FLOWS_HTML,
  CONTROLS_FOOT_HTML,
  ENDED_FADE_MS,
  ControlPanel,
  type ControlHandler,
} from './presenter-controls.js';
import {
  statusTheme,
  blockerHtml,
  getPresenterSettings,
  OutputDetail,
  syncPageBlocker,
  type PresenterSettings,
} from './presenter-settings.js';
import { Annotator, type AnnotatorChrome } from '../review/annotator.js';
// Re-export the config surface so the public import path (`./presenter.js`) is unchanged.
export { GlowPhase } from './presenter-config.js';
export type { PresenterOptions } from './presenter-config.js';
export { LOG_KIND, LOG_RESULT } from './presenter-log.js';
export type { LogHandle } from './presenter-log.js';
export type { ControlIntent, ControlHandler } from './presenter-controls.js';

type RunLogEntry = { at: number; kind: LogKind; text: string; result?: LogResult };
// Presenter / transparency layer: a human watches the agent work. Glowing border while
// active, a synthetic cursor that flies to targets, click/hover/type effects, and a HUD that
// shows the current action + the agent's narrated intent. All nodes carry data-reticle-* attrs
// so they're excluded from snapshots/observers (see dom-ignore.ts).
export class Presenter {
  #paceMs: number;
  #root: HTMLElement | undefined;
  #glow: HTMLElement | undefined;
  #cursor: HTMLElement | undefined;
  #ring: HTMLElement | undefined;
  #hud: HTMLElement | undefined;
  #actLine: HTMLElement | undefined;
  #actStrip: HTMLElement | undefined;
  /** Label inside the minimised-chat capsule; mirrors the act strip. */
  #chatPillText: HTMLElement | undefined;
  /** Age of the last action, shown in the capsule's own slot. */
  #chatPillTime: HTMLElement | undefined;
  #chip: HTMLElement | undefined;
  /** Live verdict tally (✓N ✗M) in the header - the running testing score the human watches. */
  #tally: HTMLElement | undefined;
  #tallied = { passes: 0, fails: 0 };
  #mode: PresenterMode = PresenterMode.IDLE;
  #now: () => number;
  #heartbeatMs: number;
  #idleNoticeMs: number;
  #borderMode: BorderMode;
  /** The glow / activity state machine (border shimmer + cursor visibility from activity timing). */
  #glowCtl: GlowController;
  /** Liveness: the most recent action text + a 1s ticker that ages it into an "idle · {dur}" clock. */
  #lastActionText = '';
  #heartbeatTimer: ReturnType<typeof nativeSetTimeout> | undefined;
  /** Session lifecycle: idle-end window (tweakable), session id, start/end cursors, structured run log. */
  #idleEndMs: number;
  #sessionId: string;
  #startMs: number | undefined;
  #endMs: number | undefined;
  #runLog: RunLogEntry[] = [];
  /** Tracks sessionStart/sessionEnd so both are idempotent (no strobe / no spurious off-write). */
  #sessionActive = false;
  // v2: narration + action status accumulate in a persistent, timestamped, scrollable log.
  #logMax: number;
  #log: HTMLElement | undefined;
  /** now of the first row, the baseline for the +elapsed timestamps. */
  #logBaseMs: number | undefined;
  // Live-control panel: the two-way control surface (Pause/Resume + End + message Send).
  #onControl: ControlHandler | undefined;
  #panel: ControlPanel;
  #shell: HudShell;
  #annotator: Annotator | undefined;
  constructor(options: PresenterOptions = {}) {
    this.#paceMs = effectivePaceMs(options.paceMs);
    this.#now = options.now ?? nativeNow;
    this.#heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.#idleNoticeMs = options.idleNoticeMs ?? IDLE_NOTICE_MS;
    this.#idleEndMs = options.idleEndMs ?? IDLE_END_MS;
    this.#sessionId = options.sessionId ?? '';
    this.#borderMode = options.border ?? DEFAULT_BORDER_MODE;
    this.#glowCtl = new GlowController({
      now: this.#now,
      idleAfterMs: options.idleAfterMs ?? IDLE_AFTER_MS,
      glowFadeMs: options.glowFadeMs ?? GLOW_FADE_MS,
      borderMode: this.#borderMode,
      setMode: (mode) => this.setMode(mode),
    });
    this.#logMax = clampLogMax(options.logMax);
    this.#onControl = options.onControl;
    this.#panel = new ControlPanel({
      emit: (kind, text) => this.#onControl?.(text !== undefined ? { kind, text } : { kind }),
      logHuman: (text) => {
        this.log(LOG_KIND.HUMAN, text);
      },
      endedFadeMs: options.endedFadeMs ?? ENDED_FADE_MS,
      runState: () => this.runState(),
      clearRunLog: () => this.#clearRunLog(),
      onStateChange: () => this.#syncAnnotator(),
    });
    this.#shell = new HudShell({
      onChatOpen: () => this.#shell.pulseFab(false),
      onExpand: () => this.#syncAnnotator(),
      onAnnotateToggle: () => this.#syncAnnotator(),
      onCollapse: () => this.#syncAnnotator(),
      settings: {
        onBeforeOpen: () => {
          if (this.#shell.isCollapsed()) this.#shell.expand();
        },
        onHideUntilRestart: () => this.#applyHideUntilRestart(),
        onSettingsChange: (s) => this.#onSettingsChange(s),
      },
    });
  }
  /** Setter so reticle.ts can wire the control callback after construction. */
  setControlHandler(handler: ControlHandler): void {
    this.#onControl = handler;
  }
  /** Current live-control session state mirrored onto the panel (data-reticle-state). */
  get state() {
    return this.#panel.state;
  }
  /** Whether a run is currently being presented (false before the agent's first activity / after end). */
  get sessionActive() {
    return this.#sessionActive;
  }
  /** Drive the panel's live-control visual state (server-push / agent path; never emits). */
  setState(state: SessionState, text?: string, tone?: PresenterTone): void {
    this.#panel.setState(state, text, tone);
  }
  /** Apply a bridge→browser presenter push: PRESENTER (state echo) or FLOWS (replay list, the human's
   * no-agent replay surface). Owns the wire parsing so the SDK dispatcher stays a thin router;
   * setState-only so an echo can't re-emit. */
  /** Re-scope the replay-flow chips to the current page (called by the SDK on route change). */
  refilterFlows() {
    this.#panel.refilterFlows();
  }
  handlePush(command: { name: string; args: Record<string, unknown> }): void {
    const a = command.args;
    if (command.name === ReticleCommand.FLOWS) return void this.#panel.setFlows(a['flows']);
    if (command.name === ReticleCommand.IMPACT) {
      const snapshot = parseImpactSnapshot(a['snapshot']);
      if (snapshot !== undefined) this.#shell.report.setSnapshot(snapshot);
      return;
    }
    const state = a['state'];
    const tone = a['tone'];
    const text = 'string' === typeof a['text'] && a['text'].length > 0 ? a['text'] : undefined;
    if (isSessionState(state)) this.setState(state, text, isPresenterTone(tone) ? tone : undefined);
  }
  /** Current cap on accumulated log rows. */
  get logMax() {
    return this.#logMax;
  }
  set logMax(n) {
    this.#logMax = clampLogMax(n);
    this.#pruneLog();
  }
  mount() {
    if (this.#root !== undefined || 'undefined' === typeof document) return;
    const style = document.createElement('style');
    style.setAttribute('data-reticle-overlay', '');
    style.textContent = PRESENTER_CSS;
    document.head.appendChild(style);
    const root = document.createElement('div');
    root.setAttribute('data-reticle-overlay', '');
    // The mode rides ON the status row, next to the dot and the elapsed time it already reports.
    // It used to be a sibling BELOW the strip, hidden except while reading or acting — so every
    // single tool call popped a block into the panel and took it away again, which reads as a
    // second UI flashing in rather than as the one status line changing what it says.
    const actStrip = `<div class="reticle-act-strip" data-liveness="idle"><span class="reticle-act-dot" aria-hidden="true"></span><span class="reticle-act">${ACT_STRIP.READY}</span><span class="reticle-chip" data-reticle-chip></span></div>`;
    root.innerHTML = `
      ${blockerHtml()}
      <div data-reticle-glow></div>
      <div data-reticle-cursor></div>
      <div data-reticle-ring></div>
      ${HudShell.dockHtml(actStrip, CONTROLS_BANNER_HTML, DATA_RETICLE_LOG, CONTROLS_FLOWS_HTML, CONTROLS_FOOT_HTML)}`;
    document.body.appendChild(root);
    this.#root = root;
    this.#glow = root.querySelector<HTMLElement>('[data-reticle-glow]') ?? undefined;
    this.#cursor = root.querySelector<HTMLElement>('[data-reticle-cursor]') ?? undefined;
    this.#ring = root.querySelector<HTMLElement>('[data-reticle-ring]') ?? undefined;
    this.#hud = root.querySelector<HTMLElement>('[data-reticle-hud]') ?? undefined;
    this.#actLine = root.querySelector<HTMLElement>('.reticle-act') ?? undefined;
    this.#actStrip = root.querySelector<HTMLElement>('.reticle-act-strip') ?? undefined;
    this.#chatPillText =
      root.querySelector<HTMLElement>('[data-reticle-chat-pill-text]') ?? undefined;
    this.#chatPillTime =
      root.querySelector<HTMLElement>('[data-reticle-chat-pill-time]') ?? undefined;
    this.#log = root.querySelector<HTMLElement>(`[${DATA_RETICLE_LOG}]`) ?? undefined;
    this.#chip = root.querySelector<HTMLElement>('[data-reticle-chip]') ?? undefined;
    this.#tally = root.querySelector<HTMLElement>('[data-reticle-tally]') ?? undefined;
    this.#shell.mount(root);
    syncPageBlocker(root, getPresenterSettings(), false);
    this.#glowCtl.setElements(this.#glow, this.#cursor);
    // The panel queries its refs, binds listeners, and paints the initial active state.
    this.#panel.mount(root, this.#glow);
    this.setMode(this.#mode);
    this.#renderTally();
  }
  /** Wire annotation chrome; expanding the HUD enters annotate mode. */
  bindAnnotator(annotator: Annotator): void {
    this.#annotator = annotator;
    const root = this.#root;
    if (root === undefined) return;
    const markers = root.querySelector(`[${MARKERS_BTN_ATTR}]`);
    const clear = root.querySelector(`[${CLEAR_MARKS_ATTR}]`);
    const count = root.querySelector(`[${MARK_COUNT_ATTR}]`);
    const chrome: AnnotatorChrome = {};
    if (markers instanceof HTMLElement) chrome.markersBtn = markers;
    if (clear instanceof HTMLElement) chrome.clearBtn = clear;
    if (count instanceof HTMLElement) chrome.countEl = count;
    annotator.attachChrome(chrome);
    annotator.setAccent(statusTheme(getPresenterSettings().statusThemeId).active);
    this.#syncAnnotator();
  }
  /** Annotate whenever the HUD is open and the person asked for it - agent or no agent. */
  #syncAnnotator(): void {
    // Two things have to agree, and both are the user's: the HUD is open, and annotate is switched
    // on. Session state used to be a third, so the mode was refused the moment the agent
    // disconnected - which is precisely when someone opens the HUD to record what they just saw.
    // The button still lit up, so the refusal was invisible: no outline, no composer, no reason.
    const live = !this.#shell.isCollapsed() && this.#shell.isAnnotateOn();
    this.#annotator?.toggle(live);
    if (this.#root !== undefined) {
      syncPageBlocker(this.#root, getPresenterSettings(), live);
    }
  }
  destroy() {
    this.#glowCtl.teardown();
    if (this.#heartbeatTimer !== undefined) nativeClearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#shell.teardown();
    this.#panel.teardown();
    this.#sessionActive = false;
    this.#logBaseMs = undefined;
    this.#log = undefined;
    this.#root?.remove();
    document.querySelectorAll('style[data-reticle-overlay]').forEach((s) => s.remove());
    this.#root = undefined;
  }
  /**
   * Session start: in 'session' border mode this fades the base border IN and keeps it on until
   * sessionEnd. Idempotent, and a no-op when unmounted or in 'busy' border mode.
   */
  sessionStart() {
    // Returning agent activity after the session ended (idle or explicit) revives it as a fresh run.
    if (this.state === SessionState.ENDED) {
      this.#revive();
      return;
    }
    if (this.#sessionActive) return;
    // A bridge that answered supersedes whatever the failed connect left on screen.
    if (UNREACHABLE_STATE === this.#root?.getAttribute(STATE_ATTR))
      this.#root.removeAttribute(STATE_ATTR);
    this.#sessionActive = true;
    this.#startMs ??= this.#now();
    this.#endMs = undefined;
    this.#showSession();
    this.#glowCtl.resetActivity(this.#now());
    this.#startHeartbeat();
    if (getPresenterSettings().autoOpenChat) {
      this.#shell.openChat();
    }
  }
  /**
   * The bridge never answered: show that, rather than showing nothing.
   *
   * An instrumented page with a dead bridge used to be indistinguishable from a page with no
   * Reticle in it — overlay mounted, dock off, nothing on screen. The user cannot tell "I forgot to
   * start the daemon" from "the install did not work", and the commonest cause is the cheapest to
   * say: the port. So the HUD appears, states the URL it tried, and marks itself unreachable so it
   * is never mistaken for a live session.
   *
   * Not an error dialog and not modal: the page is the user's, and a dev overlay that shouts is one
   * they turn off. It is the same capsule they would have had, saying the one thing it knows.
   */
  showUnreachable(url: string, attempts: number): void {
    if (this.#sessionActive) return;
    this.#root?.setAttribute(STATE_ATTR, UNREACHABLE_STATE);
    // Dock and HUD, but NOT the border glow: the glow means the agent is working, and nothing is.
    const dock = this.#root?.querySelector('[data-reticle-dock]');
    dock?.setAttribute(DATA_ON, GLOW_ON);
    this.#hud?.setAttribute(DATA_ON, GLOW_ON);
    this.#lastActionText = unreachableStripText(url, attempts);
    this.#paintActStrip(this.#lastActionText, true);
    // The message IS the reason this state exists, and a collapsed capsule hides it. Same setting
    // a live session honours, so a user who wants the bare toolbar still gets one.
    if (getPresenterSettings().autoOpenChat) this.#shell.openChat();
  }

  /** Turn the base border (session mode) + the HUD/log on - the visible "session is live" state. */
  #showSession() {
    const dock = this.#root?.querySelector('[data-reticle-dock]');
    dock?.setAttribute(DATA_ON, GLOW_ON);
    this.#hud?.setAttribute(DATA_ON, GLOW_ON);
    // Base border persists in 'session' mode; 'busy' mode leaves it to the busy machine.
    if (this.#borderMode === BorderMode.SESSION) this.#glow?.setAttribute(DATA_ON, GLOW_ON);
  }
  /** Revive after an ended session (new agent activity): clear the ended state + glow back on. */
  #revive() {
    this.#panel.setState(SessionState.ACTIVE);
    this.#endMs = undefined;
    this.#showSession();
    this.#glowCtl.resetActivity(this.#now());
    this.#startHeartbeat();
  }
  /**
   * Session end: hides the log/HUD and (in 'session' mode) clears the base border. Idempotent; a
   * no-op without a prior sessionStart or when unmounted.
   */
  sessionEnd() {
    if (!this.#sessionActive) return;
    this.#sessionActive = false;
    if (this.#heartbeatTimer !== undefined) {
      nativeClearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    const dock = this.#root?.querySelector('[data-reticle-dock]');
    dock?.setAttribute(DATA_ON, GLOW_OFF);
    this.#hud?.setAttribute(DATA_ON, GLOW_OFF);
    this.#shell.collapse();
    if (this.#borderMode === BorderMode.SESSION) {
      this.#glow?.setAttribute(DATA_ON, GLOW_OFF);
      this.#glow?.setAttribute(DATA_BUSY, BUSY_OFF);
    }
  }
  /**
   * Record agent activity. Idempotent while busy - only the first activity from idle/fading flips
   * the glow on, so a burst never restarts the reticle-pulse animation (no strobe). Subsequent calls
   * just refresh the last-activity timestamp and re-arm the idle check.
   */
  markActivity() {
    this.#glowCtl.markActivity();
  }
  /** Re-arm the quiet-window idle check (kept for reticle.ts's finally block). */
  scheduleIdle() {
    this.#glowCtl.scheduleIdle();
  }
  /** Test/diagnostic accessor for the current glow phase. */
  glowPhase() {
    return this.#glowCtl.phase();
  }
  /** Current intent (reading vs acting), exposed for tests + the watcher. */
  get mode() {
    return this.#mode;
  }
  /**
   * Set the presenter intent. READING shows a cyan scan + chip and hides the cursor; ACTING
   * keeps the warm cursor/ripple + chip; IDLE clears the chip. Drives color via data-reticle-mode.
   */
  setMode(mode: PresenterMode): void {
    this.#mode = mode;
    this.#root?.setAttribute('data-reticle-mode', mode);
    if (this.#chip !== undefined) {
      const label = CHIP_LABEL[mode];
      this.#chip.setAttribute('data-mode', mode);
      this.#chip.replaceChildren();
      if (label.length > 0) {
        const icon =
          mode === PresenterMode.READING
            ? PresenterIcon.VIEW
            : mode === PresenterMode.ACTING
              ? PresenterIcon.POINTER
              : undefined;
        if (icon !== undefined) this.#chip.appendChild(hiIcon(icon, PRESENTER_ICON_SIZE.CHIP));
        const labelEl = document.createElement('span');
        labelEl.className = 'reticle-chip-label';
        labelEl.textContent = label;
        this.#chip.appendChild(labelEl);
      }
    }
    // READING has no real pointer to show (synthetic-hover pointer is native-only) - hide the cursor.
    if (mode === PresenterMode.READING) this.#cursor?.setAttribute(DATA_ON, GLOW_OFF);
  }
  status(text: string): void {
    this.markActivity();
    if (this.#chatPillTime !== undefined) this.#chatPillTime.textContent = ACT_STRIP.NOW;
    this.#lastActionText = text;
    this.#paintActStrip(text, false);
  }
  /**
   * Sync act-strip text + the live/idle state.
   *
   * The liveness is mirrored onto the overlay root as well as the strip, because that is what the
   * status COLOUR resolves against: the page glow, the collapsed FAB's halo and the minimised
   * capsule all live outside the strip and still have to say whether the agent is working.
   */
  #paintActStrip(text: string, idle: boolean): void {
    if (this.#actLine !== undefined) this.#actLine.textContent = text;
    const liveness = idle ? 'idle' : 'active';
    if (this.#actStrip !== undefined) this.#actStrip.setAttribute('data-liveness', liveness);
    this.#root?.setAttribute(LIVENESS_ATTR, liveness);
    if (this.#chatPillText !== undefined) {
      // The capsule reads "logo | what the agent did | how long ago | expand", so it takes the
      // ACTION, never the composed "idle · 12s since last action" line the strip shows: the age
      // lives in its own slot next to it.
      this.#chatPillText.textContent = idle
        ? this.#lastActionText !== ''
          ? this.#lastActionText
          : ACT_STRIP.READY
        : text;
    }
  }
  /**
   * Liveness heartbeat (native 1s timer - never rAF, so it ticks in a foreground tab regardless of
   * agent activity). Once the agent has been quiet for IDLE_NOTICE_MS, the act strip shows a LIVE,
   * growing "◌ idle · {duration} since last action" - the signal that was missing when a stopped
   * agent left the panel frozen and indistinguishable from one still thinking.
   */
  #startHeartbeat() {
    if (this.#heartbeatTimer !== undefined) nativeClearTimeout(this.#heartbeatTimer);
    const tick = () => {
      this.#tickLiveness();
      this.#heartbeatTimer = nativeSetTimeout(tick, this.#heartbeatMs);
    };
    this.#heartbeatTimer = nativeSetTimeout(tick, this.#heartbeatMs);
  }
  #tickLiveness() {
    if (!this.#sessionActive || this.#actLine === undefined) return;
    if (this.state === SessionState.ENDED) return; // already ended - leave the summary
    const idleMs = this.#now() - this.#glowCtl.lastActivityMs();
    if (idleMs >= this.#idleEndMs) {
      this.#endIdle(idleMs); // crossed the idle-end window → auto-end (glow off, panel kept)
      return;
    }
    if (idleMs < this.#idleNoticeMs) return; // still active (or a brief think) - keep the action text
    const since = this.#lastActionText !== '' ? ACT_STRIP.SINCE_LAST : '';
    this.#paintActStrip(`${ACT_STRIP.IDLE_PREFIX}${humanDuration(idleMs)}${since}`, true);
    if (this.#chatPillTime !== undefined) this.#chatPillTime.textContent = humanDuration(idleMs);
  }
  /** Auto-end after the idle window: stamp the end, drive the panel to ENDED, stop the heartbeat. */
  #endIdle(idleMs: number): void {
    this.#endMs = this.#now();
    this.#panel.setState(SessionState.ENDED, `idle ${humanDuration(idleMs)}`);
    if (this.#heartbeatTimer !== undefined) {
      nativeClearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
  }
  /** Agent-tunable idle-end window (reticle_session). Floored so it can't be set uselessly small. */
  setIdleEndMs(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.#idleEndMs = Math.max(IDLE_END_MIN_MS, Math.floor(ms));
  }
  /**
   * The exported "run state" for the Copy/Export buttons - everything the page holds about this
   * run: session id, url, duration, capability surface, per-kind counts, and the full activity log.
   * (The full network/console ring-buffer lives server-side; this is the in-page run summary.)
   */
  runState(): PresenterRunState | Record<string, unknown> {
    const base = buildRunState({
      sessionId: this.#sessionId,
      state: this.state,
      startMs: this.#startMs,
      endMs: this.#endMs,
      now: this.#now(),
      runLog: this.#runLog,
    });
    const settings = getPresenterSettings();
    if (settings.outputDetail === OutputDetail.MINIMAL) {
      return {
        session: base.session,
        url: base.url,
        state: base.state,
        startedMs: base.startedMs,
        durationMs: base.durationMs,
        counts: base.counts,
      };
    }
    if (settings.outputDetail === OutputDetail.VERBOSE && settings.reactComponents) {
      return { ...base, includeReactComponents: true };
    }
    return base;
  }
  #clearRunLog(): void {
    this.#runLog = [];
    this.#tallied = { passes: 0, fails: 0 };
    if (this.#log !== undefined) this.#log.replaceChildren();
    this.#renderTally();
  }
  #applyHideUntilRestart(): void {
    this.#root?.setAttribute('data-reticle-hidden', '1');
    this.#shell.collapse();
  }
  #onSettingsChange(settings: PresenterSettings): void {
    this.#annotator?.setAccent(statusTheme(settings.statusThemeId).active);
    if (!settings.showTally) {
      this.#tally?.setAttribute('hidden', '');
    } else {
      this.#renderTally();
    }
    if (this.#root !== undefined) {
      const live = SessionState.ACTIVE === this.#panel.state && !this.#shell.isCollapsed();
      syncPageBlocker(this.#root, settings, live);
    }
  }
  /**
   * Append an activity-log row. Accumulates (never overwrites): each call adds a timestamped row
   * with a mode chip + text. Returns a handle to stamp the row's outcome glyph (✓/✗) later, or
   * undefined when unmounted / when the text is empty after trimming.
   */
  log(kind: LogKind, text: string, result?: LogResult): LogHandle | undefined {
    const ms = this.#now();
    this.#glowCtl.markActivity(ms);
    if (this.#log === undefined) return undefined;
    const trimmed = text.trim();
    if (0 === trimmed.length) return undefined;
    this.#logBaseMs ??= ms;
    // Structured run-log entry (mirrors the DOM row) for the exported run state, capped like the DOM.
    const entry =
      result !== undefined
        ? { at: ms - this.#logBaseMs, kind, text: trimmed, result }
        : { at: ms - this.#logBaseMs, kind, text: trimmed };
    this.#runLog.push(entry);
    while (this.#runLog.length > this.#logMax) this.#runLog.shift();
    const ts = formatElapsed(ms - this.#logBaseMs);
    const handle = appendLogRow(this.#log, kind, trimmed, ts, this.#logMax);
    if (result !== undefined) handle.result(result);
    if (this.#shell.isCollapsed()) this.#shell.pulseFab(true);
    this.#renderTally();
    // Wrap the handle so a later outcome stamp updates BOTH the DOM glyph and the run-log entry.
    return {
      result: (r: LogResult) => {
        handle.result(r);
        entry.result = r;
        this.#renderTally(); // a deferred ✓/✗ stamp bumps the header tally
      },
    };
  }
  /** Repaint the header verdict tally from the run log; the side that grew gets a one-shot pop. */
  #renderTally(): void {
    if (!getPresenterSettings().showTally) {
      this.#tally?.setAttribute('hidden', '');
      return;
    }
    this.#tallied = renderTally(this.#tally, this.#runLog, this.#tallied);
  }
  /** Back-compat: narration appends to the live log (append-only, never overwrites). */
  narrate(text: string, level = 'info'): LogHandle | undefined {
    const line = 'info' === level ? text : `[${level}] ${text}`;
    return this.log(LOG_KIND.NARRATION, line);
  }
  #pruneLog(): void {
    if (this.#log === undefined) return;
    while (this.#log.childElementCount > this.#logMax) {
      this.#log.firstElementChild?.remove();
    }
  }
  /**
   * Mirror the server's session.throttled state onto the HUD border. When throttled (tab
   * backgrounded or stale), the border turns amber so the developer knows actions are no-oping -
   * the same signal the agent already reads from result.session.throttled.
   */
  setThrottled(throttled: boolean): void {
    this.#root?.setAttribute(THROTTLED_ATTR, throttled ? '1' : '0');
    if (throttled && this.#actLine !== undefined) {
      this.#actLine.textContent =
        'Tab backgrounded - actions throttled. Bring tab to front or use `reticle drive`.';
    }
  }
  /** Fly the cursor to an element, play the action's effect, then pace for the human. */
  async beforeAct(refId: string, action: string, label: string): Promise<void> {
    const el = refs.resolve(refId);
    this.status(`${actionVerb(action)} ${label}`);
    if (!(el instanceof HTMLElement)) {
      await pace(this.#paceMs);
      return;
    }
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    moveCursor(this.#cursor, cx, cy);
    ringAround(this.#ring, rect);
    await pace(this.#paceMs);
    if (
      ActionType.CLICK === action ||
      ActionType.DBLCLICK === action ||
      ActionType.SUBMIT === action
    )
      spawnRipple(this.#root, cx, cy);
  }
}
