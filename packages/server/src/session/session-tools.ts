import { z } from 'zod';
import { ReticleCommand } from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { asNumber, asString } from '../tools/tools-helpers.js';
import { idleMsSchema } from '../tools/numeric-bounds.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';

/**
 * Session lifecycle controls. The presenter session begins on the agent's first action and ends
 * either when the agent ends it (reticle_end_session) or after an idle window — and the human keeps the
 * panel (with Copy/Export of the run) afterwards. reticle_session lets the AGENT tune that idle window
 * for the app: raise it for a slow app, lower it for a quick check.
 */
export const SESSION_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.SESSION_TUNE,
    description:
      'Tune the presenter session for this app. { idleEndMs } sets how long the session stays open after you go quiet before the panel shows the human you are WAITING (your turn). Default 5min — the SLOW backstop; signal handback IMMEDIATELY with reticle_session{action:"yield"} instead of waiting for this. Lower it for snappier auto-handback, raise it for a slow app where long gaps between your tool calls are normal. Enforced SERVER-SIDE (immune to background-tab throttling); it also fires if you (the MCP client) disconnect — so a forgotten or crashed session never leaves the HUD reading "live". Going quiet then acting again revives the session automatically. Returns { applied, idleEndMs }.',
    inputSchema: {
      idleEndMs: idleMsSchema
        .optional()
        .describe(
          'Idle window in milliseconds after which the panel shows WAITING (your turn). Default: 300000 (5 min) — the slow backstop; prefer reticle_session{action:"yield"}. Raise for slow apps.',
        ),
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID from reticle_sessions. Omit when only one browser session is open.',
        ),
    },
    outputSchema: {
      applied: z.boolean(),
      idleEndMs: z.number().optional(),
    },
    handler: async (deps: ToolDeps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const idleEndMs = asNumber(args['idleEndMs']);
      // Tune BOTH sides: the browser's foreground idle timer AND the server reaper (the throttle-proof
      // authority), so the agent-set window is honored even when the tab is backgrounded.
      if (idleEndMs !== undefined) session.setIdleEndMs(idleEndMs);
      const res = await session.command(
        ReticleCommand.SESSION_CONFIG,
        idleEndMs !== undefined ? { idleEndMs } : {},
      );
      if (!res.ok) throw new Error(res.error ?? 'session config failed');
      return res.result ?? { applied: true };
    },
  },
];
