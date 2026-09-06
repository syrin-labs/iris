import { describe, expect, it } from 'vitest';
import { readDevServers, type DevServerIo } from './dev-servers.js';

const HOME = '/home/.reticle';

function io(
  files: Record<string, string>,
  alive: (pid: number) => boolean = () => true,
): DevServerIo {
  return {
    readdir: () => Object.keys(files),
    readFile: (path) => {
      const found = files[path.slice(`${HOME}/`.length)];
      if (found === undefined) throw new Error('ENOENT');
      return found;
    },
    isAlive: alive,
  };
}

const entry = (port: number, pid: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    port,
    pid,
    root: `/repo/app-${String(port)}`,
    url: `http://localhost:${String(port)}/`,
    sdkVersion: '2.13.0',
    startedAt: 1,
    ...extra,
  });

describe('readDevServers', () => {
  it('reads the entries a dev server announced', () => {
    const found = readDevServers(HOME, io({ 'devserver-5173.json': entry(5173, 10) }));
    expect(found.map((e) => e.port)).toEqual([5173]);
  });

  /**
   * The daemon's own registry lives in the same directory. Reading one as a dev server would report
   * the daemon as an instrumented app — the exact false green this signal exists to prevent.
   */
  it('ignores the daemon registry alongside it', () => {
    const found = readDevServers(
      HOME,
      io({ 'daemon-4400.json': entry(4400, 10), 'devserver-5173.json': entry(5173, 11) }),
    );
    expect(found.map((e) => e.port)).toEqual([5173]);
  });

  it('drops an entry whose process is gone', () => {
    const found = readDevServers(
      HOME,
      io({ 'devserver-5173.json': entry(5173, 10) }, () => false),
    );
    expect(found).toEqual([]);
  });

  /**
   * A half-written or hand-edited file must not take the whole reading with it. This runs on the
   * path that tells a user why setup has not worked; throwing here would replace a real diagnosis
   * with a stack trace.
   */
  it('skips malformed entries instead of throwing', () => {
    const found = readDevServers(
      HOME,
      io({ 'devserver-1.json': '{ not json', 'devserver-5173.json': entry(5173, 10) }),
    );
    expect(found.map((e) => e.port)).toEqual([5173]);
  });

  it('is empty when the directory does not exist', () => {
    const throwing: DevServerIo = {
      readdir: () => {
        throw new Error('ENOENT');
      },
      readFile: () => '',
      isAlive: () => true,
    };
    expect(readDevServers(HOME, throwing)).toEqual([]);
  });
});
