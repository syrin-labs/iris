/**
 * Wait, briefly, for the SDK to reconnect after a navigation — so `confirmed` can mean something.
 *
 * `window.location.assign(url)` destroys the SDK that would report on the new document, so the
 * navigation itself cannot be confirmed from inside the page. But the SDK reconnects TO THE DAEMON,
 * which makes the daemon the only party that can see arrival happen. Before this, it did not look,
 * and told the agent to poll `reticle_sessions` instead — a tool call on every navigation, on the
 * least reliable tool we ship.
 *
 * Bounded and best-effort by construction: a navigation to a page that is not instrumented, or not
 * there at all, must still return promptly with `confirmed:false` rather than hanging. The clock and
 * the sleep are injected so this is testable without waiting on a real one.
 */

import type { SessionManager } from '../session/session-manager.js';
import type { NavigateArrival } from './navigate-result.js';

/** Long enough for a dev server to serve a page and the SDK to dial back; short enough to not hang. */
const ARRIVAL_TIMEOUT_MS = 5_000;
const POLL_MS = 100;

/**
 * Compare only origin + pathname.
 *
 * The app is entitled to add or rewrite the query and hash on arrival — a redirect to
 * `?redirect=%2F`, a router normalising a trailing slash, an auth guard appending a reason. Matching
 * the whole URL string would report `confirmed:false` for a navigation that plainly succeeded, which
 * is the same lie in the opposite direction.
 */
function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '');
  } catch {
    return false;
  }
}

function findArrival(sessions: SessionManager, target: string): NavigateArrival | null {
  for (const s of sessions.all()) {
    if (samePage(s.url, target)) return { sessionId: s.id };
  }
  return null;
}

export interface ArrivalClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const REAL_CLOCK: ArrivalClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Poll until a session is present at `target`, or the budget runs out. Returns `null` on timeout —
 * never throws, because a failure to confirm is a legitimate answer, not an error.
 */
export async function awaitArrival(
  sessions: SessionManager,
  target: string,
  timeoutMs: number = ARRIVAL_TIMEOUT_MS,
  clock: ArrivalClock = REAL_CLOCK,
): Promise<NavigateArrival | null> {
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    const found = findArrival(sessions, target);
    if (found !== null) return found;
    if (clock.now() >= deadline) return null;
    await clock.sleep(POLL_MS);
  }
}
