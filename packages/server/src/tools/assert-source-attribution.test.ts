/**
 * An assertion's `source` must describe the assertion's OWN evidence, or be absent.
 *
 * `reticle_assert` drives nothing, so `session.lastAct.source()` is whatever unrelated action ran
 * before it. Measured on a Next.js app: an assert on `{ role: 'navigation' }` whose evidence lived at
 * `ui/global-nav.tsx:54` was journaled as `app/page.tsx:22` — the previous CLICK's file — and an
 * assert that matched nothing at all was journaled the same way. Both are persisted into the session
 * journal and read back by `reticle_context`'s `proven`, so a wrong file:line outlives the turn that
 * produced it.
 *
 * The repo already holds this line in three other places (the instrumentation gap that refuses to
 * borrow the acted line, the undeclared-change gap that carries no source at all, the flow intent
 * that is never derived from step names): absence beats a wrong pointer, because a guessed pointer
 * costs the trip AND leaves the agent further from the code.
 *
 * The one borrow that stays is the documented one: a failure with no DOM element of its own — a
 * signal that never fired, a request never made — has nowhere else to point, and the control that
 * was last driven is where that handler lives. That is stated in the tool's own output schema.
 */

import { describe, expect, it } from 'vitest';
import { type CommandResult, type ReticleEvent } from '@reticlehq/core';
import { LastAct } from '../session/last-act.js';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import type { Session, SessionManager } from '../session/session.js';
import { createFakeSession } from '../session/fake-session.js';

const ACTED_SOURCE = 'app/page.tsx:22';
const NAV_SOURCE = 'ui/global-nav.tsx:54';

const tool = (name: string): ToolDef => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`${name} is not on the surface`);
  return found;
};

interface Recorded {
  effect: unknown;
}

/** A session whose element matcher returns exactly `elements`, with an act already remembered. */
function fakeSession(
  elements: readonly Record<string, unknown>[],
  recorded: Recorded,
): { session: Session; deps: ToolDeps } {
  const lastAct = new LastAct();
  lastAct.markSource(ACTED_SOURCE);
  const noEvents: ReticleEvent[] = [];
  const command = (): Promise<CommandResult> =>
    Promise.resolve({
      kind: 'command_result',
      id: 'c',
      ok: true,
      result: { matched: elements.length > 0, count: elements.length, elements },
    });
  const stub = createFakeSession(
    {
      lastAct,
      command,
      recordAction: (_tool: string, _args: Record<string, unknown>, effect?: unknown): string => {
        recorded.effect = effect;
        return 'a1';
      },
      bufferHealth: () => ({ total: 5, dropped: 0 }),
      eventsSince: () => noEvents,
      queryEvents: () => Promise.resolve(noEvents),
      elapsed: () => 1000,
      health: () => ({ lastSeenMs: 5, throttled: false, focused: true }),
    },
    { url: 'http://localhost:3000/' },
  );
  const session = stub;
  const sessions: Partial<SessionManager> = { resolve: () => session };
  return { session, deps: { sessions: sessions as SessionManager } as unknown as ToolDeps };
}

const navPredicate = {
  predicate: { kind: 'element', query: { role: 'navigation' } },
  timeout_ms: 0,
};
const signalPredicate = { predicate: { kind: 'signal', name: 'todos:loaded' }, timeout_ms: 0 };

const runAssert = async (
  elements: readonly Record<string, unknown>[],
  args: Record<string, unknown> = navPredicate,
): Promise<{ result: Record<string, unknown>; effect: Record<string, unknown> }> => {
  const recorded: Recorded = { effect: undefined };
  const { deps } = fakeSession(elements, recorded);
  const result = (await tool(ReticleTool.ASSERT).handler(deps, args)) as Record<string, unknown>;
  return { result, effect: (recorded.effect ?? {}) as Record<string, unknown> };
};

const descriptor = (source?: string): Record<string, unknown> => ({
  ref: 'e1',
  tag: 'nav',
  role: 'navigation',
  name: 'Main',
  states: [],
  visible: true,
  ...(source === undefined ? {} : { source }),
});

describe('an assert reports the source of its OWN evidence', () => {
  it('names the matched element, not the element the previous act clicked', async () => {
    const { result, effect } = await runAssert([descriptor(NAV_SOURCE)]);

    expect(result['pass']).toBe(true);
    expect(effect['source']).toBe(NAV_SOURCE);
    expect(result['source']).toBe(NAV_SOURCE);
  });

  it('omits the source when the matched element carries none', async () => {
    const { result, effect } = await runAssert([descriptor()]);

    expect(result['pass']).toBe(true);
    expect('source' in effect).toBe(false);
    expect('source' in result).toBe(false);
  });

  it('omits the source when the assertion matched nothing', async () => {
    const { result, effect } = await runAssert([]);

    expect(result['pass']).toBe(false);
    expect('source' in effect).toBe(false);
    expect('source' in result).toBe(false);
  });

  it('omits the source when the matched elements disagree about where they live', async () => {
    // Two loci and no way to choose — the same reason a guessed pointer is worse than none.
    const { result, effect } = await runAssert([descriptor(NAV_SOURCE), descriptor(ACTED_SOURCE)]);

    expect(result['pass']).toBe(true);
    expect('source' in effect).toBe(false);
    expect('source' in result).toBe(false);
  });

  it('the journal effect and the tool response agree for the same verdict', async () => {
    for (const elements of [[descriptor(NAV_SOURCE)], [descriptor()], []]) {
      const { result, effect } = await runAssert(elements);
      expect(effect['source']).toBe(result['source']);
    }
  });

  it('still points at the last driven control when the failure has no element of its own', async () => {
    // The documented borrow: a signal that never fired has no DOM node, and the handler that should
    // have fired it lives with the control that was clicked. Stated in the output schema.
    const { result, effect } = await runAssert([], signalPredicate);

    expect(result['pass']).toBe(false);
    expect(result['source']).toBe(ACTED_SOURCE);
    expect(effect['source']).toBe(ACTED_SOURCE);
  });
});

/**
 * The act path is a different question and must not move.
 *
 * `act_and_wait` DID drive an element, so the file:line it captured at act time is that element's —
 * a fact, not a borrow. It is written to the journal on every verdict and promoted into the response
 * on red only.
 */
describe('act_and_wait still reports the element it drove', () => {
  const ACT_ROOT = '/tmp/reticle-test/.reticle';
  const ACT_SOURCE = { file: 'ui/save-button.tsx', line: 12 };
  const ACT_LABEL = 'ui/save-button.tsx:12';

  function actDeps(recorded: Recorded): ToolDeps {
    const noEvents: ReticleEvent[] = [];
    const command = (): Promise<CommandResult> =>
      Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: {
          dispatched: true,
          settled: true,
          source: ACT_SOURCE,
          effect: { domMutatedWithin: 1 },
        },
      });
    const stub = createFakeSession(
      {
        command,
        finishAction: (effect?: unknown): void => {
          recorded.effect = effect;
        },
        queryEvents: () => Promise.resolve(noEvents),
        eventsSince: () => noEvents,
        bufferHealth: () => ({ total: 10, dropped: 0 }),
        health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
        elapsed: () => 1000,
      },
      { url: 'http://localhost:3000/' },
    );
    const sessions: Partial<SessionManager> = { resolve: () => stub };
    return {
      sessions,
      baselines: new BaselineStore(),
      recordings: new RecordingStore(),
      flows: new FlowStore(createNodeFileSystem(), ACT_ROOT, { now: () => 0 }),
      project: new ProjectStore(createNodeFileSystem(), ACT_ROOT, { now: () => 0 }),
      annotations: new AnnotationStore(),
      fs: createNodeFileSystem(),
      reticleRoot: ACT_ROOT,
      now: () => 0,
    } as unknown as ToolDeps;
  }

  it('journals the driven element as the verdict source', async () => {
    const recorded: Recorded = { effect: undefined };
    await tool(ReticleTool.ACT_AND_WAIT).handler(actDeps(recorded), {
      ref: 'e1',
      action: 'click',
      until: { kind: 'settled' },
    });

    expect((recorded.effect as Record<string, unknown>)['source']).toBe(ACT_LABEL);
  });
});
