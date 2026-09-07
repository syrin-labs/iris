import { z } from 'zod';
import { QueryBy } from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { asNumber, asString } from '../tools/tools-helpers.js';
import { listIndexSchema, scrollCountSchema } from '../tools/numeric-bounds.js';
import { scrollToFind, type ScrollFindQuery } from './scroll-find.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';

/**
 * reticle_scroll_to — the windowed/virtualized-list escape hatch. A plain reticle_query
 * only sees rendered nodes, so an off-screen row in a react-window/react-virtualized list returns
 * nothing. This scrolls the container until the row mounts, then returns its ref.
 */
/**
 * The query strategies, derived from QueryBy — the same vocabulary reticle_query uses, and for the
 * same reason. A free string here produced the identical false negative: `by:'css'` scrolled the
 * whole list and reported `{ found: false, exhausted: true }`, which reads as "the row is not in
 * this list" rather than "that strategy does not exist".
 */
const QUERY_BY_LIST = Object.values(QueryBy).join(' | ');
const queryByEnum = z.enum(Object.values(QueryBy) as [string, ...string[]]);

export const SCROLL_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.SCROLL_TO,
    description:
      'Find an element in a VIRTUALIZED list that has not rendered yet. Pass `by` (see the parameter for the exact strategies) and `value` (query string) to identify the target row. Scrolls the container until the row mounts, the list ends, or maxScrolls (default 20) is spent. Pass targetIndex + totalCount for bisection — jumps directly to the estimated offset in one scroll (e.g. targetIndex:800 totalCount:1000 jumps to 80% of scrollHeight). Returns { found, element?, scrolls, exhausted }.',
    inputSchema: {
      by: queryByEnum.describe(`Query strategy for finding the target: ${QUERY_BY_LIST}`),
      value: z
        .string()
        .describe('Query value for the selected strategy (the element to scroll into view).'),
      name: z.string().optional().describe('Optional accessible name filter when using by=role.'),
      container: z
        .string()
        .optional()
        .describe('Element ref for the scrollable container. Omit to scroll the document.'),
      maxScrolls: scrollCountSchema
        .optional()
        .describe('Maximum number of scroll steps before giving up. Default: 20.'),
      targetIndex: listIndexSchema
        .optional()
        .describe(
          'Known row index of the target in the list. Combine with totalCount for bisection — jumps directly to the estimated offset.',
        ),
      totalCount: listIndexSchema
        .optional()
        .describe(
          'Total item count in the virtualized list. Required for bisection with targetIndex.',
        ),
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID from reticle_sessions. Omit when only one browser session is open.',
        ),
    },
    outputSchema: {
      found: z.boolean(),
      element: z.object({ ref: z.string(), role: z.string(), name: z.string() }).optional(),
      scrolls: z.number(),
      exhausted: z.boolean(),
      note: z
        .string()
        .optional()
        .describe(
          'Present only when informative: the document itself did not scroll, so the target may be inside a list with its own scroll container — pass its ref as `container`.',
        ),
    },
    handler: (deps: ToolDeps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const name = asString(args['name']);
      const container = asString(args['container']);
      const targetIndex = asNumber(args['targetIndex']);
      const totalCount = asNumber(args['totalCount']);
      const q: ScrollFindQuery = {
        by: asString(args['by']) ?? '',
        value: asString(args['value']) ?? '',
        ...(name !== undefined ? { name } : {}),
        ...(container !== undefined ? { container } : {}),
        ...(targetIndex !== undefined ? { targetIndex } : {}),
        ...(totalCount !== undefined ? { totalCount } : {}),
      };
      const maxScrolls = asNumber(args['maxScrolls']);
      return scrollToFind(session, q, maxScrolls !== undefined ? { maxScrolls } : {});
    },
  },
];
