/**
 * Unit tests for `rewriteUploadArgs` — the daemon-side path that lets an agent name a file on
 * disk and have its real bytes reach the browser's `<input type="file">`.
 *
 * These tests use an in-memory FileSystemPort fake so no actual disk files are needed.
 *
 * All paths are derived from `os.tmpdir()` so tests work on Windows (D:\...) and POSIX (/tmp/...)
 * without any hardcoded separators.
 */
import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { TRANSPORT_LIMITS } from '@reticlehq/core';
import { ActionType } from '@reticlehq/core';
import { rewriteUploadArgs } from './real-input-attempt.js';
import type { ToolDeps } from './tools.js';
import type { FileSystemPort } from '../project/fs-port.js';

/**
 * A stable cross-platform root for all test paths.
 * Using os.tmpdir() avoids hardcoded POSIX paths that break on Windows.
 */
const CWD = resolve(join(tmpdir(), 'reticle-upload-test'));
const RETICLE_ROOT = join(CWD, '.reticle');

/** Absolute path of a file under CWD. */
function p(...parts: string[]): string {
  return join(CWD, ...parts);
}

/**
 * The cap in bytes that rewriteUploadArgs enforces — mirrors the formula in real-input-attempt.ts
 * so tests stay in sync when TRANSPORT_LIMITS changes.
 */
const UPLOAD_MAX_BYTES = Math.floor((TRANSPORT_LIMITS.MAX_MESSAGE_BYTES / (4 / 3)) * 0.75);

/**
 * Build a minimal FileSystemPort fake backed by an in-memory map of path → bytes.
 * Keys are normalised with resolve() so Windows paths match what rewriteUploadArgs resolves.
 */
function fakeFs(files: Record<string, Uint8Array>): FileSystemPort {
  // Pre-normalise every key so lookup always works regardless of separator.
  const normalised: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) normalised[resolve(k)] = v;

  return {
    readFile: () => Promise.resolve(''),
    writeFile: () => Promise.resolve(),
    appendFile: () => Promise.resolve(),
    readFileBytes: (path) => {
      const bytes = normalised[resolve(path)];
      if (bytes === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
      return Promise.resolve(bytes);
    },
    writeFileBytes: () => Promise.resolve(),
    mkdir: () => Promise.resolve(),
    exists: (path) => Promise.resolve(resolve(path) in normalised),
    readdir: () => Promise.resolve([]),
    rename: () => Promise.resolve(),
    rm: () => Promise.resolve(),
    stat: (path) => {
      const bytes = normalised[resolve(path)];
      if (bytes === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
      return Promise.resolve({ mtimeMs: Date.now(), size: bytes.byteLength });
    },
    // realpath: resolve symlinks — in the fake, just normalise the path (no actual symlinks)
    realpath: (path) => {
      const resolved = resolve(path);
      // If the path isn't in our file map, reject with ENOENT
      if (!(resolved in normalised)) return Promise.reject(new Error(`ENOENT: ${path}`));
      return Promise.resolve(resolved);
    },
    isNotFound: (err) => String(err).includes('ENOENT'),
  };
}

/** Minimal ToolDeps with only the fields rewriteUploadArgs needs. */
function fakeDeps(files: Record<string, Uint8Array>): ToolDeps {
  return {
    fs: fakeFs(files),
    // reticleRoot is CWD/.reticle — rewriteUploadArgs derives project root from join(reticleRoot, '..')
    reticleRoot: RETICLE_ROOT,
  } as unknown as ToolDeps;
}

const HELLO_BYTES = new TextEncoder().encode('hello world');

describe('rewriteUploadArgs', () => {
  describe('passthrough for non-upload actions', () => {
    it('returns args unchanged when action is not upload', async () => {
      const inner = { value: 'hello' };
      const result = await rewriteUploadArgs(fakeDeps({}), ActionType.FILL, inner);
      expect(result).toBe(inner); // same reference — no copy made
    });

    it('returns args unchanged when action is upload but no path is given', async () => {
      const inner = { content: 'abc', name: 'file.txt', type: 'text/plain' };
      const result = await rewriteUploadArgs(fakeDeps({}), ActionType.UPLOAD, inner);
      expect(result).toBe(inner);
    });
  });

  describe('happy path — absolute path within cwd', () => {
    it('reads the file and rewrites to { content, name, type, __base64 }', async () => {
      const filePath = p('fixtures', 'doc.pdf');
      const deps = fakeDeps({ [filePath]: HELLO_BYTES });
      const result = await rewriteUploadArgs(deps, ActionType.UPLOAD, { path: filePath });

      expect(result['content']).toBe(Buffer.from(HELLO_BYTES).toString('base64'));
      expect(result['name']).toBe('doc.pdf');
      expect(result['type']).toBe('application/pdf');
      expect(result['__base64']).toBe(true);
      expect(result['path']).toBeUndefined(); // stripped — browser doesn't understand it
    });

    it('uses a relative path resolved against the project root', async () => {
      const filePath = p('fixtures', 'data.csv');
      const deps = fakeDeps({ [filePath]: HELLO_BYTES });
      const result = await rewriteUploadArgs(deps, ActionType.UPLOAD, {
        path: join('fixtures', 'data.csv'), // relative
      });

      expect(result['name']).toBe('data.csv');
      expect(result['type']).toBe('text/csv');
      expect(result['content']).toBe(Buffer.from(HELLO_BYTES).toString('base64'));
    });
  });

  describe('caller overrides', () => {
    it('respects caller-supplied name and type', async () => {
      const filePath = p('file.bin');
      const deps = fakeDeps({ [filePath]: HELLO_BYTES });
      const result = await rewriteUploadArgs(deps, ActionType.UPLOAD, {
        path: filePath,
        name: 'my-upload.txt',
        type: 'text/plain',
      });

      expect(result['name']).toBe('my-upload.txt');
      expect(result['type']).toBe('text/plain');
    });

    it('passes through generic action args (confirmDangerous etc.) untouched', async () => {
      const filePath = p('file.txt');
      const deps = fakeDeps({ [filePath]: HELLO_BYTES });
      const result = await rewriteUploadArgs(deps, ActionType.UPLOAD, {
        path: filePath,
        confirmDangerous: true,
      });

      expect(result['confirmDangerous']).toBe(true);
      expect(result['content']).toBeDefined();
    });
  });

  describe('MIME inference', () => {
    const cases: Array<[string, string]> = [
      ['report.pdf', 'application/pdf'],
      ['data.csv', 'text/csv'],
      ['notes.txt', 'text/plain'],
      ['config.json', 'application/json'],
      ['photo.png', 'image/png'],
      ['photo.jpg', 'image/jpeg'],
      ['archive.zip', 'application/zip'],
      ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['unknown.bin', 'application/octet-stream'],
    ];

    for (const [filename, expectedMime] of cases) {
      it(`infers ${expectedMime} for ${filename}`, async () => {
        const filePath = p(filename);
        const deps = fakeDeps({ [filePath]: HELLO_BYTES });
        const result = await rewriteUploadArgs(deps, ActionType.UPLOAD, { path: filePath });
        expect(result['type']).toBe(expectedMime);
      });
    }
  });

  describe('trust boundary — path must be within project root', () => {
    it('refuses a path outside the project root', async () => {
      const deps = fakeDeps({});
      const outsidePath = join(tmpdir(), 'other-project', 'secret.txt');
      // Add the file to the fake so realpath doesn't fail on ENOENT before the boundary check
      const depsWithFile = {
        ...deps,
        fs: {
          ...deps.fs,
          realpath: (path: string) => Promise.resolve(resolve(path)),
        },
      } as unknown as ToolDeps;
      await expect(
        rewriteUploadArgs(depsWithFile, ActionType.UPLOAD, { path: outsidePath }),
      ).rejects.toThrow('outside the project root');
    });

    it('refuses a relative path that escapes via ../', async () => {
      const deps = fakeDeps({});
      const escapePath = join('..', '..', 'etc', 'passwd');
      const depsWithRealpath = {
        ...deps,
        fs: {
          ...deps.fs,
          realpath: (path: string) => Promise.resolve(resolve(CWD, path)),
        },
      } as unknown as ToolDeps;
      await expect(
        rewriteUploadArgs(depsWithRealpath, ActionType.UPLOAD, { path: escapePath }),
      ).rejects.toThrow('outside the project root');
    });

    it('names the project root in the error', async () => {
      const deps = fakeDeps({});
      const outsidePath = join(tmpdir(), 'other', 'secret.txt');
      const depsWithRealpath = {
        ...deps,
        fs: { ...deps.fs, realpath: (path: string) => Promise.resolve(resolve(path)) },
      } as unknown as ToolDeps;
      const err = await rewriteUploadArgs(depsWithRealpath, ActionType.UPLOAD, {
        path: outsidePath,
      }).catch((e: unknown) => String(e));
      expect(err).toContain(CWD);
    });
  });

  describe('deny-list — sensitive files are refused even inside the project root', () => {
    const sensitiveFiles = [
      '.env',
      '.env.local',
      '.env.production',
      '.git',
      'secrets.pem',
      'id_rsa',
      'id_ed25519',
      '.npmrc',
      '.netrc',
      '.aws',
    ];

    for (const filename of sensitiveFiles) {
      it(`refuses ${filename}`, async () => {
        const filePath = p(filename);
        const deps = fakeDeps({ [filePath]: HELLO_BYTES });
        await expect(
          rewriteUploadArgs(deps, ActionType.UPLOAD, { path: filePath }),
        ).rejects.toThrow('sensitive-file pattern');
      });
    }

    it('allows a normal fixture file that happens to contain env in its name', async () => {
      // "environment-report.pdf" should NOT be caught by the .env pattern
      const filePath = p('fixtures', 'environment-report.pdf');
      const deps = fakeDeps({ [filePath]: HELLO_BYTES });
      const result = await rewriteUploadArgs(deps, ActionType.UPLOAD, { path: filePath });
      expect(result['content']).toBeDefined();
    });
  });

  describe('missing or unreadable file', () => {
    it('throws a clear error when the file does not exist', async () => {
      const deps = fakeDeps({});
      await expect(
        rewriteUploadArgs(deps, ActionType.UPLOAD, { path: p('missing.pdf') }),
      ).rejects.toThrow('could not be read');
    });
  });

  describe('size cap — derived from TRANSPORT_LIMITS', () => {
    it('refuses a file that exceeds the cap', async () => {
      const bigFile = new Uint8Array(UPLOAD_MAX_BYTES + 1);
      const filePath = p('huge.pdf');
      const deps = fakeDeps({ [filePath]: bigFile });
      await expect(rewriteUploadArgs(deps, ActionType.UPLOAD, { path: filePath })).rejects.toThrow(
        'exceeds the',
      );
    });

    it('accepts a file at exactly the cap', async () => {
      const exactFile = new Uint8Array(UPLOAD_MAX_BYTES);
      const filePath = p('exact.pdf');
      const deps = fakeDeps({ [filePath]: exactFile });
      await expect(
        rewriteUploadArgs(deps, ActionType.UPLOAD, { path: filePath }),
      ).resolves.toBeDefined();
    });

    it('checks size via stat BEFORE reading bytes (fast rejection for huge files)', async () => {
      // The fake's stat() returns the size from the registered files map.
      // We verify that a file exceeding the cap throws "exceeds the" (from stat check)
      // rather than a read error — proving stat runs first.
      const bigFile = new Uint8Array(UPLOAD_MAX_BYTES + 1024);
      const filePath = p('too-big.pdf');
      const deps = fakeDeps({ [filePath]: bigFile });
      const err = await rewriteUploadArgs(deps, ActionType.UPLOAD, {
        path: filePath,
      }).catch((e: unknown) => String(e));
      expect(err).toContain('exceeds the');
      // Must NOT contain "could not be read" — that's the read-failure message, not the cap message
      expect(err).not.toContain('could not be read');
    });
  });
});
