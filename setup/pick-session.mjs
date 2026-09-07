/**
 * Which session to drive, given everything the daemon is holding.
 *
 * This is a false-green guard, which is why it is its own module with its own test rather than four
 * lines inlined in the middle of a setup script. Two ways to get it wrong, both of which report a
 * successful install for an app that was never verified:
 *
 *   - match "any session" and you pass on somebody else's tab — a daemon usually holds several, and
 *     one of them being alive says nothing about whether YOUR app connected.
 *   - match "the first session on this url" and you drive whichever the daemon happened to list
 *     first, usually the oldest: a tab from a dev server that died yesterday. The HUD then plays to
 *     a window nobody is watching, and the verdict describes a page the user cannot see.
 *
 * Preference order, strongest evidence first:
 *   1. NEW since we opened the tab — definitely this run's, definitely alive
 *   2. visible and not throttled  — the tab a human is actually looking at
 *   3. most recently seen         — the least stale of a bad set
 */
export function pickSession(sessions, url, before = new Set()) {
  const wanted = String(url).replace(/\/$/, '');
  const onUrl = (sessions ?? []).filter((s) => (s?.url ?? '').startsWith(wanted));
  if (onUrl.length === 0) return null;
  const live = (s) => s.hidden !== true && s.throttled !== true;
  const fresh = onUrl.filter((s) => !before.has(s.sessionId));
  const pool = fresh.length > 0 ? fresh : onUrl;
  return (
    pool.find(live) ??
    pool.slice().sort((a, b) => (a.lastSeenMs ?? Infinity) - (b.lastSeenMs ?? Infinity))[0]
  );
}
