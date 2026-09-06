import { z } from 'zod';
import { ReticleTool } from '../tools/tool-names.js';
import { asNumber, asString } from '../tools/tools-helpers.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';
import { routeFromUrl, routesFromEvents } from '../project/learned-routes.js';
import {
  NAV_SMOKE_DEFAULTS,
  NAV_SMOKE_HONESTY_NOTE,
  navSmoke,
  type NavSmokeOptions,
} from './nav-smoke.js';

const nodeSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const NAV_SMOKE_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.NAV_SMOKE,
    description:
      'One-shot smoke of primary navigation: query links inside a nav landmark (default `nav`), click each internal href (bounded by maxLinks, default 25), and return one consolidated table. Each row reports `renderedWithoutConsoleErrors` and `consoleErrors` — that is "rendered without new console errors in the settle window", NOT "the route works". Skipped rows name why (external href, duplicate, missing href). DESTRUCTIVE — it really clicks and may navigate. Use reticle_explore first for a non-destructive inventory.',
    inputSchema: {
      maxLinks: z
        .number()
        .optional()
        .describe(
          `Maximum internal nav links to click. Default: ${String(NAV_SMOKE_DEFAULTS.MAX_LINKS)}.`,
        ),
      settleMs: z
        .number()
        .optional()
        .describe(
          `Milliseconds to wait after each click for the app to react. Default: ${String(NAV_SMOKE_DEFAULTS.SETTLE_MS)}.`,
        ),
      scope: z
        .string()
        .optional()
        .describe(
          `CSS selector or element ref restricting the link query. Default: "${NAV_SMOKE_DEFAULTS.SCOPE}" (nav landmark).`,
        ),
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID from reticle_sessions. Omit when only one browser session is open.',
        ),
    },
    outputSchema: {
      linksFound: z.number(),
      linksVisited: z.number(),
      rows: z.array(
        z.object({
          label: z.string(),
          href: z.string().optional(),
          route: z.string().optional(),
          renderedWithoutConsoleErrors: z.boolean(),
          consoleErrors: z.number(),
          skipped: z.string().optional(),
        }),
      ),
      truncated: z.boolean(),
      note: z.string().describe(NAV_SMOKE_HONESTY_NOTE),
      scopeMissing: z
        .boolean()
        .optional()
        .describe(
          'True when the scope matched nothing — zero links may mean the scope is wrong, not that the app has no nav.',
        ),
    },
    handler: async (deps: ToolDeps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const since = session.elapsed();
      const initialRoute = routeFromUrl(session.url);
      const maxLinks = asNumber(args['maxLinks']);
      const settleMs = asNumber(args['settleMs']);
      const scope = asString(args['scope']);
      const opts: NavSmokeOptions = {
        ...(maxLinks !== undefined ? { maxLinks } : {}),
        ...(settleMs !== undefined ? { settleMs } : {}),
        ...(scope !== undefined ? { scope } : {}),
      };
      const report = await navSmoke(session, opts, nodeSleep);
      const routes = [
        ...(initialRoute === undefined ? [] : [initialRoute]),
        ...routesFromEvents(session.eventsSince(since)),
      ];
      if (routes.length > 0) await deps.project.recordRoutes(routes);
      return report;
    },
  },
];
