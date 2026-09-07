import { z } from 'zod';
import { CDP_NO_PROVIDER_REASON, CDP_NO_PROVIDER_RECOMMENDATION } from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { sessionIdShape } from '../tools/tool-kit.js';
import { MAX_VIEWPORT_PX, MIN_VIEWPORT_PX, viewportPxSchema } from '../tools/numeric-bounds.js';
import { asString } from '../tools/tools-helpers.js';
import type { RealInputProvider } from './real-input.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';

/** Bounds so a viewport request stays sane (and a typo can't ask for a 1px or 100k-px window). */
const MIN_DIM = MIN_VIEWPORT_PX;
const MAX_DIM = MAX_VIEWPORT_PX;

/** A provider that can set the viewport — narrows the optional capability so callers branch once. */
type ViewportCapable = RealInputProvider & {
  setViewport(sessionUrl: string, size: { width: number; height: number }): Promise<boolean>;
};

function viewportProvider(deps: ToolDeps): ViewportCapable | undefined {
  const p = deps.realInput;
  return p !== undefined && 'function' === typeof p.setViewport
    ? (p as ViewportCapable)
    : undefined;
}

export const VIEWPORT_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.VIEWPORT,
    description:
      'Pin the DRIVEN page (needs `reticle drive`) to a fixed viewport size so a screenshot baseline is ' +
      'reproducible across machines — the missing piece of CI-stable visual regression, alongside ' +
      'reticle_visual_diff `masks` and a frozen clock (reticle_clock). Set it once before reticle_screenshot / ' +
      'reticle_visual_diff. Returns { applied, width, height } or the no-provider recommendation.',
    inputSchema: {
      width: viewportPxSchema.describe('Viewport width in CSS px (e.g. 1280).'),
      height: viewportPxSchema.describe('Viewport height in CSS px (e.g. 800).'),
      ...sessionIdShape,
    },
    outputSchema: {
      applied: z.boolean(),
      width: z.number(),
      height: z.number(),
      ok: z.boolean().optional(),
      reason: z.string().optional(),
      recommendation: z.string().optional(),
    },
    handler: async (deps, args) => {
      const provider = viewportProvider(deps);
      if (provider === undefined) {
        return {
          applied: false,
          width: 0,
          height: 0,
          ok: false,
          reason: CDP_NO_PROVIDER_REASON,
          recommendation: CDP_NO_PROVIDER_RECOMMENDATION,
        };
      }
      const width = clampDim(args['width']);
      const height = clampDim(args['height']);
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const applied = await provider.setViewport(session.url, { width, height });
      return { applied, width, height };
    },
  },
];

/** Clamp a requested dimension into [MIN_DIM, MAX_DIM]; a missing/NaN value falls back to MIN_DIM. */
function clampDim(value: unknown): number {
  const n = 'number' === typeof value && Number.isFinite(value) ? Math.round(value) : MIN_DIM;
  return Math.max(MIN_DIM, Math.min(n, MAX_DIM));
}
