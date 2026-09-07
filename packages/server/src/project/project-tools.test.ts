import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectReadError, RunKind, RunStatus } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import { BaselineStore } from './baselines.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from './project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import { createNodeFileSystem, type FileSystemPort } from './fs-port.js';
import type { Session, SessionManager } from '../session/session.js';

const clock = { now: (): number => 1234 };

function noopSession(): Partial<Session> {
  return {
    id: 'demo',
    command: () => Promise.resolve({ kind: 'command_result', id: 'a', ok: true, result: {} }),
    eventsSince: () => [],
    onEvent: () => () => undefined,
  };
}

function fakeDeps(fs: FileSystemPort, root: string): ToolDeps {
  const sessions: Partial<SessionManager> = { resolve: () => noopSession() as Session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(fs, root, clock),
    project: new ProjectStore(fs, root, clock),
    annotations: new AnnotationStore(),
    fs,
    reticleRoot: root,
    now: clock.now,
  };
}

function tool(name: string): (typeof TOOLS)[number] {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

/**
 * How long a test that writes tens of run records to a real temp directory may take.
 *
 * Generous on purpose, and a BOUND rather than a measurement: nothing here claims the code is fast.
 * The two tests below write 30 and 40 records sequentially through the real filesystem port, which
 * is milliseconds on macOS and Linux and much slower on a Windows runner. The 40-record one timed
 * out at vitest's 5s default on Windows CI only, which reads as a product failure and is a statement
 * about the machine — the exact shape CLAUDE.md forbids asserting on.
 */
const HISTORY_WRITE_TIMEOUT_MS = 30_000;

describe('project tools — temp dir, never touches the repo', () => {
  let dir: string;
  let root: string;
  let fs: FileSystemPort;
  let deps: ToolDeps;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-proj-tools-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
    deps = fakeDeps(fs, root);
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it('2: reticle_project on empty history returns a structured MISSING error', async () => {
    const res = (await tool(ReticleTool.PROJECT).handler(deps, {})) as { reason?: string };
    expect(res.reason).toBe(ProjectReadError.MISSING);
  });

  it('3: reticle_project (no name) returns the full run list', async () => {
    await deps.project.recordRun({ kind: RunKind.MANUAL, name: 'a', status: RunStatus.PASS });
    await deps.project.recordRun({ kind: RunKind.MANUAL, name: 'b', status: RunStatus.FAIL });
    const res = (await tool(ReticleTool.PROJECT).handler(deps, {})) as {
      runs: { name: string }[];
    };
    expect(res.runs.map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('4: reticle_project { name } returns scoped runs + lastRun + diff-vs-last', async () => {
    await deps.project.recordRun({
      kind: RunKind.FLOW_REPLAY,
      name: 'checkout',
      status: RunStatus.PASS,
      evidence: { driftSteps: 0, consoleErrors: 0 },
    });
    await deps.project.recordRun({
      kind: RunKind.FLOW_REPLAY,
      name: 'checkout',
      status: RunStatus.DRIFT,
      evidence: { driftSteps: 2, consoleErrors: 3 },
    });
    const res = (await tool(ReticleTool.PROJECT).handler(deps, { name: 'checkout' })) as {
      runs: unknown[];
      lastRun?: { status: string };
      diff?: {
        statusChanged: boolean;
        regressed: boolean;
        consoleErrorsDelta?: number;
        driftStepsDelta?: number;
      };
    };
    expect(res.runs).toHaveLength(2);
    expect(res.lastRun?.status).toBe(RunStatus.DRIFT);
    expect(res.diff?.statusChanged).toBe(true);
    expect(res.diff?.regressed).toBe(true);
    expect(res.diff?.consoleErrorsDelta).toBe(3);
    expect(res.diff?.driftStepsDelta).toBe(2);
  });

  it('5: reticle_project { name } with a single run has lastRun but no diff', async () => {
    await deps.project.recordRun({ kind: RunKind.MANUAL, name: 'solo', status: RunStatus.PASS });
    const res = (await tool(ReticleTool.PROJECT).handler(deps, { name: 'solo' })) as {
      lastRun?: unknown;
      diff?: unknown;
    };
    expect(res.lastRun).toBeDefined();
    expect(res.diff).toBeUndefined();
  });

  /**
   * The run history is append-only and unbounded. Measured on this repo it had reached 176 runs and
   * ~20KB (~5,000 tokens) — a large slice of an agent's context for data it mostly does not read, and
   * it only grows. The cap must never be silent: `totalRuns` is what tells a caller the list was cut.
   */
  describe('reticle_project bounds an unbounded history, and says so', () => {
    it(
      'returns the most recent N and reports the true total',
      async () => {
        for (let i = 0; i < 30; i += 1) {
          await deps.project.recordRun({
            kind: RunKind.MANUAL,
            name: `run-${String(i)}`,
            status: RunStatus.PASS,
          });
        }
        const res = (await tool(ReticleTool.PROJECT).handler(deps, { limit: 5 })) as {
          runs: { name: string }[];
          totalRuns: number;
        };
        expect(res.runs).toHaveLength(5);
        expect(res.totalRuns, 'the cap must never hide how much exists').toBe(30);
        // Most RECENT, and still in the order they happened.
        expect(res.runs.map((r) => r.name)).toEqual([
          'run-25',
          'run-26',
          'run-27',
          'run-28',
          'run-29',
        ]);
        // Thirty sequential writes to a REAL temp directory. A bound, not a duration assertion: this
        // says nothing about how fast the machine is, only that the test is allowed to finish on a
        // slow one. Windows CI file IO is much slower than macOS or Linux, and its sibling below
        // timed out there at the 5s default while passing everywhere else.
      },
      HISTORY_WRITE_TIMEOUT_MS,
    );

    it(
      'caps by default, so a huge history cannot arrive unasked',
      async () => {
        for (let i = 0; i < 40; i += 1) {
          await deps.project.recordRun({
            kind: RunKind.MANUAL,
            name: `r${String(i)}`,
            status: RunStatus.PASS,
          });
        }
        const res = (await tool(ReticleTool.PROJECT).handler(deps, {})) as {
          runs: unknown[];
          totalRuns: number;
        };
        expect(res.runs.length).toBeLessThan(res.totalRuns);
        // Forty of them, so the same bound and more of it. This is the one that actually went red.
      },
      HISTORY_WRITE_TIMEOUT_MS,
    );
  });
});
