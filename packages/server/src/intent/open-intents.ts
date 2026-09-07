import { IntentStore } from './intent-store.js';
import { sessionRoot } from '../project/session-root.js';
import type { Intent } from '@reticlehq/core';
import type { ToolDeps } from '../tools/tool-kit.js';

/**
 * What this project still owes — the ledger's undischarged intents, for a tool that has `deps` and a
 * session id rather than a store.
 *
 * One helper rather than the same three-line construction at each site: the ROOT resolution is the
 * part that must not drift. A caller that resolved the daemon's own directory while the declaring
 * tool wrote to the project's would read an empty ledger and report that nothing was declared, which
 * is a false accusation rather than an error.
 */
export async function openSessionIntents(
  deps: ToolDeps,
  sessionId: string | undefined,
): Promise<Intent[]> {
  return new IntentStore(deps.fs, sessionRoot(deps, sessionId), { now: deps.now }).open();
}

/**
 * EVERY intent in the ledger, proved ones included — the denominator the open list is a subset of.
 *
 * Separate from `openSessionIntents` rather than a flag on it, because the two answer different
 * questions: "what does this project still owe" drives a verdict's honesty, and "was anything ever
 * declared" is what decides whether `reticle_intent` is used at all. Same root resolution, for the
 * same reason it is shared above.
 */
export async function allSessionIntents(
  deps: ToolDeps,
  sessionId: string | undefined,
): Promise<Intent[]> {
  return new IntentStore(deps.fs, sessionRoot(deps, sessionId), { now: deps.now }).read();
}

/** What the ledger still owes once this verdict's own intent is discharged, and how old it is. */
interface IntentDebt {
  openIntentCount: number;
  /**
   * Age of the OLDEST open intent, in ms. Absent when nothing is open.
   *
   * A count alone cannot tell "declared a minute ago and not proved yet" from "this project has
   * owed eighteen things since last week", and only the first is actionable on the result being
   * read. A number that is always large is one people learn to skip, which is how an honest gap
   * gets filtered out along with the noise.
   */
  oldestOpenIntentAgeMs?: number;
}

/**
 * The debt a verdict should report, MINUS the intent it is about to discharge.
 *
 * The discharge happens after the gaps are built, so counting the raw ledger would include the
 * intent this very call proves — measured live: an inline intent was declared, asserted and proved
 * by one verdict, and the result still said "1 declared intent(s) are still unproved".
 */
export function intentDebt(
  open: readonly Intent[],
  dischargedId: string | undefined,
  now: number,
): IntentDebt {
  const stillOpen = open.filter((i) => dischargedId === undefined || i.id !== dischargedId);
  const oldest = stillOpen.reduce<number | undefined>(
    (min, i) => (min === undefined || i.declaredAt < min ? i.declaredAt : min),
    undefined,
  );
  return {
    openIntentCount: stillOpen.length,
    ...(oldest === undefined ? {} : { oldestOpenIntentAgeMs: now - oldest }),
  };
}
