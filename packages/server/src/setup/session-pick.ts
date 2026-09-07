/**
 * Which connected session to drive, out of everything the daemon is holding.
 *
 * This is a false-green guard, which is why it is its own module. Two ways to get it wrong, and
 * both report a successful install for an app that was never verified:
 *
 * - Match "any session" and you pass on somebody else's tab. A daemon usually holds several, and
 *   one of them being alive says nothing about whether THIS app connected.
 * - Match "the first session on this url" and you drive whichever the daemon listed first, usually
 *   the oldest: a tab whose dev server died yesterday. The HUD then plays to a window nobody is
 *   watching, and the verdict describes a page the user cannot see.
 */

/** The fields of a daemon session this decision actually reads. */
export interface CandidateSession {
  readonly sessionId: string;
  readonly url?: string;
  readonly hidden?: boolean;
  readonly throttled?: boolean;
  readonly lastSeenMs?: number;
  /** False when the capabilities file init scaffolded was never completed. */
  readonly hasCapabilities?: boolean;
  /** Which shell answered. Absent on an SDK too old to report one — see requiredRuntime below. */
  readonly runtime?: string;
}

/** Sorts a hidden tab after a visible one; among equals, the least stale first. */
const isLive = (s: CandidateSession): boolean => true !== s.hidden && true !== s.throttled;
const staleness = (s: CandidateSession): number => s.lastSeenMs ?? Number.POSITIVE_INFINITY;

/**
 * The session to drive, or null when nothing on this url qualifies.
 *
 * Preference order, strongest evidence first:
 *   1. NEW since we opened the tab — definitely this run's, definitely alive
 *   2. visible and not throttled  — the tab a human is actually looking at
 *   3. least stale               — the best of a bad set
 *
 * `before` is the set of session ids that already existed when this run started; anything outside
 * it belongs to us.
 */
export function pickSession(
  sessions: readonly CandidateSession[],
  url: string,
  before: ReadonlySet<string> = new Set(),
  /**
   * The runtime this project's app RUNS as, when it is a desktop one.
   *
   * A desktop shell serves its renderer from an ordinary dev server, so its window and a browser tab
   * open on the same origin are indistinguishable by url. Driving the tab passes every check here —
   * live, on the url, SDK present — while having none of the app's IPC and none of its commands, so
   * the verdict describes a different program that happens to share an address.
   *
   * Undefined for a web project, where the runtime is not a distinction worth making.
   */
  requiredRuntime?: string,
): CandidateSession | null {
  const wanted = String(url).replace(/\/$/, '');
  const onUrl = sessions
    .filter((s) => (s?.url ?? '').startsWith(wanted))
    // An SDK too old to report a runtime is ACCEPTED rather than excluded: re-running init is the
    // only upgrade path an existing user has, and refusing them their own install to enforce a
    // field their SDK cannot send would break the one route out.
    .filter(
      (s) =>
        undefined === requiredRuntime || undefined === s.runtime || requiredRuntime === s.runtime,
    );
  if (0 === onUrl.length) return null;
  const fresh = onUrl.filter((s) => !before.has(s.sessionId));
  const pool = 0 < fresh.length ? fresh : onUrl;
  return pool.find(isLive) ?? [...pool].sort((a, b) => staleness(a) - staleness(b))[0] ?? null;
}
