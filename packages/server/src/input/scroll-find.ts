import { ReticleCommand, SCROLL_FIND_DEFAULTS, type CommandResult } from '@reticlehq/core';
import { asRecord } from '../tools/tools-helpers.js';

/** The slice of Session scroll-to-find needs — so tests inject a fake without a live browser. */
export interface ScrollFindSession {
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
}

export interface ScrollFindQuery {
  by: string;
  value: string;
  name?: string;
  /** Ref of the scrollable list container; omit to scroll the document. */
  container?: string;
  /**
   * Known index of the target row in the list. When combined with totalCount, enables bisection:
   * one jump to the estimated scroll offset rather than 20 sequential viewport scrolls.
   */
  targetIndex?: number;
  /** Total item count in the list (required for bisection). */
  totalCount?: number;
}

export interface ScrollFindResult {
  found: boolean;
  /** The first matching element descriptor (when found). */
  element?: Record<string, unknown>;
  /** How many viewport scrolls were performed. */
  scrolls: number;
  /**
   * true ⇒ stopped because the list reached its end / could not scroll (raising maxScrolls won't
   * help). false ⇒ stopped at the maxScrolls budget (more rows may exist further down).
   */
  exhausted: boolean;
  /**
   * Present only when informative: the document itself did not scroll (nothing scrollable), so the
   * target is likely inside a list with its own scroll container. A genuine exhaustion — reaching
   * the real end of a scrolled container — stays quiet.
   */
  note?: string;
}

/** One query for the target; returns the first matching element descriptor or undefined. */
async function queryFirst(
  session: ScrollFindSession,
  q: ScrollFindQuery,
): Promise<Record<string, unknown> | undefined> {
  const res = await session.command(ReticleCommand.QUERY, {
    by: q.by,
    value: q.value,
    ...(q.name !== undefined ? { name: q.name } : {}),
  });
  const elements = asRecord(res.result)['elements'];
  if (Array.isArray(elements) && elements.length > 0) return asRecord(elements[0]);
  return undefined;
}

/**
 * A note attached to `{ found: false, exhausted: true }` only when the failure is actually
 * informative: nothing in the container ever moved (so the "list" being searched was never
 * scrollable and the target is likely inside one with its own scroll container). Reaching the
 * genuine ends of a container that DID scroll stays quiet — that is exhaustion, not confusion.
 */
function exhaustNote(
  q: ScrollFindQuery,
  data: Record<string, unknown>,
  nothingEverScrolled: boolean,
): { note?: string } {
  if (q.container !== undefined) return {};
  if (true === data['scrolled'] || !nothingEverScrolled) return {};
  return {
    note: "The document did not scroll — the target may be inside a list with its own scroll container. Pass that container's ref as `container`.",
  };
}

/** One viewport-height step upward when the last result carried no clientHeight to size it by. */
const UP_STEP_FALLBACK_PX = 400;

/**
 * Size the upward step off the container the SCROLL result just described, falling back to a
 * plain viewport height when the result did not carry one.
 */
function upStepPx(last: Record<string, unknown>): number {
  const h = last['clientHeight'];
  return 'number' === typeof h && h > 0 ? h : UP_STEP_FALLBACK_PX;
}

/**
 * Reveal an element that a windowed/virtualized list has not mounted yet. Queries once (it may
 * already be visible), optionally jumps straight to a bisection estimate, then walks the container
 * a viewport at a time re-querying after each step. Downward first; when the bottom is reached the
 * walk TURNS AROUND and continues upward, because a list that is already scrolled to its end keeps
 * its earlier rows mounted above the viewport and a downward-only search answered "exhausted" on
 * its first step (#505). `exhausted` therefore means BOTH directions are spent, not "the bottom is
 * here". Pure orchestration over the session command seam — fully unit-testable with a fake.
 */
export async function scrollToFind(
  session: ScrollFindSession,
  q: ScrollFindQuery,
  opts: { maxScrolls?: number } = {},
): Promise<ScrollFindResult> {
  const max = opts.maxScrolls ?? SCROLL_FIND_DEFAULTS.MAX_SCROLLS;

  const first = await queryFirst(session, q);
  if (first !== undefined) return { found: true, element: first, scrolls: 0, exhausted: false };

  const baseArgs = (): Record<string, unknown> =>
    q.container !== undefined ? { ref: q.container } : {};

  let scrolls = 0;
  let last: Record<string, unknown> = {};

  // Bisection: if the caller knows the target index and list size, jump to the estimated offset in
  // one scroll command rather than stepping a viewport at a time. The estimate can land on either
  // side of the target, so refinement below still searches both directions from wherever this put us.
  if (q.targetIndex !== undefined && q.totalCount !== undefined && q.totalCount > 1) {
    const fraction = Math.min(1, Math.max(0, q.targetIndex / q.totalCount));
    const sr = await session.command(ReticleCommand.SCROLL, { ...baseArgs(), fraction });
    scrolls += 1;
    last = asRecord(sr.result);
    const hit = await queryFirst(session, q);
    if (hit !== undefined) return { found: true, element: hit, scrolls, exhausted: false };
  }

  let downwardSpent = false;
  let everScrolled = false;

  // The downward pass. Spending its whole budget without reaching the end means rows may remain
  // further down, so that answer is `exhausted:false` and the upward pass never runs.
  for (let i = 0; i < max && !downwardSpent; i += 1) {
    const sr = await session.command(ReticleCommand.SCROLL, baseArgs());
    scrolls += 1;
    const data = asRecord(sr.result);
    last = data;
    if (true === data['scrolled']) everScrolled = true;

    const hit = await queryFirst(session, q);
    if (hit !== undefined) return { found: true, element: hit, scrolls, exhausted: false };

    // Reached the bottom, or the container would not move downward — turn around before giving up.
    if (true === data['atEnd'] || true !== data['scrolled']) downwardSpent = true;
  }

  // If the downward pass spent its budget it never saw the end, so there is nothing to turn around
  // for; report honestly rather than doubling a call whose caller asked for `max` steps.
  if (!downwardSpent) {
    return { found: false, scrolls, exhausted: false };
  }

  // The upward pass gets the caller's budget again, not what is left of it: a list at the bottom of
  // 14k px needs ~90 scrolls to reach its end and ~90 more to get back, so sharing one budget would
  // strand the search halfway and answer `exhausted:false` about a list both of whose ends are known.
  for (let i = 0; i < max; i += 1) {
    const sr = await session.command(ReticleCommand.SCROLL, { ...baseArgs(), dy: -upStepPx(last) });
    scrolls += 1;
    const data = asRecord(sr.result);
    last = data;
    if (true === data['scrolled']) everScrolled = true;

    const hit = await queryFirst(session, q);
    if (hit !== undefined) return { found: true, element: hit, scrolls, exhausted: false };

    // The top refusing to move means both directions are spent.
    if (true !== data['scrolled']) {
      return { found: false, scrolls, exhausted: true, ...exhaustNote(q, data, !everScrolled) };
    }
  }
  return { found: false, scrolls, exhausted: false }; // spent the upward budget; more may lie above
}
