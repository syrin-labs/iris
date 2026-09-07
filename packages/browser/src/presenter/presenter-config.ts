import type { ControlHandler } from './presenter-controls.js';

/**
 * Presenter tunables + option surface. Split out of presenter.ts so that file is just the controller
 * under the size cap; these are pure declarations (interfaces + named constants), no behavior. None
 * cross the browser↔bridge↔agent wire, so they live here, not in @reticlehq/core.
 */

/**
 * Border behavior.
 * - 'session': base border persists connect→disconnect; the busy machine drives only the shimmer.
 * - 'busy': back-compat - the busy machine toggles the base border on/off.
 */
export const BorderMode = { SESSION: 'session', BUSY: 'busy' } as const;
export type BorderMode = (typeof BorderMode)[keyof typeof BorderMode];
export const DEFAULT_BORDER_MODE: BorderMode = BorderMode.SESSION;
export const DATA_BUSY = 'data-busy';
export const BUSY_ON = '1';
export const BUSY_OFF = '0';

export interface PresenterOptions {
  paceMs?: number;
  /** Injected monotonic clock for the glow state machine (tests drive transitions). */
  now?: () => number;
  /** Quiet window before busy -> fading. Overridable so tests run fast. */
  idleAfterMs?: number;
  /** Fade duration before fading -> idle (keep in sync with the glow CSS opacity transition). */
  glowFadeMs?: number;
  /** Liveness heartbeat interval (ms). Overridable so tests run fast. */
  heartbeatMs?: number;
  /** Quiet (ms) after which the act strip shows the live "idle · {duration}" clock. Test-overridable. */
  idleNoticeMs?: number;
  /** Quiet (ms) after which the session AUTO-ENDS (glow off, panel kept). Default 5min; agent-tunable. */
  idleEndMs?: number;
  /** Session id, surfaced in the exported run state. */
  sessionId?: string;
  /** Deprecated: accepted for source compat; the live log no longer auto-expires. */
  narrationDwellMs?: number;
  /**
   * 'session' (default): base border persists connect→disconnect, busy machine drives only the
   * shimmer. 'busy': back-compat - busy machine toggles the base border on/off.
   */
  border?: BorderMode;
  /** Max accumulated activity-log rows before the oldest are pruned. Default 50. */
  logMax?: number;
  /** Called when the human clicks pause/resume/end or sends a message from the panel. */
  onControl?: ControlHandler;
  /** Overridable ended-border fade delay (native timer). Default 4000. */
  endedFadeMs?: number;
}

export const DEFAULT_PACE = 450;

/**
 * The pace to actually use: the default in a browser a human is watching, zero in an automated one.
 *
 * The HUD paces `beforeAct` so a person can see the cursor reach the element before it fires. In a
 * headless browser that is 450ms of nothing, charged to the agent, on every action. Measured with
 * RETICLE_TRACE across the e2e battery: 42 `act` round-trips, 40 of them in a 452–460ms band -
 * a fixed cost, not app work - 19.7 SECONDS in total, 98.5% of all time the battery spent in the
 * browser, while every other command ran in 1–4ms.
 *
 * `navigator.webdriver` is the discriminator because it is exactly the question being asked: true
 * under automation (Playwright, CDP, the browser pool's leased tabs, CI), false in the dev browser
 * a human has open - the case the HUD exists for, which keeps its pacing untouched.
 *
 * An EXPLICIT `paceMs` always wins: a recorded demo runs under automation and still wants the glide,
 * and an option that quietly ignores what the caller asked for is worse than no option.
 */
export function effectivePaceMs(
  requested: number | undefined,
  nav: Navigator | undefined = 'undefined' === typeof navigator ? undefined : navigator,
): number {
  if (requested !== undefined) return requested;
  return true === nav?.webdriver ? 0 : DEFAULT_PACE;
}

/**
 * Glow state machine phases (exposed via glowPhase for tests). A burst of activity flips the
 * border IN once on the first activity, holds steady (the slow reticle-pulse breathing keeps running
 * uninterrupted - no per-action restart/strobe), then fades OUT once after a quiet window.
 */
export const GlowPhase = {
  IDLE: 'idle',
  BUSY: 'busy',
  FADING: 'fading',
} as const;
export type GlowPhase = (typeof GlowPhase)[keyof typeof GlowPhase];

/** Quiet window before busy -> fading. */
export const IDLE_AFTER_MS = 700;
/** Liveness heartbeat: how often the act strip refreshes its "idle · {duration}" clock. */
export const HEARTBEAT_MS = 1000;
/**
 * After this much quiet, the act strip stops showing the last action and starts a LIVE, ticking
 * "◌ idle · {duration} since last action" - so a watcher can tell a 3s think from a dead agent
 * (the killer gap: a frozen panel used to look identical whether the agent paused or stopped).
 */
export const IDLE_NOTICE_MS = 4000;
/** Act-strip copy (presenter-only UI). */
export const ACT_STRIP = {
  READY: 'Ready',
  IDLE_PREFIX: 'idle · ',
  NOW: 'now',
  SINCE_LAST: ' since last action',
} as const;
/** Default session-idle-end: after this much quiet the session auto-ends (glow off, panel persists
 * for analysis). Agent-tweakable via reticle_session { idleEndMs } for the app's needs. */
export const IDLE_END_MS = 300_000;
/** Floor for a tweaked idle-end so the agent can't set a uselessly tiny window. */
export const IDLE_END_MIN_MS = 5_000;
/** Must match the glow CSS opacity transition.25s) so phase reaches idle after the fade paints. */
export const GLOW_FADE_MS = 250;
export const GLOW_ON = '1';
export const GLOW_OFF = '0';
export const DATA_ON = 'data-on';
/** The overlay root's state attribute, which the shell styles resolve colour against. */
export const STATE_ATTR = 'data-reticle-state';
/**
 * Not a SessionState: there is no session. It is the absence of one, said out loud.
 *
 * Kept off `SessionState` deliberately — that enum crosses the wire, and this state exists only
 * because nothing crossed the wire.
 */
export const UNREACHABLE_STATE = 'unreachable';

/** Overlay-root attribute toggled when the HUD is collapsed to the FAB. */
export const MIN_ATTR = 'data-reticle-min';
/** Overlay-root attribute toggled when the agent chat panel is open. */
export const CHAT_ATTR = 'data-reticle-chat';
/** Fixed dock wrapper that stacks chat above the morphing HUD shell. */
export const DOCK_ATTR = 'data-reticle-dock';
/** Collapsed circular control that expands the toolbar. */
export const FAB_ATTR = 'data-reticle-fab';
/** Toolbar chat toggle button. */
export const CHAT_TOGGLE_ATTR = 'data-reticle-chat-toggle';
/** Agent chat panel anchored to the dock. */
export const CHAT_PANEL_ATTR = 'data-reticle-chat-panel';
/** Chat panel opens above or below the HUD bar depending on viewport space. */
export const CHAT_PLACEMENT_ATTR = 'data-reticle-chat-placement';
/** Settings card opens above or below the HUD bar depending on viewport space. */
export const SETTINGS_PLACEMENT_ATTR = 'data-reticle-settings-placement';
/** Horizontal alignment of dock-anchored panels (start = left, end = right). */
export const DOCK_ALIGN_ATTR = 'data-reticle-dock-align';
export const Placement = { ABOVE: 'above', BELOW: 'below' } as const;
/** Show/hide annotation markers. */
export const MARKERS_BTN_ATTR = 'data-reticle-markers-btn';
/** Clear every annotation on the page. */
export const CLEAR_MARKS_ATTR = 'data-reticle-clear-marks';
/** Collapsed FAB annotation-count badge. */
export const MARK_COUNT_ATTR = 'data-reticle-mark-count';
/**
 * Turn annotation on and off from the toolbar.
 *
 * Annotation used to be reachable only as a side effect of expanding the HUD, which meant there was
 * no way to keep the HUD open and stop annotating, and nothing on screen said the mode existed at
 * all. It is a mode the user chooses, so it gets a control they can see and press.
 */
export const ANNOTATE_BTN_ATTR = 'data-reticle-annotate-btn';
/** Minimise the agent chat back to the toolbar, without collapsing the whole HUD. */
export const CHAT_MIN_ATTR = 'data-reticle-chat-min';
/** Overlay flag: is the impact report on screen. */
export const REPORT_ATTR = 'data-reticle-report';
/** The report panel itself. */
export const REPORT_PANEL_ATTR = 'data-reticle-report-panel';
/** The report's close button. */
export const REPORT_CLOSE_ATTR = 'data-reticle-report-close';
/** The toolbar button that opens the report. */
export const REPORT_BTN_ATTR = 'data-reticle-report-btn';

/** The capsule that stands in for the chat while it is minimised - state dot + last action. */
export const CHAT_PILL_ATTR = 'data-reticle-chat-pill';
/** Settings gear is open - the card sits above the dock. */
export const SETTINGS_ATTR = 'data-reticle-settings';
export const SETTINGS_BTN_ATTR = 'data-reticle-settings-btn';
export const SETTINGS_PANEL_ATTR = 'data-reticle-settings-panel';
export const SETTINGS_CLOSE_ATTR = 'data-reticle-settings-close';
export const SETTING_KEY_ATTR = 'data-reticle-setting';
export const SETTINGS_STORAGE_KEY = 'reticle-presenter-settings';
/** Accent swatch applied to the dock chrome. */
/** Overlay flag: is the page-edge glow wanted at all (user setting). */
export const AMBIENT_GLOW_ATTR = 'data-reticle-ambient-glow';
/** Overlay mirror of the activity strip's liveness, so CSS can pick the ACTIVE status colour. */
export const LIVENESS_ATTR = 'data-reticle-live';
/** When 1, a transparent blocker captures page pointer events. */
export const BLOCK_ATTR = 'data-reticle-block';
/** When 1, the dock is hidden until the page reloads. */
export const HIDDEN_UNTIL_RESTART_ATTR = 'data-reticle-hidden';
/** When 0, activity-log timestamps are hidden. */
export const LOG_TIMESTAMPS_ATTR = 'data-reticle-log-ts';
/** When 1, the chat panel uses a narrower width. */
/** When 1, HUD motion is reduced for accessibility. */
export const REDUCE_MOTION_ATTR = 'data-reticle-reduce-motion';
/** Docs opened from the settings footer. */
export const MCP_DOCS_URL: string =
  'https://github.com/reticlehq/reticle/blob/main/docs/getting-started.md';
/** HUD has been dragged off the default dock - positioned with explicit left/top. */
export const HUD_DRAGGED_ATTR = 'data-dragged';
/** CSS custom properties written when the HUD is dragged. */
export const HUD_POS_X_VAR = '--reticle-hud-x';
export const HUD_POS_Y_VAR = '--reticle-hud-y';
/** Pointer movement below this threshold is treated as a click, not a drag. */
export const HUD_DRAG_THRESHOLD_PX = 4;
/** Minimum gap between a dragged HUD and the viewport edge. */
export const HUD_DOCK_MARGIN_PX = 8;
/** Interactive nodes inside the drag handle that must not start a drag (not the FAB itself). */
export const HUD_DRAG_IGNORE_SEL: string =
  '[data-reticle-pause], [data-reticle-annotate-btn], [data-reticle-markers-btn], [data-reticle-clear-marks], [data-reticle-end], [data-reticle-min-btn], [data-reticle-settings-btn], [data-reticle-settings-panel], [data-reticle-report-btn], [data-reticle-report-panel], [data-reticle-chat-panel], [data-reticle-chat-toggle], [data-reticle-workspace-btn], [data-reticle-workspace-menu], [data-reticle-copy], [data-reticle-export], [data-reticle-send], input, textarea, select, a, .reticle-head-ctl, [data-reticle-tally], .reticle-maxhint';
export const THROTTLED_ATTR = 'data-reticle-throttled';
