import { describe, expect, it } from 'vitest';
import { SessionState, Verified, VerifiedReason } from '@reticlehq/core';
import type { CommandResult, ReticleEvent } from '@reticlehq/core';
import { LastAct } from '../session/last-act.js';
import { TOOLS, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import type { Session, SessionManager } from '../session/session.js';

/**
 * A verdict whose window LOST events must not grade `proved` — and one whose window lost nothing
 * must not be caveated for evictions that happened elsewhere.
 *
 * `act_and_wait` marks its window truncated with `session.lostSince(since)`. That feeds
 * `integrity.issues`, and `!integrity.clean` is what makes `decideVerified` answer UNCLEAN_CAPTURE:
 * "a green here would only describe what was observed".
 *
 * Found by mutation: hardcoding that flag to `false` failed ZERO tests. So a verdict reached over a
 * window the server buffer had evicted during would have come back `proved`, with no trace that
 * part of the window was never seen.
 *
 * The flag stuck ON is the opposite failure and, in the field, the more expensive one: it read the
 * cumulative drop counter, which moves on every push once a session is a minute old, so verdicts
 * came back `unknown` over windows that were completely intact. The cursor is asserted below for
 * that reason — the whole defect was a consumer asking the buffer a question about the session when
 * it meant to ask one about the window.
 *
 * Distinct from the Session-level gap (`Session.lostSince` delegating to the ring buffer, covered
 * separately): this is act_and_wait's USE of it, and it had its own hole.
 */
function fakeSession(lost: boolean, cursors: number[] = []): Session {
  const command = (): Promise<CommandResult> =>
    Promise.resolve({
      kind: 'command_result',
      id: 'c',
      ok: true,
      result: { dispatched: true, settled: true, effect: { domMutatedWithin: 1 } },
    });
  const noEvents: ReticleEvent[] = [];
  const stub: Partial<Session> = {
    id: 'demo',
    url: 'http://localhost:5173/app',
    elapsed: () => 1000,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    command,
    queryEvents: () => Promise.resolve(noEvents),
    eventsSince: () => noEvents,
    bufferHealth: () => ({ total: 10, dropped: 9 }),
    lostSince: (cursor: number) => {
      cursors.push(cursor);
      return lost;
    },
    blindSpots: () => ({}),
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
    onEvent: () => () => undefined,
    ambientCounts: () => ({}),
  };
  return stub as Session;
}

function fakeDeps(session: Session): ToolDeps {
  const sessions: Partial<SessionManager> = { resolve: () => session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(createNodeFileSystem(), '/tmp/reticle-test/.reticle', { now: () => 0 }),
    project: new ProjectStore(createNodeFileSystem(), '/tmp/reticle-test/.reticle', {
      now: () => 0,
    }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    reticleRoot: '/tmp/reticle-test/.reticle',
    now: () => 0,
  };
}

function tool(name: string) {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no ${name} tool`);
  return found;
}

const ACT = { ref: 'e1', action: 'click', until: { kind: 'settled' } };

interface Verdict {
  verified?: string;
  verifiedReason?: string;
  because?: string;
}

describe('act_and_wait declares a window that lost events', () => {
  it('does not grade proved when scarce evidence was lost from THIS window', async () => {
    const deps = fakeDeps(fakeSession(true));
    const r = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, ACT)) as Verdict;
    expect(r.verified).toBe(Verified.UNKNOWN);
    expect(r.verifiedReason).toBe(VerifiedReason.UNCLEAN_CAPTURE);
  });

  it('does not caveat a clean window, however much the session evicted', async () => {
    // The control, and the field defect: `dropped` reads 9 here. A verdict that consults the
    // session-wide counter caveats every window on any page that has been open for a minute.
    //
    // Asserted as "not UNCLEAN_CAPTURE" rather than "is PROVED" because `ACT` declares
    // `{kind:"settled"}`, and an explicit settle is the idle wait itself, not a declaration about
    // the app — so it now correctly grades `nothing_declared`. Pinning PROVED here would pin the
    // false green this fixture happened to sit on: an undeclared call reporting a full pass.
    // The subject of this test is which COUNTER decides, and that contrast is intact.
    const deps = fakeDeps(fakeSession(false));
    const r = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, ACT)) as Verdict;
    expect(r.verifiedReason).not.toBe(VerifiedReason.UNCLEAN_CAPTURE);
    expect(r.verifiedReason).toBe(VerifiedReason.NOTHING_DECLARED);
  });

  it('asks about the window, not the session — the cursor is where the observation opened', async () => {
    // Pins the ARGUMENT, not just the answer. `lostSince(0)` would be true for the whole session and
    // is exactly how this regresses: same call, same shape, silently back to a session-wide claim.
    const cursors: number[] = [];
    const deps = fakeDeps(fakeSession(false, cursors));
    await tool(ReticleTool.ACT_AND_WAIT).handler(deps, ACT);
    expect(cursors).toContain(1000); // the fake's `elapsed()` — the moment the window opened
    expect(cursors).not.toContain(0);
  });
});
