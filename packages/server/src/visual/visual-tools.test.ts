import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { VisualReason } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';
import type { RealInputProvider } from '../input/real-input.js';
import type { Session, SessionManager } from '../session/session.js';

const now = (): number => 0;
const SESSION_URL = 'http://localhost:3100/';

function solidPng(rgb: [number, number, number]): Uint8Array {
  const png = new PNG({ width: 6, height: 6 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}

/** A provider that screenshots a fixed PNG (the "page"). */
function fakeProvider(png: Uint8Array): RealInputProvider {
  return {
    isAvailableFor: () => Promise.resolve(true),
    perform: () => Promise.resolve({ performed: false, center: { cx: 0, cy: 0 } }),
    screenshot: () => Promise.resolve(png),
  };
}

function fakeSession(runtime?: string): Session {
  return { id: 'demo', url: SESSION_URL, runtime } as Session;
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

describe('visual tools — temp dir, never touches the repo', () => {
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-vt-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
  });

  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  function deps(provider?: RealInputProvider, sessionRuntime?: string): ToolDeps {
    const session = fakeSession(sessionRuntime);
    const sessions: Partial<SessionManager> = { resolve: () => session };
    const base: ToolDeps = {
      sessions: sessions as SessionManager,
      baselines: new BaselineStore(),
      recordings: new RecordingStore(),
      flows: new FlowStore(fs, root, { now }),
      project: new ProjectStore(fs, root, { now }),
      annotations: new AnnotationStore(),
      fs,
      reticleRoot: root,
      now,
    };
    return provider === undefined ? base : { ...base, realInput: provider };
  }

  it('1: reticle_screenshot with no driven browser returns NO_PROVIDER + recommendation', async () => {
    const r = (await tool(ReticleTool.SCREENSHOT).handler(deps(), { name: 'home' })) as {
      ok: boolean;
      reason: string;
      recommendation?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(VisualReason.NO_PROVIDER);
    expect(r.recommendation).toContain('reticle drive');
  });

  it('2: reticle_screenshot saves a baseline PNG to .reticle/visual/<name>.png', async () => {
    const png = solidPng([255, 255, 255]);
    const r = (await tool(ReticleTool.SCREENSHOT).handler(deps(fakeProvider(png)), {
      name: 'home',
    })) as { saved: boolean; name: string; path: string; bytes: number };
    expect(r.saved).toBe(true);
    expect(r.name).toBe('home');
    expect(r.bytes).toBe(png.length);
    expect((await stat(r.path)).isFile()).toBe(true);
  });

  it('3: reticle_visual_diff against an identical page matches', async () => {
    const png = solidPng([255, 255, 255]);
    const d = deps(fakeProvider(png));
    await tool(ReticleTool.SCREENSHOT).handler(d, { name: 'home' });
    const r = (await tool(ReticleTool.VISUAL_DIFF).handler(d, { baseline: 'home' })) as {
      matched: boolean;
      changedPixels: number;
      diffPath: string;
    };
    expect(r.matched).toBe(true);
    expect(r.changedPixels).toBe(0);
    expect((await stat(r.diffPath)).isFile()).toBe(true);
  });

  it('4: reticle_visual_diff detects a changed page (saved white vs current black)', async () => {
    const white = solidPng([255, 255, 255]);
    // Save a white baseline, then diff with a provider that now returns black.
    await tool(ReticleTool.SCREENSHOT).handler(deps(fakeProvider(white)), { name: 'home' });
    const r = (await tool(ReticleTool.VISUAL_DIFF).handler(
      deps(fakeProvider(solidPng([0, 0, 0]))),
      {
        baseline: 'home',
      },
    )) as { matched: boolean; changedPixels: number; ratio: number };
    expect(r.matched).toBe(false);
    expect(r.changedPixels).toBe(36); // every pixel of the 6×6 image changed
    expect(r.ratio).toBe(1);
  });

  it('5: reticle_visual_diff with no saved baseline returns BASELINE_MISSING', async () => {
    const r = (await tool(ReticleTool.VISUAL_DIFF).handler(
      deps(fakeProvider(solidPng([0, 0, 0]))),
      {
        baseline: 'never-saved',
      },
    )) as { ok: boolean; reason: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(VisualReason.BASELINE_MISSING);
  });

  /**
   * A baseline belongs to the renderer that produced its pixels, which is decided by the CAPTURE
   * ROUTE — not by the session named.
   *
   * `capture()` tries three: a driven browser, the desktop window's own backing store, then a leased
   * page. Two of the three are browsers. So naming a Tauri session while a driven browser is attached
   * yields a BROWSER rendering of that url, and filing it under `tauri/` would overwrite the desktop
   * baseline with a picture of a different renderer — a later real regression then passes against it.
   *
   * Keying on the session's runtime looked equivalent and is exactly this bug.
   */
  describe('a visual baseline is keyed by what rendered it', () => {
    it('files a driven-browser capture as web, even for a desktop session', async () => {
      const result = (await tool(ReticleTool.SCREENSHOT).handler(
        deps(fakeProvider(solidPng([10, 20, 30])), 'tauri'),
        { name: 'home' },
      )) as { ok: boolean; path?: string };
      expect(result.ok).toBe(true);
      // Flat, because a driven browser IS web — never under visual/tauri/.
      expect(result.path).toBe(join(root, 'visual', 'home.png'));
      expect(result.path).not.toContain(join('visual', 'tauri'));
    });
  });
});
