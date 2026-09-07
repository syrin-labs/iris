import { z } from 'zod';
import { coverageRegressed, observabilityOf } from '../honesty/observability.js';
import { foldFeatureCapture } from '../honesty/feature-capture.js';
import { foldToolHitRate } from '../honesty/tool-hit-rate.js';
import { allSessionIntents } from '../intent/open-intents.js';
import { ReticleCommand, SnapshotMode } from '@reticlehq/core';
import { ReticleTool } from './tool-names.js';
import type { ToolDef, ToolDeps } from './tools.js';
import { asString } from './tools-helpers.js';
import { exercisedCount } from './coverage-identity.js';
import { commandOrThrow, sessionIdShape } from './tool-kit.js';

/**
 * `reticle_coverage` — which interactive controls this session has driven, and which it has not.
 *
 * Every other read here answers a question the agent already thought to ask, which bounds
 * verification by the agent's imagination — the documented weak link. This answers the one question
 * that tells the agent whether to STOP: an agent that exercised 4 of 17 controls and believes it
 * verified the page is exactly the confident-and-wrong case Reticle exists to prevent, and nothing
 * in the tool surface previously contradicted it.
 *
 * Note this is NOT the existing `blindSpots` coverage, which is about what the layer could not SEE
 * (closed shadow roots, cross-origin frames). This is about what the agent did not TOUCH. Both are
 * honesty signals; they answer different questions and neither substitutes for the other.
 *
 * Unadvertised by every profile: it costs nothing per turn and is reached through `reticle_run`.
 */

/** Refs as the snapshot tree spells them: `(ref=e12)`. The tree format is ours, so this is exact. */
const REF_IN_TREE = /\(ref=(e\d+)\)/g;

/** The label a tree line carries before its ref, e.g. `- button "Archive" (ref=e9)`. */
const LINE_WITH_REF = /^\s*-\s*(.+?)\s*\(ref=(e\d+)\)/;

interface Control {
  ref: string;
  label: string;
}

/** Parse the interactive snapshot into {ref,label} controls, preserving document order. */
export function parseControls(tree: string): Control[] {
  const controls: Control[] = [];
  const seen = new Set<string>();
  for (const line of tree.split('\n')) {
    const match = LINE_WITH_REF.exec(line);
    if (null === match) continue;
    const [, label, ref] = match;
    if (label === undefined || ref === undefined || seen.has(ref)) continue;
    seen.add(ref);
    controls.push({ ref, label });
  }
  // A ref can appear on a line this regex does not shape (nested formatting); count it regardless,
  // because under-reporting the denominator would overstate coverage — the one direction that lies.
  for (const match of tree.matchAll(REF_IN_TREE)) {
    const ref = match[1];
    if (ref !== undefined && !seen.has(ref)) {
      seen.add(ref);
      controls.push({ ref, label: '' });
    }
  }
  return controls;
}

/**
 * Build the coverage tool over the dispatchable tool table.
 *
 * The table arrives as a thunk rather than an import: `tools.ts` assembles it FROM this module, so
 * importing it back would close a cycle whose failure mode is a load-order-dependent crash rather
 * than an error anyone sees while writing it. The thunk is called inside the handler, long after the
 * table exists. It carries the merged names — the ones `reticle_run` will actually accept — because
 * a tool that merged into a parent is not something an agent can call or a maintainer can cut.
 */
export function buildCoverageTools(toolNames: () => readonly string[]): ToolDef[] {
  return [
    {
      name: ReticleTool.COVERAGE,
      description:
        'Which interactive controls you have driven this session, and which you have NOT. Returns { total, exercised, untouched:[{ref,label}], alsoDroveGone? } over the controls currently on the page. Use it to decide whether verification is finished: an untouched list that still holds the controls your change affects means you are not done. This is about what you did not TOUCH — distinct from the `coverage` field on an action result, which reports what the layer could not SEE.',
      example: {},
      inputSchema: { ...sessionIdShape },
      outputSchema: {
        total: z.number(),
        exercised: z.number(),
        untouched: z.array(z.object({ ref: z.string(), label: z.string() })),
        alsoDroveGone: z
          .number()
          .optional()
          .describe(
            'Controls you drove that are no longer on the page — usually because the action SUCCEEDED and removed them (archive/delete/submit/navigate). Counted separately so `exercised: 0` never appears immediately after real work.',
          ),
        instrumentationGaps: z
          .array(z.unknown())
          .optional()
          .describe(
            'What this app still cannot tell Reticle, as of your most recent verdict — each entry is { kind, missing, cost, fix, source?, ref? }. These are not controls you skipped; they are checks this app CANNOT answer until it is instrumented, so driving the untouched list will not close them. Apply each `fix` and re-verify: the gap disappears from this list when the app can answer, and every later verdict on this app gets stronger. OMITTED when nothing is missing.',
          ),
        unproven: z
          .boolean()
          .optional()
          .describe(
            'True when verification is NOT finished for a reason driving more controls cannot fix — instrumentationGaps is non-empty. Present only when true, so its absence is not a claim.',
          ),
        observability: z
          .object({ driven: z.number(), observable: z.number(), percent: z.number().optional() })
          .optional()
          .describe(
            'Of the controls you DROVE, how many Reticle could fully observe. `untouched` above is work left for you; this is work left in the APP, and driving more controls does not move it. `percent` is OMITTED when nothing was driven, because 0/0 is not 100%.',
          ),
        featureUse: z
          .object({
            observed: z.boolean(),
            truncated: z.boolean().optional(),
            context: z.unknown().optional(),
            intents: z.unknown().optional(),
            missed: z.unknown().optional(),
          })
          .optional()
          .describe(
            'Whether this session used `reticle_context` and `reticle_intent` at all, and what it cost when it did not: `context` counts the calls and what followed each one, `intents` the ledger, `missed` the verdicts drawn against an empty ledger and the reads that re-fetched a fact already established. `observed:false` means nothing was recorded for this session — NOT that nothing was used. An instrument for deciding whether those two features earn their place; nothing here is a fault of yours.',
          ),
        toolHitRate: z
          .object({
            observed: z.boolean(),
            cells: z.unknown().optional(),
            called: z.unknown().optional(),
            neverCalled: z.unknown().optional(),
          })
          .optional()
          .describe(
            'Which Reticle tools THIS session called, and how reachable each one was: `called` lists every tool with its call count, `neverCalled` the rest of the table, and both carry a `tier` — `default` (advertised to every agent), `extended` (advertised only on the full surface) or `run-only` (reachable solely by naming it to reticle_run). `cells` counts each tier on both sides. `observed:false` means nothing was recorded for this session, NOT that nothing was called. THREE LIMITS, all load-bearing: this is ONE session, so it is evidence about this run and is not a hit rate — a hit rate is a distribution over many sessions. A never-called tool is not a useless tool; one used once a month in an emergency looks identical here to one nobody has ever called, so frequency alone cannot decide a cut. And the counts describe how this run went, never how it should have gone — nothing here is a fault of yours.',
          ),
        observabilityRegressed: z
          .object({ was: z.number(), now: z.number() })
          .optional()
          .describe(
            'This project has previously reached a HIGHER observability than this run did. Usually means an assertion or an instrumented path was removed — the cheapest way to stop a gap firing is to stop asserting the thing that revealed it. Present only when a drop is real and the run was large enough to compare.',
          ),
      },
      handler: async (deps: ToolDeps, args) => {
        const sessionId = asString(args['sessionId']);
        const session = deps.sessions.resolve(sessionId);
        // INTERACTIVE mode is already the "controls only" view, so the denominator is the page's own
        // notion of what can be driven rather than a second, drifting definition maintained here.
        const result = await commandOrThrow(deps, sessionId, ReticleCommand.SNAPSHOT, {
          mode: SnapshotMode.INTERACTIVE,
        });
        const tree = asString((result as Record<string, unknown>)['tree']) ?? '';

        // Matched by ref AND by label — see coverage-identity. A ref dies with the next re-render, so
        // on a framework that replaces nodes this reported `exercised: 0` however much work was done.
        // `droveGone` keeps the other honesty: archive/delete/submit remove their own control, so a
        // drive that WORKED must not read as no coverage at all.
        const { exercised, droveGone, untouched } = exercisedCount(
          parseControls(tree),
          session.actedRefs(),
          session.actedLabels(),
        );
        // The other half of "am I done?". `untouched` answers what you did not DRIVE; this answers
        // what this app cannot ANSWER, which no amount of further driving will change. Reporting the
        // first without the second is how an agent finishes a pass believing it verified something the
        // app was never able to confirm.
        const gaps = session.gaps?.open() ?? [];
        // Folded here rather than given a tool of its own: this is already the "am I done, and what is
        // this verdict worth" read, and a number nobody has a reason to ask for separately is one
        // nobody ever sees. It is a fold over the journal and the intent ledger plus the one thing
        // neither records — see honesty/feature-capture.ts.
        const featureUse = foldFeatureCapture({
          calls: session.capture.calls(),
          dropped: session.capture.dropped,
          actions: await session.readJournalActions(),
          intents: await allSessionIntents(deps, sessionId),
          finalActions: session.actionCount,
        });
        // Same fold, same reason, one level out: which of the whole tool table this session reached
        // for, crossed with how reachable each name was. See honesty/tool-hit-rate.ts for what it can
        // and cannot establish — the limits matter more than usual, because this is the number a
        // decision to DELETE tools would be made on.
        const toolHitRate = foldToolHitRate({
          calls: session.capture?.toolCalls(),
          allTools: toolNames(),
        });
        // The number, and the floor under it, together. A coverage figure that can only ever be
        // reported and never contradicted is one an agent learns to satisfy rather than to earn.
        const observability = observabilityOf(session.actedRefs(), gaps);
        const best = await deps.project.bestObservability();
        const regressed = coverageRegressed(best, observability);
        if (observability.percent !== undefined) {
          await deps.project.raiseObservability(observability.percent);
        }
        return {
          total: parseControls(tree).length,
          exercised,
          untouched,
          ...(droveGone > 0 ? { alsoDroveGone: droveGone } : {}),
          ...(gaps.length > 0 ? { instrumentationGaps: gaps, unproven: true } : {}),
          observability,
          ...(regressed === undefined ? {} : { observabilityRegressed: regressed }),
          featureUse,
          toolHitRate,
        };
      },
    },
  ];
}
