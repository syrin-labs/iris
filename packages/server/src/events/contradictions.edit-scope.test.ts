import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from './contradictions.js';

/**
 * Evidence recorded before the agent's last source edit landed is LABELLED, never dropped.
 *
 * A navigation replaces everything, so cross-document evidence is excluded. A hot update does not:
 * most of the page, most of the modules and every in-flight request survive it, so most of what was
 * observed a second before the edit is still true about the app a second after. Dropping it would
 * empty windows that hold real findings — and an empty window reads as "nothing happened", which is
 * the more expensive of the two wrong answers.
 */

let seq = 0;
function ev(type: EventType, data: Record<string, unknown>, editEpoch?: number): ReticleEvent {
  seq += 1;
  const base: ReticleEvent = { t: seq, seq, type, sessionId: 's', data };
  return editEpoch === undefined ? base : { ...base, editEpoch };
}

const domChanged = (editEpoch?: number): ReticleEvent =>
  ev(EventType.DOM_REMOVED, { path: 'li' }, editEpoch);
const failedCall = (editEpoch?: number): ReticleEvent =>
  ev(
    EventType.NET_REQUEST,
    { id: `n${String(seq)}`, method: 'POST', url: '/api/x', status: 500, ok: false },
    editEpoch,
  );

// `actionSince: 0` states the premise every consequence rule now requires — these windows were
// always an action's, they simply never had to say so. See contradictions.attribution.test.ts.
const kinds = (events: ReticleEvent[], currentEditEpoch?: number): string[] =>
  findContradictions(events, { currentEditEpoch, actionSince: 0 }).map((c) => c.kind);

describe('contradiction evidence is scoped to the current edit epoch', () => {
  it('cites same-epoch evidence exactly as before', () => {
    expect(kinds([domChanged(2), failedCall(2)], 2)).toContain(
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    );
  });

  it('cites UNSTAMPED evidence, because an older SDK stamps nothing and still reports real bugs', () => {
    expect(kinds([domChanged(), failedCall()], 2)).toContain(
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    );
  });

  it('still cites evidence from an earlier epoch — an edit is not a navigation', () => {
    expect(kinds([domChanged(1), failedCall(1)], 2)).toContain(
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    );
  });

  it('labels a window whose every observation predates the current edit', () => {
    const found = findContradictions([domChanged(1), failedCall(1)], {
      currentEditEpoch: 2,
      actionSince: 0,
    });
    expect(found.map((c) => c.kind)).toContain(ContradictionKind.EVIDENCE_PREDATES_EDIT);
    expect(found.map((c) => c.kind)).toContain(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
  });

  it('does not label a window that holds even one post-edit observation', () => {
    expect(kinds([domChanged(1), failedCall(2)], 2)).not.toContain(
      ContradictionKind.EVIDENCE_PREDATES_EDIT,
    );
  });

  it('does not label anything when no edit was ever observed', () => {
    expect(kinds([domChanged(), failedCall()])).not.toContain(
      ContradictionKind.EVIDENCE_PREDATES_EDIT,
    );
  });

  it('labels a window a superseding document already emptied, without hiding either fact', () => {
    // Both scopings can be true at once, and the agent needs both: the page was replaced AND the
    // code was. Reporting one only would send it to re-drive against the wrong explanation.
    const found = findContradictions([{ ...domChanged(1), documentId: 'doc-a' }], {
      currentDocumentId: 'doc-b',
      currentEditEpoch: 2,
    });
    expect(found.map((c) => c.kind)).toEqual([
      ContradictionKind.EVIDENCE_PREDATES_EDIT,
      ContradictionKind.EVIDENCE_SUPERSEDED,
    ]);
  });
});
