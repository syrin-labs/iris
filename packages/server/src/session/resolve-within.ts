/**
 * Resolve a session, or spend the caller's stated budget waiting for one to arrive.
 *
 * Every tool that takes a `timeout_ms` used to resolve the session as its FIRST statement, so an
 * empty session map threw before the budget was ever consulted. A caller that said "wait up to
 * thirty seconds for the app" was refused in under a millisecond, and the only way to actually wait
 * was to poll `reticle_sessions` blind.
 *
 * That is the wrong answer to the commonest situation in the product. The moment an agent has run
 * `init` and restarted the dev server is exactly the moment there is no session yet and one is about
 * to appear — and `no_session` is the refusal agents hit most. An agent that gets refused rarely
 * retries; it concludes and moves on. Spending the budget it already asked for turns the most common
 * dead end into a wait that ends in a verdict.
 *
 * Deliberately narrow in two ways.
 *
 * Only the EMPTY case waits. A `sessionId` that names a session which is not connected while others
 * are is a different error with a different fix, and waiting on it would hide a typo behind a
 * timeout.
 *
 * The original error is what gets thrown on expiry, never a generic timeout message. That error
 * carries the daemon's whole diagnosis — the port scan, the next action, the literal command — and
 * it is the single most valuable string this product emits to an agent that has nothing connected.
 * Replacing it with "timed out" would trade the answer for a stopwatch reading.
 */

/** Just the part of the session manager this needs, so a test does not have to build one. */
export interface ResolvableSessions<S> {
  resolve: (sessionId?: string) => S;
  count: () => number;
}

/** How often to re-ask. A session appearing is an out-of-band event; this is a plain poll. */
const POLL_MS = 250;

export async function resolveSessionWithin<S>(
  sessions: ResolvableSessions<S>,
  sessionId: string | undefined,
  timeoutMs: number,
  deps: { now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<S> {
  try {
    return sessions.resolve(sessionId);
  } catch (first) {
    // Nothing to wait FOR unless the map is empty, and nothing to wait WITH unless a budget was
    // given. Either way the caller gets the same error it would have got before.
    if (timeoutMs <= 0 || sessions.count() > 0) throw first;
    const deadline = deps.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - deps.now();
      if (remaining <= 0) throw first;
      await deps.sleep(Math.min(POLL_MS, remaining));
      try {
        return sessions.resolve(sessionId);
      } catch {
        // Still nothing. Keep the FIRST error: it was raised when the daemon had most recently
        // computed its diagnosis, and re-throwing the newest one would report the same fact with a
        // staler explanation.
      }
    }
  }
}
