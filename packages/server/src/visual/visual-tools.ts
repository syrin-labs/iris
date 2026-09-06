import { z } from 'zod';
import {
  AppRuntime,
  ReticleCommand,
  RETICLE_CAPTURE_FILE_PREFIX,
  VISUAL_NO_PROVIDER_RECOMMENDATION,
  VisualReason,
} from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { sessionIdShape } from '../tools/tool-kit.js';
import { ratioSchema } from '../tools/numeric-bounds.js';
import { asNumber, asRecord, asString } from '../tools/tools-helpers.js';
import { diffPng, type VisualRect } from './visual-diff.js';
import { VisualStore } from './visual-store.js';
import { trackCaptureDirectory } from './capture-cleanup.js';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import type { ElementBox, RealInputProvider, ScreenshotOpts } from '../input/real-input.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';

const rectShape = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

/** A provider that can screenshot — narrows the optional capability so callers branch once. */
type ScreenshotCapable = RealInputProvider & {
  screenshot(sessionUrl: string, opts: ScreenshotOpts): Promise<Uint8Array | undefined>;
};

function screenshotProvider(deps: ToolDeps): ScreenshotCapable | undefined {
  const p = deps.realInput;
  return p !== undefined && 'function' === typeof p.screenshot
    ? (p as ScreenshotCapable)
    : undefined;
}

/** The "you need a driven browser" envelope, shared by both visual tools. */
const noProvider = {
  ok: false as const,
  reason: VisualReason.NO_PROVIDER,
  recommendation: VISUAL_NO_PROVIDER_RECOMMENDATION,
};

function asBox(value: unknown): ElementBox | undefined {
  const b = asRecord(asRecord(value)['box']);
  const x = asNumber(b['x']);
  const y = asNumber(b['y']);
  const w = asNumber(b['width']);
  const h = asNumber(b['height']);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined;
  if (w <= 0 || h <= 0) return undefined;
  return { x, y, width: w, height: h };
}

/** Build capture options from args: explicit clip > ref (resolved via INSPECT) > fullPage. */
async function buildOpts(
  deps: ToolDeps,
  sessionId: string | undefined,
  args: Record<string, unknown>,
): Promise<ScreenshotOpts> {
  const clipArg = args['clip'];
  if (clipArg !== undefined) {
    const c = asRecord(clipArg);
    const box = asBox({ box: c });
    if (box !== undefined) return { clip: box };
  }
  const ref = asString(args['ref']);
  if (ref !== undefined) {
    const session = deps.sessions.resolve(sessionId);
    const res = await session.command(ReticleCommand.INSPECT, { ref });
    const box = res.ok ? asBox(res.result) : undefined;
    if (box !== undefined) return { clip: box };
  }
  return true === args['fullPage'] ? { fullPage: true } : {};
}

/**
 * Ask the desktop shell to photograph its own window.
 *
 * Returns undefined for a plain web page (no capture helper) and for a desktop app that did not
 * install `@reticlehq/electron/main`. Deliberately NOT a screen-region capture: photographing
 * the glass returns whatever window is on top, which would save a picture of the user's editor as a
 * visual baseline — the exact false green Reticle exists to eliminate.
 */
async function desktopCapture(
  deps: ToolDeps,
  sessionId: string | undefined,
  fullPage: boolean,
): Promise<{ png?: Uint8Array; reason?: VisualReason }> {
  const session = deps.sessions.resolve(sessionId);
  // A session that cannot take commands (no live browser behind it) simply has no pixels to give.
  if (typeof session.command !== 'function') return {};
  const res = await session.command(ReticleCommand.CAPTURE, { fullPage });
  if (!res.ok) return {};
  const r = asRecord(res.result);
  if (r['ok'] !== true) {
    // The shell refused a full-page capture it cannot do. That is a different answer from "capture
    // broke", and the caller has to hear it — otherwise they read `fullPage` as honoured.
    return r['reason'] === VisualReason.FULL_PAGE_UNSUPPORTED
      ? { reason: VisualReason.FULL_PAGE_UNSUPPORTED }
      : {};
  }
  const path = asString(r['path']);
  if (path === undefined || !isCapturePath(path)) return {};
  try {
    const bytes = await readFile(path);
    await unlink(path).catch(() => undefined);
    trackCaptureDirectory(path);
    return isCompletePng(bytes) ? { png: new Uint8Array(bytes) } : {};
  } catch {
    return {};
  }
}

/**
 * Only read a capture the shell wrote. The path arrives from the PAGE, and the daemon must not
 * become a file-read oracle for whatever a compromised renderer names.
 *
 * Two layouts are accepted, and the pair is the whole subtlety:
 *
 * - `<tmp>/<prefix><dir>/<prefix><n>.png` — the shell's own PRIVATE capture directory, created 0700
 *   so no other local user can read the screenshot or pre-place a symlink at the path we write.
 * - `<tmp>/<prefix><pid>-<n>.png` — the legacy flat layout. Kept because the shell ships as a
 *   SEPARATE package on the user's own upgrade schedule: an app still on the older
 *   `@reticlehq/electron` talking to a newer daemon must keep getting screenshots, not silently
 *   start returning no image. It grants the daemon nothing it did not already have.
 *
 * Every comparison is an exact match against an UNRESOLVED path, which is what refuses traversal:
 * `<tmp>/<prefix>x/../../etc/<prefix>passwd.png` has a grandparent of `<tmp>/<prefix>x/..`, not
 * `<tmp>`. Exactly one directory level is allowed, so a deeper nesting is refused too.
 */
export function isCapturePath(path: string): boolean {
  if (!basename(path).startsWith(RETICLE_CAPTURE_FILE_PREFIX)) return false;
  const parent = dirname(path);
  if (parent === tmpdir()) return true;
  return dirname(parent) === tmpdir() && basename(parent).startsWith(RETICLE_CAPTURE_FILE_PREFIX);
}

/**
 * A PNG is complete only if it ends with IEND. This check exists because a truncated image once
 * sailed through as a saved baseline: the tool answered `saved: true` with a path, and the file was
 * undecodable. A screenshot that cannot be read must fail loudly, never bank a corrupt baseline that
 * a later visual_diff will compare against.
 */
function isCompletePng(bytes: Buffer): boolean {
  if (bytes.byteLength < 12) return false;
  return 'IEND' === bytes.subarray(bytes.byteLength - 8, bytes.byteLength - 4).toString('ascii');
}

/**
 * Get pixels for a session, by whichever route exists.
 *
 * A driven/attached browser is captured through CDP — exact, and the only route that can do
 * `fullPage`. A desktop app has no CDP endpoint, so its own shell is asked instead. CDP is tried
 * FIRST and the desktop path is a genuine fallback, not an either/or: with a CDP endpoint attached
 * to one app and the screenshot aimed at a different (desktop) session, CDP fails and the shell
 * capture is still correct.
 *
 * `clip`/`ref` are honoured only on the CDP path — the shell photographs the whole window. Scoping is
 * left to the caller rather than cropped here, so a clip never silently becomes a full-window image.
 *
 * `fullPage` is different, because it cannot be emulated by cropping: only WebKitGTK (Tauri on Linux)
 * can render a full document offscreen. Where the shell cannot, it REFUSES and this reports
 * `full-page-unsupported` — a viewport image returned as though it were the whole scroll height is a
 * baseline that says nothing about the content below the fold, and a later diff would call it green.
 */
/**
 * Which runtime this session is, for scoping a visual artifact.
 *
 * Undefined when the session cannot be resolved or its SDK never reported one — and undefined means
 * the flat legacy path, so a baseline captured before any of this keeps matching.
 */
function runtimeOf(deps: ToolDeps, sessionId: string | undefined): string | undefined {
  try {
    return deps.sessions.resolve(sessionId).runtime;
  } catch {
    return undefined;
  }
}

async function capture(
  deps: ToolDeps,
  sessionId: string | undefined,
  args: Record<string, unknown>,
): Promise<{ png?: Uint8Array; reason?: string; runtime?: string | undefined }> {
  const provider = screenshotProvider(deps);
  if (provider !== undefined) {
    const session = deps.sessions.resolve(sessionId);
    const png = await provider.screenshot(session.url, await buildOpts(deps, sessionId, args));
    // A driven browser renders the session's URL in a BROWSER — so the pixels are web even when the
    // session named is a desktop window. Scoping those under the desktop runtime would corrupt that
    // runtime's baseline with a picture of a different renderer.
    if (png !== undefined) return { png, runtime: AppRuntime.WEB };
  }
  // The window's own backing store, via the Electron/Tauri adapter — the only route whose pixels
  // really are the desktop app.
  const desktop = await desktopCapture(deps, sessionId, true === args['fullPage']);
  if (desktop.png !== undefined) return { png: desktop.png, runtime: runtimeOf(deps, sessionId) };
  if (desktop.reason !== undefined) return { reason: desktop.reason };

  /*
   * A LEASED page is a real browser page, so the pixels were always there — the visual tools simply
   * had no route to them. Without this, `reticle_screenshot` answered "no provider" for every context
   * an agent can actually acquire, which made visual regression impossible on exactly the isolated
   * contexts the pool exists to hand out. Tried last: a CDP provider, when there is one, is driving
   * the page the caller means, and a lease is the fallback rather than a competitor.
   */
  const leased =
    sessionId === undefined
      ? undefined
      : await deps.pool?.screenshotLease(sessionId, { fullPage: true === args['fullPage'] });
  // A leased page is a real browser page, whatever the session is.
  if (leased !== undefined) return { png: leased, runtime: AppRuntime.WEB };
  return {
    reason: provider === undefined ? VisualReason.NO_PROVIDER : VisualReason.CAPTURE_FAILED,
  };
}

function rectsFrom(value: unknown): VisualRect[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rects: VisualRect[] = [];
  for (const r of value as unknown[]) {
    const box = asBox({ box: r });
    if (box !== undefined) rects.push(box);
  }
  return rects.length > 0 ? rects : undefined;
}

/**
 * The opt-in pixel layer. Both tools require a DRIVEN browser (reticle drive /
 * RETICLE_CDP_URL) — the always-on SDK ships no screenshotter — and return a structured NO_PROVIDER
 * envelope (with a recommendation) instead of throwing when none is attached. Behavioral checks
 * stay the default; this is the complementary "does it look right" surface, never bundled in.
 */
export const VISUAL_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.SCREENSHOT,
    example: { name: 'home' },
    description:
      'Capture a pixel screenshot of the DRIVEN page (needs `reticle drive`/RETICLE_CDP_URL — the SDK has no screenshotter) and save it as a visual baseline at .reticle/visual/<name>.png. { fullPage } for the whole scroll height, { ref } or { clip:{x,y,width,height} } for one element/region. Returns { saved:true, name, path, bytes } or { ok:false, reason } when no driven browser is attached.',
    inputSchema: {
      name: z
        .string()
        .describe(
          'Baseline name — saved as .reticle/visual/<name>.png. Use the same name in reticle_visual_diff to compare.',
        ),
      fullPage: z
        .boolean()
        .optional()
        .describe('Capture the full scroll height. Default: viewport only.'),
      ref: z
        .string()
        .optional()
        .describe(
          'Element ref to screenshot (scopes to element bounding box). Omit for full page.',
        ),
      clip: rectShape
        .optional()
        .describe('Explicit { x, y, width, height } clip rectangle in page coordinates.'),
      ...sessionIdShape,
    },
    outputSchema: {
      ok: z.boolean(),
      saved: z.boolean().optional(),
      name: z.string().optional(),
      path: z.string().optional(),
      bytes: z.number().optional(),
      reason: z.string().optional(),
      recommendation: z.string().optional(),
    },
    handler: async (deps: ToolDeps, args) => {
      const sessionId = asString(args['sessionId']);
      const { png, reason, runtime } = await capture(deps, sessionId, args);
      if (png === undefined) {
        return reason === VisualReason.NO_PROVIDER ? noProvider : { ok: false, reason };
      }
      const name = asString(args['name']) ?? 'default';
      const store = new VisualStore(deps.fs, deps.reticleRoot);
      // Scoped to the runtime that produced it: an Electron window, a Tauri webview and a browser
      // tab do not render the same url the same way, and one shared baseline makes every
      // cross-runtime diff wrong. See visualDir.
      const path = await store.saveBaseline(name, png, runtime);
      return { ok: true, saved: true, name, path, bytes: png.length };
    },
  },
  {
    name: ReticleTool.VISUAL_DIFF,
    example: { baseline: 'home' },
    description:
      'Perceptually diff the DRIVEN page against a saved visual baseline (see reticle_screenshot). { masks:[{x,y,width,height}] } neutralizes volatile regions; { maxRatio } sets the pass tolerance (default 0). Returns { matched, changedPixels, totalPixels, ratio, region?, diffPath, dimensionMismatch } — the overlay diff is written to .reticle/visual/<baseline>.diff.png — or { ok:false, reason } (no-provider / baseline-missing).',
    inputSchema: {
      baseline: z
        .string()
        .describe(
          'Baseline screenshot name (from reticle_screenshot). Used to compare with the current screenshot.',
        ),
      fullPage: z.boolean().optional(),
      ref: z.string().optional(),
      clip: rectShape.optional(),
      masks: z.array(rectShape).optional(),
      maxRatio: ratioSchema.optional(),
      threshold: ratioSchema
        .optional()
        .describe('Pixel difference threshold (0–1). Default: 0.01.'),
      ...sessionIdShape,
    },
    outputSchema: {
      ok: z.boolean(),
      matched: z.boolean().optional(),
      changedPixels: z.number().optional(),
      totalPixels: z.number().optional(),
      ratio: z.number().optional(),
      region: rectShape.optional(),
      dimensionMismatch: z.boolean().optional(),
      diffPath: z.string().optional(),
      reason: z.string().optional(),
    },
    handler: async (deps: ToolDeps, args) => {
      const baseline = asString(args['baseline']) ?? '';
      const store = new VisualStore(deps.fs, deps.reticleRoot);

      // Capture FIRST, then fetch the baseline for the runtime that produced these pixels. Reading it
      // by the session's runtime looked equivalent and is not: the route decides the renderer, so a
      // desktop session captured through a driven browser must be compared against the WEB baseline,
      // not the desktop one. Comparing across renderers is a confident wrong diff in one direction
      // and a silently overwritten baseline in the other.
      const sessionId = asString(args['sessionId']);
      const { png: current, reason, runtime } = await capture(deps, sessionId, args);
      if (current === undefined) {
        return reason === VisualReason.NO_PROVIDER ? noProvider : { ok: false, reason };
      }

      // A baseline from another runtime is not missing by accident — it is a different rendering, and
      // "no baseline for this one" is the honest answer.
      const baselineBytes = await store.readBaseline(baseline, runtime);
      if (baselineBytes === undefined) return { ok: false, reason: VisualReason.BASELINE_MISSING };

      const masks = rectsFrom(args['masks']);
      const threshold = asNumber(args['threshold']);
      const maxRatio = asNumber(args['maxRatio']);
      const result = await diffPng(baselineBytes, current, {
        ...(threshold !== undefined ? { threshold } : {}),
        ...(maxRatio !== undefined ? { maxRatio } : {}),
        ...(masks !== undefined ? { masks } : {}),
      });

      // Omit the raw diff bytes from the JSON result; persist them and return the path instead.
      const { diffPng: diffBytes, ...verdict } = result;
      if (diffBytes === undefined) {
        return { ok: false, ...verdict, reason: VisualReason.DIMENSION_MISMATCH };
      }
      const diffPath = await store.saveDiff(baseline, diffBytes, runtime);
      return { ok: true, ...verdict, diffPath };
    },
  },
];
