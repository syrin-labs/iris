import {
  access,
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';

/**
 * The injectable filesystem seam. Server logic depends on this interface, never on node:fs
 * directly — so tests pass an in-memory or temp-dir adapter and never touch the repo's .reticle/.
 */
export interface FileSystemPort {
  /** Read a UTF-8 file. Rejects (ENOENT) if absent. */
  readFile(path: string): Promise<string>;
  /**
   * Read a UTF-8 file from a BYTE offset to EOF, returning the tail plus the file's total byte size.
   * The append-only journal grows unboundedly, so re-reading the whole file per query is O(N-per-call);
   * this reads only what was appended since the caller's tracked offset. Callers MUST pass an offset
   * that lands on a `\n` boundary (the journal's line terminator, 1 ASCII byte) so the returned tail
   * starts on a valid UTF-8 char boundary. Optional — a FileSystemPort that omits it makes readers fall
   * back to a whole-file read.
   */
  readFileFrom?(path: string, byteOffset: number): Promise<{ text: string; size: number }>;
  writeFile(path: string, data: string): Promise<void>;
  /** Append UTF-8 text, creating the file if absent — for the append-only JSONL journal. */
  appendFile(path: string, data: string): Promise<void>;
  /** Read raw bytes (PNG baselines). Rejects (ENOENT) if absent. */
  readFileBytes(path: string): Promise<Uint8Array>;
  /** Write raw bytes (PNG screenshots/diffs). */
  writeFileBytes(path: string, data: Uint8Array): Promise<void>;
  /** Recursive + idempotent: no throw if the directory already exists. */
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** List entries of a directory (for flows/baselines listing). */
  readdir(path: string): Promise<string[]>;
  /** Atomically replace `to` with `from` (same-FS rename) — for crash-safe writes. */
  rename(from: string, to: string): Promise<void>;
  /** Idempotent remove (no throw if absent) — for retention pruning + cleaning temp files. */
  rm(path: string): Promise<void>;
  /** Modification time in epoch ms — for recency-based retention pruning. Rejects if absent. */
  stat(path: string): Promise<{ mtimeMs: number; size: number }>;
  /** Resolve symlinks to their real path — for upload trust-boundary checks. Rejects if absent. */
  realpath(path: string): Promise<string>;
  /** ENOENT classifier — narrows unknown without `any`, so callers can distinguish missing-file. */
  isNotFound(error: unknown): boolean;
}

/** Production adapter — the single import site of node:fs/promises in the server. */
export function createNodeFileSystem(): FileSystemPort {
  return {
    readFile: (path) => readFile(path, 'utf8'),
    readFileFrom: async (path, byteOffset) => {
      const fh = await open(path, 'r');
      try {
        const { size } = await fh.stat();
        if (byteOffset >= size) return { text: '', size };
        const length = size - byteOffset;
        const buf = Buffer.allocUnsafe(length);
        await fh.read(buf, 0, length, byteOffset);
        return { text: buf.toString('utf8'), size };
      } finally {
        await fh.close();
      }
    },
    writeFile: (path, data) => writeFile(path, data, 'utf8'),
    appendFile: (path, data) => appendFile(path, data, 'utf8'),
    readFileBytes: async (path) => {
      const buf = await readFile(path);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    writeFileBytes: (path, data) => writeFile(path, data),
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    exists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    readdir: (path) => readdir(path),
    rename: (from, to) => rename(from, to),
    rm: async (path) => {
      // recursive so a session-journal DIRECTORY can be pruned; force so a missing path is a no-op.
      // recursive is harmless for the file-removal callers (run/flow artifacts).
      await rm(path, { recursive: true, force: true });
    },
    stat: async (path) => {
      const s = await stat(path);
      return { mtimeMs: s.mtimeMs, size: s.size };
    },
    realpath: (path) => realpath(path),
    isNotFound: (error) => 'ENOENT' === (error as NodeJS.ErrnoException | undefined)?.code,
  };
}
