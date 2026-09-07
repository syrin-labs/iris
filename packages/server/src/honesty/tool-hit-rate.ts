import { CORE_TOOL_NAMES, EXTENDED_TOOL_NAMES } from '../tools/tool-surface.js';

/**
 * Which tools this session called, and how reachable each one was.
 *
 * The generalisation of the capture ledger: it recorded a short list of read tools to answer one
 * feature's disproof, and the question that followed is the same question asked of the whole table —
 * most of the surface has never been observed being called at all, and a decision about what to cut
 * or consolidate is about to be made. This is the instrument for that decision, and nothing else.
 *
 * ## Why the count alone is not enough
 *
 * A tool that goes uncalled because nobody was told it exists and a tool that goes uncalled because
 * nobody wants it look identical in a call count. They are opposite conclusions. So every count is
 * reported beside the tool's REACHABILITY — advertised on the default surface, advertised only on
 * the extended one, or reachable solely by naming it to `reticle_run` — and the interesting cell is
 * the one where an agent found a run-only tool anyway.
 *
 * ## The tiers are derived, never restated
 *
 * `tierOfTool` reads `CORE_TOOL_NAMES` and `EXTENDED_TOOL_NAMES` directly. A tool promoted or
 * demoted between surfaces changes tier here with nothing edited. A local copy of either list would
 * go stale on the first move and would then be wrong about the exact axis this exists to measure —
 * and it would be wrong silently, in a report used to justify deleting things.
 *
 * ## What these numbers do NOT establish
 *
 *  - **One session is not a hit rate.** This is evidence about ONE run by ONE agent against ONE app.
 *    A hit rate is a distribution over many sessions; a single session quoted as one is an anecdote
 *    with a denominator drawn on it.
 *  - **Never-called is not useless.** A tool one team reaches for once a month in an emergency and a
 *    tool nobody has ever called are the same zero here. Frequency alone cannot separate them, so a
 *    cut decided on frequency alone will delete the wrong things.
 *  - **Absent is not zero.** A session with no ledger reports `observed: false`. It has not
 *    established that no tools were called; it has established that nothing was watching.
 *  - The tools that ran BEFORE this instrument existed in the process, or against a session this
 *    daemon adopted after the fact, are simply missing rather than counted low.
 */

/** How an agent could have reached a tool. Derived from the surface sets — see above. */
export const ToolTier = {
  /** Advertised directly on the surface every user gets. */
  DEFAULT: 'default',
  /** Advertised only when the full schema-carrying surface is switched on. */
  EXTENDED: 'extended',
  /** Advertised nowhere: reachable only by naming it to `reticle_run`. */
  RUN_ONLY: 'run-only',
} as const;
export type ToolTier = (typeof ToolTier)[keyof typeof ToolTier];

/** Which surface would have put this tool in front of an agent, read off that surface's own set. */
export function tierOfTool(tool: string): ToolTier {
  if (CORE_TOOL_NAMES.has(tool)) return ToolTier.DEFAULT;
  if (EXTENDED_TOOL_NAMES.has(tool)) return ToolTier.EXTENDED;
  return ToolTier.RUN_ONLY;
}

/** How many tools fell in each tier on one side of the called/never-called split. */
interface TierCounts {
  default: number;
  extended: number;
  runOnly: number;
}

interface ToolHitRate {
  /** False when this session carries no ledger — "not watched", never "nothing was called". */
  observed: boolean;
  /** The four-plus-two cells: every tier, called and never-called. Omitted when not observed. */
  cells?: { called: TierCounts; neverCalled: TierCounts };
  /** Each tool called this session, most-called first. */
  called?: readonly { tool: string; tier: ToolTier; calls: number }[];
  /** Each tool in the table this session never called, by name. */
  neverCalled?: readonly { tool: string; tier: ToolTier }[];
}

function tally(tools: readonly ToolTier[]): TierCounts {
  return {
    default: tools.filter((tier) => ToolTier.DEFAULT === tier).length,
    extended: tools.filter((tier) => ToolTier.EXTENDED === tier).length,
    runOnly: tools.filter((tier) => ToolTier.RUN_ONLY === tier).length,
  };
}

/**
 * Cross one session's per-tool counts with the tool table.
 *
 * `allTools` is the DISPATCHABLE table — the names `reticle_run` will accept — passed in rather than
 * imported, because the table is assembled in the module that owns this tool and importing it back
 * would close a cycle. A tool counted but absent from the table still appears, so a name the table
 * lost is visible rather than dropped.
 */
export function foldToolHitRate(input: {
  calls: ReadonlyMap<string, number> | undefined;
  allTools: readonly string[];
}): ToolHitRate {
  const { calls } = input;
  if (calls === undefined) return { observed: false };

  const called = [...calls]
    .map(([tool, count]) => ({ tool, tier: tierOfTool(tool), calls: count }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  const neverCalled = input.allTools
    .filter((tool) => !calls.has(tool))
    .map((tool) => ({ tool, tier: tierOfTool(tool) }))
    .sort((a, b) => a.tool.localeCompare(b.tool));

  return {
    observed: true,
    cells: {
      called: tally(called.map((entry) => entry.tier)),
      neverCalled: tally(neverCalled.map((entry) => entry.tier)),
    },
    called,
    neverCalled,
  };
}
