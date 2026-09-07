/**
 * `reticle_memory` — ask the project what it already knows.
 *
 * Shared memory reached three callers before this one: the sync writes it, flow replay consults it
 * automatically, and `reticle memory` prints it at a terminal. The one who could not ask was the
 * agent doing the work — mid-drive, holding a question, with a whole tool surface and nothing on it
 * for "what has this team already established about checkout?".
 *
 * That matters twice over. An agent that can read the corpus stops re-deriving what a colleague
 * proved last week; and because the read is attributed, the coverage map's fetch counts finally
 * measure something — they were zero across an entire real corpus, not because the knowledge was
 * useless but because consulting it was a separate act nobody performed.
 */
import { z } from 'zod';
import { ReticleTool } from '../tools/tool-names.js';
import { countSchema } from '../tools/numeric-bounds.js';
import { sessionIdShape } from '../tools/tool-kit.js';
import { asNumber, asString } from '../tools/tools-helpers.js';
import { sessionRoot } from '../project/session-root.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';
import { MemoryUnavailable, readProjectMemory } from './project-memory.js';
import { homedir } from 'node:os';

/**
 * Enough to orient on, not enough to flood a context.
 *
 * A busy subject on a real project runs to dozens of statements; an agent asking a question wants
 * the ones that settle it. `total` always rides along, so the cap is never silent.
 */
const DEFAULT_LIMIT = 10;

/** What to do next, per reason. A refusal that does not say how to fix it is a dead end. */
const ADVICE: Record<MemoryUnavailable, string> = {
  [MemoryUnavailable.NOT_LINKED]:
    'this project is not linked to a Reticle workspace, so there is no shared memory to read. Run `npx @reticlehq/server login` in the project to link it.',
  [MemoryUnavailable.DISABLED]:
    'this project is linked but memory sync is turned off in .reticle/cloud.json, so nothing is being shared. Enable `sync.memory` to use it.',
  [MemoryUnavailable.UNREACHABLE]:
    'the workspace could not be reached, or refused the key. Nothing is wrong with this project — try again, or check the link with `reticle status`.',
};

export const MEMORY_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.MEMORY,
    description:
      'Ask what THIS PROJECT already knows — the shared memory its team has built up, written by every engineer who verified something and readable by every agent since. Use it BEFORE re-deriving how a feature is supposed to behave: a colleague may already have proved it, and a statement marked `proved` was established by a real verdict rather than written down. With { subject } it narrows to one area (a flow name, or a route like "checkout"); without, it returns across the project. Each entry carries the flow and the source file it is about, so a claim can be checked. The read is recorded as an agent consultation, which is what the dashboard\'s per-flow fetch counts are built from. Returns { subject, known, total } or { error, reason, advice } when this project is not linked to a workspace.',
    inputSchema: {
      subject: z
        .string()
        .optional()
        .describe(
          'Narrow to one area — a flow name ("checkout-pay") or a route segment ("issues"). Omit to read across the whole project. Subjects come from the coverage map; an unknown one returns nothing rather than erroring.',
        ),
      limit: countSchema
        .optional()
        .describe(
          `Most relevant N statements. Defaults to ${String(DEFAULT_LIMIT)}. Proved statements rank first, so a small limit still returns the settled ones. \`total\` always reports the true count.`,
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      subject: z.string().nullable().optional(),
      known: z.array(z.unknown()).optional(),
      total: z.number().optional(),
      error: z.string().optional(),
      reason: z.string().optional(),
      advice: z.string().optional(),
    },
    handler: async (deps: ToolDeps, args) => {
      /*
       * The APP's root, not the daemon's.
       *
       * `deps.reticleRoot` is wherever the daemon was launched, which for a user-scoped MCP
       * registration is almost never the project being driven — so the link file it reads is the
       * wrong one or absent, and every project silently reads as "not attached". The same defect
       * has now been fixed three times in this codebase; routing through sessionRoot is what stops
       * a fourth.
       */
      const root = sessionRoot(deps, asString(args['sessionId']));
      const subject = asString(args['subject']);
      const result = await readProjectMemory(deps.fs, root, homedir(), process.env, {
        subject,
        limit: asNumber(args['limit']) ?? DEFAULT_LIMIT,
      });
      if (!result.ok)
        return {
          error: 'no shared memory available for this project',
          reason: result.reason,
          advice: ADVICE[result.reason],
        };
      return { subject: result.subject, known: result.known, total: result.total };
    },
  },
];
