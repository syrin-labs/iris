import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CommandResult } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import type { Session, SessionManager } from '../session/session.js';

/**
 * The QUERY handler forwards an explicit ALLOWLIST of arguments to the browser, so a newly added
 * input is silently dropped unless it is also added there. That happened with `attrs`: the zod schema
 * accepted it, the browser implemented it, and every browser-side unit test passed — because those
 * call `matchQuery` directly. Only a live run revealed the field never crossed the wire.
 *
 * These tests pin the forwarding itself. A schema and an implementation are not the whole wire.
 */

/** Capture the args the tool hands to the session command. */
function depsCapturing(seen: { args?: Record<string, unknown> | undefined }): ToolDeps {
  const command = (_cmd: string, args?: Record<string, unknown>): Promise<CommandResult> => {
    seen.args = args;
    return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: { elements: [] } });
  };
  const session: Partial<Session> = { id: 'demo', command };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return { sessions: sessions as SessionManager } as unknown as ToolDeps;
}

const queryTool = () => {
  const tool = TOOLS.find((t) => t.name === ReticleTool.QUERY);
  if (tool === undefined) throw new Error('reticle_query is not on the surface');
  return tool;
};

describe('reticle_query argument forwarding', () => {
  it('forwards `attrs` to the browser — the field is useless if the handler drops it', async () => {
    const seen: { args?: Record<string, unknown> | undefined } = {};
    await queryTool().handler(depsCapturing(seen), {
      sessionId: 's1',
      by: 'role',
      value: 'link',
      attrs: ['href'],
    });
    expect(seen.args?.['attrs']).toEqual(['href']);
  });

  it('still forwards the pre-existing targeting arguments', async () => {
    const seen: { args?: Record<string, unknown> | undefined } = {};
    await queryTool().handler(depsCapturing(seen), {
      sessionId: 's1',
      by: 'testid',
      value: 'submit',
      name: 'Save',
      scope: '#main',
    });
    expect(seen.args).toMatchObject({
      by: 'testid',
      value: 'submit',
      name: 'Save',
      scope: '#main',
    });
  });

  it('omits `attrs` when the caller did not ask for it, so the browser keeps its default shape', async () => {
    const seen: { args?: Record<string, unknown> | undefined } = {};
    await queryTool().handler(depsCapturing(seen), {
      sessionId: 's1',
      by: 'role',
      value: 'button',
    });
    expect(seen.args?.['attrs']).toBeUndefined();
  });
});

describe('QUERY output schema declares every field a descriptor can carry', () => {
  it('includes `chart`, so structuredContent does not drop it on a validating profile', () => {
    // The bug this pins: the browser `describe()` adds a `chart` field to a broken chart's descriptor,
    // but the QUERY outputSchema listed ref/role/name/value/states/visible/attrs/source and NOT chart.
    // On the `full` profile (which keeps outputSchema and validates structuredContent), the SDK drops
    // any field the schema does not list — so the chart faults silently vanished from structuredContent
    // while the text block still carried them. A field the tool RETURNS must be in the schema it
    // DECLARES, or the two disagree exactly where a schema-consuming client trusts the schema.
    const query = TOOLS.find((t) => t.name === ReticleTool.QUERY);
    const elements = query?.outputSchema?.['elements'];
    // elements is ZodOptional<ZodArray<ZodObject>>. Walk it with zod's PUBLIC api (no _def spelunking).
    if (!(elements instanceof z.ZodOptional))
      throw new Error('elements is not optional as expected');
    const arr = elements.unwrap() as z.ZodTypeAny;
    if (!(arr instanceof z.ZodArray)) throw new Error('elements is not an array as expected');
    const obj = arr.element as z.ZodTypeAny;
    if (!(obj instanceof z.ZodObject)) throw new Error('element is not an object as expected');
    const keys = Object.keys((obj as z.ZodObject<z.ZodRawShape>).shape);
    expect(keys).toContain('chart');
    expect(keys).toContain('source');
  });

  it('the STATE tool declares `truncation` — a false-green guard must survive schema validation', () => {
    // Same class as the chart drop, but worse: truncation is the marker that says "this is NOT the
    // whole store". If it drops on the validating `full` profile, a structuredContent consumer gets a
    // partial store with no warning — the exact silent truncation the marker exists to prevent.
    const state = TOOLS.find((t) => t.name === ReticleTool.STATE);
    expect(Object.keys(state?.outputSchema ?? {})).toContain('truncation');
  });

  it('the ASSERT tool declares `coverage` — the partial-observation warning must not drop', () => {
    const assert = TOOLS.find((t) => t.name === ReticleTool.ASSERT);
    const keys = Object.keys(assert?.outputSchema ?? {});
    expect(keys).toContain('coverage');
    expect(keys).toContain('coverage_spots');
  });

  it('wait/assert/act_and_wait declare `inconclusive` — a throttled-tab miss must not drop', () => {
    // Same silent-drop class as coverage: a validating profile strips undeclared fields, so a
    // starved-tab wait that only names the miss in `inconclusive` would arrive as a bare near-miss
    // again — the exact confusion this field exists to prevent.
    for (const name of [ReticleTool.WAIT_FOR, ReticleTool.ASSERT]) {
      expect(Object.keys(TOOLS.find((t) => t.name === name)?.outputSchema ?? {})).toContain(
        'inconclusive',
      );
    }
    const verdict = TOOLS.find((t) => t.name === ReticleTool.ACT_AND_WAIT)?.outputSchema?.[
      'verdict'
    ];
    if (!(verdict instanceof z.ZodObject))
      throw new Error('act_and_wait verdict is not an object schema');
    expect(Object.keys((verdict as z.ZodObject<z.ZodRawShape>).shape)).toContain('inconclusive');
  });
});
