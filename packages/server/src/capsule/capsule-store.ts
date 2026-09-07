import { join } from 'node:path';
import { z } from 'zod';
import { FlowStepSchema, type FlowStep } from '@reticlehq/core';
import type { FileSystemPort } from '../project/fs-port.js';
import { reticleDirPaths } from '../project/reticle-dir.js';

/**
 * Bug capsules. When an assertion fails, the evidence that explains it is in hand exactly once —
 * at the moment of the failure. A capsule persists that moment as a *replayable artifact*: the minimal
 * failing steps, the consequence that was supposed to hold, and the divergence that was observed instead.
 *
 * This is deliberately fail-to-pass shaped (SWE-bench style): a capsule reproduces a bug NOW and, once the
 * fix lands, it is exactly a regression flow. Capsules are ordinary flow files plus evidence, so they
 * replay through the existing machinery rather than needing a second runner.
 */

/**
 * The capsule file-format version. Declared ABOVE the schema so the schema, the writer and this
 * constant cannot disagree: the number was previously written as a bare `1` in three places — here,
 * in the schema literal, and in act-capsule's writer — with the named one used by nobody.
 */
export const CAPSULE_VERSION = 1;

const CapsuleSchema = z.object({
  version: z.literal(CAPSULE_VERSION),
  id: z.string(),
  /** The flow the failure happened in, when it came from one (a bare assert has no flow). */
  flow: z.string().optional(),
  createdAt: z.number(),
  /** Why it was captured — a failed assertion, a crawl anomaly, a human review pin. */
  origin: z.string(),
  /** The consequence that was supposed to hold. */
  expected: z.string(),
  /** What was observed instead — the first-divergence sentence. */
  observed: z.string(),
  /** Minimal steps to reproduce (prefix-trimmed). */
  steps: z.array(FlowStepSchema),
});
export type Capsule = z.infer<typeof CapsuleSchema>;

/** Capsule ids are filenames — refuse anything that could escape the capsules directory. */
export function isValidCapsuleId(id: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(id) && id !== '.' && id !== '..' && id.length <= 128;
}

export class CapsuleStore {
  readonly #fs: FileSystemPort;
  readonly #dir: string;

  constructor(fs: FileSystemPort, root: string) {
    this.#fs = fs;
    this.#dir = reticleDirPaths(root).capsules;
  }

  #pathFor(id: string): string {
    return join(this.#dir, `${id}.json`);
  }

  /** Persist a capsule. Best-effort by design: capturing evidence must never fail the run that found it. */
  async save(capsule: Capsule): Promise<boolean> {
    if (!isValidCapsuleId(capsule.id)) return false;
    try {
      await this.#fs.mkdir(this.#dir);
      const tmp = `${this.#pathFor(capsule.id)}.tmp`;
      await this.#fs.writeFile(tmp, `${JSON.stringify(capsule, null, 2)}\n`);
      await this.#fs.rename(tmp, this.#pathFor(capsule.id));
      return true;
    } catch {
      return false;
    }
  }

  /** Capsule ids on disk, newest-first by id (ids are time-prefixed). Never throws. */
  async list(): Promise<string[]> {
    try {
      if (!(await this.#fs.exists(this.#dir))) return [];
      const entries = await this.#fs.readdir(this.#dir);
      return entries
        .filter((e) => e.endsWith('.json'))
        .map((e) => e.slice(0, -'.json'.length))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /** Read one capsule; undefined when missing or malformed (never throws). */
  async read(id: string): Promise<Capsule | undefined> {
    if (!isValidCapsuleId(id)) return undefined;
    try {
      const parsed: unknown = JSON.parse(await this.#fs.readFile(this.#pathFor(id)));
      const result = CapsuleSchema.safeParse(parsed);
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every readable capsule, newest-first — what `reticle capsules` prints. */
  async all(): Promise<Capsule[]> {
    const out: Capsule[] = [];
    for (const id of await this.list()) {
      const capsule = await this.read(id);
      if (capsule !== undefined) out.push(capsule);
    }
    return out;
  }
}

/** Deterministic, path-safe capsule id: time-ordered so `list` sorts newest-first for free. */
export function capsuleId(now: number, label: string): string {
  const safe = label.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40);
  return `${String(now)}-${safe.length > 0 ? safe : 'capsule'}`;
}

/** The minimal reproduction: the steps up to and including the one that failed (prefix trim). */
export function minimalSteps(steps: readonly FlowStep[], failedIndex: number): FlowStep[] {
  if (failedIndex < 0) return [...steps];
  return steps.slice(0, failedIndex + 1);
}
