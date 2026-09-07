import { z } from 'zod';
import { EventType, ReticleCommand, SnapshotMode, urlForMatch } from '@reticlehq/core';
import { ReticleTool } from './tool-names.js';
import { cursorSchema } from './numeric-bounds.js';
import { reconcile, type Mismatch } from '../events/reconcile.js';
import { salvageJson } from '../events/json-salvage.js';
import { withControl } from '../session/control-envelope.js';
import { asNumber, asString } from './tools-helpers.js';
import { type ToolDef, sessionIdShape, commandOrThrow } from './tool-kit.js';
import { readCompleteTree } from './complete-snapshot.js';

/**
 * Does the screen agree with the data the app was given?
 *
 * A separate tool rather than a passive contradiction rule, because it needs the rendered page as
 * well as the events — a comparison, not an observation. Passive rules stay pure and run on every
 * window; this one costs a snapshot, so the agent asks for it.
 *
 * It exists because the misses that mattered on a real payments dashboard were all this shape: a USD
 * amount rendered with a rupee sign, a settlement the API calls `on_hold` rendered as "pending". No
 * request fails, no assertion fails, and the numbers on screen match the numbers in the payload. The
 * only thing that disagrees is the meaning.
 */

/** Response bodies captured in the window, newest last. Only JSON is worth comparing. */
async function capturedBodies(
  session: { queryEvents: (q: { since: number }) => Promise<readonly unknown[]> },
  since: number,
  urlContains: string | undefined,
): Promise<{ bodies: unknown[]; withBody: number; total: number; truncated: number }> {
  const events = (await session.queryEvents({ since })) as {
    type: string;
    data: Record<string, unknown>;
  }[];
  const bodies: unknown[] = [];
  let withBody = 0;
  let total = 0;
  let truncated = 0;
  for (const event of events) {
    if (event.type !== EventType.NET_REQUEST) continue;
    const url = urlForMatch(event.data);
    if (urlContains !== undefined && !url.includes(urlContains)) continue;
    total += 1;
    const raw = event.data['responseBody'];
    if (typeof raw !== 'string' || 0 === raw.length) continue;
    // A capped body is not an absent one. Recover the records that closed before the cut rather than
    // reporting nothing about the page with the most data on it.
    const salvaged = salvageJson(raw);
    if (0 === salvaged.values.length) continue;
    bodies.push(...salvaged.values);
    withBody += 1;
    if (salvaged.partial) truncated += 1;
  }
  return { bodies, withBody, total, truncated };
}

export const RECONCILE_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.RECONCILE,
    example: { urlContains: '/api/v1/settlements' },
    description:
      'Compare what the API returned against what the page RENDERS. Catches the class no status code and no assertion can: a USD amount shown with a ₹ sign, a record the API calls `on_hold` displayed as "pending". Needs response bodies — enable `captureNetworkBodies` — and says so when they are missing rather than reporting a clean result over data it never read.',
    inputSchema: {
      ...sessionIdShape,
      since: cursorSchema
        .optional()
        .describe('Cursor from a prior act — scopes to responses received after it. Default: 0.'),
      urlContains: z
        .string()
        .optional()
        .describe('Only compare responses from URLs containing this, e.g. "/api/v1/settlements".'),
    },
    outputSchema: {
      mismatches: z
        .array(z.object({ entity: z.string(), field: z.string(), api: z.string() }).passthrough())
        .describe('Fields whose rendering disagrees with the data the app was given.'),
      compared: z.number().describe('How many responses carried a body that could be compared.'),
      note: z
        .string()
        .optional()
        .describe('Present when nothing could be compared — never silent about an empty check.'),
    },
    handler: async (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const since = asNumber(args['since']) ?? 0;
      const { bodies, withBody, total, truncated } = await capturedBodies(
        session,
        since,
        asString(args['urlContains']),
      );

      // An empty result over data that was never read is the exact false green this tool exists to
      // prevent, so the two cases are reported differently and neither is silent.
      if (0 === bodies.length) {
        return withControl(session, {
          mismatches: [],
          compared: 0,
          note:
            0 === total
              ? 'no responses in this window matched — nothing was compared'
              : `${String(total)} response(s) matched but NONE carried a recorded body, so nothing was compared. Enable it where your app calls connect(): \`reticle.connect({ captureNetworkBodies: true })\`, then re-run`,
        });
      }

      // The whole page, INCLUDING whatever the snapshot's node cap cut off. A comparison against a
      // prefix of the page can miss the row that disagrees and can invent one that does not — the
      // value it was looking for may simply sit past the cut.
      const page = await readCompleteTree((scope) =>
        commandOrThrow(deps, session.id, ReticleCommand.SNAPSHOT, {
          mode: SnapshotMode.FULL,
          ...(scope === undefined ? {} : { scope, includeRoot: true }),
        }),
      );
      const mismatches: Mismatch[] = reconcile(bodies, page.tree);
      // ASYMMETRIC on purpose. A mismatch FOUND in a partial page is still found — one witness proves
      // presence, and withholding it because the rest of the page was unread helps nobody. An EMPTY
      // result is the universal claim "nothing anywhere disagrees", and a partial page cannot support
      // it. So the positive keeps working and only the negative is refused.
      if (0 === mismatches.length && !page.complete) {
        throw new Error(
          `the page could not be read completely — ${page.incompleteBecause ?? 'the snapshot was cut'}. ` +
            'Nothing was found to disagree with the API, but that is not the same as nothing disagreeing: ' +
            'the record that does could be in the part that was never read. Narrow the page (close overlays, ' +
            'navigate to the view holding these records) and re-run.',
        );
      }
      // A truncated body is declared whether or not anything was found in it: "no mismatches" over a
      // partially-read payload is a weaker statement than over a whole one, and the difference is
      // exactly the kind of omission this layer exists to refuse.
      const partial =
        truncated > 0
          ? {
              note: `${String(truncated)} of ${String(withBody)} response(s) exceeded the body cap and were read only up to the cut — records after it were not compared`,
            }
          : 0 === mismatches.length
            ? {
                note: `compared ${String(withBody)} response(s); nothing on screen contradicts them`,
              }
            : {};
      return withControl(session, { mismatches, compared: withBody, ...partial });
    },
  },
];
