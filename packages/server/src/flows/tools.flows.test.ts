import { describe, expect, it } from 'vitest';
import type { CommandResult } from '@reticlehq/core';
import { ActionType, FlowErrorCode, QueryBy } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { RecordingStore } from './recordings.js';
import { FlowStore } from './flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from './annotation-store.js';
import type { FileSystemPort } from '../project/fs-port.js';
import type { Session, SessionManager } from '../session/session.js';
import type { CompiledProgram, RecordedStep } from './recordings.js';

const ROOT = '/virtual/.reticle';

/** In-memory FileSystemPort — proves the tool wiring without touching the real disk. */
/** Separators normalised at the port — the code under test joins paths with the platform
 *  separator, and these keys are POSIX. Sixth instance of this fixture bug on this branch. */
const norm = (p: string): string => p.split('\\').join('/');

function memoryFs(): FileSystemPort {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    readFile(path) {
      const v = files.get(norm(path));
      if (v === undefined) {
        const err: NodeJS.ErrnoException = new Error('ENOENT');
        err.code = 'ENOENT';
        return Promise.reject(err);
      }
      return Promise.resolve(v);
    },
    writeFile(path, data) {
      files.set(norm(path), data);
      return Promise.resolve();
    },
    appendFile(path, data) {
      files.set(norm(path), (files.get(norm(path)) ?? '') + data);
      return Promise.resolve();
    },
    readFileBytes(path) {
      const v = files.get(norm(path));
      if (v === undefined) {
        const err: NodeJS.ErrnoException = new Error('ENOENT');
        err.code = 'ENOENT';
        return Promise.reject(err);
      }
      return Promise.resolve(new TextEncoder().encode(v));
    },
    writeFileBytes(path, data) {
      files.set(norm(path), new TextDecoder().decode(data));
      return Promise.resolve();
    },
    mkdir(path) {
      dirs.add(norm(path));
      return Promise.resolve();
    },
    exists(path) {
      return Promise.resolve(files.has(norm(path)) || dirs.has(norm(path)));
    },
    readdir(path) {
      const prefix = `${norm(path)}/`;
      const names = new Set<string>();
      for (const f of files.keys()) {
        if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split('/')[0] ?? '');
      }
      return Promise.resolve([...names]);
    },
    rename(from, to) {
      const v = files.get(from);
      if (v !== undefined) {
        files.set(to, v);
        files.delete(from);
      }
      return Promise.resolve();
    },
    rm(path) {
      files.delete(norm(path));
      return Promise.resolve();
    },
    stat() {
      return Promise.resolve({ mtimeMs: 0, size: 0 });
    },
    realpath(path: string) {
      return Promise.resolve(path);
    },
    isNotFound(error) {
      return 'ENOENT' === (error as NodeJS.ErrnoException | undefined)?.code;
    },
  };
}

function fakeDeps(fs: FileSystemPort, recordings: RecordingStore): ToolDeps {
  const command = (): Promise<CommandResult> =>
    Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
  const session: Partial<Session> = { id: 'demo', command };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings,
    flows: new FlowStore(fs, ROOT, { now: () => 1234 }),
    project: new ProjectStore(fs, ROOT, { now: () => 1234 }),
    annotations: new AnnotationStore(),
    fs,
    reticleRoot: ROOT,
    now: () => 1234,
  };
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

function program(name: string, steps: RecordedStep[]): CompiledProgram {
  return { name, version: 1, steps };
}

describe('reticle_flow_save / reticle_flow_load handlers', () => {
  it('19: reticle_flow_save with no compiled recording returns NO_RECORDING', async () => {
    const deps = fakeDeps(memoryFs(), new RecordingStore());
    const res = (await tool(ReticleTool.FLOW_SAVE).handler(deps, { flowName: 'missing' })) as {
      error?: string;
      code?: string;
    };
    expect(res.code).toBe(FlowErrorCode.NO_RECORDING);
    expect(res.error).toBeDefined();
  });

  it('20: reticle_flow_save then reticle_flow_load via handlers round-trips', async () => {
    const recordings = new RecordingStore();
    recordings.saveCompiled(
      program('checkout', [
        {
          tool: ReticleTool.ACT,
          stable: true,
          args: { by: QueryBy.TESTID, value: 'pay', action: ActionType.CLICK, args: {} },
        },
      ]),
    );
    const deps = fakeDeps(memoryFs(), recordings);
    const saved = (await tool(ReticleTool.FLOW_SAVE).handler(deps, { flowName: 'checkout' })) as {
      name: string;
      stepCount: number;
    };
    expect(saved).toMatchObject({ name: 'checkout', stepCount: 1 });

    const loaded = (await tool(ReticleTool.FLOW).handler(deps, {
      action: 'load',
      flowName: 'checkout',
    })) as {
      flowName: string;
      steps: { anchor: { kind: string; value?: string } }[];
    };
    expect(loaded.flowName).toBe('checkout');
    expect(loaded.steps[0]?.anchor).toEqual({ kind: 'testid', value: 'pay' });

    // FLOW_LIST returns {name, path} objects (matches its outputSchema — schema-validating MCP
    // clients reject bare strings).
    const list = (await tool(ReticleTool.FLOW).handler(deps, { action: 'list' })) as {
      flows: { name: string; path: string }[];
    };
    expect(list.flows.map((f) => f.name)).toEqual(['checkout']);
    expect(list.flows[0]?.path).toContain('checkout');
  });

  it('3: a recorded expect.signal survives the round-trip', async () => {
    const recordings = new RecordingStore();
    recordings.saveCompiled(
      program('withexpect', [
        {
          tool: ReticleTool.ACT,
          stable: true,
          args: { by: QueryBy.TESTID, value: 'go', action: ActionType.CLICK, args: {} },
          expect: { signal: 'diff:shown' },
        },
      ]),
    );
    const deps = fakeDeps(memoryFs(), recordings);
    await tool(ReticleTool.FLOW_SAVE).handler(deps, { flowName: 'withexpect' });
    const loaded = (await tool(ReticleTool.FLOW).handler(deps, {
      action: 'load',
      flowName: 'withexpect',
    })) as {
      steps: { expect?: { signal?: string } }[];
    };
    expect(loaded.steps[0]?.expect?.signal).toBe('diff:shown');
  });
  /**
   * `flowName` selects the RECORDING; it never named the file (#698).
   *
   * A recording is named at `record{start}` - often `default`, or whatever the drive began as -
   * while every other flow tool reads a flow name as the thing you load and replay. So a caller
   * who wanted their flow called `create-table` had no way to say so and had to `mv` it on disk.
   * The give-away that this confused people rather than merely being undocumented: the
   * no-recording error in this handler already had to spend a sentence explaining the difference,
   * after it cost a real investigation.
   */
  it('22: reticle_flow_save saves under saveAs, and that name loads back', async () => {
    const recordings = new RecordingStore();
    recordings.saveCompiled(
      program('default', [
        {
          tool: ReticleTool.ACT,
          stable: true,
          args: { by: QueryBy.TESTID, value: 'pay', action: ActionType.CLICK, args: {} },
        },
      ]),
    );
    const deps = fakeDeps(memoryFs(), recordings);
    const saved = (await tool(ReticleTool.FLOW_SAVE).handler(deps, {
      flowName: 'default',
      saveAs: 'create-table',
    })) as { name: string };
    expect(saved.name).toBe('create-table');

    // A name you cannot load with is not a name.
    const loaded = (await tool(ReticleTool.FLOW).handler(deps, {
      action: 'load',
      flowName: 'create-table',
    })) as { flowName?: string; error?: string };
    expect(loaded.error).toBeUndefined();
    expect(loaded.flowName).toBe('create-table');
  });

  it('23: omitting saveAs still saves under the recording name', async () => {
    // The compatibility guard: every existing caller passes only flowName.
    const recordings = new RecordingStore();
    recordings.saveCompiled(
      program('checkout', [
        {
          tool: ReticleTool.ACT,
          stable: true,
          args: { by: QueryBy.TESTID, value: 'pay', action: ActionType.CLICK, args: {} },
        },
      ]),
    );
    const deps = fakeDeps(memoryFs(), recordings);
    const saved = (await tool(ReticleTool.FLOW_SAVE).handler(deps, {
      flowName: 'checkout',
    })) as { name: string };
    expect(saved.name).toBe('checkout');
  });

  it('24: a saveAs that cannot be a filename is refused, and nothing is written', async () => {
    // It becomes a path under .reticle/flows/, so a traversal attempt is refused by name rather
    // than resolved into one - and refusing must not quietly save under the recording name
    // instead, which would write a file the caller never asked for and report success.
    const recordings = new RecordingStore();
    recordings.saveCompiled(
      program('default', [
        {
          tool: ReticleTool.ACT,
          stable: true,
          args: { by: QueryBy.TESTID, value: 'pay', action: ActionType.CLICK, args: {} },
        },
      ]),
    );
    const deps = fakeDeps(memoryFs(), recordings);
    const res = (await tool(ReticleTool.FLOW_SAVE).handler(deps, {
      flowName: 'default',
      saveAs: '../escape',
    })) as { code?: string };
    expect(res.code).toBe(FlowErrorCode.INVALID_NAME);

    const loaded = (await tool(ReticleTool.FLOW).handler(deps, {
      action: 'load',
      flowName: 'default',
    })) as { error?: string };
    expect(loaded.error).toBeDefined();
  });
});
