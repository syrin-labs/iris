import type { FileSystemPort } from './fs-port.js';

/**
 * An in-memory `FileSystemPort`, and the map it wrote into.
 *
 * Three specs had hand-rolled their own copy of this before it was extracted, each one slightly
 * different and each one a fresh chance to reintroduce the same fixture bug: the code under test
 * joins paths with the PLATFORM separator, the fixtures are written with POSIX ones, and a spec that
 * forgets to normalise passes on macOS and fails on Windows. Normalising at the port — once, here —
 * is what stops that recurring.
 *
 * Exposing `written` is the other reason this exists. A store's return value says what it believes it
 * did; the map says where the bytes actually went, which is the only way to test a defect about
 * writing to the wrong directory.
 */

/** POSIX form, so a `\`-joined path and a `/`-joined one are the same key. */
const norm = (path: string): string => path.split('\\').join('/');

interface MemoryFs {
  fs: FileSystemPort;
  /** Every file written, keyed by normalised absolute path. */
  written: Map<string, string>;
  /** Every directory created. */
  dirs: Set<string>;
}

export function createMemoryFs(): MemoryFs {
  const written = new Map<string, string>();
  const dirs = new Set<string>();

  const notFound = (): NodeJS.ErrnoException => {
    const err: NodeJS.ErrnoException = new Error('ENOENT: no such file or directory');
    err.code = 'ENOENT';
    return err;
  };

  const fs: FileSystemPort = {
    readFile(path) {
      const value = written.get(norm(path));
      return value === undefined ? Promise.reject(notFound()) : Promise.resolve(value);
    },
    writeFile(path, data) {
      written.set(norm(path), data);
      return Promise.resolve();
    },
    appendFile(path, data) {
      written.set(norm(path), (written.get(norm(path)) ?? '') + data);
      return Promise.resolve();
    },
    readFileBytes(path) {
      const value = written.get(norm(path));
      return value === undefined
        ? Promise.reject(notFound())
        : Promise.resolve(new TextEncoder().encode(value));
    },
    writeFileBytes(path, data) {
      written.set(norm(path), new TextDecoder().decode(data));
      return Promise.resolve();
    },
    mkdir(path) {
      dirs.add(norm(path));
      return Promise.resolve();
    },
    exists(path) {
      const key = norm(path);
      return Promise.resolve(written.has(key) || dirs.has(key));
    },
    readdir(path) {
      const prefix = `${norm(path)}/`;
      const names = new Set<string>();
      for (const key of written.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length).split('/')[0];
          if (rest !== undefined && rest.length > 0) names.add(rest);
        }
      }
      return Promise.resolve([...names]);
    },
    rename(from, to) {
      const value = written.get(norm(from));
      if (value === undefined) return Promise.reject(notFound());
      written.set(norm(to), value);
      written.delete(norm(from));
      return Promise.resolve();
    },
    rm(path) {
      written.delete(norm(path));
      dirs.delete(norm(path));
      return Promise.resolve();
    },
    stat(path) {
      return written.has(norm(path))
        ? Promise.resolve({ mtimeMs: 0, size: 0 })
        : Promise.reject(notFound());
    },
    realpath(path: string) {
      return written.has(norm(path)) ? Promise.resolve(norm(path)) : Promise.reject(notFound());
    },
    isNotFound(error) {
      return 'ENOENT' === (error as NodeJS.ErrnoException | undefined)?.code;
    },
  };

  return { fs, written, dirs };
}
