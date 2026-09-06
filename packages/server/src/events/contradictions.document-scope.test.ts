import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from './contradictions.js';

/**
 * Evidence used to be scoped by time and by ring-buffer capacity and nothing else, so a request or a
 * signal observed under a PREVIOUS document could be cited as the cause of an action taken now. The
 * bytes were real; the world they described was gone.
 *
 * The common case matters most here: nothing about a window whose evidence all belongs to the
 * document currently on screen may change, and the first two tests are the ones that say so.
 */

let seq = 0;
function ev(type: EventType, data: Record<string, unknown>, documentId?: string): ReticleEvent {
  seq += 1;
  const base: ReticleEvent = { t: seq, seq, type, sessionId: 's', data };
  return documentId === undefined ? base : { ...base, documentId };
}

const domChanged = (documentId?: string): ReticleEvent =>
  ev(EventType.DOM_REMOVED, { path: 'li' }, documentId);
const failedCall = (documentId?: string): ReticleEvent =>
  ev(
    EventType.NET_REQUEST,
    { id: `n${String(seq)}`, method: 'POST', url: '/api/x', status: 500, ok: false },
    documentId,
  );

// `actionSince: 0` states the premise every consequence rule now requires — these windows were
// always an action's, they simply never had to say so. See contradictions.attribution.test.ts.
const kinds = (events: ReticleEvent[], currentDocumentId?: string): string[] =>
  findContradictions(events, { currentDocumentId, actionSince: 0 }).map((c) => c.kind);

describe('contradiction evidence is scoped to the document currently under observation', () => {
  it('cites same-document evidence exactly as before', () => {
    expect(kinds([domChanged('doc-a'), failedCall('doc-a')], 'doc-a')).toContain(
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    );
  });

  it('cites UNSTAMPED evidence, because an older SDK stamps nothing and still reports real bugs', () => {
    expect(kinds([domChanged(), failedCall()], 'doc-a')).toContain(
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    );
  });

  it('does not cite a failed request that belongs to a document since replaced', () => {
    // The archetype from the field: the cited failing request named a row that no longer exists.
    expect(kinds([domChanged('doc-b'), failedCall('doc-a')], 'doc-b')).not.toContain(
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    );
  });

  it('reports that the evidence was SUPERSEDED rather than answering that nothing happened', () => {
    const found = findContradictions([domChanged('doc-a'), failedCall('doc-a')], {
      currentDocumentId: 'doc-b',
    });
    expect(found.map((c) => c.kind)).toEqual([ContradictionKind.EVIDENCE_SUPERSEDED]);
    // The user-visible value of the change: an agent told this knows to re-drive.
    expect(found[0]?.counter).toContain('replaced');
  });

  it('stays silent on a window that was empty to begin with — that is not supersession', () => {
    expect(findContradictions([], { currentDocumentId: 'doc-b' })).toEqual([]);
  });

  it('does not accuse a control of doing nothing when its window was superseded', () => {
    // Without the early return, dropping the superseded events empties the window and
    // `action-had-no-effect` fires — trading a wrong citation for a wrong accusation.
    const found = findContradictions([domChanged('doc-a')], {
      currentDocumentId: 'doc-b',
      action: 'click',
      mutatedWithin: 0,
    });
    expect(found.map((c) => c.kind)).not.toContain(ContradictionKind.ACTION_HAD_NO_EFFECT);
    expect(found.map((c) => c.kind)).toEqual([ContradictionKind.EVIDENCE_SUPERSEDED]);
  });

  it('still judges the survivors when only PART of the window was superseded', () => {
    expect(
      kinds([failedCall('doc-a'), domChanged('doc-b'), failedCall('doc-b')], 'doc-b'),
    ).toContain(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
  });
});
