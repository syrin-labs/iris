/**
 * The filesystem half of a sync cycle: what `.reticle/` looks like to the protocol.
 *
 * Kept apart from `sync-cycle.ts` on purpose. The cycle is the interesting part — what to send, what
 * to skip, what to do when the network is down — and it stays provable only because it never touches
 * a disk. This is the boring part, and boring is what it should be: read a file, tolerate its
 * absence, never throw.
 *
 * EVERY READ IS FORGIVING. A half-written impact.json from a process that died mid-flush must cost
 * one unsynced record, not a crashed sync. There is no state here worth defending against a parse
 * error — the file will be rewritten on the next tool call anyway.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import type { CloudSyncState, PulledIssues, SyncSink, SyncSource } from './sync-cycle.js';
import { subjectFor } from '../intent/intent-subject.js';

const JSON_SUFFIX = '.json';

/** Read + parse, or undefined for absent/unreadable/malformed. Never throws. */
function readJson(path: string): unknown {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write atomically. tmp + rename, because two daemons can serve one repo at once and a half-written
 * cursor file is one the next read discards — which would silently re-pull the whole decision
 * history, or worse, skip it.
 */
function writeJson(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
  } catch {
    // Bookkeeping that cannot be written must never break a sync. The next cycle re-derives it; the
    // worst case is one redundant upload, which the server dedupes anyway.
  }
}

/** Every `*.json` directly inside a directory, parsed. Absent directory reads as empty. */
function readJsonDir(dir: string): unknown[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(JSON_SUFFIX))
      .map((f) => readJson(join(dir, f)))
      .filter((v) => v !== undefined);
  } catch {
    return [];
  }
}

/** Flows live one directory deeper, under the app's own project id. */
function readFlows(root: string): unknown[] {
  const dir = join(root, ReticleDir.FLOWS_SUBDIR);
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((scope) => readJsonDir(join(dir, scope)));
  } catch {
    return [];
  }
}

const DERIVED_FILE = {
  impact: ReticleDir.IMPACT_FILE,
  flake: ReticleDir.FLAKE_FILE,
  intent: ReticleDir.INTENT_FILE,
} as const;

/** The directory the sharded intent store writes into, beside the legacy flat file. */
const INTENT_SUBDIR = 'intent';
const INTENT_INDEX = 'index.json';

/**
 * Every intent this project holds, flat file and shards merged.
 *
 * The store was split into one file per subject so that writing one record stops rewriting all of
 * them. Sync was not told, and kept reading `intent.json` alone — which the migration deliberately
 * does not delete. The result was the worst shape a sync bug can take: not an error, but a corpus
 * that looked healthy on the dashboard and had silently stopped moving, because every intent
 * captured after the migration stayed on the engineer's laptop.
 *
 * Shards WIN on a collision, matching the store's own rule: an id present in both has been migrated
 * and possibly edited since, and letting the flat copy overwrite that would revert the edit on every
 * cycle. `index.json` is derived from the shards and is skipped — sending it would duplicate every
 * record as a summary of itself.
 *
 * Returns undefined when there is no memory at all, so a project with nothing to say sends nothing
 * rather than an empty envelope the server has to store.
 */
function readIntent(reticleRoot: string): unknown {
  const legacy = readJson(join(reticleRoot, ReticleDir.INTENT_FILE));
  const merged: Record<string, unknown> = {
    ...((legacy as { intents?: Record<string, unknown> } | undefined)?.intents ?? {}),
  };
  let shards = 0;
  for (const file of safeReaddir(join(reticleRoot, INTENT_SUBDIR))) {
    if (!file.endsWith(JSON_SUFFIX) || INTENT_INDEX === file) continue;
    const shard = readJson(join(reticleRoot, INTENT_SUBDIR, file)) as
      { intents?: Record<string, unknown> } | undefined;
    // A hand-edited or half-written shard costs one subject, never the whole sync.
    if (shard?.intents === undefined) continue;
    shards++;
    for (const [id, record] of Object.entries(shard.intents)) merged[id] = record;
  }
  if (legacy === undefined && 0 === shards) return undefined;
  /*
   * Stamp the SUBJECT before sending, on anything that does not already carry one.
   *
   * The subject ladder lives here, in the engine, and knows how to read a flow, a route and a
   * binding predicate. The server had no access to it and had reimplemented a far weaker version —
   * flow-or-nothing — so records this ladder files correctly arrived at the dashboard as
   * `unsorted`. Measured on the real corpus: 105 of 163 records the engine can place were landing
   * in the bucket of last resort, which is what made a coverage map read as one pile with six
   * labels.
   *
   * Computed HERE rather than duplicated there, because two rules for one question is how the
   * answers start disagreeing — and the one with the evidence should be the one that decides.
   * Records that already name a subject keep it: an agent's explicit choice outranks inference.
   */
  const placed = Object.fromEntries(
    Object.entries(merged).map(([id, record]) => {
      const held = record as { subject?: unknown; surface?: unknown; binding?: unknown };
      if ('string' === typeof held.subject && held.subject.length > 0) return [id, record];
      const subject = subjectFor({
        surface: held.surface as { route?: string; flow?: string } | undefined,
        binding: held.binding,
      });
      return [id, { ...held, subject }];
    }),
  );
  return { version: 1, intents: placed };
}

/** Directory listing that tolerates absence — an unmigrated project has no `intent/`. */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** What the cycle reads, backed by a real `.reticle` directory. */
export function diskSource(reticleRoot: string): SyncSource {
  return {
    runs: () =>
      readJsonDir(join(reticleRoot, ReticleDir.RUNS_SUBDIR))
        .map((payload) => {
          const id = (payload as { runId?: unknown } | null)?.runId;
          return 'string' === typeof id ? { runId: id, payload } : undefined;
        })
        // A run artifact with no id cannot be diffed against the server's list, so sending it would
        // mean re-sending it every cycle forever. Dropped rather than uploaded repeatedly.
        .filter((r): r is { runId: string; payload: unknown } => r !== undefined),
    flows: () => readFlows(reticleRoot),
    // Intent is the only derived record that is no longer one file. See readIntent.
    derived: (kind) =>
      'intent' === kind ? readIntent(reticleRoot) : readJson(join(reticleRoot, DERIVED_FILE[kind])),
  };
}

/** What the cycle writes back into `.reticle/`. */
export function diskSink(reticleRoot: string): SyncSink {
  return {
    writeIssues: (issues: PulledIssues): void => {
      // MERGED, not replaced. A pull returns only what changed since the cursor, so overwriting
      // would drop every earlier decision the moment one new decision arrived.
      const held = readCloudIssues(reticleRoot);
      writeJson(join(reticleRoot, ReticleDir.ISSUES_FILE), {
        triage: { ...held.triage, ...issues.triage },
      });
    },
    writeState: (state: CloudSyncState): void => {
      writeJson(join(reticleRoot, ReticleDir.CLOUD_STATE_FILE), state);
    },
  };
}

/** This machine's side of the conversation, or a blank one on first run. */
export function readCloudState(reticleRoot: string): CloudSyncState {
  const raw = readJson(join(reticleRoot, ReticleDir.CLOUD_STATE_FILE));
  return 'object' === typeof raw && null !== raw ? raw : {};
}

/** The decisions pulled back from the dashboard, for the HUD and for the next run to read. */
export function readCloudIssues(reticleRoot: string): PulledIssues {
  const raw = readJson(join(reticleRoot, ReticleDir.ISSUES_FILE));
  const triage = 'object' === typeof raw && null !== raw ? (raw as PulledIssues).triage : undefined;
  return { triage: 'object' === typeof triage && null !== triage ? triage : {} };
}
