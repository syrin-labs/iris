import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asFlowName,
  ActionType,
  AnchorKind,
  DANGEROUS_ACTION_CONFIRM_ARG,
  EventType,
  FLOW_FILE_VERSION,
  FlowErrorCode,
  IntentState,
  ReticleCommand,
  QueryBy,
  ReplayStatus,
  RunKind,
  RunStatus,
  type CommandResult,
  type FlowReplayResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { IntentStore } from '../intent/intent-store.js';
import { FlowAssertionGrade } from './flow-classify.js';
import { TOOLS, type ToolDeps } from '../tools/tools.js';
import { buildSuiteVerdict } from './decision.js';
import { ReticleTool } from '../tools/tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { RecordingStore } from './recordings.js';
import { FlowStore, type FlowAnnotations } from './flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from './annotation-store.js';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';
import { flowPath } from '../project/reticle-dir.js';
import { asRecord, asString } from '../tools/tools-helpers.js';
import type { Session, SessionManager } from '../session/session.js';
import type { CompiledProgram, RecordedStep } from './recordings.js';

const clock = { now: (): number => 1234 };

interface ScriptedSessionOptions {
  actOk?: boolean;
  actArgs?: Record<string, unknown>[];
}

/** A session whose QUERY answers from a per-testid script and whose ACT is configurable. */
function scriptedSession(
  queryScript: (testid: string) => unknown,
  options: ScriptedSessionOptions = {},
): Partial<Session> {
  const command = (name: string, args: Record<string, unknown> = {}): Promise<CommandResult> => {
    if (name === ReticleCommand.QUERY) {
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: queryScript(asString(args['value']) ?? ''),
      });
    }
    if (name === ReticleCommand.ACT) {
      options.actArgs?.push(asRecord(args['args']));
      const ok = options.actOk ?? true;
      return Promise.resolve({
        kind: 'command_result',
        id: 'a',
        ok,
        result: {},
        ...(ok ? {} : { error: 'act failed' }),
      });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  };
  return {
    id: 'demo',
    command,
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
}

function fakeDeps(
  fs: FileSystemPort,
  root: string,
  session: Partial<Session>,
  recordings = new RecordingStore(),
): ToolDeps {
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings,
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

function program(name: string, steps: RecordedStep[]): CompiledProgram {
  return { name, version: 1, steps };
}

function actStep(value: string): RecordedStep {
  return {
    tool: ReticleTool.ACT,
    stable: true,
    args: { by: QueryBy.TESTID, value, action: ActionType.CLICK, args: {} },
  };
}

describe('reticle_flow_replay handler — temp dir, never touches the repo', () => {
  let dir: string;
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-replay-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  async function saveFlow(name: string, steps: RecordedStep[]): Promise<void> {
    const store = new FlowStore(fs, root, clock);
    const res = await store.save(program(name, steps));
    if (!res.ok) throw new Error(`save failed: ${res.code}`);
  }

  it('A: a flow whose testids all resolve replays with status ok', async () => {
    await saveFlow('green', [actStep('chat-send'), actStep('chat-input')]);
    const session = scriptedSession((testid) => ({ elements: [{ ref: `e-${testid}` }] }));
    const deps = fakeDeps(fs, root, session);

    const res = (await tool(ReticleTool.FLOW_REPLAY).handler(deps, {
      flowName: 'green',
    })) as FlowReplayResult;
    expect(res.status).toBe(ReplayStatus.OK);
    expect(res.name).toBe('green');
    expect(res.steps).toHaveLength(2);
    expect(res.steps.every((s) => s.ok)).toBe(true);
  });

  it('B: a flow with one renamed testid returns status drift with a computed nearest', async () => {
    await saveFlow('renamed', [actStep('chat-send')]);
    const session = scriptedSession(() => ({
      elements: [],
      hint: {
        route: '/',
        presentTestids: ['chat-submit', 'sidebar-toggle'],
        knownEmptyState: false,
      },
    }));
    const deps = fakeDeps(fs, root, session);

    const res = (await tool(ReticleTool.FLOW_REPLAY).handler(deps, {
      flowName: 'renamed',
    })) as FlowReplayResult;
    expect(res.status).toBe(ReplayStatus.DRIFT);
    expect(res.steps.at(-1)?.drift?.nearest).toBe('chat-submit');
    expect(res.steps.at(-1)?.drift?.reason).toBe('testid "chat-send" not found');
  });

  it('C: a missing flow file returns a structured error envelope (no throw)', async () => {
    const session = scriptedSession(() => ({ elements: [] }));
    const deps = fakeDeps(fs, root, session);

    const res = (await tool(ReticleTool.FLOW_REPLAY).handler(deps, {
      flowName: 'nope',
    })) as FlowReplayResult;
    expect(res.status).toBe(ReplayStatus.ERROR);
    expect(res.error?.code).toBe(FlowErrorCode.NOT_FOUND);
    expect(res.steps).toHaveLength(0);
  });

  it('D: a corrupt flow file returns status error with a parse-failed code', async () => {
    await fs.mkdir(join(root, 'flows'));
    await fs.writeFile(flowPath(root, asFlowName('bad')), '{ not: a flow');
    const session = scriptedSession(() => ({ elements: [] }));
    const deps = fakeDeps(fs, root, session);

    const res = (await tool(ReticleTool.FLOW_REPLAY).handler(deps, {
      flowName: 'bad',
    })) as FlowReplayResult;
    expect(res.status).toBe(ReplayStatus.ERROR);
    expect(res.error?.code).toBe(FlowErrorCode.PARSE_FAILED);
    expect(res.steps).toHaveLength(0);
  });

  it('a flow with an unrecognized expect key surfaces the flow, step, and key in the error message', async () => {
    await fs.mkdir(join(root, 'flows'));
    await fs.writeFile(
      flowPath(root, asFlowName('bad-expect')),
      JSON.stringify({
        version: FLOW_FILE_VERSION,
        name: 'bad-expect',
        createdAt: 1,
        steps: [
          {
            tool: 'reticle_act',
            anchor: { kind: AnchorKind.TESTID, value: 'submit' },
            expect: { signal: 'x', signl: 'typo' },
          },
        ],
      }),
    );
    const session = scriptedSession(() => ({ elements: [] }));
    const deps = fakeDeps(fs, root, session);

    const res = (await tool(ReticleTool.FLOW_REPLAY).handler(deps, {
      flowName: 'bad-expect',
    })) as FlowReplayResult;
    expect(res.status).toBe(ReplayStatus.ERROR);
    expect(res.error?.code).toBe(FlowErrorCode.PARSE_FAILED);
    // The flow name is the caller's own argument, so the message spends its words on the part the
    // caller does NOT have: which step, and which key.
    expect(res.error?.message).toContain('step 0');
    expect(res.error?.message).toContain('signl');
  });

  it('E: an invalid flow name returns a structured error (no path escape)', async () => {
    const session = scriptedSession(() => ({ elements: [] }));
    const deps = fakeDeps(fs, root, session);

    const res = (await tool(ReticleTool.FLOW_REPLAY).handler(deps, {
      flowName: '../escape',
    })) as FlowReplayResult;
    expect(res.status).toBe(ReplayStatus.ERROR);
    expect(res.error?.code).toBe(FlowErrorCode.INVALID_NAME);
  });

  // ---- every replay records a run to .reticle/project.json ----

  it('F: an ok replay auto-records a pass run with mapped status + driftSteps:0', async () => {
    await saveFlow('green', [actStep('chat-send')]);
    const session = scriptedSession((testid) => ({ elements: [{ ref: `e-${testid}` }] }));
    const deps = fakeDeps(fs, root, session);

    await tool(ReticleTool.FLOW_REPLAY).handler(deps, { flowName: 'green' });
    const history = await deps.project.read();
    expect(history.ok).toBe(true);
    if (!history.ok) throw new Error('expected history');
    expect(history.file.runs).toHaveLength(1);
    expect(history.file.runs[0]).toMatchObject({
      kind: RunKind.FLOW_REPLAY,
      name: 'green',
      status: RunStatus.PASS,
      evidence: { driftSteps: 0 },
    });
  });

  it('G: the missing-flow ERROR early-return also records an error run', async () => {
    const session = scriptedSession(() => ({ elements: [] }));
    const deps = fakeDeps(fs, root, session);

    await tool(ReticleTool.FLOW_REPLAY).handler(deps, { flowName: 'nope' });
    const last = await deps.project.lastRun('nope');
    expect(last?.status).toBe(RunStatus.ERROR);
    expect(last?.kind).toBe(RunKind.FLOW_REPLAY);
  });

  it('H: an action failure is an error, not selector drift', async () => {
    await saveFlow('action-fails', [actStep('chat-send')]);
    const session = scriptedSession((testid) => ({ elements: [{ ref: `e-${testid}` }] }), {
      actOk: false,
    });
    const deps = fakeDeps(fs, root, session);

    const res = (await tool(ReticleTool.FLOW_REPLAY).handler(deps, {
      flowName: 'action-fails',
    })) as FlowReplayResult;
    expect(res.status).toBe(ReplayStatus.ERROR);
    expect(res.steps[0]).toMatchObject({ ok: false, error: 'act failed' });
    expect(res.error).toEqual({ code: ReplayStatus.ERROR, message: 'act failed' });

    const last = await deps.project.lastRun('action-fails');
    expect(last?.status).toBe(RunStatus.ERROR);
    expect(last?.evidence).toMatchObject({ driftSteps: 0 });
  });

  it('I: destructive-action confirmation is scoped to the current replay invocation', async () => {
    await saveFlow('dangerous', [actStep('delete-account')]);
    const actArgs: Record<string, unknown>[] = [];
    const session = scriptedSession((testid) => ({ elements: [{ ref: `e-${testid}` }] }), {
      actArgs,
    });
    const deps = fakeDeps(fs, root, session);

    await tool(ReticleTool.FLOW_REPLAY).handler(deps, { flowName: 'dangerous' });
    await tool(ReticleTool.FLOW_REPLAY).handler(deps, {
      flowName: 'dangerous',
      confirmDangerous: true,
    });

    expect(actArgs[0]).not.toHaveProperty(DANGEROUS_ACTION_CONFIRM_ARG);
    expect(actArgs[1]).toMatchObject({ [DANGEROUS_ACTION_CONFIRM_ARG]: true });
  });
});

/**
 * #341: a single-flow replay of a flow that asserts nothing returned a bare `ok`.
 *
 * `reticle_flow_verify` already refuses to count those as passes and says why. The single-flow
 * tool did not, so an agent replaying one flow and reading `status: "ok"` had no way to learn the
 * flow would read `ok` even if the feature were entirely broken.
 *
 * The status stays `ok` deliberately. `buildSuiteVerdict` reaches its unverifiable branch ONLY
 * through `ReplayStatus.OK` and pushes everything else onto `failures`, so introducing an
 * `unverifiable` status would make the suite report an unasserted flow as a FAILED one — a worse
 * lie than the one being fixed, because it sends someone debugging an app that is fine.
 */
describe('reticle_flow_replay — a green that cannot go red (#341)', () => {
  let dir: string;
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-unverifiable-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  async function save(
    name: string,
    steps: RecordedStep[],
    annotations?: FlowAnnotations,
  ): Promise<void> {
    const res = await new FlowStore(fs, root, clock).save(program(name, steps), annotations);
    if (!res.ok) throw new Error(`save failed: ${res.code}`);
  }

  function resolvingSession(): Partial<Session> {
    return scriptedSession((testid) => ({ elements: [{ ref: `e-${testid}` }] }));
  }

  async function replay(name: string): Promise<FlowReplayResult> {
    const deps = fakeDeps(fs, root, resolvingSession());
    return (await tool(ReticleTool.FLOW_REPLAY).handler(deps, {
      flowName: name,
    })) as FlowReplayResult;
  }

  it('an assertion-free flow replays ok AND says it proved nothing', async () => {
    await save('asserts-nothing', [actStep('login-submit')]);

    const res = await replay('asserts-nothing');

    // Still ok: the replay genuinely completed. That is the point — the status alone was never
    // going to carry this, which is why a bare `ok` was misleading rather than wrong.
    expect(res.status).toBe(ReplayStatus.OK);
    expect(res.unverifiable?.reason).toBeDefined();
    expect(res.unverifiable?.reason).toMatch(/asserts no observable consequence/);
  });

  it('a flow with a consequence assertion carries no such caveat', async () => {
    // The control. Without it, a bug that attached the caveat unconditionally would pass every
    // other assertion here — and would tell an agent that a genuinely verified flow proved nothing.
    await save('asserts-something', [actStep('login-submit')], {
      stepExpect: new Map(),
      dynamic: [],
      success: { signal: 'auth:logged-in' },
    });

    const res = await replay('asserts-something');

    expect(res.unverifiable).toBeUndefined();
  });

  it('the single-flow result and the suite agree about the same flow', async () => {
    // The actual invariant. Asserting the field exists in isolation would let the two tools drift
    // apart again, which is the whole defect: two answers to one question about one flow.
    await save('asserts-nothing', [actStep('login-submit')]);
    const flow = await new FlowStore(fs, root, clock).load('asserts-nothing');
    if (!flow.ok) throw new Error('load failed');

    const single = await replay('asserts-nothing');
    const suite = buildSuiteVerdict([{ replay: single, flow: flow.value }]);

    expect(suite.status).toBe('unverifiable');
    expect(suite.unverifiable?.[0]?.reason).toBe(single.unverifiable?.reason);
  });

  it('the reason is declared on the tool output schema, or a profile strips it', () => {
    // `name` was omitted here once and arrived stripped, which is why this is asserted rather
    // than trusted: a field the handler sets and the schema omits returns as nothing, silently.
    const schema = tool(ReticleTool.FLOW_REPLAY).outputSchema;
    expect(schema).toHaveProperty('unverifiable');
  });
});

/**
 * A replay reports in the language of the product, not only of the DOM.
 *
 * The intent ledger already models `declared → bound → proved` and records which verdict discharged
 * an intent. A flow that carries one should therefore DISCHARGE it when it passes — otherwise the
 * ledger stays open forever on something a suite proves on every run, and a failing flow reports a
 * missing testid where the reader needed "checkout no longer works".
 */
describe('reticle_flow_replay — the business intent a flow discharges', () => {
  let dir: string;
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-flow-intent-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  const CHECKED_IN = 'the trip badge reads "checked in" after the traveller checks in';

  function sessionEmitting(signal: string, options: ScriptedSessionOptions = {}): Partial<Session> {
    const event: ReticleEvent = {
      t: 1,
      type: EventType.SIGNAL,
      sessionId: 'demo',
      data: { name: signal },
    };
    return {
      ...scriptedSession((testid) => ({ elements: [{ ref: `e-${testid}` }] }), options),
      eventsSince: () => [event],
    };
  }

  async function save(name: string, annotations?: FlowAnnotations): Promise<void> {
    const res = await new FlowStore(fs, root, clock).save(
      program(name, [actStep('send-checkin')]),
      annotations,
    );
    if (!res.ok) throw new Error(`save failed: ${res.code}`);
  }

  function withIntent(intent: string, signal: string): FlowAnnotations {
    return { stepExpect: new Map(), dynamic: [], intent, success: { signal } };
  }

  it('a passing replay marks the intent proved with the verdict that did it', async () => {
    await save('checkin', withIntent(CHECKED_IN, 'trip:checked-in'));
    const deps = fakeDeps(fs, root, sessionEmitting('trip:checked-in'));

    const res = (await tool(ReticleTool.FLOW_REPLAY).handler(deps, {
      flowName: 'checkin',
    })) as FlowReplayResult;
    expect(res.status).toBe(ReplayStatus.OK);

    const [intent] = await new IntentStore(fs, root, clock).read();
    expect(intent?.statement).toBe(CHECKED_IN);
    expect(intent?.state).toBe(IntentState.PROVED);
    expect(intent?.provenBy?.verdictId).toContain('checkin');
    expect(intent?.provenBy?.grade).toBe(FlowAssertionGrade.ASSERTED);
  });

  it('a failing replay names the business outcome that is no longer true, then the step', async () => {
    await save('checkin', withIntent(CHECKED_IN, 'trip:checked-in'));
    // The check-in button no longer does anything: the step fails, so the outcome never happens.
    const deps = fakeDeps(fs, root, sessionEmitting('trip:checked-in', { actOk: false }));

    const res = (await tool(ReticleTool.FLOW_REPLAY).handler(deps, {
      flowName: 'checkin',
    })) as FlowReplayResult;
    expect(res.status).toBe(ReplayStatus.ERROR);
    expect(res.decision?.summary).toContain(CHECKED_IN);
    expect(res.decision?.whatChanged).toBeDefined();

    // A failed replay must never discharge: the ledger stays open on an outcome nothing proved.
    const [intent] = await new IntentStore(fs, root, clock).read();
    expect(intent?.state).not.toBe(IntentState.PROVED);
  });

  it('an older flow file with no intent replays exactly as it does today', async () => {
    await save('legacy');
    const deps = fakeDeps(fs, root, sessionEmitting('irrelevant'));

    const res = (await tool(ReticleTool.FLOW_REPLAY).handler(deps, {
      flowName: 'legacy',
    })) as FlowReplayResult;
    expect(res.status).toBe(ReplayStatus.OK);
    expect(res.steps).toHaveLength(1);
    expect(await new IntentStore(fs, root, clock).read()).toEqual([]);
  });
});
