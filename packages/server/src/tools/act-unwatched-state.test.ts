import { describe, expect, it } from 'vitest';
import { BlindSpotKind, SessionState, Verified } from '@reticlehq/core';
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
import type { CausalSummary } from '../capsule/causal-summary.js';
import type { HonestyBlock } from '../honesty/honesty.js';
import type { Session, SessionManager } from '../session/session.js';

/**
 * An act over an app with NO subscribed store returns `stateDiffs: []` — which reads as "the app
 * changed no state" when the truth is "nothing was watching state". The SDK declares that as a blind
 * spot; this pins that the verdict path carries it through to the two places an agent reads:
 * the summary it is looking at, and the coverage statement it is told to gate on.
 *
 * It must NOT impeach the capture. Conflating a bounded blind spot with a lost one is what once made
 * every verdict on a virtualized list permanently UNKNOWN.
 */
function fakeSession(blindSpots: Record<string, number>): Session {
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
    bufferHealth: () => ({ total: 10, dropped: 0 }),
    lostSince: () => false,
    blindSpots: () => blindSpots,
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

interface ActResult {
  summary?: CausalSummary;
  honesty?: HonestyBlock;
  verified?: string;
}

describe('act_and_wait tells an unwatched state channel from an unchanged one', () => {
  it('marks the summary and the coverage when nothing is subscribed', async () => {
    const deps = fakeDeps(fakeSession({ [BlindSpotKind.UNWATCHED_STATE]: 1 }));
    const r = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, ACT)) as ActResult;
    expect(r.summary?.stateUnwatched).toBe(true);
    expect(r.honesty?.coverage.partial).toBe(true);
  });

  it('does not impeach the capture — the verdict still stands on what WAS observed', async () => {
    const deps = fakeDeps(fakeSession({ [BlindSpotKind.UNWATCHED_STATE]: 1 }));
    const r = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, ACT)) as ActResult;
    expect(r.verified).not.toBe(Verified.UNKNOWN);
    expect(r.honesty?.integrity.clean).toBe(true);
  });

  it('says nothing once a store is subscribed (the SDK withdraws the spot with count 0)', async () => {
    const deps = fakeDeps(fakeSession({ [BlindSpotKind.UNWATCHED_STATE]: 0 }));
    const r = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, ACT)) as ActResult;
    expect(r.summary?.stateUnwatched).toBeUndefined();
    expect(r.honesty?.coverage.partial).toBe(false);
  });
});

/**
 * `partial: true` with nothing beside it is an unanswerable flag, and the verdict prose sends the
 * reader to `coverage` for what went unobserved. The sentence was built at the call site and
 * dropped there. Found by driving a one-way IPC send against a real Electron app: the verdict read
 * `verified: yes` for a send whose outcome is structurally unknowable, and the one sentence that
 * says so never left the process.
 *
 * This pins the WIRING, not the builder — deleting `coverageNote` from the act_and_wait call site
 * leaves every honesty.ts unit test green.
 */
describe('the coverage flag carries the sentence that explains it', () => {
  it('names a one-way send as the thing that went unobserved', async () => {
    const deps = fakeDeps(fakeSession({ [BlindSpotKind.VERDICTLESS_SEND]: 1 }));
    const r = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, ACT)) as ActResult;
    expect(r.honesty?.coverage.partial).toBe(true);
    expect(r.honesty?.coverage.note).toContain('one-way IPC send');
    expect(r.honesty?.coverage.note).toContain('NO verdict');
  });

  it('leaves the note off when coverage is full', async () => {
    const deps = fakeDeps(fakeSession({}));
    const r = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, ACT)) as ActResult;
    expect(r.honesty?.coverage.partial).toBe(false);
    expect(r.honesty?.coverage.note).toBeUndefined();
  });
});
