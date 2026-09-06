/**
 * Whether a session was attached for the whole window an agent is about to reason about.
 *
 * `reticle_sessions` answers "which tabs are connected RIGHT NOW", and **a tab that dropped for four
 * seconds and came back looks identical to one that never dropped** (#117). That is the difference
 * between a verdict you can trust and one that describes what you happened to see — the same problem
 * `honesty.integrity` solves for a single action, applied to the session.
 *
 * Measured HERE rather than reported by the SDK. The browser transport does track
 * `#disconnectedSince` (`transport.ts:95`), and reading it would need a wire change and a new thing
 * for every SDK version to remember to send. The daemon already sees both halves — `remove()` when
 * the socket drops, `add()` when it returns — so the gap is computable with no protocol change at
 * all, and it cannot drift out of sync with what the daemon actually observed.
 *
 * The clock is injected, per the repo rule: this is arithmetic over timestamps, and a test that
 * needs to wait four seconds to check a four-second gap is a test nobody runs.
 */

/** What an agent needs to know about the continuity of one session. */
interface Attachment {
  /** How long THIS attachment has lasted. Resets on reconnect — it is not the session's lifetime. */
  connectedSinceMs: number;
  /** How many times this session dropped and came back. Zero means it never left. */
  outages: number;
  /** The most recent gap, when there has been one. */
  lastOutage?: { startedMs: number; durationMs: number };
}

interface Record_ {
  attachedAt: number;
  outages: number;
  detachedAt?: number;
  lastOutage?: { startedMs: number; durationMs: number };
}

export class AttachmentHistory {
  readonly #now: () => number;
  readonly #records = new Map<string, Record_>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** A session connected, or reconnected. A reconnect closes the open gap and counts an outage. */
  attached(sessionId: string): void {
    const at = this.#now();
    const prior = this.#records.get(sessionId);
    if (prior?.detachedAt === undefined) {
      this.#records.set(sessionId, { attachedAt: at, outages: prior?.outages ?? 0 });
      return;
    }
    this.#records.set(sessionId, {
      attachedAt: at,
      outages: prior.outages + 1,
      lastOutage: { startedMs: prior.detachedAt, durationMs: at - prior.detachedAt },
    });
  }

  /** A session dropped. The gap stays open until it comes back, or the record is forgotten. */
  detached(sessionId: string): void {
    const prior = this.#records.get(sessionId);
    if (prior === undefined) return;
    this.#records.set(sessionId, { ...prior, detachedAt: this.#now() });
  }

  /** Drop a session's history. A long-lived daemon must not accumulate one record per tab forever. */
  forget(sessionId: string): void {
    this.#records.delete(sessionId);
  }

  /**
   * The continuity of one session, or `undefined` when it has never been seen.
   *
   * Undefined rather than a zeroed record on purpose: `outages: 0` reads as "it never dropped", which
   * is a confident claim about a session this has no knowledge of.
   */
  of(sessionId: string): Attachment | undefined {
    const record = this.#records.get(sessionId);
    if (record === undefined) return undefined;
    return {
      connectedSinceMs: this.#now() - record.attachedAt,
      outages: record.outages,
      ...(record.lastOutage === undefined ? {} : { lastOutage: record.lastOutage }),
    };
  }
}
