import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VisualStore } from './visual-store.js';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 250, 0, 128]);

describe('VisualStore — temp dir, never touches the repo', () => {
  let root: string;
  let fs: FileSystemPort;
  let store: VisualStore;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-visual-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
    store = new VisualStore(fs, root);
  });

  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  it('1: saveBaseline → readBaseline round-trips the exact bytes', async () => {
    const path = await store.saveBaseline('home', PNG_BYTES);
    expect(path.endsWith(join('.reticle', 'visual', 'home.png'))).toBe(true);
    const back = await store.readBaseline('home');
    expect(back).toEqual(PNG_BYTES);
    // bytes really hit disk (not a string round-trip)
    expect(new Uint8Array(await readFile(path))).toEqual(PNG_BYTES);
  });

  it('2: hasBaseline reflects existence', async () => {
    expect(await store.hasBaseline('home')).toBe(false);
    await store.saveBaseline('home', PNG_BYTES);
    expect(await store.hasBaseline('home')).toBe(true);
  });

  it('3: readBaseline on a missing name returns undefined (no throw)', async () => {
    expect(await store.readBaseline('nope')).toBeUndefined();
  });

  it('4: saveDiff writes to <name>.diff.png', async () => {
    const path = await store.saveDiff('home', PNG_BYTES);
    expect(path.endsWith(join('.reticle', 'visual', 'home.diff.png'))).toBe(true);
    expect(new Uint8Array(await readFile(path))).toEqual(PNG_BYTES);
  });

  it('5: an invalid (traversal) name is rejected before any disk write', async () => {
    await expect(store.saveBaseline('../escape', PNG_BYTES)).rejects.toThrow();
    expect(await store.readBaseline('../escape')).toBeUndefined();
    expect(await store.hasBaseline('../escape')).toBe(false);
  });

  it('6: the path-echo methods also reject a traversal name (never echo an out-of-dir path)', () => {
    expect(() => store.baselinePath('../escape')).toThrow();
    expect(() => store.diffPath('../escape')).toThrow();
    expect(store.baselinePath('home').endsWith(join('.reticle', 'visual', 'home.png'))).toBe(true);
  });

  /**
   * A baseline from another runtime is not this runtime's baseline.
   *
   * The dangerous direction is the quiet one. If they share a path, saving from Electron overwrites
   * the browser's baseline, and the next web diff passes against a picture of a different program —
   * a real regression, reported green. Reading it as ABSENT is the honest answer: "no baseline for
   * this runtime" is actionable, and a pixel diff across renderings is a confident wrong one.
   */
  describe('a visual baseline belongs to the runtime that produced it', () => {
    it('does not hand an electron baseline to a web diff, or the reverse', async () => {
      await store.saveBaseline('home', PNG_BYTES, 'electron');

      expect(await store.hasBaseline('home', 'electron')).toBe(true);
      expect(await store.hasBaseline('home', 'web')).toBe(false);
      expect(await store.hasBaseline('home')).toBe(false);
      expect(await store.readBaseline('home', 'web')).toBeUndefined();
    });

    it('keeps the two desktop runtimes apart', async () => {
      await store.saveBaseline('home', PNG_BYTES, 'tauri');
      expect(await store.hasBaseline('home', 'electron')).toBe(false);
      expect(await store.hasBaseline('home', 'tauri')).toBe(true);
    });

    // Everything captured before this existed came from a driven browser, and must keep matching.
    it('leaves web and unscoped on the same flat path', async () => {
      await store.saveBaseline('home', PNG_BYTES);
      expect(await store.hasBaseline('home', 'web')).toBe(true);
      expect(await store.hasBaseline('home')).toBe(true);
    });

    it('writes the overlay diff beside its own baseline', async () => {
      await store.saveBaseline('home', PNG_BYTES, 'electron');
      const path = await store.saveDiff('home', PNG_BYTES, 'electron');
      expect(path).toContain(join('visual', 'electron'));
    });
  });
});
