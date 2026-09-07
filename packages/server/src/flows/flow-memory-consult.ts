/**
 * What the team already knows about the flow being verified.
 *
 * ## Why a replay should ask at all
 *
 * Shared memory is written on every verification and, measured across this project's whole corpus,
 * read essentially never: every subject on the dashboard showed `fetches: 0` and `readers: []`. Not
 * because the data is useless — because consulting it is a SEPARATE act an agent has to remember to
 * perform. Knowledge that must be deliberately fetched is a wiki, and wikis are not read.
 *
 * So verification asks on the agent's behalf. Replaying `checkout` returns what the project knows
 * about checkout beside the verdict, which is the difference between memory the platform stores and
 * memory the platform USES — and it is the only way the read counts on the coverage map ever become
 * a real signal rather than a number nobody moves.
 *
 * ## Why this file is pure
 *
 * The fetch is the caller's. What a replay is ENTITLED to ask for — which subject, how much of it —
 * is a rule worth testing without a network, and the rule is where the mistakes live.
 */
import type { FlowFile } from '@reticlehq/core';

/**
 * How many records travel back with a verdict.
 *
 * Small on purpose. This rides on every replay, and a verdict that arrives with fifty statements
 * attached is one whose actual result is now below the fold. The subject page is one call away for
 * an agent that wants the rest.
 */
export const MEMORY_CONSULT_LIMIT = 5;

/**
 * The subject a replay should ask about.
 *
 * The FLOW NAME, because a flow is a feature and that is the axis the store shards on — replaying
 * `checkout` should surface what the team knows about checkout, not about the route it happens to
 * start on. A flow whose name says nothing gets nothing: asking for `unsorted` would return the
 * project's junk drawer on every verdict, which is worse than silence because it looks like an
 * answer.
 */
export function consultSubjectFor(flow: FlowFile): string | undefined {
  const name = flow.name;
  if ('string' !== typeof name || 0 === name.trim().length) return undefined;
  return name.trim();
}

/** One thing the project knows, as it travels back with a verdict. */
export interface ConsultedMemory {
  statement: string;
  status: string;
}

/**
 * Trim what came back to what is worth carrying.
 *
 * PROVED records first: a statement something has actually verified is stronger evidence about the
 * feature than one somebody proposed and never checked. Beyond that the order is the server's, and
 * anything without a statement is dropped rather than rendered as an empty line.
 */
export function selectConsulted(
  entries: readonly { statement?: unknown; status?: unknown }[],
  limit = MEMORY_CONSULT_LIMIT,
): ConsultedMemory[] {
  const usable = entries.flatMap((e) =>
    'string' === typeof e.statement && e.statement.trim().length > 0
      ? [{ statement: e.statement, status: 'string' === typeof e.status ? e.status : 'unknown' }]
      : [],
  );
  const proved = usable.filter((e) => 'proved' === e.status);
  const rest = usable.filter((e) => 'proved' !== e.status);
  return [...proved, ...rest].slice(0, limit);
}
