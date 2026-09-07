/**
 * A full-document navigation replaces the session. The agent still holds the old id.
 *
 * `act_and_wait` on a link ends `observation_lost` because the SDK died with the document;
 * `assert` then refuses the dead id even though the new page has already HELLO'd. Same-origin,
 * one live tab, the id the agent holds is the one that just left — that is a successor, not a
 * guess. Two live tabs at that origin is still a guess, and a never-seen id still is not.
 */

import { describe, expect, it } from 'vitest';
import { pickDocumentSuccessor, awaitDocumentSuccessor } from './session-successor.js';
import type { Session } from './session.js';
import type { SuccessorRegistry, SuccessorClock } from './session-successor.js';

const departed = {
  id: 'old',
  url: 'http://localhost:3000/orders',
  projectId: 'shop',
};

describe('pickDocumentSuccessor', () => {
  it('picks the one live session at the departed origin', () => {
    expect(
      pickDocumentSuccessor(
        [{ id: 'new', url: 'http://localhost:3000/orders/42', projectId: 'shop' }],
        departed,
      )?.id,
    ).toBe('new');
  });

  it('picks a same-id reconnect — the id survived, the document did not', () => {
    expect(
      pickDocumentSuccessor(
        [{ id: 'old', url: 'http://localhost:3000/orders/42', projectId: 'shop' }],
        departed,
      )?.id,
    ).toBe('old');
  });

  it('does not guess when two tabs share the origin', () => {
    expect(
      pickDocumentSuccessor(
        [
          { id: 'a', url: 'http://localhost:3000/a', projectId: 'shop' },
          { id: 'b', url: 'http://localhost:3000/b', projectId: 'shop' },
        ],
        departed,
      ),
    ).toBeUndefined();
  });

  it('does not pick a different origin', () => {
    expect(
      pickDocumentSuccessor(
        [{ id: 'other', url: 'http://localhost:9999/orders', projectId: 'shop' }],
        departed,
      ),
    ).toBeUndefined();
  });

  it('does not pick a different project on the same origin', () => {
    expect(
      pickDocumentSuccessor(
        [{ id: 'stray', url: 'http://localhost:3000/admin', projectId: 'admin' }],
        departed,
      ),
    ).toBeUndefined();
  });

  it('with no projectId, origin alone is the match', () => {
    expect(
      pickDocumentSuccessor([{ id: 'new', url: 'http://localhost:3000/done' }], {
        id: 'old',
        url: 'http://localhost:3000/start',
      })?.id,
    ).toBe('new');
  });
});

function stub(id: string, url: string): Session {
  return { id, url } as Session;
}

function fakeClock(step: number): SuccessorClock {
  let t = 0;
  return {
    now: () => t,
    sleep: () => {
      t += step;
      return Promise.resolve();
    },
  };
}

describe('awaitDocumentSuccessor', () => {
  it('returns the session that arrives a few polls later', async () => {
    const departed = stub('old', 'http://localhost:3000/a');
    const next = stub('new', 'http://localhost:3000/b');
    const snapshots: Session[][] = [[], [], [next]];
    let look = 0;
    const sessions: SuccessorRegistry = {
      get: (id) => snapshots[Math.min(look, snapshots.length - 1)]?.find((s) => s.id === id),
      all: () => {
        const snap = snapshots[Math.min(look, snapshots.length - 1)] ?? [];
        look += 1;
        return snap;
      },
    };
    await expect(awaitDocumentSuccessor(sessions, departed, 5_000, fakeClock(25))).resolves.toBe(
      next,
    );
  });

  it('finds the successor even while the departed session is still listed', async () => {
    const departed = stub('old', 'http://localhost:3000/a');
    const next = stub('new', 'http://localhost:3000/b');
    const sessions: SuccessorRegistry = {
      get: (id) => (id === departed.id ? departed : id === next.id ? next : undefined),
      all: () => [departed, next],
    };
    await expect(awaitDocumentSuccessor(sessions, departed, 1_000, fakeClock(25))).resolves.toBe(
      next,
    );
  });

  it('gives up with null rather than hanging when nobody arrives', async () => {
    const departed = stub('old', 'http://localhost:3000/a');
    let looks = 0;
    const sessions: SuccessorRegistry = {
      get: () => undefined,
      all: () => {
        looks += 1;
        return [];
      },
    };
    await expect(
      awaitDocumentSuccessor(sessions, departed, 100, fakeClock(25)),
    ).resolves.toBeNull();
    expect(looks).toBeLessThanOrEqual(6);
  });
});
