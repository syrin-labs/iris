import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskSource } from './sync-disk.js';

/**
 * Shared memory has to actually reach the dashboard.
 *
 * `.reticle/intent.json` was split into `.reticle/intent/<subject>.json` shards so a write touches
 * one subject instead of rewriting 141 records. Sync was never told: it kept reading the flat file,
 * which the migration deliberately does not delete. So every intent captured after the migration
 * stayed on the engineer's laptop, and the dashboard showed a frozen corpus that looked healthy.
 *
 * That is the worst shape a sync bug can take — not an error, a plausible answer that stopped
 * moving. These pin the merge that fixes it.
 */

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'reticle-intent-sync-'));
  mkdirSync(join(root, 'intent'), { recursive: true });
  return root;
}

const shard = (root: string, subject: string, ids: string[]): void =>
  writeFileSync(
    join(root, 'intent', `${subject}.json`),
    JSON.stringify({
      version: 1,
      subject,
      intents: Object.fromEntries(
        ids.map((id) => [
          id,
          {
            id,
            statement: `${id} holds`,
            state: 'declared',
            declaredAt: 1,
            subject,
            status: 'proposed',
          },
        ]),
      ),
    }),
  );

const flat = (root: string, ids: string[]): void =>
  writeFileSync(
    join(root, 'intent.json'),
    JSON.stringify({
      version: 1,
      intents: Object.fromEntries(
        ids.map((id) => [id, { id, statement: `${id} holds`, state: 'declared', declaredAt: 1 }]),
      ),
    }),
  );

const idsOf = (value: unknown): string[] =>
  Object.keys((value as { intents?: Record<string, unknown> })?.intents ?? {}).sort();

describe('the intent a sync sends', () => {
  it('includes intents that live only in a shard', () => {
    const root = repo();
    try {
      shard(root, 'checkout', ['inline:pay']);
      expect(idsOf(diskSource(root).derived('intent'))).toEqual(['inline:pay']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** The migration does not delete the flat file, and an older build still writes it. */
  it('merges the legacy flat file with the shards', () => {
    const root = repo();
    try {
      flat(root, ['old:one']);
      shard(root, 'checkout', ['new:two']);
      expect(idsOf(diskSource(root).derived('intent'))).toEqual(['new:two', 'old:one']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * An id in both has been migrated and possibly edited since. Letting the flat copy win would
   * silently revert that edit on every sync — the sharded copy is the live one.
   */
  it('prefers the sharded copy when an id is in both', () => {
    const root = repo();
    try {
      flat(root, ['dup']);
      shard(root, 'checkout', ['dup']);
      const sent = diskSource(root).derived('intent') as {
        intents: Record<string, { subject?: string }>;
      };
      expect(sent.intents['dup']?.subject).toBe('checkout');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is undefined when there is no memory at all, so nothing is sent', () => {
    const root = mkdtempSync(join(tmpdir(), 'reticle-intent-empty-'));
    try {
      expect(diskSource(root).derived('intent')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** One hand-edited shard must cost one subject, never the whole sync. */
  it('skips a malformed shard rather than sending nothing', () => {
    const root = repo();
    try {
      writeFileSync(join(root, 'intent', 'broken.json'), '{ not json');
      shard(root, 'checkout', ['inline:pay']);
      expect(idsOf(diskSource(root).derived('intent'))).toEqual(['inline:pay']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The subject travels WITH the record.
 *
 * The ladder that can read a flow, a route or a binding predicate lives in the engine. The server
 * had no access to it and had reimplemented a far weaker version — flow-or-nothing — so records the
 * engine files correctly arrived at the dashboard as `unsorted`. Measured on the real corpus: 105
 * of 163 placeable records were landing in the bucket of last resort, which is what made a coverage
 * map read as one pile with six labels.
 */
describe('the subject a sync sends', () => {
  const sent = (root: string): Record<string, { subject?: string }> =>
    (diskSource(root).derived('intent') as { intents: Record<string, { subject?: string }> })
      .intents;

  it('derives a subject from the route when the record has no explicit one', () => {
    const root = repo();
    try {
      writeFileSync(
        join(root, 'intent.json'),
        JSON.stringify({
          version: 1,
          intents: {
            'i:1': {
              id: 'i:1',
              statement: 's',
              state: 'declared',
              declaredAt: 1,
              surface: { route: '/billing' },
            },
          },
        }),
      );
      expect(sent(root)['i:1']?.subject).toBe('billing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** The commonest legacy shape: no surface at all, but a predicate that names an API path. */
  it('derives a subject from a binding predicate', () => {
    const root = repo();
    try {
      writeFileSync(
        join(root, 'intent.json'),
        JSON.stringify({
          version: 1,
          intents: {
            'i:1': {
              id: 'i:1',
              statement: 's',
              state: 'declared',
              declaredAt: 1,
              binding: { kind: 'net', urlContains: '/v1/members' },
            },
          },
        }),
      );
      expect(sent(root)['i:1']?.subject).toBe('members');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** An agent that named its own subject outranks anything inferred from evidence. */
  it('never overwrites a subject the record already carries', () => {
    const root = repo();
    try {
      shard(root, 'checkout', ['inline:pay']);
      expect(sent(root)['inline:pay']?.subject).toBe('checkout');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
