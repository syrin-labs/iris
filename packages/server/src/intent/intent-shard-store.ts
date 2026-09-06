/**
 * Reading and writing the sharded intent store, and migrating the flat one into it.
 *
 * The operations an agent actually performs, and what each is allowed to cost:
 *
 *   index()            every id + one line, always affordable — the session-start read
 *   subject(name)      the full records for one subject, when it is about to work on that
 *   get(id)            one record, via the index rather than by scanning shards
 *   record()/update()  a write that touches ONE shard file plus the index
 *
 * The last one is the reason for the whole design. Under the flat file, changing one intent rewrote
 * all 141, so two sessions touching unrelated subjects raced each other and the loser's write
 * vanished. Sharded, they only collide when they genuinely edit the same subject.
 *
 * ## Migration is automatic, and it does not delete
 *
 * `.reticle/intent.json` is read on every load and folded in when the sharded copy has nothing for
 * an id. That makes the move invisible: an agent on the new store sees old intents immediately, and
 * an older build still reading the flat file keeps working, because nothing removes it. Deleting it
 * is a separate decision somebody can take once they believe the migration.
 */
import { parseIntentFile, type Intent } from '@reticlehq/core';
import type { FileSystemPort } from '../project/fs-port.js';
import { reticleDirPaths } from '../project/reticle-dir.js';
import { withFileLock } from '../project/file-lock.js';
import { subjectFor } from './intent-subject.js';
import {
  emptyShard,
  indexFrom,
  IntentShardSchema,
  IntentStatus,
  recordFromIntent,
  serialise,
  shardsFrom,
  readJsonFile,
  type IntentIndex,
  type IntentRecord,
  type IntentShard,
} from './intent-shard.js';

const INTENT_DIR = 'intent';
const INDEX_FILE = 'index.json';
const SHARD_SUFFIX = '.json';

export interface Clock {
  now: () => number;
}

/** What a caller supplies to write an intent. Everything optional is genuinely optional. */
interface IntentInput {
  id: string;
  statement: string;
  subject?: string | undefined;
  why?: string | undefined;
  source?: string | undefined;
  status?: IntentStatus | undefined;
  surface?: Intent['surface'];
  binding?: unknown;
}

export class IntentShardStore {
  readonly #fs: FileSystemPort;
  readonly #root: string;
  readonly #clock: Clock;

  constructor(fs: FileSystemPort, root: string, clock: Clock) {
    this.#fs = fs;
    this.#root = root;
    this.#clock = clock;
  }

  #dir(): string {
    return `${reticleDirPaths(this.#root).root}/${INTENT_DIR}`;
  }

  #indexPath(): string {
    return `${this.#dir()}/${INDEX_FILE}`;
  }

  #shardPath(subject: string): string {
    return `${this.#dir()}/${subject}${SHARD_SUFFIX}`;
  }

  /** Legacy records, keyed by id. Empty when there is no flat file, which is the eventual case. */
  async #legacy(): Promise<Map<string, IntentRecord>> {
    const file = await readJsonFile(
      this.#fs,
      reticleDirPaths(this.#root).intent,
      (raw) => parseIntentFile(raw),
      { version: 1 as const, intents: {} },
    );
    return new Map(Object.values(file.intents).map((i) => [i.id, recordFromIntent(i)] as const));
  }

  async #readShard(subject: string): Promise<IntentShard> {
    return readJsonFile(
      this.#fs,
      this.#shardPath(subject),
      (raw) => IntentShardSchema.parse(raw),
      emptyShard(subject),
    );
  }

  /**
   * Which subjects exist, read from the DIRECTORY rather than the index.
   *
   * The index cannot be the source here. It is derived from the shards, so discovering shards
   * through it is circular — and the circle is not theoretical: a brand-new subject was invisible to
   * the very write that created it, because its shard existed on disk while the index did not
   * mention it yet. Listing the directory also makes the index self-healing: delete it and the next
   * read rebuilds it from what is actually there.
   */
  async #subjectsOnDisk(): Promise<string[]> {
    try {
      const entries = await this.#fs.readdir(this.#dir());
      return entries
        .filter((e) => e.endsWith(SHARD_SUFFIX) && INDEX_FILE !== e)
        .map((e) => e.slice(0, -SHARD_SUFFIX.length));
    } catch {
      // No directory yet — an unmigrated project, which the legacy fold below still answers for.
      return [];
    }
  }

  /**
   * Every record: the shards, plus any legacy intent the shards have not absorbed.
   *
   * Sharded wins on a collision. An id present in both has been migrated and possibly edited since,
   * and letting the flat copy overwrite that would silently revert the edit.
   */
  async #all(): Promise<IntentRecord[]> {
    const shards = await Promise.all((await this.#subjectsOnDisk()).map((s) => this.#readShard(s)));
    const merged = new Map<string, IntentRecord>();
    for (const [id, record] of await this.#legacy()) merged.set(id, record);
    for (const shard of shards) {
      for (const record of Object.values(shard.intents)) merged.set(record.id, record);
    }
    return [...merged.values()];
  }

  /**
   * The cheap read: one line per intent, and the call an agent makes at the start of a session.
   *
   * Includes anything still only in the legacy flat file, so the very first call on an unmigrated
   * project already answers completely — which is what makes the migration invisible rather than a
   * step somebody has to remember to run.
   */
  async index(): Promise<IntentIndex> {
    // Derived from what is on disk, never from the stored copy. The stored index is a cache for
    // readers outside this process; inside it, trusting it would let a stale one hide a real record.
    return indexFrom(shardsFrom(await this.#all()));
  }

  /** Records already in shards, ignoring the legacy file — what migration diffs against. */
  async #storedRecords(): Promise<IntentRecord[]> {
    const shards = await Promise.all((await this.#subjectsOnDisk()).map((s) => this.#readShard(s)));
    return shards.flatMap((s) => Object.values(s.intents));
  }

  /** Every record for one subject — the working read, once an agent knows what it is touching. */
  async subject(name: string): Promise<IntentRecord[]> {
    const all = await this.#all();
    return all.filter((r) => name === r.subject);
  }

  /** One record by id, or null. */
  async get(id: string): Promise<IntentRecord | null> {
    const all = await this.#all();
    return all.find((r) => id === r.id) ?? null;
  }

  /**
   * Write one intent, creating or updating it.
   *
   * Merges onto whatever is already stored, so a caller adding a `why` to a migrated record does not
   * have to restate its binding — and cannot silently drop it by omission, which is the failure mode
   * that makes agents afraid to touch a store.
   */
  async record(input: IntentInput): Promise<IntentRecord> {
    return withFileLock(this.#indexPath(), async () => {
      const existing = await this.get(input.id);
      const now = this.#clock.now();
      const subject =
        input.subject ??
        existing?.subject ??
        subjectFor({ surface: input.surface, binding: input.binding });

      const next: IntentRecord = {
        ...(existing ?? {
          id: input.id,
          statement: input.statement,
          state: 'declared',
          declaredAt: now,
          subject,
          status: IntentStatus.PROPOSED,
        }),
        statement: input.statement,
        subject,
        status: input.status ?? existing?.status ?? IntentStatus.PROPOSED,
        updatedAt: now,
        ...(input.why === undefined ? {} : { why: input.why }),
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.surface === undefined ? {} : { surface: input.surface }),
        ...(input.binding === undefined ? {} : { binding: input.binding }),
      };

      await this.#write(next, existing?.subject);
      return next;
    });
  }

  /** Persist one record, rewriting its shard and the index — and the OLD shard if it moved. */
  async #write(record: IntentRecord, previousSubject?: string): Promise<void> {
    await this.#fs.mkdir(this.#dir());

    if (previousSubject !== undefined && record.subject !== previousSubject) {
      const old = await this.#readShard(previousSubject);
      if (old.intents[record.id] !== undefined) {
        const { [record.id]: _moved, ...rest } = old.intents;
        await this.#fs.writeFile(
          this.#shardPath(previousSubject),
          serialise({ ...old, intents: rest }),
        );
      }
    }

    const shard = await this.#readShard(record.subject);
    shard.intents[record.id] = record;
    await this.#fs.writeFile(this.#shardPath(record.subject), serialise(shard));

    // The index is DERIVED, never edited in place: two sources of truth would disagree, and the one
    // that is cheap to read is the one people would trust.
    const all = await this.#all();
    await this.#fs.writeFile(this.#indexPath(), serialise(indexFrom(shardsFrom(all))));
  }

  /**
   * Fold the flat file into shards on disk, so the move is visible in a diff rather than implicit.
   *
   * Idempotent, and it does not delete `.reticle/intent.json`: an older build still reads it, and a
   * migration that removes its own source cannot be checked afterwards.
   */
  async migrate(): Promise<{ migrated: number; subjects: string[] }> {
    return withFileLock(this.#indexPath(), async () => {
      const legacy = await this.#legacy();
      if (0 === legacy.size) return { migrated: 0, subjects: [] };
      const stored = await this.#storedRecords();
      const known = new Set(stored.map((r) => r.id));
      const incoming = [...legacy.values()].filter((r) => !known.has(r.id));
      if (0 === incoming.length) return { migrated: 0, subjects: [] };

      const shards = shardsFrom([...stored, ...incoming]);
      await this.#fs.mkdir(this.#dir());
      for (const shard of shards) {
        await this.#fs.writeFile(this.#shardPath(shard.subject), serialise(shard));
      }
      await this.#fs.writeFile(this.#indexPath(), serialise(indexFrom(shards)));
      return {
        migrated: incoming.length,
        subjects: [...new Set(incoming.map((r) => r.subject))].sort(),
      };
    });
  }
}
