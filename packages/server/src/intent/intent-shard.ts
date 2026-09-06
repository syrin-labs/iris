/**
 * The sharded intent store: one small file per subject, plus an index cheap enough to always load.
 *
 * ## Why this exists
 *
 * `.reticle/intent.json` was a single object that reached 141 entries and 109KB. Parsing that is
 * nothing; READING it is the cost, and reading is what this store is for. An agent wanting the two
 * rules about checkout pulled 139 irrelevant ones through its context to find them, and an agent
 * changing one rewrote the whole file — which is both slow to review and a lost write whenever two
 * sessions touch different subjects at once.
 *
 * ## The shape
 *
 *   .reticle/intent/index.json     every id, its subject and one line of prose
 *   .reticle/intent/<subject>.json the full records for that subject
 *
 * The index is the whole point: it answers "what do we know, and where does it live?" without
 * opening anything, and detail is then fetched for the one subject in play. Measured on the real
 * corpus, that is 109KB all-or-nothing becoming an index plus one shard — and the largest shard is
 * under 10KB once the unsorted bucket is set aside.
 *
 * The index is NOT tiny, and measuring beat guessing twice over. With full statements it came to
 * 36KB for 141 entries; summarising them saved 7%, because the bulk is not the prose but the ids —
 * `inline:signing-in-with-the-email-password-created-earli-6ca804e9` is 63 characters before the
 * statement starts. So the honest numbers are: 109KB all-or-nothing becomes a 33KB index plus one
 * ~10KB shard, and the real win is that a READ and a WRITE are both bounded to one subject rather
 * than the whole corpus.
 *
 * The index is therefore the part that does not scale forever. At ten times this size it needs a
 * second tier — subjects and counts, with ids fetched per subject — rather than a longer single
 * read. Recorded here because the next person will hit it, and the shape of the fix is already
 * visible.
 *
 * ## What the records carry that the old ones did not
 *
 * The legacy file was written BY verification, AT verification time, in verification's vocabulary: a
 * statement, a predicate, and whether a verdict discharged it. Of 141 entries, four named a surface.
 * There was nowhere to put the reason a thing must be true, who decided it, or when — so the
 * business case somebody states once and then forgets had no home and was never captured.
 *
 * `why`, `source` and `subject` are that home. They are optional because a migrated record cannot
 * invent them, and a store that rejected incomplete records would simply not be written to.
 */
import { z } from 'zod';
import { IntentSchema, type Intent } from '@reticlehq/core';
import type { FileSystemPort } from '../project/fs-port.js';
import { subjectFor, UNSORTED_SUBJECT } from './intent-subject.js';

const INTENT_SHARD_VERSION = 1;

/** Byte-stable writes: an unchanged shard produces no diff, so the ones that DID change stand out. */
const JSON_INDENT = 2;

/**
 * How settled a record is.
 *
 * Separate from the legacy `state`, which only ever described the VERIFICATION lifecycle
 * (declared → bound → proved). A rule can be agreed with the customer months before anything can
 * prove it, and collapsing those two axes is what made the old file an assertion log rather than a
 * memory.
 */
export const IntentStatus = {
  /** Captured, not yet confirmed by anyone. What an agent writes while building. */
  PROPOSED: 'proposed',
  /** Confirmed as something that must hold. May have no way to prove it yet. */
  AGREED: 'agreed',
  /** A verdict has actually shown it holds. */
  PROVED: 'proved',
  /** Believed out of date — kept, because deleting the record loses the fact it was ever true. */
  STALE: 'stale',
} as const;
export type IntentStatus = (typeof IntentStatus)[keyof typeof IntentStatus];

const IntentRecordSchema = IntentSchema.extend({
  /** Which shard this lives in. Stored as well as implied, so a file read alone is self-describing. */
  subject: z.string().min(1),
  status: z.enum([
    IntentStatus.PROPOSED,
    IntentStatus.AGREED,
    IntentStatus.PROVED,
    IntentStatus.STALE,
  ]),
  /** WHY it must be true. The half the old file had no room for. */
  why: z.string().optional(),
  /** Where it came from — "the user, in conversation" beats an anonymous assertion in six months. */
  source: z.string().optional(),
  /** When it was last touched, so a stale-looking record can be told from an untouched one. */
  updatedAt: z.number().optional(),
});
export type IntentRecord = z.infer<typeof IntentRecordSchema>;

export const IntentShardSchema = z.object({
  version: z.literal(INTENT_SHARD_VERSION),
  subject: z.string().min(1),
  intents: z.record(z.string(), IntentRecordSchema),
});
export type IntentShard = z.infer<typeof IntentShardSchema>;

/**
 * How much of a statement the index carries.
 *
 * The index exists to answer WHICH SHARD, and a clause is enough to decide that; the sentence is one
 * file away. Ellipsis included so a truncated line is never mistaken for the whole intent.
 *
 * Worth 7% on the real corpus rather than the large saving expected — the ids dominate — but it also
 * bounds the damage a future 500-character statement can do to a file meant to be read every
 * session, which is the reason to keep it.
 */
const SUMMARY_MAX = 72;

export const summarise = (statement: string): string =>
  statement.length <= SUMMARY_MAX ? statement : `${statement.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;

/** One line per intent: enough to decide whether to open the shard, and no more. */
const IntentIndexEntrySchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  statement: z.string().min(1),
  status: z.enum([
    IntentStatus.PROPOSED,
    IntentStatus.AGREED,
    IntentStatus.PROVED,
    IntentStatus.STALE,
  ]),
});
export type IntentIndexEntry = z.infer<typeof IntentIndexEntrySchema>;

export const IntentIndexSchema = z.object({
  version: z.literal(INTENT_SHARD_VERSION),
  entries: z.array(IntentIndexEntrySchema),
});
export type IntentIndex = z.infer<typeof IntentIndexSchema>;

export const emptyShard = (subject: string): IntentShard => ({
  version: INTENT_SHARD_VERSION,
  subject,
  intents: {},
});

export const emptyIndex = (): IntentIndex => ({ version: INTENT_SHARD_VERSION, entries: [] });

/** The verification lifecycle a legacy record carried, mapped onto the settledness axis. */
export const statusFromState = (state: Intent['state']): IntentStatus =>
  'proved' === state ? IntentStatus.PROVED : IntentStatus.AGREED;

/**
 * Turn a legacy intent into a record, inferring only what can be inferred.
 *
 * `why` and `source` are left ABSENT rather than filled with the statement or a placeholder. A
 * record that claims to carry a reason it does not have is worse than one that admits the gap: the
 * gap is a prompt to write the reason down, and a placeholder is a reason to stop looking.
 */
export const recordFromIntent = (intent: Intent): IntentRecord => ({
  ...intent,
  subject: subjectFor({ surface: intent.surface, binding: intent.binding }),
  status: statusFromState(intent.state),
});

/** Build the index from the shards. Derived, never hand-maintained — two sources would disagree. */
export const indexFrom = (shards: readonly IntentShard[]): IntentIndex => ({
  version: INTENT_SHARD_VERSION,
  entries: shards
    .flatMap((s) => Object.values(s.intents))
    .map((r) => ({
      id: r.id,
      subject: r.subject,
      statement: summarise(r.statement),
      status: r.status,
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject) || a.id.localeCompare(b.id)),
});

/** Group records into shards by their own subject. */
export const shardsFrom = (records: readonly IntentRecord[]): IntentShard[] => {
  const bySubject = new Map<string, IntentShard>();
  for (const r of records) {
    const subject = '' === r.subject ? UNSORTED_SUBJECT : r.subject;
    const shard = bySubject.get(subject) ?? emptyShard(subject);
    shard.intents[r.id] = r;
    bySubject.set(subject, shard);
  }
  return [...bySubject.values()].sort((a, b) => a.subject.localeCompare(b.subject));
};

/** Serialise byte-stably, with keys sorted so a re-save of unchanged data is a no-op diff. */
export const serialise = (value: unknown): string =>
  `${JSON.stringify(value, (_k, v: unknown) => sortKeys(v), JSON_INDENT)}\n`;

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value) || null === value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
  );
};

/** Read + validate one JSON file, failing soft: a hand-merged file with a conflict marker is real. */
export const readJsonFile = async <T>(
  fs: FileSystemPort,
  path: string,
  parse: (raw: unknown) => T,
  fallback: T,
): Promise<T> => {
  try {
    return parse(JSON.parse(await fs.readFile(path)) as unknown);
  } catch {
    return fallback;
  }
};
