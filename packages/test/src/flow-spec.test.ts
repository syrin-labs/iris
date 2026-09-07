import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  DriftReason,
  FLOW_FILE_VERSION,
  FlowErrorCode,
  ReticleCommand,
  type CommandResult,
  type FlowFile,
  type ReticleEvent,
} from '@reticlehq/core';
import type { Clock, EvalResult, FileSystemPort } from '@reticlehq/server';
import { FlowStore } from '@reticlehq/server';
import { SpecKind, SpecMessage, SpecOutcome } from './constants.js';
import { flowToSpec, flowsAsSpecs } from './flow-spec.js';

const FIXED_MS = 1_700_000_000_000;
const fixedClock: Clock = { now: () => FIXED_MS };

/** An in-memory FileSystemPort over .reticle/flows so a unit test never touches the repo. */
/**
 * Normalise separators at the boundary.
 *
 * These fixtures are keyed with POSIX paths, and the code under test builds its paths with `join()`
 * — correctly, because those paths are real on a user's disk. On Windows that yields backslashes,
 * every lookup here missed, and `list()` returned nothing: six tests failed by enumerating an empty
 * store rather than by anything being wrong. The same fixture bug existed in two other packages.
 *
 * Normalising in the PORT, not in the assertions, keeps every test written in one style and means a
 * new one cannot reintroduce it.
 */
const norm = (p: string): string => p.replace(/\\/g, '/');

function memoryFs(files: Record<string, string>): FileSystemPort {
  const store = new Map<string, string>(Object.entries(files));
  return {
    readFile: (path) => {
      const v = store.get(norm(path));
      if (v === undefined)
        return Promise.reject(Object.assign(new Error('enoent'), { code: 'ENOENT' }));
      return Promise.resolve(v);
    },
    writeFile: (path, data) => {
      store.set(norm(path), data);
      return Promise.resolve();
    },
    appendFile: (path, data) => {
      store.set(norm(path), (store.get(norm(path)) ?? '') + data);
      return Promise.resolve();
    },
    readFileBytes: (path) => {
      const v = store.get(norm(path));
      if (v === undefined)
        return Promise.reject(Object.assign(new Error('enoent'), { code: 'ENOENT' }));
      return Promise.resolve(new TextEncoder().encode(v));
    },
    writeFileBytes: (path, data) => {
      store.set(norm(path), new TextDecoder().decode(data));
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(),
    exists: (path) =>
      Promise.resolve(
        store.has(norm(path)) || [...store.keys()].some((k) => k.startsWith(`${norm(path)}/`)),
      ),
    readdir: (path) =>
      Promise.resolve(
        [...store.keys()]
          .filter((k) => k.startsWith(`${norm(path)}/`))
          .map((k) => k.slice(norm(path).length + 1))
          .filter((k) => !k.includes('/')),
      ),
    rename: (from, to) => {
      const v = store.get(norm(from));
      if (v !== undefined) {
        store.set(norm(to), v);
        store.delete(norm(from));
      }
      return Promise.resolve();
    },
    rm: (path) => {
      store.delete(norm(path));
      return Promise.resolve();
    },
    stat: () => Promise.resolve({ mtimeMs: 0, size: 0 }),
    realpath: (path: string) => Promise.resolve(path),
    isNotFound: (error) => 'ENOENT' === (error as { code?: string } | undefined)?.code,
  };
}

const ROOT = '/tmp/reticle-root/.reticle';
const FLOWS_DIR = '/tmp/reticle-root/.reticle/flows';

/** A fake replay session: scripted DOM testids + a scripted event buffer (signals/net). */
interface FakeSessionConfig {
  testids: string[]; // testids present in the fake DOM
  events?: ReticleEvent[]; // event buffer evaluatePredicate reads
}

function ok(result: unknown): CommandResult {
  return { kind: 'command_result', id: 'x', ok: true, result };
}

function fakeSession(config: FakeSessionConfig): FlowReplaySessionLike {
  const present = new Set(config.testids);
  const events = config.events ?? [];
  const command = (name: string, args?: Record<string, unknown>): Promise<CommandResult> => {
    if (name === ReticleCommand.QUERY) {
      const raw = args?.['value'];
      const value = 'string' === typeof raw ? raw : '';
      const has = present.has(value);
      return Promise.resolve(
        ok({
          elements: has ? [{ ref: `e-${value}` }] : [],
          hint: has
            ? undefined
            : { route: '/', presentTestids: config.testids, knownEmptyState: false },
        }),
      );
    }
    if (name === ReticleCommand.MATCH) {
      const query = (args?.['query'] ?? {}) as { testid?: string };
      const testid = query.testid ?? '';
      const matched = present.has(testid);
      return Promise.resolve(
        ok(
          matched
            ? {
                matched: true,
                count: 1,
                elements: [{ ref: `e-${testid}`, role: '', name: '', states: [], visible: true }],
              }
            : { matched: false, count: 0, elements: [] },
        ),
      );
    }
    // ACT
    return Promise.resolve(ok({}));
  };
  return {
    command,
    eventsSince: () => events,
    onEvent: () => () => {},
    elapsed: () => 0,
  };
}

// Local structural alias so the test file doesn't depend on the exact import name surfacing.
interface FlowReplaySessionLike {
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  eventsSince(cursor: number): ReticleEvent[];
  onEvent(listener: (event: ReticleEvent) => void): () => void;
  elapsed(): number;
}

/** A waiter that synchronously evaluates a signal predicate against the fake event buffer. */
function signalWait(events: ReticleEvent[]) {
  return (
    _session: FlowReplaySessionLike,
    predicate: { kind: string; name?: string },
  ): Promise<EvalResult> => {
    if (predicate.kind !== 'signal') return Promise.resolve({ pass: false });
    const hit = events.find((e) => 'signal' === e.type && e.data['name'] === predicate.name);
    if (hit !== undefined) return Promise.resolve({ pass: true, evidence: hit.data });
    return Promise.resolve({
      pass: false,
      failureReason: `signal '${predicate.name}' not observed`,
    });
  };
}

function signalEvent(name: string): ReticleEvent {
  return { t: 1, type: 'signal', data: { name, data: {} } } as unknown as ReticleEvent;
}

function testidStepFlow(opts: {
  name: string;
  stepTestid: string;
  expectTestid?: string;
  success?: FlowFile['success'];
  dynamic?: string[];
}): FlowFile {
  const flow: FlowFile = {
    version: FLOW_FILE_VERSION,
    name: opts.name,
    createdAt: FIXED_MS,
    steps: [
      {
        tool: 'reticle_act',
        anchor: { kind: AnchorKind.TESTID, value: opts.stepTestid },
        action: 'click',
        ...(opts.expectTestid !== undefined
          ? { expect: { element: { testid: opts.expectTestid } } }
          : {}),
      },
    ],
  };
  if (opts.success !== undefined) flow.success = opts.success;
  if (opts.dynamic !== undefined) {
    flow.dynamic = opts.dynamic.map((value) => ({ kind: AnchorKind.TESTID, value }));
  }
  return flow;
}

describe('flowToSpec — RUNNABLE', () => {
  it('#1 passing success predicate -> spec PASS', async () => {
    const flow = testidStepFlow({
      name: 'save-draft',
      stepTestid: 'save-btn',
      success: { signal: 'flow:done' },
    });
    const events = [signalEvent('flow:done')];
    const spec = flowToSpec(flow, { waitForSignal: signalWait(events) });
    expect(spec.kind).toBe(SpecKind.RUNNABLE);
    const result = await spec.run(fakeSession({ testids: ['save-btn'], events }));
    expect(result.outcome).toBe(SpecOutcome.PASS);
    expect(result.successResult.pass).toBe(true);
    expect(result.steps.every((s) => s.ok)).toBe(true);
  });

  it('#2 per-step expect asserted via replay (present -> no drift)', async () => {
    const flow = testidStepFlow({
      name: 'save-draft',
      stepTestid: 'save-btn',
      expectTestid: 'saved-badge',
    });
    const spec = flowToSpec(flow, { waitForSignal: signalWait([]) });
    const result = await spec.run(fakeSession({ testids: ['save-btn', 'saved-badge'] }));
    expect(result.outcome).toBe(SpecOutcome.PASS);
    expect(result.steps[0]?.drift).toBeUndefined();
  });

  it('#3 asserted signal never fires -> spec FAIL with evidence', async () => {
    const flow = testidStepFlow({
      name: 'save-draft',
      stepTestid: 'save-btn',
      success: { signal: 'flow:done' },
    });
    const spec = flowToSpec(flow, { waitForSignal: signalWait([]) });
    const result = await spec.run(fakeSession({ testids: ['save-btn'], events: [] }));
    expect(result.outcome).toBe(SpecOutcome.FAIL);
    expect(result.message).toBe(SpecMessage.SUCCESS_NOT_MET);
    expect(result.successResult.pass).toBe(false);
    expect(result.successResult.failureReason).toBeTruthy();
  });

  it('#4 step anchor drift -> spec FAIL, replay stops', async () => {
    const flow = testidStepFlow({ name: 'save-draft', stepTestid: 'save-btn' });
    const spec = flowToSpec(flow, { waitForSignal: signalWait([]) });
    // save-btn absent; a near testid present so drift carries a nearest survivor.
    const result = await spec.run(fakeSession({ testids: ['save-bton'] }));
    expect(result.outcome).toBe(SpecOutcome.FAIL);
    expect(result.message).toBe(SpecMessage.STEP_DRIFT);
    expect(result.steps[0]?.drift?.reasonKind).toBe(DriftReason.TESTID_NOT_FOUND);
    expect(result.steps[0]?.drift?.nearest).toBe('save-bton');
    expect(result.steps).toHaveLength(1);
  });

  it('#5 dynamic-marked anchor is NOT asserted (skipped)', async () => {
    const flow = testidStepFlow({
      name: 'ai-flow',
      stepTestid: 'gen-btn',
      expectTestid: 'ai-output',
      dynamic: ['ai-output'],
    });
    const spec = flowToSpec(flow, { waitForSignal: signalWait([]) });
    // ai-output ABSENT — but it is dynamic, so the expect on it must be skipped.
    const result = await spec.run(fakeSession({ testids: ['gen-btn'] }));
    expect(result.outcome).toBe(SpecOutcome.PASS);
  });

  it('#5b negative control: same flow without dynamic -> FAIL with drift on ai-output', async () => {
    const flow = testidStepFlow({
      name: 'ai-flow',
      stepTestid: 'gen-btn',
      expectTestid: 'ai-output',
    });
    const spec = flowToSpec(flow, { waitForSignal: signalWait([]) });
    const result = await spec.run(fakeSession({ testids: ['gen-btn'] }));
    expect(result.outcome).toBe(SpecOutcome.FAIL);
    expect(result.steps[0]?.drift?.anchor).toBe('ai-output');
  });

  it('#6 dynamic success field skipped -> success vacuously met', async () => {
    const flow = testidStepFlow({
      name: 'ai-flow',
      stepTestid: 'gen-btn',
      success: { element: { testid: 'ai-output' } },
      dynamic: ['ai-output'],
    });
    const spec = flowToSpec(flow, { waitForSignal: signalWait([]) });
    const result = await spec.run(fakeSession({ testids: ['gen-btn'] }));
    expect(result.outcome).toBe(SpecOutcome.PASS);
    expect(result.successResult.pass).toBe(true);
  });

  it('#10 no success condition -> PASS on steps alone', async () => {
    const flow = testidStepFlow({ name: 'save-draft', stepTestid: 'save-btn' });
    const spec = flowToSpec(flow, { waitForSignal: signalWait([]) });
    const result = await spec.run(fakeSession({ testids: ['save-btn'] }));
    expect(result.outcome).toBe(SpecOutcome.PASS);
    expect(result.successResult.pass).toBe(true);
  });

  it('#12 signalTimeout injected is threaded, never wall-clock', async () => {
    const flow = testidStepFlow({
      name: 'save-draft',
      stepTestid: 'save-btn',
      success: { signal: 'flow:done' },
    });
    const seen: number[] = [];
    const recordingWait = (_s: unknown, _p: unknown, timeoutMs: number): Promise<EvalResult> => {
      seen.push(timeoutMs);
      return Promise.resolve({ pass: true });
    };
    const spec = flowToSpec(flow, { waitForSignal: recordingWait, signalTimeoutMs: 10 });
    await spec.run(fakeSession({ testids: ['save-btn'] }));
    expect(seen).toContain(10);
  });
});

describe('flowsAsSpecs — enumeration', () => {
  function serialize(flow: FlowFile): string {
    return `${JSON.stringify(flow, null, 2)}\n`;
  }

  it('#7 empty flows dir -> zero specs, no throw', async () => {
    const fs = memoryFs({});
    const specs = await flowsAsSpecs(ROOT, {
      fs,
      clock: fixedClock,
      waitForSignal: signalWait([]),
    });
    expect(specs).toEqual([]);
  });

  it('#7b absent flows dir -> zero specs, no throw', async () => {
    const fs = memoryFs({ '/tmp/reticle-root/.reticle/contract.json': '{}' });
    const specs = await flowsAsSpecs(ROOT, {
      fs,
      clock: fixedClock,
      waitForSignal: signalWait([]),
    });
    expect(specs).toEqual([]);
  });

  it('#8 malformed flow file -> ERROR spec, others still run', async () => {
    const good = testidStepFlow({ name: 'good', stepTestid: 'save-btn' });
    const fs = memoryFs({
      [`${FLOWS_DIR}/good.json`]: serialize(good),
      [`${FLOWS_DIR}/bad.json`]: '{ this is not valid json',
    });
    const specs = await flowsAsSpecs(ROOT, {
      fs,
      clock: fixedClock,
      waitForSignal: signalWait([]),
    });
    expect(specs).toHaveLength(2);
    const bad = specs.find((s) => 'bad' === s.name);
    const goodSpec = specs.find((s) => 'good' === s.name);
    expect(bad?.kind).toBe(SpecKind.ERROR);
    expect(bad?.loadError?.code).toBe(FlowErrorCode.PARSE_FAILED);
    expect(goodSpec?.kind).toBe(SpecKind.RUNNABLE);
    const result = await goodSpec?.run?.(fakeSession({ testids: ['save-btn'] }));
    expect(result?.outcome).toBe(SpecOutcome.PASS);
  });

  it('#8b schema-invalid flow file -> ERROR spec with PARSE_FAILED', async () => {
    const fs = memoryFs({
      [`${FLOWS_DIR}/wrongver.json`]: JSON.stringify({
        version: 99,
        name: 'wrongver',
        createdAt: 1,
        steps: [],
      }),
    });
    const specs = await flowsAsSpecs(ROOT, {
      fs,
      clock: fixedClock,
      waitForSignal: signalWait([]),
    });
    expect(specs[0]?.kind).toBe(SpecKind.ERROR);
    expect(specs[0]?.loadError?.code).toBe(FlowErrorCode.PARSE_FAILED);
  });

  it('#9 invalid flow name on disk -> ERROR spec with INVALID_NAME, sibling unaffected', async () => {
    const good = testidStepFlow({ name: 'good', stepTestid: 'save-btn' });
    const fs = memoryFs({
      [`${FLOWS_DIR}/good.json`]: serialize(good),
      // A leading-dot name fails isValidFlowName -> FlowStore.load returns INVALID_NAME.
      [`${FLOWS_DIR}/.secret.json`]: serialize(good),
    });
    const specs = await flowsAsSpecs(ROOT, {
      fs,
      clock: fixedClock,
      waitForSignal: signalWait([]),
    });
    const bad = specs.find((s) => '.secret' === s.name);
    expect(bad?.kind).toBe(SpecKind.ERROR);
    expect(bad?.loadError?.code).toBe(FlowErrorCode.INVALID_NAME);
    expect(specs.find((s) => 'good' === s.name)?.kind).toBe(SpecKind.RUNNABLE);
  });

  it('accepts a pre-built FlowStore as the source', async () => {
    const good = testidStepFlow({ name: 'good', stepTestid: 'save-btn' });
    const fs = memoryFs({ [`${FLOWS_DIR}/good.json`]: serialize(good) });
    const store = new FlowStore(fs, ROOT, fixedClock);
    const specs = await flowsAsSpecs(store, { waitForSignal: signalWait([]) });
    expect(specs).toHaveLength(1);
    expect(specs[0]?.kind).toBe(SpecKind.RUNNABLE);
  });
});
