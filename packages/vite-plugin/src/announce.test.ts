import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { DevServerEntrySchema, devServerRegistryFileName } from '@reticlehq/core';
import { announceDevServer, type AnnounceIo } from './announce.js';

const HOME = '/home/.reticle';

function fakeIo(): AnnounceIo & { files: Map<string, string>; dirs: string[] } {
  const files = new Map<string, string>();
  const dirs: string[] = [];
  return {
    files,
    dirs,
    mkdir: (dir) => void dirs.push(dir),
    writeFile: (path, data) => void files.set(path, data),
    removeFile: (path) => void files.delete(path),
  };
}

const entry = {
  port: 5173,
  pid: 42,
  root: '/repo/apps/web',
  url: 'http://localhost:5173/',
  sdkVersion: '2.13.0',
  startedAt: 1000,
  projectId: 'web-abc123',
};

describe('announceDevServer', () => {
  it('writes an entry the shared schema accepts', () => {
    const io = fakeIo();
    announceDevServer(entry, HOME, io);
    // `join`, not a literal slash: announceDevServer joins the path, so on Windows the key it wrote
    // is `\`-separated and a hand-built `/` key missed it. The assertion then read "expected
    // undefined to be defined" — a portability bug in the test that only a Windows runner could see,
    // and this branch is the first to have had one.
    const raw = io.files.get(join(HOME, devServerRegistryFileName(5173)));
    expect(raw).toBeDefined();
    expect(DevServerEntrySchema.safeParse(JSON.parse(raw ?? '')).success).toBe(true);
  });

  it('removes the entry when the returned cleanup runs', () => {
    const io = fakeIo();
    const done = announceDevServer(entry, HOME, io);
    done();
    expect(io.files.size).toBe(0);
  });

  /**
   * Cleanup runs from process exit handlers, which fire more than once and race each other. A second
   * call must be a no-op, not a throw into a shutdown path nobody is catching.
   */
  it('is safe to clean up twice', () => {
    const io = fakeIo();
    const done = announceDevServer(entry, HOME, io);
    done();
    expect(() => done()).not.toThrow();
  });

  /**
   * A dev server that cannot write its announcement must still serve the app. This is a diagnostic,
   * and a diagnostic that can break the thing it reports on is worse than no diagnostic.
   */
  it('never throws when the filesystem refuses', () => {
    const io: AnnounceIo = {
      mkdir: () => {
        throw new Error('EACCES');
      },
      writeFile: () => {
        throw new Error('EACCES');
      },
      removeFile: () => {
        throw new Error('EACCES');
      },
    };
    const done = announceDevServer(entry, HOME, io);
    expect(() => done()).not.toThrow();
  });
});
