import { z } from 'zod';
import { sessionRoot } from '../project/session-root.js';
import { asNumber, asString } from '../tools/tools-helpers.js';
import type { FlowFile } from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { countSchema } from '../tools/numeric-bounds.js';
import { readContract } from '../project/reticle-dir.js';
import { buildDomainModel } from './domain-model.js';
import { proposeInstrumentation } from '../oracles/self-instrument.js';
import { instrumentationGapsForFlows } from '../oracles/flow-instrument-gaps.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';

/**
 * reticle_domain — the "learn the app before testing it" tool. Synthesizes every saved flow + the
 * registered capabilities into a compact domain model: the journeys, what each asserts, and the
 * GAPS (declared signals/testids no flow verifies). An agent reads this once instead of crawling
 * the whole app or reading all the source — and it points straight at untested intent.
 */
/** Flows detailed when the caller does not ask for a specific count. */
const DEFAULT_FLOW_DETAIL_LIMIT = 25;

export const DOMAIN_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.DOMAIN,
    description:
      'Read the app domain model BEFORE testing: every saved flow with its assertion grade, the consequence that MUST hold for it (mustHold = what it actually tests), the anchors/signals it exercises, plus GAPS — declared signals/testids that NO flow asserts (untested intent), and flows that assert no observable consequence. Use this to decide what to test and where the real risk is, instead of crawling the whole app. Reads .reticle/flows/ + .reticle/contract.json (no browser needed).',
    inputSchema: {
      limit: countSchema
        .optional()
        .describe(
          'Most-recent N flows to detail. Defaults to 25 — the per-flow list grows with every saved flow (measured at ~11KB / ~2,700 tokens at 22 flows) and a large project would spend most of an agent context on flows it is not asking about. `flowCount` is always the true total, and the gaps/coverage summary is computed over ALL flows regardless, so capping the detail never changes the analysis.',
        ),
    },
    outputSchema: {
      flowCount: z.number(),
      flows: z.array(
        z.object({
          name: z.string(),
          steps: z.number(),
          grade: z.string(),
          asserts: z.boolean(),
          mustHold: z
            .string()
            .optional()
            .describe(
              'The success consequence that must hold for this flow (what it actually tests).',
            ),
          warning: z.string().optional(),
          signals: z.array(z.string()),
          testids: z.array(z.string()),
        }),
      ),
      declared: z.object({
        testids: z.number(),
        signals: z.array(z.string()),
        stores: z.array(z.string()),
      }),
      flowsTruncated: z
        .number()
        .optional()
        .describe(
          'How many flows were omitted from `flows` by `limit`. Absent means the listing is complete. gaps/coverage always cover every flow.',
        ),
      coverage: z.object({
        asserted: z.number(),
        presenceOnly: z.number(),
        assertionFree: z.number(),
      }),
      gaps: z.object({
        unassertedFlows: z.array(z.string()),
        declaredUntestedSignals: z.array(z.string()),
        declaredUntestedTestids: z.array(z.string()),
      }),
      riskRanked: z
        .array(z.string())
        .describe(
          'Flow names worst-risk first (run history + assertion quality). Test these first.',
        ),
      summary: z.string(),
      instrumentation: z
        .array(z.unknown())
        .optional()
        .describe(
          'Ready-to-apply instrumentation proposals for gaps that have a source location — { file, line, insert, rationale }. Apply, re-verify, and the app’s observability compounds.',
        ),
    },
    handler: async (deps: ToolDeps, args) => {
      const names = await deps.flows.list();
      const flows: FlowFile[] = [];
      for (const name of names) {
        const loaded = await deps.flows.load(name);
        if (loaded.ok) flows.push(loaded.value);
      }
      const contract = await readContract(deps.fs, sessionRoot(deps, asString(args['sessionId'])));
      const project = await deps.project.read();
      const runs = project.ok ? project.file.runs : [];
      const model = buildDomainModel(flows, contract.ok ? contract.capabilities : null, runs);
      // Self-instrumentation: turn located gaps (unasserted flows with a source stamp) into apply-ready diffs.
      const stepsByName = new Map(flows.map((f) => [f.name, f.steps]));
      const instrumentation = proposeInstrumentation(
        instrumentationGapsForFlows(model.gaps.unassertedFlows, stepsByName),
      );
      // The per-flow detail is capped; `flowCount`, `gaps` and `coverage` are computed over every
      // flow, so the ANALYSIS is never truncated — only the listing an agent reads past is.
      const cap = asNumber(args['limit']) ?? DEFAULT_FLOW_DETAIL_LIMIT;
      const capped =
        model.flows.length > cap
          ? { ...model, flows: model.flows.slice(-cap), flowsTruncated: model.flows.length - cap }
          : model;
      return instrumentation.length > 0 ? { ...capped, instrumentation } : capped;
    },
  },
];
