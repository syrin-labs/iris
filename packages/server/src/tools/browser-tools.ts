import { carryReticleIdentity } from './lease-tools.js';
import { z } from 'zod';
import { navigateResult } from './navigate-result.js';
import { awaitArrival } from './navigate-arrival.js';
import { reloadResult } from './reload-result.js';
import { waitForReconnect, RELOAD_RECONNECT_TIMEOUT_MS } from '../session/session-reconnect.js';
import { ReticleCommand } from '@reticlehq/core';
import { ReticleTool } from './tool-names.js';
import { asString } from './tools-helpers.js';
import { sessionIdShape, commandOrThrow } from './tool-kit.js';
import type { ToolDef } from './tools.js';

export const BROWSER_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.NAVIGATE,
    example: { url: '/settings' },
    description:
      'Navigate the connected browser tab to a URL, or reload it in place with { reload: true } (add { hard: true } to bypass the cache). `ok` means the navigation was DISPATCHED — the SDK is torn down by the navigation, so the page itself cannot report on it. The daemon then waits briefly for the SDK to reconnect: `confirmed:true` with a new `sessionId` means the page arrived and you can act immediately. `confirmed:false` means it did not arrive within the window — the page may be slow, uninstrumented, or not there; check reticle_sessions before acting.',
    inputSchema: {
      url: z.string().optional().describe('The URL to navigate to. Omit when using reload.'),
      reload: z
        .boolean()
        .optional()
        .describe(
          'Reload the current page instead of navigating (replaces the former standalone refresh tool).',
        ),
      hard: z
        .boolean()
        .optional()
        .describe('With reload:true, bypass the browser cache (Cmd+Shift+R). Default: false.'),
      ...sessionIdShape,
    },
    outputSchema: {
      ok: z.boolean(),
      url: z.string().optional(),
      reason: z.string().optional(),
      // Present on a dispatched navigation: nothing here can see the new document, so arrival is
      // reported as unconfirmed rather than implied by `ok`. See navigate-result.ts.
      confirmed: z.boolean().optional(),
      /** The session the SDK reconnected as, when arrival was confirmed — it is a NEW id. */
      sessionId: z.string().optional(),
      note: z.string().optional(),
    },
    handler: async (deps, args) => {
      // reload:true is the absorbed reticle_refresh — same command, one fewer advertised tool.
      if (true === args['reload']) {
        const before = deps.sessions.resolve(asString(args['sessionId']));
        // The verdict floor moves HERE, before the page goes away. A reload destroys the document,
        // so every request that failed under the old one belongs to a page that no longer exists —
        // and a later assert defaulting its window to "the last thing that happened" must not reach
        // back past this point. Reported from the field as an assertion whose clauses all passed
        // coming back `contradicted` by hundreds of 500s against resources that were already gone.
        before.lastAct.markNavigated(before.elapsed());
        await commandOrThrow(deps, asString(args['sessionId']), ReticleCommand.REFRESH, {
          hard: true === args['hard'],
        });
        // WAIT for the page to come back, rather than telling the agent to. The id survives the
        // reload, but the seconds between dispatch and the new HELLO are seconds in which every call
        // lands in the old, disconnected session — measured as reticle_run failing 5 of 5 on a page
        // that was healthy immediately afterwards. Returns on the first poll in the common case.
        const back = await waitForReconnect({
          current: () => deps.sessions.get(before.id),
          previous: before,
          timeoutMs: RELOAD_RECONNECT_TIMEOUT_MS,
          now: deps.now,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        });
        // Not a bare `{ ok: true }`. The URL branch below already discloses that `ok` means
        // DISPATCHED — the reload branch had identical semantics and said nothing, on the path most
        // likely to need it. See reload-result.
        return reloadResult(back);
      }
      const requested = asString(args['url']);
      if (requested === undefined || 0 === requested.length)
        return { ok: false, reason: 'url required' };
      // Record navigate as an action. Its window is usually empty (the page unloads and the SDK
      // reconnects), but the action record itself — "navigated to X" — is the causal fact worth keeping.
      const session = deps.sessions.resolve(asString(args['sessionId']));
      // A leased tab is addressed by a URL param, so navigating away from it used to strand the
      // lease — see carryReticleIdentity. A tab that claims no identity is untouched.
      const url = carryReticleIdentity(session.url, requested);
      session.beginAction(ReticleTool.NAVIGATE, { url });
      // Same floor as the reload path above, for the same reason: going to a new URL replaces the
      // document just as thoroughly. `beginAction` attributes events to this action; it does not move
      // the window a later assert judges over, and those are two different jobs.
      session.lastAct.markNavigated(session.elapsed());
      try {
        const result = (await commandOrThrow(
          deps,
          asString(args['sessionId']),
          ReticleCommand.NAVIGATE,
          { url },
        )) as { ok?: unknown; url?: unknown; reason?: unknown };
        // `ok` is the browser accepting the instruction, not the page arriving — see navigate-result.
        // The daemon is the only party that CAN see arrival (the SDK reconnects to it), so it looks,
        // briefly, instead of telling the agent to go poll reticle_sessions itself.
        const arrival = true === result.ok ? await awaitArrival(deps.sessions, url) : null;
        return navigateResult(result, arrival);
      } finally {
        session.finishAction();
      }
    },
  },
];
