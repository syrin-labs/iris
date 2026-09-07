/**
 * The wiring, which is the half that can silently stop working.
 *
 * The fold in honesty/feature-capture.ts is pure and pinned by its own spec. Nothing there notices
 * if the dispatch point stops feeding it — and a feature-use instrument that quietly records nothing
 * reports "not observed" forever, which is exactly the unfalsifiable state it exists to end.
 */

import { describe, expect, it } from 'vitest';
import { SessionState } from '@reticlehq/core';
import { ReticleTool } from './tool-names.js';
import { runTool } from './invoke-tool.js';
import { buildDynamicTools } from './dynamic-tools.js';
import { CaptureLedger } from '../honesty/feature-capture.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import { BaselineStore } from '../project/baselines.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import type { ToolDef, ToolDeps } from './tools.js';
import type { Session, SessionManager } from '../session/session.js';

const ROOT = '/tmp/reticle-captured-calls-test/.reticle';
const SESSION_ID = 'sA';
const REF = 'e4';
const ACTIONS_SO_FAR = 5;
const now = (): number => 0;

function session(capture: CaptureLedger): Session {
  return {
    id: SESSION_ID,
    url: 'http://localhost:5173/',
    capture,
    actionCount: ACTIONS_SO_FAR,
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    takeSessionLease: () => undefined,
    ageWarning: () => undefined,
  } as unknown as Session;
}

function deps(only: Session): ToolDeps {
  const sessions: Partial<SessionManager> = {
    resolve: () => only,
    list: () => [{ sessionId: only.id, url: only.url }] as ReturnType<SessionManager['list']>,
  };
  const fs = createNodeFileSystem();
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(fs, ROOT, { now }),
    project: new ProjectStore(fs, ROOT, { now }),
    annotations: new AnnotationStore(),
    fs,
    reticleRoot: ROOT,
    now,
  };
}

const tool = (name: string): ToolDef => ({
  name,
  description: '',
  inputSchema: {},
  handler: () => Promise.resolve({ ok: true }),
});

describe('the dispatch point records the calls the journal never keeps', () => {
  it('records a reticle_context call against the session, at the step it was made', async () => {
    const capture = new CaptureLedger();

    await runTool(tool(ReticleTool.CONTEXT), deps(session(capture)), {});

    expect(capture.calls()).toEqual([{ tool: ReticleTool.CONTEXT, afterActions: ACTIONS_SO_FAR }]);
  });

  it('records the subject a read named, so a re-fetch can be told from a first look', async () => {
    const capture = new CaptureLedger();

    await runTool(tool(ReticleTool.INSPECT), deps(session(capture)), { ref: REF });

    expect(capture.calls()[0]?.subject).toBe(REF);
  });

  it('records nothing for a tool that drives the page — the journal already holds those', async () => {
    const capture = new CaptureLedger();

    await runTool(tool(ReticleTool.ACT), deps(session(capture)), { ref: REF });

    expect(capture.calls()).toEqual([]);
  });
});

describe('the dispatch point counts every tool call, whatever route it took', () => {
  it('counts a call under the tool name, including one that drives the page', async () => {
    const capture = new CaptureLedger();
    const only = session(capture);

    await runTool(tool(ReticleTool.ACT), deps(only), { ref: REF });
    await runTool(tool(ReticleTool.ACT), deps(only), { ref: REF });
    await runTool(tool(ReticleTool.SNAPSHOT), deps(only), {});

    expect([...capture.toolCalls()]).toEqual([
      [ReticleTool.ACT, 2],
      [ReticleTool.SNAPSHOT, 1],
    ]);
  });

  it('attributes a reticle_run dispatch to the tool it RAN, not to reticle_run', async () => {
    const capture = new CaptureLedger();
    const inner = tool(ReticleTool.EXPLORE);
    const run = buildDynamicTools([inner]).find((t) => ReticleTool.RUN === t.name);
    if (run === undefined) throw new Error('reticle_run is missing from the dynamic tools');

    await runTool(run, deps(session(capture)), { tool: ReticleTool.EXPLORE });

    expect([...capture.toolCalls()]).toEqual([[ReticleTool.EXPLORE, 1]]);
  });
});
