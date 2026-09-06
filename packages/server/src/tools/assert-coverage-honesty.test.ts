import { describe, expect, it } from 'vitest';
import {
  AppRuntime,
  BlindSpotKind,
  EventType,
  ReticleCommand,
  Verified,
  VerifiedReason,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import type { SessionManager } from '../session/session.js';
import { createFakeSession } from '../session/fake-session.js';

/**
 * A green verdict must never imply more coverage than the SDK actually had.
 *
 * `reticle_act_and_wait` has always carried a coverage statement, so a cross-origin iframe or a closed
 * shadow root downgrades its verdict to `partial`. Plain `reticle_assert` did not — and assert is the
 * cheaper, more-used verdict path, the one an agent gates on. So on a page with an unobservable
 * region, a passing assert read as "the page is correct" when the only honest claim available was
 * "nothing failed in the part I could see". That is the exact false-green shape this project exists to
 * prevent, sitting on the most-travelled route.
 *
 * The field stays OMITTED at full coverage: its PRESENCE is the warning, so emitting it always would
 * make it noise on every healthy call and it would stop being read.
 */
function depsWithBlindSpots(
  blindSpots: Record<string, number>,
  runtime?: (typeof AppRuntime)[keyof typeof AppRuntime],
): ToolDeps {
  const session = createFakeSession({
    bufferHealth: () => ({ total: 5, dropped: 0 }),
    command: () =>
      Promise.resolve({
        ok: true,
        kind: 'command_result' as const,
        id: 'match-1',
        result: { matched: false, count: 0, elements: [] },
      }),
    blindSpots: () => blindSpots,
    elapsed: () => 1000,
    health: () => ({ lastSeenMs: 5, throttled: false, focused: true, hidden: false }),
    ...(runtime === undefined ? {} : { runtime }),
  });
  const sessions: Partial<SessionManager> = { resolve: () => session };
  return { sessions: sessions as SessionManager } as unknown as ToolDeps;
}

const tool = (name: string): ToolDef => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`${name} is not on the surface`);
  return found;
};

/** An absence assertion — the shape most vulnerable to an unobserved region hiding the failure. */
const absentConsole = {
  predicate: { kind: 'console', level: 'error', absent: true },
  timeout_ms: 0,
};

const absentElement = {
  predicate: {
    kind: 'element',
    query: { by: 'testid', value: 'shipment-row' },
    absent: true,
  },
  timeout_ms: 0,
};

const absentElementInScope = {
  predicate: {
    kind: 'element',
    query: { by: 'testid', value: 'shipment-row', scope: '#cross-origin-frame' },
    absent: true,
  },
  timeout_ms: 0,
};

const notWrappedAbsentElement = {
  predicate: {
    kind: 'not',
    predicate: {
      kind: 'element',
      query: { by: 'testid', value: 'shipment-row' },
    },
  },
  timeout_ms: 0,
};

describe('reticle_assert discloses partial coverage', () => {
  it('a PASSING assertion on a page with a cross-origin iframe reports partial coverage', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBlindSpots({ 'cross-origin-iframe': 1 }),
      absentConsole,
    )) as Record<string, unknown>;

    expect(result['pass']).toBe(true);
    expect(result['coverage']).toBeTypeOf('string');
    expect(String(result['coverage'])).toContain('partial');
  });

  it('downgrades a passing scoped element absence when a cross-origin frame is unobserved', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBlindSpots({ 'cross-origin-iframe': 1 }),
      absentElementInScope,
    )) as Record<string, unknown>;

    expect(result['pass']).toBe(true);
    expect(result['verified']).toBe(Verified.UNKNOWN);
    expect(result['verifiedReason']).toBe(VerifiedReason.ABSENCE_BLIND_SPOT);
    expect(String(result['because'])).toContain('cross-origin');
  });

  it('keeps an unscoped element absence green when only an unrelated cross-origin frame is unobserved', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBlindSpots({ 'cross-origin-iframe': 1 }),
      absentElement,
    )) as Record<string, unknown>;

    expect(result['pass']).toBe(true);
    expect(result['verified']).toBe(Verified.YES);
  });

  it('downgrades an element absence to UNKNOWN when virtualized rows are unobserved', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBlindSpots({ 'virtualized-unmounted': 1 }),
      absentElement,
    )) as Record<string, unknown>;

    expect(result['pass']).toBe(true);
    expect(result['verified']).toBe(Verified.UNKNOWN);
    expect(result['verifiedReason']).toBe(VerifiedReason.ABSENCE_BLIND_SPOT);
  });

  it('downgrades an element absence to UNKNOWN when a closed shadow root is unobserved', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBlindSpots({ 'closed-shadow-root': 1 }),
      absentElement,
    )) as Record<string, unknown>;

    expect(result['pass']).toBe(true);
    expect(result['verified']).toBe(Verified.UNKNOWN);
    expect(result['verifiedReason']).toBe(VerifiedReason.ABSENCE_BLIND_SPOT);
  });

  it('downgrades a not-wrapped element absence when virtualized rows are unobserved', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBlindSpots({ 'virtualized-unmounted': 1 }),
      notWrappedAbsentElement,
    )) as Record<string, unknown>;

    expect(result['pass']).toBe(true);
    expect(result['verified']).toBe(Verified.UNKNOWN);
    expect(result['verifiedReason']).toBe(VerifiedReason.ABSENCE_BLIND_SPOT);
  });

  it('names which regions were unobservable, so the agent can act on it', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBlindSpots({ 'cross-origin-iframe': 2 }),
      absentConsole,
    )) as Record<string, unknown>;

    const spots = result['coverage_spots'] as { kind: string; count: number }[] | undefined;
    expect(spots?.[0]).toMatchObject({ kind: 'cross-origin-iframe', count: 2 });
  });

  it('OMITS coverage entirely when the page was fully observable', async () => {
    // Silence has to keep meaning "I saw everything", or the field becomes noise and gets ignored.
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBlindSpots({}),
      absentConsole,
    )) as Record<string, unknown>;

    expect(result['pass']).toBe(true);
    expect('coverage' in result).toBe(false);
    expect('coverage_spots' in result).toBe(false);
  });

  it('a zero-count blind spot is not a blind spot', async () => {
    // The sensor emits on change, so a region that was unobservable and then went away reports 0.
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBlindSpots({ 'cross-origin-iframe': 0 }),
      absentConsole,
    )) as Record<string, unknown>;

    expect('coverage' in result).toBe(false);
  });

  /**
   * A browser tab was reported as an Electron renderer with unobserved IPC because the desktop
   * kinds sit in the same coverage vocabulary. The session already knows it is web.
   */
  it('does not report Electron IPC coverage on a web session', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBlindSpots(
        {
          [BlindSpotKind.UNOBSERVED_IPC]: 1,
          [BlindSpotKind.UNWATCHED_STATE]: 1,
        },
        AppRuntime.WEB,
      ),
      absentConsole,
    )) as Record<string, unknown>;

    expect(String(result['coverage'])).toContain('no subscribable store');
    expect(String(result['coverage'])).not.toContain('Electron');
    expect(String(result['coverage'])).not.toContain('ipcRenderer');
    const spots = result['coverage_spots'] as { kind: string }[] | undefined;
    expect(spots?.map((s) => s.kind)).toEqual([BlindSpotKind.UNWATCHED_STATE]);
  });

  it('still names a missing Electron preload on an Electron renderer', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBlindSpots({ [BlindSpotKind.UNOBSERVED_IPC]: 1 }, AppRuntime.ELECTRON),
      absentConsole,
    )) as Record<string, unknown>;

    expect(String(result['coverage'])).toContain('@reticlehq/electron/preload');
  });
});

describe('reticle_assert carries the verdict, not just pass', () => {
  // Measured on a shipments console: a dispatch answered 202 Accepted, the row rendered "dispatched"
  // optimistically, and an assert taken right after returned a bare `pass: true`. The server reverted
  // the write 1.2s later. The 202 machinery that exists to report this as `verified: "unknown"` lived
  // only in act_and_wait — the tool an agent actually calls never consulted it.
  /** A console-absence assertion over a window we control, so only the WRITE varies. */
  const runAssert = async (events: ReticleEvent[]): Promise<unknown> => {
    const session = createFakeSession({
      bufferHealth: () => ({ total: 5, dropped: 0 }),
      eventsSince: () => events,
      queryEvents: () => Promise.resolve(events),
      elapsed: () => 1000,
      health: () => ({ lastSeenMs: 5, throttled: false, focused: true, hidden: false }),
    });
    const sessions: Partial<SessionManager> = { resolve: () => session };
    const deps = { sessions: sessions as SessionManager } as unknown as ToolDeps;
    return tool(ReticleTool.ASSERT).handler(deps, absentConsole);
  };

  // The real shape: the row rendered "dispatched" optimistically AND the write came back 202. A 202
  // with no UI movement is a different finding (`response-ignored`) and would mask what is tested here.
  const acceptedWrite = [
    { type: EventType.DOM_TEXT, t: 5, data: { text: 'dispatched', old: 'draft' } },
    {
      type: EventType.NET_REQUEST,
      t: 10,
      data: { method: 'POST', url: '/api/dispatch', status: 202, ok: true },
    },
  ] as unknown as ReticleEvent[];

  it('reports unknown when a write was only ACCEPTED, even though the assertion passed', async () => {
    const result = (await runAssert(acceptedWrite)) as Record<string, unknown>;
    expect(result['pass']).toBe(true);
    expect(result['verified']).toBe(Verified.UNKNOWN);
    expect(String(result['because'])).toContain('202');
  });

  it('reports yes on a clean window', async () => {
    const result = (await runAssert([])) as Record<string, unknown>;
    expect(result['verified']).toBe(Verified.YES);
  });
});

describe('reticle_act_and_wait downgrades absence when blind spots hide the target', () => {
  function actSessionWithBlindSpots(blindSpots: Record<string, number>): ToolDeps {
    const noEvents: ReticleEvent[] = [];
    const command = (name: string): Promise<CommandResult> => {
      if (name === ReticleCommand.MATCH) {
        return Promise.resolve({
          kind: 'command_result',
          id: 'q1',
          ok: true,
          result: { matched: false, count: 0, elements: [] },
        });
      }
      return Promise.resolve({
        kind: 'command_result',
        id: 'c1',
        ok: true,
        result: { dispatched: true, settled: true, effect: { domMutatedWithin: 1 } },
      });
    };
    const session = createFakeSession(
      {
        elapsed: () => 1000,
        command,
        queryEvents: () => Promise.resolve(noEvents),
        eventsSince: () => noEvents,
        bufferHealth: () => ({ total: 10, dropped: 0 }),
        blindSpots: () => blindSpots,
        health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
      },
      { url: 'http://localhost:5173/app' },
    );
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

  const ACT_ABSENT = {
    ref: 'e1',
    action: 'click',
    until: { kind: 'element', query: { by: 'testid', value: 'shipment-row' }, absent: true },
  };

  it('downgrades to UNKNOWN when virtualized rows hide where the element could be', async () => {
    const deps = actSessionWithBlindSpots({ [BlindSpotKind.VIRTUALIZED_UNMOUNTED]: 1 });
    const r = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, ACT_ABSENT)) as Record<
      string,
      unknown
    >;
    expect(r['verified']).toBe(Verified.UNKNOWN);
    expect(r['verifiedReason']).toBe(VerifiedReason.ABSENCE_BLIND_SPOT);
  });

  it('downgrades to UNKNOWN when a closed shadow root hides subtrees', async () => {
    const deps = actSessionWithBlindSpots({ [BlindSpotKind.CLOSED_SHADOW_ROOT]: 1 });
    const r = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, ACT_ABSENT)) as Record<
      string,
      unknown
    >;
    expect(r['verified']).toBe(Verified.UNKNOWN);
    expect(r['verifiedReason']).toBe(VerifiedReason.ABSENCE_BLIND_SPOT);
  });

  it('does NOT cite ABSENCE_BLIND_SPOT when no blind spot is present', async () => {
    const deps = actSessionWithBlindSpots({});
    const r = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, ACT_ABSENT)) as Record<
      string,
      unknown
    >;
    expect(r['verifiedReason']).not.toBe(VerifiedReason.ABSENCE_BLIND_SPOT);
  });
});
