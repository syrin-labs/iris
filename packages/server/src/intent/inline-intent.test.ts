import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  EventType,
  InstrumentationGapKind,
  IntentState,
  MessageKind,
  RETICLE_PROTOCOL_VERSION,
  SessionState,
  Verified,
  type CommandResult,
  type HelloMessage,
  type InstrumentationGap,
  type ReticleEvent,
} from '@reticlehq/core';
import { createMemoryFs } from '../project/memory-fs.js';
import { IntentStore } from './intent-store.js';
import { LastAct } from '../session/last-act.js';
import { RecordingStore } from '../flows/recordings.js';
import { Session, type SessionManager } from '../session/session.js';
import { TOOLS, type ToolDef, type ToolDeps } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';

/**
 * Intent declared INLINE, on the two tools that draw a verdict.
 *
 * `reticle_intent` lives on the extended surface, so declaring intent costs an agent a discovery, a
 * decision and a round trip before it has done anything — and an option with three ways to be
 * skipped is one that gets skipped. `reticle_act_and_wait` and `reticle_assert` are in every agent's
 * tool list already, so an `intent` argument there is discoverable by construction and free.
 *
 * What these pin is that the shortcut is not a second mechanism: it writes the SAME ledger, in the
 * same vocabulary, and it is discharged only by a verdict that actually proved something.
 */

const ROOT = '/repo/app/.reticle';
const SIGNAL_NAME = 'todo:added';
const STATEMENT = 'adding a todo announces it to the list';
const EDIT_EPOCH = 7;

const noopSocket = { send: () => undefined, close: () => undefined } as unknown as WebSocket;

function tool(name: string): ToolDef {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`${name} is not on the surface`);
  return found;
}

function hello(): HelloMessage {
  return {
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId: 'demo',
    url: 'http://localhost/',
    title: 'Demo',
    adapters: [],
  };
}

function signalEvent(): ReticleEvent {
  return {
    t: 1,
    seq: 1,
    type: EventType.SIGNAL,
    sessionId: 'demo',
    editEpoch: EDIT_EPOCH,
    data: { name: SIGNAL_NAME },
  };
}

/** A live session plus deps whose ledger is in memory, so the file it wrote can be read back. */
function harness(): { session: Session; deps: ToolDeps; ledger: IntentStore } {
  const session = new Session(hello(), noopSocket, () => 0);
  const { fs } = createMemoryFs();
  const sessions: Partial<SessionManager> = { resolve: () => session };
  const deps = {
    sessions: sessions as SessionManager,
    fs,
    reticleRoot: ROOT,
    now: () => 1_000,
  } as unknown as ToolDeps;
  return { session, deps, ledger: new IntentStore(fs, ROOT, { now: () => 1_000 }) };
}

/** The act path needs a driven page; only the fields the handler reads are stubbed. */
function actHarness(events: ReticleEvent[]): { deps: ToolDeps; ledger: IntentStore } {
  const command = (): Promise<CommandResult> =>
    Promise.resolve({
      kind: 'command_result',
      id: 'c',
      ok: true,
      result: { dispatched: true, settled: true, effect: { domMutatedWithin: 1 } },
    });
  const stub: Partial<Session> = {
    id: 'demo',
    url: 'http://localhost/',
    elapsed: () => 1_000,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    command,
    queryEvents: () => Promise.resolve(events),
    eventsSince: () => events,
    bufferHealth: () => ({ total: 10, dropped: 0 }),
    lostSince: () => false,
    blindSpots: () => ({}),
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
    onEvent: () => () => undefined,
    ambientCounts: () => ({}),
    currentEditEpoch: EDIT_EPOCH,
  };
  const session = stub as Session;
  const { fs } = createMemoryFs();
  const sessions: Partial<SessionManager> = { resolve: () => session };
  const deps = {
    sessions: sessions as SessionManager,
    recordings: new RecordingStore(),
    fs,
    reticleRoot: ROOT,
    now: () => 1_000,
  } as unknown as ToolDeps;
  return { deps, ledger: new IntentStore(fs, ROOT, { now: () => 1_000 }) };
}

const assertSignal = { predicate: { kind: 'signal', name: SIGNAL_NAME }, timeout_ms: 0 };

interface VerdictResult {
  verified?: string;
  instrumentationGaps?: InstrumentationGap[];
}

describe('an inline intent lands in the same ledger reticle_intent writes', () => {
  it('records the prose on reticle_assert', async () => {
    const { session, deps, ledger } = harness();
    session.pushEvent(signalEvent());
    await tool(ReticleTool.ASSERT).handler(deps, { ...assertSignal, intent: STATEMENT });
    const [intent] = await ledger.read();
    expect(intent?.statement).toBe(STATEMENT);
  });

  it('records the prose on reticle_act_and_wait', async () => {
    const { deps, ledger } = actHarness([signalEvent()]);
    await tool(ReticleTool.ACT_AND_WAIT).handler(deps, {
      ref: 'e1',
      action: 'click',
      until: { kind: 'signal', name: SIGNAL_NAME },
      timeout_ms: 0,
      intent: STATEMENT,
    });
    const [intent] = await ledger.read();
    expect(intent?.statement).toBe(STATEMENT);
  });
});

describe('a verdict discharges the intent it proved, and nothing it did not', () => {
  it('marks the intent proved, naming the verdict that did it', async () => {
    const { session, deps, ledger } = harness();
    session.pushEvent(signalEvent());
    const result = (await tool(ReticleTool.ASSERT).handler(deps, {
      ...assertSignal,
      intent: STATEMENT,
    })) as VerdictResult;
    expect(result.verified).toBe(Verified.YES);
    const [intent] = await ledger.read();
    expect(intent?.state).toBe(IntentState.PROVED);
    expect(intent?.provenBy?.verdictId).toContain(ReticleTool.ASSERT);
  });

  it('leaves it undischarged when the verdict failed', async () => {
    const { session, deps, ledger } = harness();
    session.pushEvent(signalEvent());
    await tool(ReticleTool.ASSERT).handler(deps, {
      predicate: { kind: 'signal', name: 'never:fired' },
      timeout_ms: 0,
      intent: STATEMENT,
    });
    const [intent] = await ledger.read();
    expect(intent?.state).not.toBe(IntentState.PROVED);
    expect(intent?.provenBy).toBeUndefined();
  });
});

describe('the undeclared-change gap is silent on the verdict that declared inline', () => {
  const gapKinds = (result: VerdictResult): string[] =>
    (result.instrumentationGaps ?? []).map((gap) => gap.kind);

  it('still reports the gap when nothing was declared', async () => {
    const { session, deps } = harness();
    session.pushEvent(signalEvent());
    const result = (await tool(ReticleTool.ASSERT).handler(deps, assertSignal)) as VerdictResult;
    expect(gapKinds(result)).toContain(InstrumentationGapKind.UNDECLARED_CHANGE);
  });

  it('goes quiet on the SAME verdict the intent was declared on, not the next one', async () => {
    const { session, deps } = harness();
    session.pushEvent(signalEvent());
    const result = (await tool(ReticleTool.ASSERT).handler(deps, {
      ...assertSignal,
      intent: STATEMENT,
    })) as VerdictResult;
    expect(gapKinds(result)).not.toContain(InstrumentationGapKind.UNDECLARED_CHANGE);
  });
});

describe('an intent already in the ledger is referenced by id, not restated', () => {
  it('proves the existing row and keeps its own words', async () => {
    const { session, deps, ledger } = harness();
    await ledger.declare([{ id: 'checkin', statement: STATEMENT }]);
    session.pushEvent(signalEvent());
    await tool(ReticleTool.ASSERT).handler(deps, { ...assertSignal, intent: 'checkin' });
    const intents = await ledger.read();
    expect(intents).toHaveLength(1);
    expect(intents[0]?.statement).toBe(STATEMENT);
    expect(intents[0]?.state).toBe(IntentState.PROVED);
  });

  it('does not overwrite a binding the agent bound deliberately', async () => {
    const { session, deps, ledger } = harness();
    await ledger.declare([{ id: 'checkin', statement: STATEMENT }]);
    const deliberate = { kind: 'net', urlContains: '/api/todos' };
    await ledger.bind('checkin', deliberate);
    session.pushEvent(signalEvent());
    await tool(ReticleTool.ASSERT).handler(deps, { ...assertSignal, intent: 'checkin' });
    expect((await ledger.read())[0]?.binding).toEqual(deliberate);
  });
});

describe('omitting intent changes nothing at all', () => {
  it('writes no ledger and returns the same verdict', async () => {
    const { session, deps, ledger } = harness();
    session.pushEvent(signalEvent());
    const result = (await tool(ReticleTool.ASSERT).handler(deps, assertSignal)) as VerdictResult;
    expect(result.verified).toBe(Verified.YES);
    expect(await ledger.read()).toEqual([]);
  });

  it('writes no ledger from the act path either', async () => {
    const { deps, ledger } = actHarness([signalEvent()]);
    await tool(ReticleTool.ACT_AND_WAIT).handler(deps, {
      ref: 'e1',
      action: 'click',
      until: { kind: 'signal', name: SIGNAL_NAME },
      timeout_ms: 0,
    });
    expect(await ledger.read()).toEqual([]);
  });
});
