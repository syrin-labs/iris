import { describe, expect, it } from 'vitest';
import type { CommandResult } from '@reticlehq/core';
import { ActionType, QueryBy } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { RecordingStore, type CompiledProgram } from './recordings.js';
import { FlowStore } from './flows.js';
import { FLOW_TOOLS } from './flow-tools.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from './annotation-store.js';
import { ArtifactRootReason } from '../project/artifact-root.js';
import { createMemoryFs } from '../project/memory-fs.js';
import type { FileSystemPort } from '../project/fs-port.js';
import type { Session, SessionManager } from '../session/session.js';

/**
 * Where a saved flow LANDS, as opposed to what it contains.
 *
 * `flows.save` already scopes by projectId into a subdirectory, so two projects under one daemon
 * never collide. What it could not do was choose the BASE: that came from the daemon's own
 * `process.cwd()`, decided once at construction, and a user-scoped MCP registration is started
 * wherever the editor happens to be. The flow then landed outside the repo it verifies — reported
 * from the field as a save that returned success, named no path, and was found afterwards with
 * `find`.
 *
 * These tests pin the base path and the reported path. The resolution rule itself is
 * `resolveArtifactRoot`'s and is tested there.
 */

const DAEMON_ROOT = '/daemon-cwd/.reticle';
const PROJECT_ROOT = '/repo/apps/web/.reticle';

const norm = (p: string): string => p.split('\\').join('/');

function depsFor(
  fs: FileSystemPort,
  recordings: RecordingStore,
  sessionProjectId: string | undefined,
  artifactRootFor: ToolDeps['artifactRootFor'],
): ToolDeps {
  const command = (): Promise<CommandResult> =>
    Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
  const session: Partial<Session> = { id: 'demo', command, projectId: sessionProjectId };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings,
    flows: new FlowStore(fs, DAEMON_ROOT, { now: () => 1234 }),
    project: new ProjectStore(fs, DAEMON_ROOT, { now: () => 1234 }),
    annotations: new AnnotationStore(),
    fs,
    reticleRoot: DAEMON_ROOT,
    now: () => 1234,
    ...(artifactRootFor === undefined ? {} : { artifactRootFor }),
  };
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

function oneStep(name: string): CompiledProgram {
  return {
    name,
    version: 1,
    steps: [
      {
        tool: ReticleTool.ACT,
        stable: true,
        args: { by: QueryBy.TESTID, value: 'submit', action: ActionType.CLICK, args: {} },
      },
    ],
  };
}

describe('reticle_flow_save writes to the session project, not the daemon cwd', () => {
  it('writes under the resolved project root when the session names a known project', async () => {
    const { fs, written } = createMemoryFs();
    const recordings = new RecordingStore();
    recordings.saveCompiled(oneStep('login'));

    const deps = depsFor(fs, recordings, 'acme-web-9f3c1d', () => ({
      root: PROJECT_ROOT,
      reason: ArtifactRootReason.MATCHED_PROJECT,
    }));

    await tool(ReticleTool.FLOW_SAVE).handler(deps, { flowName: 'login' });

    const paths = [...written.keys()];
    expect(
      paths.some((p) => p.startsWith(`${PROJECT_ROOT}/flows`)),
      `expected a write under ${PROJECT_ROOT}/flows, got: ${paths.join(', ')}`,
    ).toBe(true);
    expect(paths.some((p) => p.startsWith(`${DAEMON_ROOT}/flows`))).toBe(false);
  });

  /**
   * The reporter who lost a `find` to this needs the path in the response, whichever branch
   * resolution took. A save that says it succeeded and not where is not checkable by its caller.
   */
  it('reports the absolute path it wrote', async () => {
    const { fs } = createMemoryFs();
    const recordings = new RecordingStore();
    recordings.saveCompiled(oneStep('login'));

    const deps = depsFor(fs, recordings, 'acme-web-9f3c1d', () => ({
      root: PROJECT_ROOT,
      reason: ArtifactRootReason.MATCHED_PROJECT,
    }));

    const res = (await tool(ReticleTool.FLOW_SAVE).handler(deps, { flowName: 'login' })) as {
      path?: string;
    };
    expect(res.path).toBeDefined();
    expect(norm(res.path ?? '')).toContain(PROJECT_ROOT);
  });

  /**
   * No resolver supplied is the shape every existing construction of ToolDeps has, and the shape a
   * consumer embedding this engine may keep. It must behave exactly as it does today.
   */
  it('falls back to the daemon root when no resolver is wired', async () => {
    const { fs, written } = createMemoryFs();
    const recordings = new RecordingStore();
    recordings.saveCompiled(oneStep('login'));

    const deps = depsFor(fs, recordings, 'acme-web-9f3c1d', undefined);
    await tool(ReticleTool.FLOW_SAVE).handler(deps, { flowName: 'login' });

    expect([...written.keys()].some((p) => p.startsWith(`${DAEMON_ROOT}/flows`))).toBe(true);
  });
});

/**
 * The listing is what an agent READS to learn what a project has, and it was the half still
 * answering from the daemon's own directory: the store was resolved but the reported path was
 * joined onto `deps.reticleRoot`, so a HUD driving a React dashboard listed an unrelated
 * checkout's Electron and Tauri flows and gave paths into a repo the user was not in.
 */
describe('reticle_flow_list reports paths in the session project', () => {
  it('joins listed names onto the resolved root, not the daemon root', async () => {
    const { fs } = createMemoryFs();
    const recordings = new RecordingStore();
    recordings.saveCompiled(oneStep('login'));

    const deps = depsFor(fs, recordings, 'acme-web-9f3c1d', () => ({
      root: PROJECT_ROOT,
      reason: ArtifactRootReason.MATCHED_PROJECT,
    }));
    await tool(ReticleTool.FLOW_SAVE).handler(deps, { flowName: 'login' });

    // FLOW_LIST is merged into the `reticle_flow` facade, so it is not in TOOLS by its own name.
    const listTool = FLOW_TOOLS.find((t) => t.name === ReticleTool.FLOW_LIST);
    if (listTool === undefined) throw new Error('no flow_list tool');
    const res = (await listTool.handler(deps, {})) as {
      flows: { name: string; path: string }[];
    };
    expect(res.flows.map((f) => f.name)).toContain('login');
    for (const flow of res.flows) {
      expect(norm(flow.path).startsWith(PROJECT_ROOT)).toBe(true);
      expect(norm(flow.path).startsWith(DAEMON_ROOT)).toBe(false);
    }
  });
});
