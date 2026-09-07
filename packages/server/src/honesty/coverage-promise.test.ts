import { describe, expect, it } from 'vitest';
import { Verified } from '@reticlehq/core';
import { HonestyGrade, buildHonestyBlock, honestyForVerdict } from './honesty.js';

/**
 * The contract, pinned as a contract rather than as an implementation.
 *
 * `decideVerified`'s YES branch says "coverage was PARTIAL — see `coverage` for what went
 * unobserved". For every non-impeaching blind spot that sentence pointed at an empty field, because
 * both call sites built the coverage statement and dropped its note. A one-way IPC send graded
 * `verified: yes` and the sentence explaining that its outcome was unknowable never left the process.
 *
 * So: wherever a verdict directs the reader to `coverage`, the note is there. That is the invariant —
 * not "the builder can carry a note", which was already true while the bug was live.
 */
describe('a verdict that points at coverage always has something there', () => {
  const partial = (): ReturnType<typeof buildHonestyBlock> =>
    buildHonestyBlock({
      grade: HonestyGrade.NET,
      coveragePartial: true,
      coverageNote: 'partial — 1 one-way IPC send dispatched with NO verdict',
    });

  it('keeps the note on YES, which is the verdict that promises it', () => {
    expect(honestyForVerdict(Verified.YES, partial()).coverage.note).toBeDefined();
  });

  it('keeps it on UNKNOWN, where what went unseen IS the answer', () => {
    expect(honestyForVerdict(Verified.UNKNOWN, partial()).coverage.note).toBeDefined();
  });

  // Dropped only here: nothing in a NO directs the reader to `coverage`, and the concrete
  // counter-example is what the agent acts on. `partial` still travels, so the caveat is not lost.
  it('drops it on NO, and keeps the partial flag', () => {
    const trimmed = honestyForVerdict(Verified.NO, partial());
    expect(trimmed.coverage.note).toBeUndefined();
    expect(trimmed.coverage.partial).toBe(true);
  });

  it('leaves a full-coverage block untouched whatever the verdict', () => {
    const full = buildHonestyBlock({ grade: HonestyGrade.NET });
    for (const v of [Verified.YES, Verified.NO, Verified.UNKNOWN]) {
      expect(honestyForVerdict(v, full)).toEqual(full);
    }
  });
});
