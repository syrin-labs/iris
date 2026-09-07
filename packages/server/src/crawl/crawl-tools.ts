import { z } from 'zod';
import { ReticleTool } from '../tools/tool-names.js';
import { asNumber, asString } from '../tools/tools-helpers.js';
import { stepCountSchema, timeoutMsSchema } from '../tools/numeric-bounds.js';
import { crawl, type CrawlOptions } from './crawl.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';
import { routeFromUrl, routesFromEvents } from '../project/learned-routes.js';

const nodeSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The autonomous "smart monkey" tool. Builds on reticle_explore (which only LISTS) by
 * actually clicking each reachable control and classifying the reaction. DESTRUCTIVE by nature —
 * it drives the app — so it's an explicit, bounded tool, never part of a passive read.
 */
export const CRAWL_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.CRAWL,
    description:
      'Autonomously click every reachable interactive control (bounded by maxSteps, default 25) and report anomalies WITHOUT a script. Two classes: single-channel faults (console errors, failed requests ≥400, DEAD controls that dispatched but did nothing) and CONTRADICTIONS — two channels disagreeing about the same click, e.g. the UI advanced while its write failed, a success signal fired over a failed request, a write succeeded and nothing changed, the same write fired twice, or the UI moved on over an in-flight request. Contradictions are the false greens a human cannot see, because a human watches one channel (the screen) and it looks correct. DESTRUCTIVE — it really clicks (may navigate/mutate state); use reticle_explore first for a non-destructive list. Returns { interactiveFound, stepsRun, anomalies[{kind,ref,desc,detail}], counts, visited, truncated }.',
    inputSchema: {
      maxSteps: stepCountSchema
        .optional()
        .describe('Maximum number of controls to click. Default: 25.'),
      settleMs: timeoutMsSchema
        .optional()
        .describe('Milliseconds to wait after each click for the app to react. Default: 500.'),
      scope: z
        .string()
        .optional()
        .describe('CSS selector or element ref to restrict crawling to a subtree.'),
      confirmDangerous: z
        .boolean()
        .optional()
        .describe(
          'Set true to allow controls classified as destructive. Default false; those controls are blocked by the browser.',
        ),
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID from reticle_sessions. Omit when only one browser session is open.',
        ),
    },
    // An UNDECLARED field is stripped from structuredContent, so a schema-aware client never sees it
    // even though the handler returns it. Everything crawl produces has to be listed here or it is
    // silently lost — which is how the source pointer and the visited list were being dropped.
    outputSchema: {
      interactiveFound: z.number(),
      stepsRun: z.number(),
      // Present only when nothing was clicked, saying WHICH zero this is — an empty page, a step
      // budget of zero, or controls found and none driven. A bare zero was unactionable.
      note: z.string().optional(),
      anomalies: z.array(
        z.object({
          kind: z.string(),
          ref: z.string(),
          desc: z.string(),
          detail: z.string().optional(),
          source: z
            .string()
            .optional()
            .describe('Where the control is written, as `file:line` — open this to fix it.'),
        }),
      ),
      counts: z.record(z.number()),
      visited: z.array(z.string()).describe('The controls actually clicked, in order.'),
      coverageNote: z
        .string()
        .optional()
        .describe(
          'Present only when the page exceeded one snapshot, so controls past the cap were never listed. When present, a zero-anomaly result does NOT mean the app is clean.',
        ),
      truncated: z.boolean(),
    },
    handler: async (deps: ToolDeps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const since = session.elapsed();
      const initialRoute = routeFromUrl(session.url);
      const maxSteps = asNumber(args['maxSteps']);
      const settleMs = asNumber(args['settleMs']);
      const scope = asString(args['scope']);
      const opts: CrawlOptions = {
        ...(maxSteps !== undefined ? { maxSteps } : {}),
        ...(settleMs !== undefined ? { settleMs } : {}),
        ...(scope !== undefined ? { scope } : {}),
        ...(true === args['confirmDangerous'] ? { confirmDangerous: true } : {}),
      };
      const report = await crawl(session, opts, nodeSleep);
      const routes = [
        ...(initialRoute === undefined ? [] : [initialRoute]),
        ...routesFromEvents(session.eventsSince(since)),
      ];
      if (routes.length > 0) await deps.project.recordRoutes(routes);
      return report;
    },
  },
];
