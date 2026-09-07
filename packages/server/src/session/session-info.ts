/**
 * The shape `reticle_sessions` returns for one connected tab.
 *
 * Split from session.ts when that file crossed the 600-line cap. A pure description of what a
 * session looks like from the outside has no reason to live inside the class that happens to build
 * it, and separating them keeps the wire-facing shape reviewable on its own.
 */
import { SESSION_LEASE } from '@reticlehq/core';
import type { SessionHealth } from './session-health.js';

export interface SessionInfo {
  sessionId: string;
  url: string;
  /** Stable build-stamped project identity; absent for v1.0 SDKs that don't send it. */
  projectId?: string;
  /** Absent when the page has no title — never the empty string. Fall back to `url`. */
  title?: string;
  adapters: string[];
  hasCapabilities: boolean;
  /**
   * Which shell answered: `web`, `electron` or `tauri`.
   *
   * Absent — never defaulted to `web` — on an SDK too old to report one, because the guess is wrong
   * on exactly the machines this exists to tell apart. Two windows on the same url are otherwise
   * indistinguishable, and a browser tab is not a desktop app: it has none of its IPC, and it does
   * not render like it.
   */
  runtime?: string;
  /** Present only when the page's SDK version differs from the daemon's — see version-skew.ts. */
  versionSkew?: string;
  /** ms since the SDK last reported anything (silence ⇒ likely throttled). */
  lastSeenMs: number;
  hidden: boolean;
  focused: boolean;
  throttled: boolean;
  /** present only when hidden/throttled — points at the `reticle drive` escape hatch. */
  recommendation?: string;
  stale?: boolean;
  cleanup_suggestion?: string;
  /**
   * present ONLY when this tab has stopped answering commands — attached, streaming events, and
   * missing every command budget. Never `false`: absence means "answering, or not asked yet".
   */
  unresponsive?: true;
  /** present with `unresponsive` — the in-protocol way out of a wedged tab. */
  unresponsive_suggestion?: string;
  /** present only when the human has flagged bugs on this tab — count of pending review marks. */
  pendingMarks?: number;
  /** present with pendingMarks — nudges the agent to drain them with reticle_review. */
  review_suggestion?: string;
  /**
   * Continuity of this attachment — `{ connectedSinceMs, outages, lastOutage? }`.
   *
   * A tab that dropped for four seconds and came back is indistinguishable from one that never left
   * (#117), and that difference decides whether a verdict over the window can be trusted. Attached
   * by `SessionManager.list()`, which is the layer that sees every connect and disconnect.
   */
  attachment?: {
    connectedSinceMs: number;
    outages: number;
    lastOutage?: { startedMs: number; durationMs: number };
  };
}

/** The read-only slice of a Session that the projection needs. Keeps this module class-free. */
interface SessionView {
  id: string;
  url: string;
  projectId: string | undefined;
  title: string;
  adapters: string[];
  hasCapabilities: boolean;
  runtime: string | undefined;
  versionSkew: string | undefined;
  hidden: boolean;
  health: () => SessionHealth;
  staleMs: () => number;
  pendingMarkCount: () => number;
  unresponsive: () => boolean;
}

/**
 * Project a live Session into the shape the tools return.
 *
 * Lives beside the SessionInfo type rather than on the class: it is a pure read of already-computed
 * state, it is where every "what does the agent see about this tab" decision belongs, and Session is
 * a stateful class already at its size cap — every field added to a listing was costing a line there.
 */
export function buildSessionInfo(session: SessionView): SessionInfo {
  const base: SessionInfo = {
    sessionId: session.id,
    url: session.url,
    ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
    // Omitted when blank, never `""`. An empty title cannot be told apart from "we sampled before
    // the page set one", and two such tabs make the listing unusable. Moving the sample later does
    // not fix it — a page may set its title after connect, or never — so the projection refuses the
    // bad answer and the reader falls back to `url`, which is right here in the same record.
    ...('' === session.title.trim() ? {} : { title: session.title }),
    adapters: session.adapters,
    hasCapabilities: session.hasCapabilities,
    // Omitted when the page never said, so absence stays readable as "unknown" rather than "web".
    ...(session.runtime === undefined ? {} : { runtime: session.runtime }),
    // On every listing, not buried in a log — skew explains failures that read as app bugs.
    ...(session.versionSkew === undefined ? {} : { versionSkew: session.versionSkew }),
    hidden: session.hidden,
    ...session.health(),
  };
  if (session.staleMs() > SESSION_LEASE.STALE_AFTER_MS) {
    base.stale = true;
    base.cleanup_suggestion =
      'Call reticle_session{action:"end"} to free this session before starting new work.';
  }
  // A tab that is attached and answering nothing. Said out loud because every health field beside it
  // reads fine — that combination is exactly what made the wedge invisible.
  if (session.unresponsive()) {
    base.unresponsive = true;
    base.unresponsive_suggestion =
      'This tab is connected but has stopped answering commands, so every call against it will time ' +
      'out. Ending the session does not revive the page. Reload the tab, or run `reticle open <url>` ' +
      'to get a fresh one — it will no longer hand this tab back.';
  }
  // Surface human bug reports in reticle_sessions (only when > 0, so a clean session adds nothing).
  const marks = session.pendingMarkCount();
  if (marks > 0) {
    base.pendingMarks = marks;
    const s = 1 === marks ? '' : 's';
    base.review_suggestion = `The human flagged ${String(marks)} issue${s} on this tab — call reticle_session{action:"review"} to see and fix ${1 === marks ? 'it' : 'them'}.`;
  }
  return base;
}
