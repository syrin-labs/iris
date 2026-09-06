import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asFlowName, ContractReadError, type CapabilitiesContract } from '@reticlehq/core';
import {
  baselinePath,
  ensureReticleDir,
  flowPath,
  isValidSessionId,
  journalActionsPath,
  journalEventsPath,
  reticleDirPaths,
  readContract,
  sessionDirPath,
  visualDir,
  visualDiffPath,
  visualPath,
  writeContract,
} from './reticle-dir.js';
import { createNodeFileSystem, type FileSystemPort } from './fs-port.js';

const FROZEN = 1_700_000_000_000;
const frozenClock = (): number => FROZEN;

const SAMPLE: CapabilitiesContract = {
  testids: ['a', 'b'],
  signals: ['s'],
  stores: ['w'],
  flows: [{ name: 'f', steps: ['x'] }],
};

describe('reticle-dir — temp-dir filesystem, never touches the repo', () => {
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
  });

  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  // ---- VALID ----

  it('1: writeContract then readContract round-trips', async () => {
    await writeContract(fs, root, SAMPLE, frozenClock);
    const r = await readContract(fs, root);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.capabilities).toEqual(SAMPLE);
    expect(r.generatedAt).toBe(FROZEN);
  });

  it('2: contract.json is pretty-printed (2-space) + trailing newline', async () => {
    await writeContract(fs, root, SAMPLE, frozenClock);
    const text = await readFile(reticleDirPaths(root).contract, 'utf8');
    expect(text).toContain('\n  "version"');
    expect(text.endsWith('}\n')).toBe(true);
    expect(() => {
      JSON.parse(text);
    }).not.toThrow();
  });

  it('3: contract.json has stable key order regardless of input array order', async () => {
    const a: CapabilitiesContract = {
      testids: ['b', 'a'],
      signals: ['s'],
      stores: ['w'],
      flows: [
        { name: 'z', steps: ['x'] },
        { name: 'a', steps: ['y'] },
      ],
    };
    const dirA = await mkdtemp(join(tmpdir(), 'reticle-a-'));
    const dirB = await mkdtemp(join(tmpdir(), 'reticle-b-'));
    const rootA = join(dirA, '.reticle');
    const rootB = join(dirB, '.reticle');
    await writeContract(fs, rootA, a, frozenClock);
    await writeContract(fs, rootB, a, frozenClock);
    const textA = await readFile(reticleDirPaths(rootA).contract, 'utf8');
    const textB = await readFile(reticleDirPaths(rootB).contract, 'utf8');
    expect(textA).toBe(textB);
    expect(textA).toContain('"testids": [\n      "a",\n      "b"\n    ]');
    expect(textA.indexOf('"name": "a"')).toBeLessThan(textA.indexOf('"name": "z"'));
    await removeTempDir(dirA);
    await removeTempDir(dirB);
  });

  it('4: writeContract stamps version + generatedAt from injected clock', async () => {
    await writeContract(fs, root, SAMPLE, () => 42);
    const parsed = JSON.parse(await readFile(reticleDirPaths(root).contract, 'utf8')) as {
      version: number;
      generatedAt: number;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.generatedAt).toBe(42);
  });

  it('5: writeContract auto-creates .reticle/ when absent (no pre-ensure)', async () => {
    await writeContract(fs, root, SAMPLE, frozenClock);
    expect(await fs.exists(reticleDirPaths(root).contract)).toBe(true);
    const r = await readContract(fs, root);
    expect(r.ok).toBe(true);
  });

  // ---- EDGE ----

  it('6: readContract on missing dir returns MISSING (no throw)', async () => {
    const r = await readContract(fs, root);
    expect(r).toEqual({ ok: false, reason: ContractReadError.MISSING });
  });

  it('7: readContract on missing file but present dir returns MISSING', async () => {
    await ensureReticleDir(fs, root);
    const r = await readContract(fs, root);
    expect(r).toEqual({ ok: false, reason: ContractReadError.MISSING });
  });

  it('8: ensureReticleDir is idempotent', async () => {
    await ensureReticleDir(fs, root);
    await ensureReticleDir(fs, root);
    await ensureReticleDir(fs, root);
    const p = reticleDirPaths(root);
    expect(await fs.exists(p.flows)).toBe(true);
    expect(await fs.exists(p.baselines)).toBe(true);
  });

  it('9: ensureReticleDir creates flows/ and baselines/', async () => {
    await ensureReticleDir(fs, root);
    const p = reticleDirPaths(root);
    expect(await fs.exists(p.flows)).toBe(true);
    expect(await fs.exists(p.baselines)).toBe(true);
  });

  it('10: reticleDirPaths/flowPath/baselinePath compose correctly', () => {
    const p = reticleDirPaths(root);
    expect(p.contract.endsWith(join('.reticle', 'contract.json'))).toBe(true);
    expect(p.flows.endsWith(join('.reticle', 'flows'))).toBe(true);
    expect(p.baselines.endsWith(join('.reticle', 'baselines'))).toBe(true);
    expect(
      flowPath(root, asFlowName('checkout')).endsWith(join('.reticle', 'flows', 'checkout.json')),
    ).toBe(true);
    expect(baselinePath(root, 'home').endsWith(join('.reticle', 'baselines', 'home.json'))).toBe(
      true,
    );
  });

  it('15: journal paths compose under sessions/<id> and guard the id', () => {
    expect(reticleDirPaths(root).sessions.endsWith(join('.reticle', 'sessions'))).toBe(true);
    expect(sessionDirPath(root, 'demo').endsWith(join('.reticle', 'sessions', 'demo'))).toBe(true);
    expect(journalEventsPath(root, 'demo').endsWith(join('sessions', 'demo', 'events.jsonl'))).toBe(
      true,
    );
    expect(
      journalActionsPath(root, 'demo').endsWith(join('sessions', 'demo', 'actions.jsonl')),
    ).toBe(true);
    expect(isValidSessionId('unique-123')).toBe(true);
    expect(isValidSessionId('alianpost')).toBe(true);
    expect(isValidSessionId('../escape')).toBe(false);
    expect(isValidSessionId('a/b')).toBe(false);
  });

  // ---- INVALID ----

  it('11: readContract on malformed JSON returns MALFORMED (no throw)', async () => {
    await ensureReticleDir(fs, root);
    await writeFile(reticleDirPaths(root).contract, '{ not json', 'utf8');
    const r = await readContract(fs, root);
    expect(r).toEqual({ ok: false, reason: ContractReadError.MALFORMED });
  });

  it('12: readContract on valid JSON failing schema returns MALFORMED', async () => {
    await ensureReticleDir(fs, root);
    await writeFile(
      reticleDirPaths(root).contract,
      '{"version":1,"generatedAt":1,"capabilities":{"testids":"oops","signals":[],"stores":[],"flows":[]}}',
      'utf8',
    );
    const r = await readContract(fs, root);
    expect(r).toEqual({ ok: false, reason: ContractReadError.MALFORMED });
  });

  it('13: readContract on empty file returns MALFORMED', async () => {
    await ensureReticleDir(fs, root);
    await writeFile(reticleDirPaths(root).contract, '', 'utf8');
    const r = await readContract(fs, root);
    expect(r).toEqual({ ok: false, reason: ContractReadError.MALFORMED });
  });

  it('14: readContract on JSON of wrong top-level shape returns MALFORMED', async () => {
    await ensureReticleDir(fs, root);
    await writeFile(reticleDirPaths(root).contract, '[]', 'utf8');
    const r = await readContract(fs, root);
    expect(r).toEqual({ ok: false, reason: ContractReadError.MALFORMED });
  });
});

/**
 * A visual baseline is only comparable within the runtime that produced it.
 *
 * An Electron window, a Tauri webview and a browser tab render the same url differently — different
 * chrome, different fonts, different device pixel ratio, a webview that is not the browser at all.
 * Sharing one baseline across them makes every cross-runtime diff wrong in one of two directions,
 * and the quiet direction is the dangerous one: a baseline overwritten from another runtime turns a
 * later real regression into a pass.
 *
 * Scoped the way flows already are — a subdir when there is something to scope by, the flat path
 * otherwise, so pre-existing baselines stay exactly where they are and keep matching. `web` stays
 * flat for the same reason: every baseline captured before this existed came from a driven browser,
 * because the SDK has no screenshotter.
 */
describe('visual baselines are scoped to the runtime that produced them', () => {
  it('keeps a desktop runtime in its own subdirectory', () => {
    expect(visualPath('/p/.reticle', 'home', 'electron')).toBe(
      join('/p/.reticle', 'visual', 'electron', 'home.png'),
    );
    expect(visualPath('/p/.reticle', 'home', 'tauri')).toBe(
      join('/p/.reticle', 'visual', 'tauri', 'home.png'),
    );
  });

  it('leaves web and unknown runtimes on the flat legacy path', () => {
    const flat = join('/p/.reticle', 'visual', 'home.png');
    expect(visualPath('/p/.reticle', 'home', 'web')).toBe(flat);
    expect(visualPath('/p/.reticle', 'home')).toBe(flat);
  });

  it('scopes the overlay diff the same way, so it lands beside its baseline', () => {
    expect(visualDiffPath('/p/.reticle', 'home', 'electron')).toBe(
      join('/p/.reticle', 'visual', 'electron', 'home.diff.png'),
    );
    expect(visualDiffPath('/p/.reticle', 'home')).toBe(
      join('/p/.reticle', 'visual', 'home.diff.png'),
    );
  });

  it('names the directory a write has to create', () => {
    expect(visualDir('/p/.reticle', 'electron')).toBe(join('/p/.reticle', 'visual', 'electron'));
    expect(visualDir('/p/.reticle')).toBe(join('/p/.reticle', 'visual'));
  });
});
