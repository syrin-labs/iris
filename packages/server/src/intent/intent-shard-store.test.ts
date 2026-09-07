/**
 * The store an agent actually uses: what each read costs, and what a write is allowed to touch.
 *
 * Built against a real corpus — 141 intents, 109KB, one object — where reading anything meant
 * reading everything and changing one meant rewriting all of them.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem } from '../project/fs-port.js';
import { IntentShardStore } from './intent-shard-store.js';
import { IntentStatus } from './intent-shard.js';

const fs = createNodeFileSystem();
const clock = { now: () => 1_700_000_000_000 };

let root: string;
/** The `.reticle` directory itself — what every store in this package is rooted at. */
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reticle-intent-'));
  dir = join(root, '.reticle');
});

const store = (): IntentShardStore => new IntentShardStore(fs, dir, clock);

/** Write a legacy flat file, the shape every existing project has on disk today. */
const seedLegacy = async (intents: Record<string, unknown>): Promise<void> => {
  await fs.mkdir(dir);
  await fs.writeFile(join(dir, 'intent.json'), JSON.stringify({ version: 1, intents }));
};

const legacyIntent = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  statement: `statement for ${id}`,
  state: 'bound',
  declaredAt: 1,
  binding: { kind: 'net', urlContains: '/v1/auth/signin', status: 200 },
  ...over,
});

describe('an existing project works before anything migrates it', () => {
  it('answers the index from the flat file alone', async () => {
    // The migration has to be invisible: an agent on the new store must see old intents on its very
    // first call, or the store is empty exactly when somebody is deciding whether to trust it.
    await seedLegacy({ a: legacyIntent('a'), b: legacyIntent('b') });
    const index = await store().index();
    expect(index.entries.map((e) => e.id).sort()).toEqual(['a', 'b']);
    expect(index.entries[0]?.subject).toBe('auth');
  });

  it('reads one record by id without a shard existing yet', async () => {
    await seedLegacy({ a: legacyIntent('a') });
    expect((await store().get('a'))?.statement).toBe('statement for a');
  });
});

describe('migrating', () => {
  it('writes a shard per subject and an index over them', async () => {
    await seedLegacy({
      a: legacyIntent('a'),
      b: legacyIntent('b', { binding: { kind: 'route', pathname: '/issues' } }),
    });
    const result = await store().migrate();
    expect(result.migrated).toBe(2);
    expect(result.subjects).toEqual(['auth', 'issues']);
    expect(await fs.exists(join(dir, 'intent', 'auth.json'))).toBe(true);
    expect(await fs.exists(join(dir, 'intent', 'index.json'))).toBe(true);
  });

  it('does NOT delete the flat file', async () => {
    // An older build still reads it, and a migration that removes its own source cannot be checked.
    await seedLegacy({ a: legacyIntent('a') });
    await store().migrate();
    expect(await fs.exists(join(dir, 'intent.json'))).toBe(true);
  });

  it('is idempotent — running it twice migrates nothing the second time', async () => {
    await seedLegacy({ a: legacyIntent('a') });
    await store().migrate();
    expect((await store().migrate()).migrated).toBe(0);
  });

  it('never lets the flat copy revert an edit made after migrating', async () => {
    await seedLegacy({ a: legacyIntent('a') });
    await store().migrate();
    await store().record({ id: 'a', statement: 'edited since', why: 'the customer asked' });
    // The legacy file still holds the ORIGINAL statement. Sharded must win.
    const got = await store().get('a');
    expect(got?.statement).toBe('edited since');
    expect(got?.why).toBe('the customer asked');
  });
});

describe('writing', () => {
  it('captures the fields the flat file had nowhere to put', async () => {
    await store().record({
      id: 'checkout-tax',
      statement: 'Tax is recalculated when the delivery country changes',
      subject: 'checkout',
      why: 'A customer was charged the wrong tax and we refunded it manually',
      source: 'support ticket 4821',
      status: IntentStatus.AGREED,
    });
    const got = await store().get('checkout-tax');
    expect(got?.why).toBe('A customer was charged the wrong tax and we refunded it manually');
    expect(got?.source).toBe('support ticket 4821');
    expect(got?.status).toBe(IntentStatus.AGREED);
  });

  it('merges rather than replaces, so adding a why cannot drop a binding', async () => {
    // The failure mode that makes agents afraid to touch a store: an update that silently loses the
    // fields it did not mention.
    await store().record({
      id: 'x',
      statement: 'original',
      binding: { kind: 'route', pathname: '/issues' },
    });
    await store().record({ id: 'x', statement: 'original', why: 'added later' });
    const got = await store().get('x');
    expect(got?.binding).toEqual({ kind: 'route', pathname: '/issues' });
    expect(got?.why).toBe('added later');
  });

  it('touches only the subject it belongs to', async () => {
    await store().record({ id: 'a', statement: 'a', subject: 'auth' });
    await store().record({ id: 'b', statement: 'b', subject: 'checkout' });
    const authBefore = await fs.readFile(join(dir, 'intent', 'auth.json'));
    await store().record({ id: 'b', statement: 'b changed', subject: 'checkout' });
    // Editing checkout left auth byte-identical: that is what makes two sessions on two subjects safe.
    expect(await fs.readFile(join(dir, 'intent', 'auth.json'))).toBe(authBefore);
  });

  it('moves a record cleanly when its subject changes, leaving no copy behind', async () => {
    await store().record({ id: 'm', statement: 'm', subject: 'auth' });
    await store().record({ id: 'm', statement: 'm', subject: 'billing' });
    expect((await store().subject('auth')).map((r) => r.id)).toEqual([]);
    expect((await store().subject('billing')).map((r) => r.id)).toEqual(['m']);
    // And the index agrees — it is derived, so it cannot drift from the shards.
    const index = await store().index();
    expect(index.entries.filter((e) => 'm' === e.id)).toHaveLength(1);
  });
});

describe('reading by subject', () => {
  it('returns only that subject', async () => {
    await seedLegacy({
      a: legacyIntent('a'),
      b: legacyIntent('b', { binding: { kind: 'route', pathname: '/issues' } }),
    });
    await store().migrate();
    expect((await store().subject('issues')).map((r) => r.id)).toEqual(['b']);
  });
});
