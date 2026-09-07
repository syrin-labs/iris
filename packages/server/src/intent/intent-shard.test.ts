/**
 * The sharded model: what makes it cheap to read, and what it refuses to invent.
 */
import { describe, expect, it } from 'vitest';
import type { Intent } from '@reticlehq/core';
import {
  indexFrom,
  IntentStatus,
  recordFromIntent,
  serialise,
  shardsFrom,
  statusFromState,
} from './intent-shard.js';

const legacy = (over: Partial<Intent> = {}): Intent => ({
  id: 'inline:example-1',
  statement: 'Signing in lands on the dashboard with a working session',
  state: 'bound',
  declaredAt: 1,
  binding: { kind: 'net', urlContains: '/v1/auth/signin', status: 200 },
  ...over,
});

describe('migrating a legacy intent', () => {
  it('derives a subject from the evidence it already carries', () => {
    expect(recordFromIntent(legacy()).subject).toBe('auth');
  });

  it('keeps every legacy field — a migration that drops data is a migration nobody trusts', () => {
    const r = recordFromIntent(legacy({ provenBy: { verdictId: 'v1', grade: 'net', at: 9 } }));
    expect(r.statement).toBe(legacy().statement);
    expect(r.binding).toEqual(legacy().binding);
    expect(r.provenBy).toEqual({ verdictId: 'v1', grade: 'net', at: 9 });
    expect(r.declaredAt).toBe(1);
  });

  it('leaves why and source ABSENT rather than inventing them', () => {
    /*
     * A record claiming a reason it does not have is worse than one admitting the gap: the gap is a
     * prompt to write the reason down, a placeholder is a reason to stop looking.
     */
    const r = recordFromIntent(legacy());
    expect(r.why).toBeUndefined();
    expect(r.source).toBeUndefined();
  });

  it('maps the verification lifecycle onto settledness without conflating them', () => {
    expect(statusFromState('proved')).toBe(IntentStatus.PROVED);
    // Declared and bound both mean "we agree this must hold, nothing has shown it yet".
    expect(statusFromState('declared')).toBe(IntentStatus.AGREED);
    expect(statusFromState('bound')).toBe(IntentStatus.AGREED);
  });
});

describe('sharding and the index', () => {
  const records = [
    recordFromIntent(legacy({ id: 'a' })),
    recordFromIntent(legacy({ id: 'b', binding: { kind: 'route', pathname: '/issues' } })),
    recordFromIntent(legacy({ id: 'c', binding: { kind: 'route', pathname: '/issues' } })),
  ];

  it('groups by subject so one subject is one small file', () => {
    const shards = shardsFrom(records);
    expect(shards.map((s) => s.subject)).toEqual(['auth', 'issues']);
    expect(Object.keys(shards[1]?.intents ?? {})).toEqual(['b', 'c']);
  });

  it('builds an index carrying one line each — enough to choose, not enough to cost', () => {
    const index = indexFrom(shardsFrom(records));
    expect(index.entries).toHaveLength(3);
    // Exactly four fields: anything more and the index stops being cheap to always load.
    expect(Object.keys(index.entries[0] ?? {}).sort()).toEqual([
      'id',
      'statement',
      'status',
      'subject',
    ]);
  });

  it('truncates the statement — the index chooses a shard, it does not read the intent', () => {
    // Full sentences made this 36KB for 141 entries, a third of the file it replaces. The whole
    // point is a read cheap enough to take every session.
    const long = 'x'.repeat(200);
    const index = indexFrom(
      shardsFrom([recordFromIntent(legacy({ id: 'long', statement: long }))]),
    );
    const entry = index.entries[0];
    expect(entry?.statement.length).toBeLessThan(80);
    expect(entry?.statement.endsWith('…')).toBe(true);
  });

  it('leaves a short statement exactly as written', () => {
    const index = indexFrom(
      shardsFrom([recordFromIntent(legacy({ id: 's', statement: 'short one' }))]),
    );
    expect(index.entries[0]?.statement).toBe('short one');
  });

  it('orders the index so its diff is readable', () => {
    const index = indexFrom(shardsFrom(records));
    expect(index.entries.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('writes are byte-stable', () => {
  it('serialises identical data identically, whatever order it was built in', () => {
    // A store that churns on every run is one whose diffs nobody reads — which is how the flows in
    // this repo rotted unnoticed.
    const a = serialise({ b: 1, a: { d: 2, c: 3 } });
    const b = serialise({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it('ends with exactly one newline', () => {
    expect(serialise({ a: 1 }).endsWith('}\n')).toBe(true);
  });
});
