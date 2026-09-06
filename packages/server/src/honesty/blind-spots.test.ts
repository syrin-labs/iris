import { describe, expect, it } from 'vitest';
import { AppRuntime, EventType, type ReticleEvent } from '@reticlehq/core';
import {
  BlindSpotKind,
  buildCoverageStatement,
  blindSpotsFromEvents,
  spotsForRuntime,
} from './blind-spots.js';

function ev(type: EventType, data: Record<string, unknown>, t = 1): ReticleEvent {
  return { t, type, sessionId: 's', data };
}

describe('buildCoverageStatement', () => {
  it('reports full coverage when nothing went unobserved', () => {
    expect(buildCoverageStatement([])).toEqual({ coverage: 'full', spots: [] });
    expect(
      buildCoverageStatement([{ kind: BlindSpotKind.CROSS_ORIGIN_IFRAME, count: 0 }]).coverage,
    ).toBe('full');
  });

  it('names an un-instrumented Electron renderer, so an empty network view cannot read as clean', () => {
    const statement = buildCoverageStatement([{ kind: BlindSpotKind.UNOBSERVED_IPC, count: 1 }]);
    expect(statement.coverage).toBe('partial');
    expect(statement.note).toContain('@reticlehq/electron/preload');
  });

  it('degrades an unknown kind to its name instead of throwing on the verdict path', () => {
    // An SDK newer than the daemon can report a kind this LABEL table has never heard of. Indexing
    // it and calling the result threw a TypeError, which turned "there is something I could not
    // see" into a crashed assert — strictly worse than either the caveat or the silence.
    const statement = buildCoverageStatement([
      { kind: 'a-kind-from-the-future' as BlindSpotKind, count: 3 },
    ]);
    expect(statement.coverage).toBe('partial');
    expect(statement.note).toContain('a-kind-from-the-future');
  });

  it('reports partial coverage with a legible note listing what was unobserved', () => {
    const statement = buildCoverageStatement([
      { kind: BlindSpotKind.CROSS_ORIGIN_IFRAME, count: 2 },
      { kind: BlindSpotKind.CLOSED_SHADOW_ROOT, count: 1 },
    ]);
    expect(statement.coverage).toBe('partial');
    expect(statement.note).toBe(
      'partial — 2 cross-origin frames unobserved, 1 closed shadow root unobserved',
    );
  });

  /**
   * A Vite + React tab at localhost:5173 was reported as an Electron renderer with unobserved
   * ipcRenderer.invoke coverage, while reticle_sessions correctly showed a web session. The
   * desktop kinds live in the same vocabulary as "no store registered", so presence of the
   * kind is not evidence the page is a desktop app — the session already reports the runtime.
   */
  it('drops Electron IPC rows on a web session, even when that kind is in the spots', () => {
    const spots = [
      { kind: BlindSpotKind.UNOBSERVED_IPC, count: 1 },
      { kind: BlindSpotKind.UNWATCHED_STATE, count: 1 },
    ];
    const statement = buildCoverageStatement(spotsForRuntime(spots, AppRuntime.WEB));
    expect(statement.note).toContain('no subscribable store');
    expect(statement.note).not.toContain('Electron');
    expect(statement.note).not.toContain('ipcRenderer');
  });

  it('drops a one-way IPC send row on Tauri — that kind is Electron preload, not invoke', () => {
    const statement = buildCoverageStatement(
      spotsForRuntime([{ kind: BlindSpotKind.VERDICTLESS_SEND, count: 1 }], AppRuntime.TAURI),
    );
    expect(statement.coverage).toBe('full');
  });

  it('keeps the missing-preload warning on an actual Electron renderer', () => {
    const statement = buildCoverageStatement(
      spotsForRuntime([{ kind: BlindSpotKind.UNOBSERVED_IPC, count: 1 }], AppRuntime.ELECTRON),
    );
    expect(statement.coverage).toBe('partial');
    expect(statement.note).toContain('@reticlehq/electron/preload');
  });

  it('keeps desktop rows when the runtime is unknown, so an older SDK still warns', () => {
    const statement = buildCoverageStatement(
      spotsForRuntime([{ kind: BlindSpotKind.UNOBSERVED_IPC, count: 1 }], undefined),
    );
    expect(statement.note).toContain('Electron');
  });

  it('drops zero-count spots from the note', () => {
    const statement = buildCoverageStatement([
      { kind: BlindSpotKind.CROSS_ORIGIN_IFRAME, count: 0 },
      { kind: BlindSpotKind.VIRTUALIZED_UNMOUNTED, count: 5 },
    ]);
    expect(statement.spots).toHaveLength(1);
    expect(statement.note).toContain('5 virtualized unmounted rows');
  });
});

describe('blindSpotsFromEvents', () => {
  it('reduces BLIND_SPOT events to one spot per kind, latest count winning', () => {
    const spots = blindSpotsFromEvents([
      ev(EventType.BLIND_SPOT, { kind: BlindSpotKind.CROSS_ORIGIN_IFRAME, count: 1 }),
      ev(EventType.DOM_ADDED, {}),
      ev(EventType.BLIND_SPOT, { kind: BlindSpotKind.CROSS_ORIGIN_IFRAME, count: 2 }), // later wins
    ]);
    expect(spots).toEqual([{ kind: BlindSpotKind.CROSS_ORIGIN_IFRAME, count: 2 }]);
  });

  it('is empty when the window has no BLIND_SPOT events (→ full coverage)', () => {
    const spots = blindSpotsFromEvents([ev(EventType.NET_REQUEST, {})]);
    expect(spots).toEqual([]);
    expect(buildCoverageStatement(spots).coverage).toBe('full');
  });
});
