/**
 * Persistence for verification-run artifacts at .reticle/runs/<runId>.json. Mirrors ProjectStore:
 * injected FileSystemPort, never-throws read, path-segment guard on the runId (the tool-arg attack
 * surface). One artifact per file (unlike project.json's single rolling file) so a host can attach an
 * individual run to a deploy. The run is already clock-stamped by buildVerificationRun, so the store
 * needs no clock.
 */

import {
  asRunId,
  ReticleVerificationRunSchema,
  RUN_RETENTION,
  RUN_RETENTION_SLACK,
  RunReadError,
  type ReticleVerificationRun,
  type RunId,
} from '@reticlehq/core';
import type { FileSystemPort } from '../project/fs-port.js';
import { reticleDirPaths, isValidRunId, runPath } from '../project/reticle-dir.js';

const JSON_INDENT = 2;
const JSON_EXT = '.json';
const TMP_EXT = '.tmp';

/** Never-throws read result (mirrors ReadProjectResult). */
export type ReadRunResult =
  { ok: true; run: ReticleVerificationRun } | { ok: false; reason: RunReadError };

/** Optional retention overrides (defaults to the protocol caps). Injectable so tests prune fast. */
interface RunStoreOptions {
  retention?: number;
  slack?: number;
  /**
   * Called after a run artifact is safely on disk. Used to wake cloud sync so a finished
   * verification reaches the dashboard promptly instead of waiting for the next timer tick.
   *
   * A callback rather than a dependency on the sync daemon: the store's job is durability, and a
   * store that imported the cloud would make "write a run" fail whenever the cloud did. It is
   * invoked AFTER the rename, so nothing can observe a run that is not yet readable, and it must
   * never throw — see the call site.
   */
  onWrote?: () => void;
}

export class RunStore {
  readonly #fs: FileSystemPort;
  readonly #root: string;
  readonly #retention: number;
  readonly #slack: number;
  readonly #onWrote: (() => void) | undefined;

  constructor(fs: FileSystemPort, root: string, opts: RunStoreOptions = {}) {
    this.#fs = fs;
    this.#root = root;
    this.#retention = opts.retention ?? RUN_RETENTION;
    this.#slack = opts.slack ?? RUN_RETENTION_SLACK;
    this.#onWrote = opts.onWrote;
  }

  /**
   * Write one run artifact. Creates .reticle/runs/ first; byte-stable (fixed indent + trailing newline).
   * Guards runId as a safe path segment BEFORE building the path — a runId can originate from a caller
   * (an OEM may set it), so an unsafe value must never escape .reticle/runs/ (mirrors the read guard).
   */
  async write(run: ReticleVerificationRun): Promise<void> {
    if (!isValidRunId(run.runId)) {
      throw new Error(`refusing to write run with unsafe runId: ${JSON.stringify(run.runId)}`);
    }
    await this.#fs.mkdir(reticleDirPaths(this.#root).runs);
    // Atomic publish: write a temp file then rename, so a crash mid-write never leaves a half-written
    // artifact (a partial.json would otherwise read back as MALFORMED).
    const path = runPath(this.#root, run.runId);
    const tmp = `${path}${TMP_EXT}`;
    await this.#fs.writeFile(tmp, `${JSON.stringify(run, null, JSON_INDENT)}\n`);
    await this.#fs.rename(tmp, path);
    // AFTER the rename: a listener that reads the run back must find it there. Swallowed, because
    // this is a notification — a sync that cannot be woken must never fail the write it followed.
    try {
      this.#onWrote?.();
    } catch {
      // Not this store's problem, and not worth failing a durable write over.
    }
    await this.#pruneOld();
  }

  /**
   * Keep .reticle/runs/ bounded. Only acts once the count exceeds RUN_RETENTION + SLACK, then deletes the
   * oldest (by createdAt) back down to RUN_RETENTION — so the read-all is amortized, not per-write.
   */
  async #pruneOld(): Promise<void> {
    const ids = await this.list();
    if (ids.length <= this.#retention + this.#slack) return;
    const stamped: Array<{ id: string; at: number }> = [];
    for (const id of ids) {
      const result = await this.read(id);
      stamped.push({ id, at: result.ok ? result.run.createdAt : 0 });
    }
    stamped.sort((a, b) => a.at - b.at);
    for (const { id } of stamped.slice(0, stamped.length - this.#retention)) {
      await this.#fs.rm(runPath(this.#root, id));
    }
  }

  /** Never throws. Invalid id / missing → MISSING; bad JSON or failed schema → MALFORMED. */
  async read(runId: RunId): Promise<ReadRunResult> {
    if (!isValidRunId(runId)) return { ok: false, reason: RunReadError.MISSING };
    const path = runPath(this.#root, runId);
    if (!(await this.#fs.exists(path))) return { ok: false, reason: RunReadError.MISSING };

    let text: string;
    try {
      text = await this.#fs.readFile(path);
    } catch (error) {
      return {
        ok: false,
        reason: this.#fs.isNotFound(error) ? RunReadError.MISSING : RunReadError.MALFORMED,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: RunReadError.MALFORMED };
    }

    const result = ReticleVerificationRunSchema.safeParse(parsed);
    if (!result.success) return { ok: false, reason: RunReadError.MALFORMED };
    return { ok: true, run: result.data };
  }

  /** List run ids on disk (filenames minus.json). Empty when the runs dir is absent. */
  async list(): Promise<RunId[]> {
    const dir = reticleDirPaths(this.#root).runs;
    if (!(await this.#fs.exists(dir))) return [];
    let entries: string[];
    try {
      entries = await this.#fs.readdir(dir);
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.endsWith(JSON_EXT))
      .map((e) => asRunId(e.slice(0, -JSON_EXT.length)));
  }

  /** The most-recent run by createdAt (undefined when none). Powers reticle_run_export's default. */
  async latest(): Promise<ReticleVerificationRun | undefined> {
    const ids = await this.list();
    let best: ReticleVerificationRun | undefined;
    for (const id of ids) {
      const result = await this.read(id);
      if (result.ok && (best === undefined || result.run.createdAt > best.createdAt)) {
        best = result.run;
      }
    }
    return best;
  }

  /**
   * The two most-recent runs by createdAt as `[previous, current]` (oldest-first), or undefined when
   * fewer than two readable runs exist. Powers reticle_run_export's `format:"diff"` (run-to-run deltas).
   */
  async latestTwo(): Promise<[ReticleVerificationRun, ReticleVerificationRun] | undefined> {
    const runs: ReticleVerificationRun[] = [];
    for (const id of await this.list()) {
      const result = await this.read(id);
      if (result.ok) runs.push(result.run);
    }
    if (runs.length < 2) return undefined;
    runs.sort((a, b) => a.createdAt - b.createdAt);
    const previous = runs[runs.length - 2];
    const current = runs[runs.length - 1];
    if (previous === undefined || current === undefined) return undefined;
    return [previous, current];
  }
}
