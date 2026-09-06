import { MarkStatus, type HumanMarkData, type MarkAnchorStrategy } from '@reticlehq/core';

/**
 * One human review mark: a mistake a human flagged on the running page, pinned to an element, ready
 * for the agent to drain and fix. The wire payload (HumanMarkData) plus a server-assigned id, the
 * session-relative time it landed, and its lifecycle status.
 */
export interface ReviewMark {
  id: string;
  note: string;
  /** Re-resolvable element anchor (auto-anchor string). */
  anchor: string;
  strategy: MarkAnchorStrategy;
  label?: string;
  /** Source file:line the agent should open to fix it, when the framework stamped one. */
  source?: { file: string; line: number };
  route?: string;
  /** Session-relative ms the mark was made (injected clock at the call site — never read here). */
  at: number;
  status: MarkStatus;
}

/**
 * Per-session store of human review marks (the "annotate the bug where you see it" inbox). A mark is
 * added when a HUMAN_MARK event arrives, listed by the agent via reticle_review, and retired with
 * resolve when the agent claims the fix — distinct from the live-control inbox, which is drained
 * (delivered-once) on read. Marks persist (read does not consume) so the agent can list, fix, and
 * THEN resolve, and a fix can be verified against the same mark.
 *
 * Pure in-memory state: no IO, no clock. The id is a monotonic counter (m1, m2, …) so it is
 * deterministic and never depends on Math.random/Date.now; the timestamp is passed in by the caller.
 */
/** Prefix on review-mark ids (m1, m2, …) — distinguishes them from command ids. */
const MARK_ID_PREFIX = 'm';

/**
 * Shared by every store in the process, so an id is never reissued.
 *
 * The sequence used to live on the instance, which looked right and was not: a store is created per
 * Session, and a Session is recreated on every page reload and socket reattach. Each new store began
 * again at `m1`, so an id an agent was still holding silently came to denote a DIFFERENT mark — and
 * `resolve` retired that one instead, reporting success. Reported from the field by an agent that
 * closed a bug nobody had fixed while the two it had fixed vanished unrecorded.
 *
 * Process-wide is deliberately not "forever": a daemon restart resets it, but a restart also
 * destroys every session, so any id from before it resolves to nothing and `resolve` correctly
 * returns false. The identity echo below covers what remains.
 */
let nextMarkId = 0;

/** Tests only — assertions on `m1` must not depend on which test ran first. */
export function resetMarkIdsForTest(): void {
  nextMarkId = 0;
}

/** What `resolve` actually did, including WHICH mark — so a caller can verify it hit the right one. */
interface ResolveOutcome {
  resolved: boolean;
  id: string;
  /** The retired mark's note. Absent when nothing was resolved. */
  note?: string;
}

export class ReviewStore {
  readonly #marks: ReviewMark[] = [];

  /** Store a new mark (status pending) stamped with the caller-supplied session-relative time. */
  add(data: HumanMarkData, at: number): ReviewMark {
    nextMarkId += 1;
    const mark: ReviewMark = {
      id: `${MARK_ID_PREFIX}${String(nextMarkId)}`,
      note: data.note,
      anchor: data.anchor,
      strategy: data.strategy,
      at,
      status: MarkStatus.PENDING,
    };
    if (data.label !== undefined) mark.label = data.label;
    if (data.source !== undefined) mark.source = data.source;
    if (data.route !== undefined) mark.route = data.route;
    this.#marks.push(mark);
    return mark;
  }

  /** All marks still awaiting a fix, oldest first. Reading never consumes — resolve retires a mark. */
  pending(): ReviewMark[] {
    return this.#marks.filter((m) => m.status === MarkStatus.PENDING).map((m) => ({ ...m }));
  }

  /** Count of pending marks, for the panel badge / diagnostics. */
  pendingCount(): number {
    return this.#marks.reduce((n, m) => (m.status === MarkStatus.PENDING ? n + 1 : n), 0);
  }

  /** Full history (pending + resolved), oldest first. */
  all(): ReviewMark[] {
    return this.#marks.map((m) => ({ ...m }));
  }

  /**
   * Retire a mark the agent has fixed. Returns true on a genuine pending → resolved transition,
   * false for an unknown id or an already-resolved mark (so resolve is idempotent).
   */
  resolve(id: string): boolean {
    return this.resolveDetail(id).resolved;
  }

  /**
   * Resolve, and say WHICH mark was retired.
   *
   * The bare boolean is what made the misattribution silent: `{"resolved":true}` is equally
   * consistent with "I retired the bug you fixed" and "I retired somebody else's". Echoing the note
   * lets a caller check the answer against what it believed it was resolving, which is exactly what
   * the agent that hit this asked for — it had been re-reading the whole list after every resolve
   * and hand-diffing the notes to get the same assurance.
   */
  resolveDetail(id: string): ResolveOutcome {
    const mark = this.#marks.find((m) => m.id === id);
    if (mark === undefined || mark.status === MarkStatus.RESOLVED) return { resolved: false, id };
    mark.status = MarkStatus.RESOLVED;
    return { resolved: true, id, note: mark.note };
  }
}
