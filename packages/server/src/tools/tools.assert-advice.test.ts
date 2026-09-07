import { describe, it, expect } from 'vitest';
import { EventType, ReticleCommand, type CommandResult, type ReticleEvent } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import type { SessionManager } from '../session/session.js';
import { createFakeSession } from '../session/fake-session.js';

/** A session whose MATCH answers `matched`, and whose buffer is a fixed event list. */
function depsWith(opts: { matched?: boolean; events?: ReticleEvent[] }): ToolDeps {
  const matchResult = {
    matched: opts.matched ?? false,
    count: true === opts.matched ? 1 : 0,
    elements:
      true === opts.matched
        ? [{ ref: 'e1', role: 'button', name: 'X', states: [], visible: true }]
        : [],
  };
  const stub = createFakeSession({
    command: (name: string): Promise<CommandResult> =>
      Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: name === ReticleCommand.MATCH ? matchResult : {},
      }),
    eventsSince: () => opts.events ?? [],
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    // A verdict now carries the buffer-honesty block, so the fake has to be able to report it.
    // An intact buffer keeps the block omitted, which is what these advice assertions expect.
    bufferHealth: () => ({ total: 0, dropped: 0 }),
  });
  const sessions: Partial<SessionManager> = { resolve: () => stub };
  return { sessions: sessions as SessionManager } as ToolDeps;
}

function assertTool() {
  const t = TOOLS.find((x) => x.name === ReticleTool.ASSERT);
  if (t === undefined) throw new Error('no reticle_assert tool');
  return t;
}

const signal = (name: string): ReticleEvent => ({
  t: 1,
  type: EventType.SIGNAL,
  sessionId: 's',
  data: { name, data: {} },
});

describe('reticle_assert presence-only advice', () => {
  it('attaches advice to a PASSING presence-only (element) assertion', async () => {
    const r = (await assertTool().handler(depsWith({ matched: true }), {
      predicate: { kind: 'element', query: { role: 'button' } },
    })) as { pass: boolean; advice?: string };
    expect(r.pass).toBe(true);
    expect(r.advice).toContain('consequence');
  });

  it('does NOT attach advice to a signal consequence assertion', async () => {
    const r = (await assertTool().handler(depsWith({ events: [signal('order:placed')] }), {
      predicate: { kind: 'signal', name: 'order:placed' },
    })) as { pass: boolean; advice?: string };
    expect(r.pass).toBe(true);
    expect(r.advice).toBeUndefined();
  });

  it('does NOT attach advice to a FAILING presence assertion (moot)', async () => {
    const r = (await assertTool().handler(depsWith({ matched: false }), {
      predicate: { kind: 'element', query: { role: 'button' } },
    })) as { pass: boolean; advice?: string };
    expect(r.pass).toBe(false);
    expect(r.advice).toBeUndefined();
  });
});
