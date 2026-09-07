/**
 * What the PROJECT knows, read on demand.
 *
 * Shared memory reached three places before this one: the sync writes it, flow replay consults it
 * automatically, and `reticle memory` prints it at a terminal. The one caller who could not ask was
 * the agent actually doing the work — mid-drive, holding a question, with 44 tools and none of them
 * "what does this team already know about checkout?". That is the gap this closes, and it is the
 * difference between a corpus and a wiki nobody opens.
 *
 * The read is ATTRIBUTED. It carries an agent header, so the coverage map counts it as a
 * consultation and a manager can see which flows are actually being pulled and by whom — the
 * question the fetch counters exist to answer and could not while nothing was reading.
 */
import { cloudFetch } from '../cloud/cloud-sync.js';
import { resolveProjectCloud } from '../cloud/cloud-config.js';
import type { FileSystemPort } from '../project/fs-port.js';

/** Named so a read from the tool surface is distinguishable from the CLI's and from replay's. */
const MCP_AGENT_ID = 'reticle-mcp';

/** Why a lookup returned nothing. Each one is a different thing for the agent to do next. */
export const MemoryUnavailable = {
  /** No `.reticle/cloud.json` — this project has never been linked to a workspace. */
  NOT_LINKED: 'not-linked',
  /** Linked, but the link says not to sync memory. A setting, not a failure. */
  DISABLED: 'memory-sync-disabled',
  /** The server was reached and said no, or could not be reached at all. */
  UNREACHABLE: 'unreachable',
} as const;
export type MemoryUnavailable = (typeof MemoryUnavailable)[keyof typeof MemoryUnavailable];

export interface KnownThing {
  statement: string;
  status: string;
  flowName: string | null;
  sourceFile: string | null;
  subject: string;
}

type ProjectMemoryResult =
  | { ok: true; subject: string | null; known: KnownThing[]; total: number }
  | { ok: false; reason: MemoryUnavailable };

/** Defensive: the wire is somebody else's server, so every field is checked before it is trusted. */
const asKnown = (raw: unknown): KnownThing | null => {
  if (null === raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const statement = r['statement'];
  if (typeof statement !== 'string' || 0 === statement.length) return null;
  return {
    statement,
    status: 'string' === typeof r['status'] ? r['status'] : 'unknown',
    flowName: 'string' === typeof r['flowName'] ? r['flowName'] : null,
    sourceFile: 'string' === typeof r['sourceFile'] ? r['sourceFile'] : null,
    subject: 'string' === typeof r['subject'] ? r['subject'] : 'unsorted',
  };
};

/**
 * Proved first, then the rest.
 *
 * An agent reading this is about to act on it, and a statement a verdict has actually established
 * is worth more than one somebody merely wrote down. Stable within each group so the same call
 * twice returns the same order — an unstable list reads as the corpus churning when it has not.
 */
const PROVED = 'proved';
export const rankKnown = (things: readonly KnownThing[]): KnownThing[] => [
  ...things.filter((t) => PROVED === t.status),
  ...things.filter((t) => PROVED !== t.status),
];

export async function readProjectMemory(
  fs: FileSystemPort,
  root: string,
  home: string,
  env: NodeJS.ProcessEnv,
  opts: { subject?: string | undefined; limit: number },
): Promise<ProjectMemoryResult> {
  const cloud = await resolveProjectCloud(fs, root, home, env);
  if (null === cloud.config) return { ok: false, reason: MemoryUnavailable.NOT_LINKED };
  if (!cloud.policy.memory) return { ok: false, reason: MemoryUnavailable.DISABLED };

  const query = opts.subject === undefined ? '' : `?subject=${encodeURIComponent(opts.subject)}`;
  try {
    const res = await cloudFetch(`${cloud.config.url}/v1/memory${query}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${cloud.config.apiKey}`,
        // What makes this read COUNT as an agent consulting the corpus rather than a human
        // browsing — the distinction the dashboard's "times an agent consulted it" rests on.
        'x-reticle-agent': MCP_AGENT_ID,
      },
    });
    if (200 !== res.status) return { ok: false, reason: MemoryUnavailable.UNREACHABLE };
    // `cloudFetch` returns a real Response, so the body is a METHOD. Reading `res.json` as a
    // property yields the function, and every downstream field is undefined — a silent "the project
    // knows nothing" that is indistinguishable from the honest empty case. It cost a live drive to
    // find once already.
    const body = (await res.json()) as { entries?: unknown } | undefined;
    const entries = body?.entries;
    if (!Array.isArray(entries)) return { ok: false, reason: MemoryUnavailable.UNREACHABLE };
    const known = entries.map(asKnown).filter((k): k is KnownThing => k !== null);
    return {
      ok: true,
      subject: opts.subject ?? null,
      // Capped for the agent's context, but `total` always reports the truth so the cap is never
      // silent — a truncated list that looks complete is how an agent concludes a project knows
      // less than it does.
      known: rankKnown(known).slice(0, opts.limit),
      total: known.length,
    };
  } catch {
    return { ok: false, reason: MemoryUnavailable.UNREACHABLE };
  }
}
