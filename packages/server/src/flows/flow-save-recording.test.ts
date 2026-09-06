/**
 * Saving what the agent recorded: the route it started on, and an error that names what exists.
 *
 * `reticle_flow_save` always read the agent's compiled recording — but `flowName` there means the
 * RECORDING's name, while every other flow tool reads it as the name to save AS. Recording
 * `default` and saving as `sign-in` therefore looked obviously right and answered "no compiled
 * recording by that name — record one first", which is advice to repeat the step that had just
 * succeeded. That cost a whole investigation before the two names were compared.
 */
import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionType, QueryBy } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { RecordingStore, type CompiledProgram } from './recordings.js';
import { AnnotationStore } from './annotation-store.js';
import { FlowStore } from './flows.js';
import { ProjectStore } from '../project/project-store.js';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';
import type { Session } from '../session/session.js';

const clock = { now: (): number => 1234 };
let root: string;
let fs: FileSystemPort;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reticle-save-'));
  fs = createNodeFileSystem();
});
afterEach(async () => removeTempDir(root));

const deps = (recordings: RecordingStore): ToolDeps =>
  ({
    sessions: {
      resolve: () =>
        ({
          id: 'demo',
          eventsSince: () => [],
          onEvent: () => () => undefined,
        }) as unknown as Session,
    },
    baselines: new BaselineStore(),
    recordings,
    annotations: new AnnotationStore(),
    flows: new FlowStore(fs, root, clock),
    project: new ProjectStore(fs, root, clock),
    fs,
    reticleRoot: root,
    now: clock.now,
  }) as ToolDeps;

const save = TOOLS.find((t) => t.name === ReticleTool.FLOW_SAVE);

const stored = (over: Partial<CompiledProgram> = {}): RecordingStore => {
  const store = new RecordingStore();
  store.saveCompiled({
    name: 'triage',
    version: 1,
    steps: [
      {
        tool: ReticleTool.ACT,
        stable: true,
        args: { by: QueryBy.TESTID, value: 'nav-issues', action: ActionType.CLICK, args: {} },
      },
    ],
    ...over,
  });
  return store;
};

const readSaved = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(root, 'flows', 'triage.json'), 'utf8')) as Record<string, unknown>;

describe('the route a recorded journey began on', () => {
  it('is written to the flow, so replay is not left wherever the tab happens to be', async () => {
    await save?.handler(deps(stored({ startPath: '/' })), { flowName: 'triage' });
    expect((await readSaved()).startPath).toBe('/');
  });

  it('is absent when the recording never captured one — never invented', async () => {
    await save?.handler(deps(stored()), { flowName: 'triage' });
    expect((await readSaved()).startPath).toBeUndefined();
  });
});

describe('asking for a recording that is not there', () => {
  it('names the ones that ARE, and says which name it wanted', async () => {
    const res = (await save?.handler(deps(stored()), { flowName: 'sign-in' })) as {
      error?: string;
    };
    // The exact confusion that cost the investigation: the recording exists under another name.
    expect(res.error).toContain("'triage'");
    expect(res.error).toContain('not');
  });

  it('falls back to the plain message when there is genuinely nothing to save', async () => {
    const res = (await save?.handler(deps(new RecordingStore()), { flowName: 'sign-in' })) as {
      error?: string;
    };
    expect(res.error).toContain('record one');
  });
});

describe('a recording that backtracks across pages', () => {
  it('warns at save, because replay has no navigation steps', async () => {
    const res = (await save?.handler(
      deps(stored({ routes: ['/search', '/product/1', '/search'] })),
      { flowName: 'triage' },
    )) as { warning?: string };
    expect(res.warning).toContain('/search');
    expect(res.warning).toMatch(/returned/i);
  });

  it('does not write the journey into the flow file', async () => {
    await save?.handler(deps(stored({ routes: ['/search', '/product/1', '/search'] })), {
      flowName: 'triage',
    });
    const file = await readSaved();
    expect(file['routes']).toBeUndefined();
  });

  it('stays quiet on a linear journey', async () => {
    const res = (await save?.handler(deps(stored({ routes: ['/search', '/product/1'] })), {
      flowName: 'triage',
    })) as { warning?: string };
    expect(res.warning).toBeUndefined();
  });
});
