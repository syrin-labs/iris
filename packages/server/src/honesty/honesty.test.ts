import { describe, expect, it } from 'vitest';
import { HonestyGrade, buildHonestyBlock, meetsHonestyBar } from './honesty.js';

describe('buildHonestyBlock', () => {
  it('composes the five components; a mature clean signal verdict is fully honest', () => {
    const block = buildHonestyBlock({
      grade: HonestyGrade.SIGNAL,
      attribution: 'window',
      envelopeSamples: 5,
      coveragePct: 80,
    });
    expect(block).toEqual({
      grade: 'signal',
      attribution: 'window',
      envelope: { samples: 5, sufficient: true },
      coverage: { pct: 80, partial: false },
      integrity: { clean: true, issues: [] },
    });
  });

  it('marks integrity dirty when capture truncated or a blind spot was hit', () => {
    const block = buildHonestyBlock({
      grade: HonestyGrade.NET,
      truncated: true,
      blindSpots: ['2 cross-origin frames'],
    });
    expect(block.integrity.clean).toBe(false);
    expect(block.integrity.issues).toEqual([
      'capture truncated',
      'blind spot: 2 cross-origin frames',
    ]);
  });

  it('flags an immature envelope as insufficient', () => {
    // `envelope` is optional now — it is omitted when nothing was sampled — so read it defensively.
    expect(
      buildHonestyBlock({ grade: HonestyGrade.NET, envelopeSamples: 2 }).envelope?.sufficient,
    ).toBe(false);
  });
});

describe('meetsHonestyBar', () => {
  const clean = buildHonestyBlock({ grade: HonestyGrade.NET, envelopeSamples: 5 });

  it('passes when the grade meets the minimum and integrity is clean', () => {
    expect(
      meetsHonestyBar(clean, { minGrade: HonestyGrade.NET, requireIntegrityClean: true }).ok,
    ).toBe(true);
  });

  it('fails a presence-only green against a net-minimum bar', () => {
    const presence = buildHonestyBlock({ grade: HonestyGrade.PRESENCE });
    const result = meetsHonestyBar(presence, { minGrade: HonestyGrade.NET });
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain('below required net');
  });

  it('fails a dirty-integrity green when clean integrity is required', () => {
    const dirty = buildHonestyBlock({ grade: HonestyGrade.SIGNAL, truncated: true });
    expect(meetsHonestyBar(dirty, { requireIntegrityClean: true }).ok).toBe(false);
  });
});

describe('coverage note', () => {
  // `partial: true` on its own is an unanswerable flag. The verdict prose says "coverage was
  // PARTIAL — see `coverage` for what went unobserved", and for every non-impeaching blind spot
  // that field held nothing to see: the sentence naming WHAT went unobserved was built by
  // buildCoverageStatement, dropped at both call sites, and never reached the agent. Found by
  // driving a one-way IPC send, where the missing sentence is the whole warning.
  it('carries the sentence that says what went unobserved', () => {
    const block = buildHonestyBlock({
      grade: HonestyGrade.NET,
      coveragePartial: true,
      coverageNote: 'partial — 1 one-way IPC send dispatched with NO verdict',
    });
    expect(block.coverage.partial).toBe(true);
    expect(block.coverage.note).toBe('partial — 1 one-way IPC send dispatched with NO verdict');
  });

  it('omits the note when coverage is full', () => {
    const block = buildHonestyBlock({ grade: HonestyGrade.NET });
    expect(block.coverage.partial).toBe(false);
    expect(block.coverage.note).toBeUndefined();
  });
});
