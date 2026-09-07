import { z } from 'zod';

/**
 * Finish a truncated snapshot, or say it could not be finished.
 *
 * The snapshot walk stops at its node cap and returns a document-order PREFIX with `truncated:true`.
 * That flag has always been honest and has never been actionable: it says the read stopped, not
 * where, so a caller could receive half a page and draw a NEGATIVE conclusion from it — "no error is
 * shown", "the row is gone" — when the thing was simply past the cut. A read that under-reports is a
 * verification result that is quietly wrong.
 *
 * The walk now names its own frontier (`unread`: refs of the subtrees it never entered), so the cut
 * is recoverable: re-read each branch at its own path and the union is the whole tree. This is that
 * loop, plus the half that matters — when the union CANNOT be assembled it says so, and the caller
 * must not turn an empty result over it into an absence.
 *
 * The assembled tree is a UNION of subtrees, not a re-render: each appended chunk is indented from
 * its own root. Callers scan it line by line (that is what every consumer of `tree` does), so the
 * indentation restart costs nothing and re-walking the whole page from scratch would cost a lot.
 */

/**
 * How many snapshot round-trips one completion may spend.
 *
 * Each is a real command to the page, so this is the cost ceiling of a completed read, not a safety
 * net. Twelve covers a page whose cut frontier is a handful of branches a couple of levels deep —
 * the shape a node cap actually produces — while keeping the worst case near a dozen round-trips
 * rather than a walk of the DOM one subtree at a time.
 */
export const MAX_COMPLETION_READS = 12;

/**
 * How many times the completion may follow a frontier into a new one.
 *
 * A branch re-read can itself truncate and name further branches, so this recursion needs a floor
 * under it independent of the read budget: a hostile or pathologically deep DOM can hand back a new
 * frontier every round forever. Four rounds (the first read plus three levels of re-reads) is deeper
 * than a node cap reaches on a real page, and terminates on one that is not real.
 */
export const MAX_COMPLETION_DEPTH = 4;

const SnapshotShape = z.object({
  tree: z.string().optional(),
  truncated: z.boolean().optional(),
  unread: z.array(z.string()).optional(),
  unreadOverflow: z.literal(true).optional(),
});

/** Reads one snapshot — whole page when `scope` is undefined, that branch when it is not. */
type SnapshotReader = (scope: string | undefined) => Promise<unknown>;

interface CompletedRead {
  /** The union of every subtree that was read. Never a lie about what it contains — only about how much. */
  tree: string;
  /** True only when every branch the page cut was read back. A negative conclusion needs this. */
  complete: boolean;
  reads: number;
  /** Why completion stopped short, for the caller to quote. Present ONLY when `complete` is false. */
  incompleteBecause?: string;
}

export async function readCompleteTree(read: SnapshotReader): Promise<CompletedRead> {
  const parts: string[] = [];
  let frontier: (string | undefined)[] = [undefined];
  let reads = 0;
  const stop = (because: string): CompletedRead => ({
    tree: parts.join('\n'),
    complete: false,
    reads,
    incompleteBecause: because,
  });

  for (let round = 0; round < MAX_COMPLETION_DEPTH; round += 1) {
    const next: string[] = [];
    for (const scope of frontier) {
      if (reads >= MAX_COMPLETION_READS) {
        return stop(
          `the page kept naming unread branches past ${String(MAX_COMPLETION_READS)} reads, so part of it was never seen`,
        );
      }
      const parsed = SnapshotShape.safeParse(await read(scope));
      reads += 1;
      if (!parsed.success) return stop('a snapshot came back in a shape this read cannot trust');
      parts.push(parsed.data.tree ?? '');
      if (true === parsed.data.unreadOverflow) {
        return stop(
          'the cut named more branches than one snapshot can carry, so the frontier itself is incomplete and no sequence of re-reads can finish this page',
        );
      }
      next.push(...(parsed.data.unread ?? []));
    }
    if (0 === next.length) return { tree: parts.join('\n'), complete: true, reads };
    frontier = next;
  }
  return stop(
    `re-reads kept cutting after ${String(MAX_COMPLETION_DEPTH)} rounds, so part of the page was never seen`,
  );
}
