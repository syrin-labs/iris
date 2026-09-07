/**
 * Session lifecycle, health, control, and lease constants. Split out of constants.ts to keep each
 * file under the cohesion cap; re-exported from the package index, so importers are unaffected.
 */

/**
 * Live-control: per-session lifecycle state (server-owned). The presenter panel mirrors it.
 * `active → paused → active … → ended`; `ended` is terminal.
 */
export const SessionState = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  ENDED: 'ended',
} as const;
export type SessionState = (typeof SessionState)[keyof typeof SessionState];

/** Narrow an unknown wire value to a SessionState (no zod needed at this membership boundary). */
export function isSessionState(value: unknown): value is SessionState {
  return (
    value === SessionState.ACTIVE || value === SessionState.PAUSED || value === SessionState.ENDED
  );
}

/**
 * Sentinel session label meaning "give this tab its own unique id". The SDK maps it (and an absent
 * label) to a per-tab id so several tabs — a human tab + an Reticle-driven tour, a Director-cut popup —
 * never collide on one session id. Pass an explicit label only when tabs should intentionally share.
 */
export const SESSION_AUTO = 'auto';

/** Live-control: kinds a human can emit from the panel (the `kind` of a HUMAN_CONTROL event). */
export const HumanControlKind = {
  PAUSE: 'pause',
  RESUME: 'resume',
  END: 'end',
  MESSAGE: 'message',
  /** Human clicked ▶ on a saved flow in the panel — replay it (no agent). `text` carries the name. */
  REPLAY: 'replay',
} as const;
export type HumanControlKind = (typeof HumanControlKind)[keyof typeof HumanControlKind];

/**
 * Human review marks: the durability tier of the anchor that pins a mark to an element. Mirrors the
 * browser's auto-anchor AnchorStrategy values (testid > component@source > role > position) so the
 * agent draining a mark knows how trustworthy the element address is. Wire-owned here because the
 * mark crosses browser → bridge → agent; the browser maps its synthesized anchor onto these.
 */
export const MarkAnchorStrategy = {
  TESTID: 'testid',
  COMPONENT: 'component',
  ROLE: 'role',
  POSITION: 'position',
} as const;
export type MarkAnchorStrategy = (typeof MarkAnchorStrategy)[keyof typeof MarkAnchorStrategy];

/** Human review marks: lifecycle of a mark in the server-side review store. */
export const MarkStatus = {
  /** Flagged by the human, not yet addressed by the agent. */
  PENDING: 'pending',
  /** The agent claimed the mark as fixed (reticle_review resolve). Terminal. */
  RESOLVED: 'resolved',
} as const;
export type MarkStatus = (typeof MarkStatus)[keyof typeof MarkStatus];

/**
 * SDK page-health heartbeat cadence (native timer) and the server's
 * throttle threshold. Kept named so the server's staleness check can be reasoned about
 * against the SDK's heartbeat (≈ 2 missed heartbeats ⇒ throttled).
 */
export const SESSION_HEALTH = {
  HEARTBEAT_MS: 5_000,
  /** lastSeenMs beyond this ⇒ throttled (≈ 2 missed heartbeats). */
  STALE_THRESHOLD_MS: 12_000,
} as const;

/**
 * Server-authoritative session liveness. The browser-side idle timer is throttled in a backgrounded
 * tab and dies entirely if the agent (MCP client) kills the bridge — so the Node server (immune to
 * throttling) owns the decision: a session whose AGENT has been idle past `IDLE_END_MS` is reaped and
 * ended via a PRESENTER push (which a throttled tab still receives). `BRIDGE_LOST_MS` is the browser's
 * own fallback: when it cannot reach the bridge for this long (server/agent process gone), it ends the
 * session itself so the HUD never sits "running" forever.
 */
export const SESSION_LIFECYCLE = {
  /**
   * Default agent-idle window before the panel hands back to the human as WAITING. The agent signals
   * this IMMEDIATELY via reticle_session {action:"yield"}; this reaper is only the slow backstop for a forgotten yield, so
   * it's deliberately long (a short window would auto-end a session mid slow-step). reticle_session-tunable.
   */
  IDLE_END_MS: 300_000,
  /** Floor for a tuned idle window (so an agent can't disable the safety net). */
  IDLE_END_MIN_MS: 5_000,
  /** How often the server reaper sweeps sessions for idle/disconnected ones. */
  REAP_INTERVAL_MS: 5_000,
  /** Browser fallback: continuous failure to reach the bridge for this long ⇒ self-end the session. */
  BRIDGE_LOST_MS: 15_000,
  /**
   * Daemon self-shutdown: after this long with NO agent connected, NO browser session, and NO pool
   * lease, the detached daemon tears itself down (closes Chromium + bridge, frees the port, removes its
   * pidfile, exits) so Reticle never lingers eating resources after the editor closes. Long enough to
   * survive brief agent reconnects between turns; overridable via RETICLE_IDLE_SHUTDOWN_MS (0 = never).
   */
  DAEMON_IDLE_SHUTDOWN_MS: 300_000,
  /** How often the daemon checks whether it has gone idle. Unref'd, so it never keeps the process up. */
  DAEMON_IDLE_CHECK_MS: 30_000,
} as const;

/**
 * Coding-agent session hygiene thresholds. Coding agents (Claude Code, Codex, Cursor) often
 * complete their task and close their context without calling reticle_session {action:"end"}. These constants
 * drive two passive reminder layers: a one-time session_lease on first call, and recurring
 * session_age_warning fields after WARN_AFTER_MS.
 */
export const SESSION_LEASE = {
  /** ms after which age warnings appear on every session-bound tool result. */
  WARN_AFTER_MS: 600_000, // 10 minutes
  /** ms after which reticle_sessions marks a session as stale. */
  STALE_AFTER_MS: 1_800_000, // 30 minutes
} as const;

/** Why the SDK emitted a PAGE_HEALTH event. */
export const HealthReason = {
  VISIBILITY: 'visibilitychange',
  FOCUS: 'focus',
  BLUR: 'blur',
  HEARTBEAT: 'heartbeat',
  INITIAL: 'initial',
} as const;
export type HealthReason = (typeof HealthReason)[keyof typeof HealthReason];

/**
 * The one thing to DO when nothing is connected — the executable half of the no-session diagnosis.
 *
 * The prose diagnosis tells the cases apart well, and an agent still has to translate it into a
 * command. This is that command's kind, so the agent branches on a value instead of on a sentence.
 * Wire-owned because it crosses daemon → agent on `reticle_sessions`.
 */
export const NoSessionAction = {
  /** Nothing is listening anywhere: the app is not running. Carries the project's own dev script. */
  START_DEV_SERVER: 'start_dev_server',
  /** Something is listening but this project carries no Reticle SDK — wire it first. */
  RUN_INIT: 'run_init',
  /** A wired app is up and no page is loaded — Reticle only ever sees a page a browser has opened. */
  OPEN_APP: 'open_app',
  /** A session was here and went away: reopen the tab, or take a lease. */
  REOPEN_APP: 'reopen_app',
  /**
   * The app IS connected — to another daemon on this machine. Nothing to open, nothing to install.
   *
   * Its own kind because every other action here is wrong for it: the app is running, wired and
   * live, so `open_app`, `run_init` and `start_dev_server` all send the agent to fix something that
   * is not broken, and `reopen_app` points it at a tab that is already open.
   */
  DAEMON_SPLIT: 'daemon_split',
} as const;
export type NoSessionAction = (typeof NoSessionAction)[keyof typeof NoSessionAction];
