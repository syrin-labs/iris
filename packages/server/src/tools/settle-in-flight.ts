/**
 * Spend the budget you were given before reporting that you ran out of certainty.
 *
 * `waitForPredicate` resolves the instant the predicate holds. On an app that navigates
 * optimistically — which is normal, correct behaviour, and the norm on exactly the flows agents
 * verify most: login, submit, save — that instant arrives while the write is still in flight. The
 * verdict was then taken over a window the app had not finished writing, and came back
 * `unknown / unsettled` with a recovery note asking the CALLER to re-check.
 *
 * Measured on the most common flow there is: a login that genuinely succeeded returned at 492ms out
 * of an 8000ms budget. The declared signal had fired with matching data, state had moved from
 * anonymous to authenticated, the token was in storage, honesty grade was `signal` and capture
 * integrity was clean. Seven and a half seconds of authorised waiting went unused, and the agent was
 * handed a shrug.
 *
 * A false NEGATIVE is not the mirror of a false positive here. A false positive stops an agent early;
 * a false negative makes it redo work that already succeeded, and — far worse — teaches it to
 * discount the verdict channel. The verdict channel is the entire product, and an agent that learns
 * to ignore `unknown` will ignore the true ones too.
 *
 * What this does NOT do is decide the request succeeded. At 492ms nobody can know that, and inventing
 * a green here would be the exact defect this product exists to prevent. It waits for the answer
 * rather than guessing at it:
 *
 *   - everything settles → the normal contradiction machinery sees the real responses, so a failure
 *     still contradicts and a success no longer looks like an absence;
 *   - still in flight when the budget genuinely runs out → `unsettled`, as before, but now an honest
 *     limit instead of an early exit.
 */

import { EventType, isDevToolingUrl } from '@reticlehq/core';

/**
 * The dev toolchain talking about ITSELF is not the app finishing its work.
 *
 * `evalSettled` and `findContradictions` both drop it already; this file read the raw window, so the
 * exclusion was cosmetic exactly where it decides a verdict. Reported from a real drive: a
 * deliberately disabled control — no state change, no storage change, zero application requests —
 * was graded on the strength of a Next webpack hot-update the same payload printed as ignored.
 */
const isDevTooling = (data: Record<string, unknown>): boolean =>
  isDevToolingUrl('string' === typeof data['url'] ? data['url'] : undefined);

/** Just the shape this needs — a real Session satisfies it, and a test can supply it. */
export interface SettleSource {
  eventsSince(cursor: number): readonly { type: string; data: Record<string, unknown> }[];
  elapsed(): number;
}

interface WaitOpts {
  /** Injected so the wait is testable without real time passing (rule: never call the clock inline). */
  sleep(ms: number): Promise<void>;
}

/** How often to re-read the buffer. Short enough to return promptly, long enough not to spin. */
const POLL_MS = 50;

const idOf = (data: Record<string, unknown>): string | undefined =>
  'string' === typeof data['id'] ? data['id'] : undefined;

/**
 * Requests that started in this window and have not come back.
 *
 * A settle for a request this window never saw START is ignored on purpose: the window is floored at
 * the act cursor, so a response belonging to an earlier action can land inside it, and counting that
 * as progress would let unrelated traffic close the window early.
 */
export function inFlightRequestIds(
  events: readonly { type: string; data: Record<string, unknown> }[],
): string[] {
  const settled = new Set<string>();
  for (const e of events) {
    if (e.type !== EventType.NET_REQUEST) continue;
    const id = idOf(e.data);
    if (id !== undefined) settled.add(id);
  }
  const open: string[] = [];
  for (const e of events) {
    if (e.type !== EventType.NET_PENDING || isDevTooling(e.data)) continue;
    const id = idOf(e.data);
    if (id !== undefined && !settled.has(id) && !open.includes(id)) open.push(id);
  }
  return open;
}

/**
 * The same outstanding requests, as "METHOD url" — what an unsettled verdict has to be able to name.
 *
 * A correlation id is the right key for the wait and useless in a sentence: an agent told that
 * `r-17` is open cannot act on it, while `POST /api/login` is the thing to re-check or to assert
 * directly. Read off the NET_PENDING the window already holds, so this costs one pass over events
 * that are in hand.
 */
export function inFlightRequestLabels(
  events: readonly { type: string; data: Record<string, unknown> }[],
): string[] {
  const open = new Set(inFlightRequestIds(events));
  const labels: string[] = [];
  for (const e of events) {
    if (e.type !== EventType.NET_PENDING) continue;
    const id = idOf(e.data);
    if (id === undefined || !open.has(id)) continue;
    open.delete(id); // one label per request, however many times its start was recorded
    const method = 'string' === typeof e.data['method'] ? e.data['method'] : 'request';
    const url = 'string' === typeof e.data['url'] ? e.data['url'] : 'an unreported url';
    labels.push(`${method} ${url}`);
  }
  return labels;
}

/** Enough to recognise the loop; a busy dashboard must not spend the verdict on a URL list. */
const MAX_REPEATED = 3;
/** One call is traffic. Two to the same endpoint inside one window is a repeat. */
const MIN_REPEATS = 2;

/**
 * Endpoints called MORE THAN ONCE in this window, busiest first, as "METHOD url ×N".
 *
 * The other half of an honest `unsettled`. A retrying query against a dead backend leaves nothing in
 * flight — every attempt comes back, then the next one fires — so the verdict fell through to "what
 * kept the page busy was its own churn (a poll, a timer, an animation)", which names three things
 * and points at none of them. Measured in the field: on an app with a background retry loop
 * `act_and_wait` could never return a pass, and nothing in the verdict said which endpoint to look
 * at. This does not judge the repetition — a poll is legitimate — it reports it, which is all an
 * agent needs to tell "my assertion was wrong" from "this app never quiets".
 */
export function repeatedRequestLabels(
  events: readonly { type: string; data: Record<string, unknown> }[],
): string[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.type !== EventType.NET_REQUEST || isDevTooling(e.data)) continue;
    const method = 'string' === typeof e.data['method'] ? e.data['method'] : 'request';
    const url = 'string' === typeof e.data['url'] ? e.data['url'] : 'an unreported url';
    const key = `${method} ${url}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= MIN_REPEATS)
    .sort(([, a], [, b]) => b - a)
    .slice(0, MAX_REPEATED)
    .map(([key, count]) => `${key} ×${String(count)}`);
}

interface SettleResult {
  /** True when nothing this window started is still outstanding. */
  settled: boolean;
  /** What was still open when the wait ended — empty when `settled`. */
  stillInFlight: string[];
}

/**
 * Wait, bounded by `budgetMs`, for the requests this window started to come back.
 *
 * Returns immediately when nothing is in flight, so the common green path — an action with no traffic
 * — pays nothing at all. A zero or negative budget means no wait: the caller may have spent the whole
 * timeout reaching the predicate, and a negative deadline must mean "stop", never "loop forever".
 */
export async function waitForInFlight(
  session: SettleSource,
  since: number,
  budgetMs: number,
  opts: WaitOpts,
): Promise<SettleResult> {
  let open = inFlightRequestIds(session.eventsSince(since));
  if (0 === open.length) return { settled: true, stillInFlight: [] };
  if (budgetMs <= 0) return { settled: false, stillInFlight: open };

  const deadline = session.elapsed() + budgetMs;
  while (session.elapsed() < deadline) {
    // Never overshoot the budget: the last sleep is trimmed to whatever is actually left.
    await opts.sleep(Math.min(POLL_MS, deadline - session.elapsed()));
    open = inFlightRequestIds(session.eventsSince(since));
    if (0 === open.length) return { settled: true, stillInFlight: [] };
  }
  return { settled: false, stillInFlight: open };
}
