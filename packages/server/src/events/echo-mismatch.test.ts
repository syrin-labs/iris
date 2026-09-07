import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findEchoMismatches } from './echo-mismatch.js';

let seq = 0;
const write = (requestBody: unknown, responseBody: unknown, ok = true): ReticleEvent =>
  ({
    type: EventType.NET_REQUEST,
    t: ++seq,
    data: {
      id: `n${String(seq)}`,
      method: 'POST',
      url: '/api/prefs',
      status: 200,
      ok,
      requestBody: JSON.stringify(requestBody),
      responseBody: JSON.stringify(responseBody),
    },
  }) as unknown as ReticleEvent;

const kinds = (e: ReticleEvent): string[] => findEchoMismatches([e]).map((c) => c.kind);

describe('findEchoMismatches — a write that half-applied', () => {
  /**
   * The archetype, measured on a desktop preferences write: asked for `locale: fr`, the server
   * echoed `locale: en`, the UI said "Preferences saved". Status 2xx, no failure in the body, UI
   * advanced, page settled — every channel except the payload agrees the save worked.
   */
  it('catches a field the server echoed back with a different value', () => {
    const found = findEchoMismatches([
      write(
        { density: 'compact', locale: 'fr' },
        { ok: true, saved: { density: 'compact', locale: 'en' } },
      ),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe(ContradictionKind.WRITE_FIELD_IGNORED);
    expect(found[0]?.counter).toContain('locale');
    // The field that WAS applied must not be named — a finding that lists healthy fields is noise.
    expect(found[0]?.counter).not.toContain('density');
  });

  it('finds the echo however deeply the envelope nests it', () => {
    expect(
      kinds(write({ locale: 'fr' }, { data: { result: { attributes: { locale: 'en' } } } })),
    ).toContain(ContradictionKind.WRITE_FIELD_IGNORED);
  });

  // ── The false-positive suite. These decide whether the kind is worth reading at all. ───────────
  //
  // A contradiction that fires on healthy APIs gets filtered out by the agents reading it, and takes
  // its true positives with it. Every case below is something ordinary servers do to a value they
  // echo, and none of them is a dropped write.

  it('stays silent when the write was applied exactly', () => {
    expect(kinds(write({ locale: 'fr' }, { ok: true, saved: { locale: 'fr' } }))).toEqual([]);
  });

  it('stays silent on case and whitespace normalisation', () => {
    expect(kinds(write({ email: '  Ada@Example.COM ' }, { email: 'ada@example.com' }))).toEqual([]);
  });

  it('stays silent when a number is echoed in another numeric form', () => {
    expect(kinds(write({ qty: 1.0, price: 20 }, { qty: 1, price: 20.0 }))).toEqual([]);
  });

  it('stays silent when the server does not echo the field at all', () => {
    // Silence is not disagreement — with no echo there is no evidence either way.
    expect(kinds(write({ locale: 'fr' }, { ok: true, id: 7 }))).toEqual([]);
  });

  it('stays silent when the response carries both the old and the new value', () => {
    expect(
      kinds(write({ locale: 'fr' }, { previous: { locale: 'en' }, current: { locale: 'fr' } })),
    ).toEqual([]);
  });

  it('ignores non-scalar fields rather than diffing structures', () => {
    // Deep structural diffing is where the false positives live; arrays reorder and objects grow.
    expect(kinds(write({ tags: ['a', 'b'] }, { tags: ['b', 'a'] }))).toEqual([]);
  });

  it('says nothing about a write that already failed', () => {
    // A failed write is a different and louder finding; reporting both would double-count it.
    const failed = {
      type: EventType.NET_REQUEST,
      t: ++seq,
      data: {
        id: 'n-failed',
        method: 'POST',
        url: '/api/prefs',
        status: 500,
        ok: false,
        requestBody: JSON.stringify({ locale: 'fr' }),
        responseBody: JSON.stringify({ locale: 'en' }),
      },
    } as unknown as ReticleEvent;
    expect(kinds(failed)).toEqual([]);
  });

  it('says nothing when bodies were not captured', () => {
    const noBodies = {
      type: EventType.NET_REQUEST,
      t: ++seq,
      data: { id: 'n-nobody', method: 'POST', url: '/api/prefs', status: 200, ok: true },
    } as unknown as ReticleEvent;
    expect(kinds(noBodies)).toEqual([]);
  });
});

describe('findEchoMismatches — the request has to be a write', () => {
  const lookup = (method: string, requestBody: unknown, responseBody: unknown): ReticleEvent =>
    ({
      type: EventType.NET_REQUEST,
      t: ++seq,
      data: {
        id: `n${String(seq)}`,
        method,
        url: '/get-branding',
        status: 200,
        ok: true,
        requestBody: JSON.stringify(requestBody),
        responseBody: JSON.stringify(responseBody),
      },
    }) as unknown as ReticleEvent;

  /**
   * Reported from the field: a lookup that sends its key in the body and gets a record back was
   * graded as a half-applied write. The check gated on the RESPONSE being a success and never on the
   * REQUEST being a write, so any successful call with a body was read as a save — and the same key
   * name legitimately means different things on the two sides of a request/response pair.
   */
  it('says nothing about a read, however much its response disagrees with its body', () => {
    expect(
      findEchoMismatches([lookup('GET', { workspace_id: '408523123' }, { workspace_id: 23 })]),
    ).toEqual([]);
  });

  it('still grades a real write on the same shape', () => {
    expect(findEchoMismatches([lookup('PATCH', { locale: 'fr' }, { locale: 'en' })])).toHaveLength(
      1,
    );
  });

  /**
   * A finding about a request that had already completed before the agent acted reads as a verdict
   * on the change it just made. Naming the attribution is what separates "your edit broke this" from
   * "this endpoint was already doing that".
   */
  it('says so when the request predates the action being verified', () => {
    const before = lookup('POST', { locale: 'fr' }, { locale: 'en' });
    const [found] = findEchoMismatches([before], before.t + 1);
    expect(found?.detail).toContain('before the action');
  });

  it('says nothing about attribution when no action opened the window', () => {
    const call = lookup('POST', { locale: 'fr' }, { locale: 'en' });
    const [found] = findEchoMismatches([call]);
    expect(found?.detail).not.toContain('before the action');
  });
});

describe('findEchoMismatches — the response has to look like an echo', () => {
  /**
   * Reported from the field: a command bus POSTed `{command:"chat.send", ...}` and the server
   * answered with the current viewer snapshot. The chat message arrived over the socket and
   * rendered. `write-field-ignored` fired because the snapshot happened to carry `id` under a
   * different meaning. A snapshot that shares a key name is not an echo of the write.
   */
  it('stays silent when a command bus is answered with a viewer snapshot', () => {
    expect(
      kinds(
        write(
          { command: 'chat.send', id: 'msg-1', text: 'hello' },
          {
            id: 'user-1',
            email: 'ada@example.com',
            name: 'Ada',
            unread: 3,
            plan: 'pro',
            status: 'ok',
          },
        ),
      ),
    ).toEqual([]);
  });

  it('stays silent when the only overlap is one coincidental key on a fat snapshot', () => {
    expect(
      kinds(
        write(
          { title: 'Hello' },
          {
            id: 'user-1',
            title: 'Dashboard',
            email: 'ada@example.com',
            name: 'Ada',
            unread: 3,
            plan: 'pro',
            locale: 'en',
            timezone: 'utc',
          },
        ),
      ),
    ).toEqual([]);
  });

  it('still catches a nested echo of a real write', () => {
    expect(
      kinds(
        write(
          { density: 'compact', locale: 'fr' },
          { ok: true, saved: { density: 'compact', locale: 'en' } },
        ),
      ),
    ).toContain(ContradictionKind.WRITE_FIELD_IGNORED);
  });

  it('still catches a write that echoes only the field that was dropped', () => {
    expect(
      kinds(write({ density: 'compact', locale: 'fr' }, { ok: true, saved: { locale: 'en' } })),
    ).toContain(ContradictionKind.WRITE_FIELD_IGNORED);
  });

  it('still catches a command-shaped write whose response restates the command', () => {
    expect(
      kinds(
        write({ command: 'prefs.save', locale: 'fr' }, { command: 'prefs.save', locale: 'en' }),
      ),
    ).toContain(ContradictionKind.WRITE_FIELD_IGNORED);
  });
  /**
   * The four cases main's own version of this guard was pinned by, kept verbatim so the rule that
   * replaces it has to satisfy both. A guard swapped for a differently-shaped one is only an
   * improvement if it still holds everything the old one held.
   */
  it('stays silent when the response shares none of the request keys', () => {
    expect(
      kinds(
        write(
          { command: 'chat.send', text: 'hello there' },
          { viewer: { id: 'u1', name: 'Ada' }, rooms: [{ id: 'r1', title: 'general' }] },
        ),
      ),
    ).toEqual([]);
  });

  it('stays silent when only half the request keys reappear, under other names for their values', () => {
    // One incidental "text" on an unrelated snapshot field must not read as the echo of the
    // message's text while the operation discriminator is nowhere in the response.
    expect(
      kinds(write({ command: 'chat.send', text: 'hello' }, { text: 'draft autosave', ok: true })),
    ).toEqual([]);
  });

  it('still grades an envelope restating most of what was sent', () => {
    expect(
      kinds(
        write(
          { density: 'compact', locale: 'fr', theme: 'dark' },
          { ok: true, saved: { density: 'compact', locale: 'en', theme: 'dark' } },
        ),
      ),
    ).toContain(ContradictionKind.WRITE_FIELD_IGNORED);
  });

  it('still grades a one-key write whose single key comes back different', () => {
    expect(kinds(write({ qty: 5 }, { ok: true, saved: { qty: 3 } }))).toContain(
      ContradictionKind.WRITE_FIELD_IGNORED,
    );
  });
});

/**
 * #670 — the hunter fired on ordinary, correct API behaviour, and the copy claimed a data-integrity
 * bug that did not exist. Three reported shapes: a create that sends `0` for "you assign the id",
 * two id spaces that share a field name, and a suffix that is not the same key.
 */
describe('findEchoMismatches — sentinels and identity keys are not ignored writes', () => {
  it('stays silent when the request sent 0, the usual create-at-root sentinel', () => {
    // POST .../add-sub-category with `sub_category_id: 0` meaning "create"; the response returns the
    // primary key of the row just made. That is not a field the caller asked to persist.
    expect(
      kinds(
        write(
          { sub_category_id: 0, name: 'Books' },
          { ok: true, saved: { sub_category_id: 19314, name: 'Books' } },
        ),
      ),
    ).toEqual([]);
  });

  it('stays silent when the only requested field was an empty string', () => {
    expect(kinds(write({ nickname: '' }, { ok: true, saved: { nickname: 'guest' } }))).toEqual([]);
  });

  it('stays silent when the only overlap is an identity key in two id spaces', () => {
    // The client sends a public workspace id; the server returns its internal row id. Same key
    // name, never expected to match, and treating it as a dropped write poisons every later assert.
    expect(
      kinds(write({ workspace_id: '408523123' }, { ok: true, saved: { workspace_id: 23 } })),
    ).toEqual([]);
  });

  it('does not pair url_workspace_id with workspace_id — exact key, not a suffix', () => {
    expect(
      kinds(
        write(
          { url_workspace_id: '408523123' },
          { ok: true, saved: { workspace_id: 23, name: 'Acme' } },
        ),
      ),
    ).toEqual([]);
  });

  it('still catches a non-identity field that came back different', () => {
    expect(
      kinds(
        write(
          { workspace_id: 7, locale: 'fr' },
          { ok: true, saved: { workspace_id: 7, locale: 'en' } },
        ),
      ),
    ).toContain(ContradictionKind.WRITE_FIELD_IGNORED);
  });

  it('names a different echo, not a half-applied write the UI cannot know about', () => {
    const [found] = findEchoMismatches([
      write({ locale: 'fr' }, { ok: true, saved: { locale: 'en' } }),
    ]);
    expect(found?.detail).toContain('returned a different value than it was asked to set');
    expect(found?.detail).not.toContain('half-applied');
    expect(found?.detail).not.toContain('no way to know');
  });
});
