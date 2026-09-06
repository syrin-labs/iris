/**
 * #673: an app that polls could not produce a verdict at all.
 *
 * A camera scan loop POSTing `/api/people/match` until it acquires a lock had every
 * `reticle_assert` and `act_and_wait` that had already seen the recognised person, the heading, the
 * 200 responses, still come back `verified: "unknown"` / `evidence_incomplete` — because
 * `duplicate-request` counted the loop's own writes as a double submit. Same shape from a second
 * reporter on an analytics-instrumented page, where two batched beacons in a window is normal.
 *
 * There was no notion of a cadence: N identical writes at a regular interval is a poll, and a
 * double submit is a burst.
 */
import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from './contradictions.js';

let seq = 0;
function at(t: number, type: EventType, data: Record<string, unknown> = {}): ReticleEvent {
  seq += 1;
  return { t, seq, type, sessionId: 's', data };
}

const write = (t: number, url = '/api/people/match'): ReticleEvent =>
  at(t, EventType.NET_REQUEST, {
    id: `n${String(seq)}`,
    method: 'POST',
    url,
    status: 200,
    ok: true,
  });

const domAt = (t: number): ReticleEvent => at(t, EventType.DOM_REMOVED, { path: 'li' });

/** The window as an ACTION's window, which is the only shape this rule runs in. */
const duplicates = (events: ReticleEvent[]): string[] =>
  findContradictions(events, { actionSince: 0, action: 'click' })
    .filter((c) => ContradictionKind.DUPLICATE_REQUEST === c.kind)
    .map((c) => c.detail);

describe('a steady cadence is a poll', () => {
  it('does not call a one-second scan loop a double submit', () => {
    const events = [write(1000), write(2000), write(3000), write(4000), domAt(4100)];
    expect(duplicates(events)).toEqual([]);
  });

  it('tolerates the drift a real interval has under load', () => {
    // A setInterval competing with a busy main thread is not metronomic.
    const events = [write(1000), write(2050), write(3120), write(4030), domAt(4200)];
    expect(duplicates(events)).toEqual([]);
  });

  it('does not call batched analytics beacons a double submit', () => {
    const events = [
      write(500, '/collect'),
      write(5500, '/collect'),
      write(10_500, '/collect'),
      domAt(11_000),
    ];
    expect(duplicates(events)).toEqual([]);
  });
});

describe('a burst is still a double submit', () => {
  it('catches two identical writes milliseconds apart', () => {
    // The classic case, and every case this rule was written for.
    expect(duplicates([write(1000), write(1040), domAt(1100)])).toEqual([
      'POST /api/people/match ×2',
    ]);
  });

  it('catches two identical writes however far apart they are', () => {
    // TWO samples give one gap, and a single gap cannot distinguish a cadence from a
    // coincidence — so two writes stay a duplicate at any spacing.
    expect(duplicates([write(1000), write(9000), domAt(9100)])).toEqual([
      'POST /api/people/match ×2',
    ]);
  });

  it('catches three identical writes fired in a burst', () => {
    // Nothing a human or a StrictMode remount does lands on a quarter-second grid.
    expect(duplicates([write(1000), write(1030), write(1055), domAt(1100)])).toEqual([
      'POST /api/people/match ×3',
    ]);
  });

  it('catches a double submit followed by a late retry', () => {
    // Two fast, one late: not a rhythm, and reading it as one would lose the double submit.
    expect(duplicates([write(1000), write(1050), write(8000), domAt(8100)])).toEqual([
      'POST /api/people/match ×3',
    ]);
  });

  it('catches a burst that happens to sit inside a poll of a DIFFERENT endpoint', () => {
    const events = [
      write(1000, '/poll'),
      write(2000, '/poll'),
      write(3000, '/poll'),
      write(1500, '/api/order'),
      write(1540, '/api/order'),
      domAt(3100),
    ];
    expect(duplicates(events)).toEqual(['POST /api/order ×2']);
  });
});

describe('the rest of the rule is unchanged', () => {
  it('still says nothing about a single write', () => {
    expect(duplicates([write(1000), domAt(1100)])).toEqual([]);
  });

  it('still says nothing when no action is attributed to the window', () => {
    const events = [write(1000), write(1040), domAt(1100)];
    expect(
      findContradictions(events)
        .filter((c) => ContradictionKind.DUPLICATE_REQUEST === c.kind)
        .map((c) => c.detail),
    ).toEqual([]);
  });
});
