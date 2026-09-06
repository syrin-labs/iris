/**
 * A saved flow step must be able to assert what the drive that produced it asserted.
 *
 * `reticle_act_and_wait` takes `{ kind: "allOf", predicates: [...] }`. A flow file's `expect` was a
 * flat object whose `signal` field is a string, so the same three-channel claim written the way an
 * agent already knows how to write it failed as `flow_parse_failed` with "malformed" — a JSON
 * syntax error in a file they had just written. Reducing it to `net` alone "fixed" it, which is
 * how this read as a one-kind limit.
 *
 * Coerce the act_and_wait grammar (and the sibling-channel spelling with `signal: { name, count }`)
 * into the on-disk FlowExpect shape. Name the step and key when a shape still cannot be accepted.
 */
import { describe, expect, it } from 'vitest';
import { FLOW_FILE_VERSION, FlowErrorCode, FlowFileSchema } from '@reticlehq/core';
import {
  FlowParseNote,
  coerceFlowExpect,
  coerceFlowFileExpects,
  describeFlowZodFailure,
  parseFlowFileText,
} from './flow-expect-grammar.js';

const REPORTER_EXPECT = {
  net: { method: 'POST', urlContains: '/decode', count: 1 },
  signal: { name: 'scan:complete', count: 1 },
  state: { store: 'app', path: 'scan.status', equals: 'done' },
};

const ALLOF_EXPECT = {
  kind: 'allOf',
  predicates: [
    { kind: 'net', method: 'POST', urlContains: '/decode', count: 1 },
    { kind: 'signal', name: 'scan:complete', count: 1 },
    { kind: 'state', store: 'app', path: 'scan.status', equals: 'done' },
  ],
};

const CANONICAL = {
  net: { method: 'POST', urlContains: '/decode', count: 1 },
  signal: 'scan:complete',
  signalCount: 1,
  state: { store: 'app', path: 'scan.status', equals: 'done' },
};

function flowDoc(expect: unknown): Record<string, unknown> {
  return {
    version: FLOW_FILE_VERSION,
    name: 'scan',
    createdAt: 1,
    steps: [
      {
        tool: 'reticle_act',
        anchor: { kind: 'testid', value: 'go' },
        action: 'click',
        expect,
      },
    ],
  };
}

describe('coerceFlowExpect', () => {
  it('flattens a sibling-channel expect whose signal is { name, count }', () => {
    const coerced = coerceFlowExpect(REPORTER_EXPECT);
    expect(coerced).toEqual({ ok: true, value: CANONICAL });
    expect(FlowFileSchema.safeParse(flowDoc(coerced.ok ? coerced.value : {})).success).toBe(true);
  });

  it('accepts the same allOf grammar act_and_wait already takes', () => {
    const coerced = coerceFlowExpect(ALLOF_EXPECT);
    expect(coerced).toEqual({ ok: true, value: CANONICAL });
  });

  it('accepts a single kind-tagged predicate as expect', () => {
    expect(
      coerceFlowExpect({ kind: 'net', method: 'POST', urlContains: '/decode', count: 1 }),
    ).toEqual({
      ok: true,
      value: { net: { method: 'POST', urlContains: '/decode', count: 1 } },
    });
  });

  it('leaves a canonical FlowExpect untouched', () => {
    expect(coerceFlowExpect({ signal: 'scan:complete', signalCount: 1 })).toEqual({
      ok: true,
      value: { signal: 'scan:complete', signalCount: 1 },
    });
  });

  it('refuses a kind-tagged expect that a saved flow cannot enforce, rather than stripping it to empty', () => {
    const coerced = coerceFlowExpect({ kind: 'settled' });
    expect(coerced.ok).toBe(false);
    if (coerced.ok) throw new Error('expected a refusal');
    expect(coerced.detail).toBe(FlowParseNote.UNENFORCED);
  });
});

describe('parseFlowFileText', () => {
  it("loads the reporter's three-channel expect instead of calling it malformed", () => {
    const parsed = parseFlowFileText(JSON.stringify(flowDoc(REPORTER_EXPECT)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');
    expect(parsed.value.steps[0]?.expect).toEqual(CANONICAL);
  });

  it('loads an allOf expect into the same canonical shape', () => {
    const parsed = parseFlowFileText(JSON.stringify(flowDoc(ALLOF_EXPECT)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');
    expect(parsed.value.steps[0]?.expect).toEqual(CANONICAL);
  });

  it('names bad JSON as bad JSON, not as a schema failure', () => {
    const parsed = parseFlowFileText('{not json');
    expect(parsed).toEqual({
      ok: false,
      code: FlowErrorCode.PARSE_FAILED,
      detail: FlowParseNote.NOT_JSON,
    });
  });

  it('names the step and key on an unsupported expect shape', () => {
    const parsed = parseFlowFileText(
      JSON.stringify(flowDoc({ signal: { count: 1 }, net: { method: 'POST' } })),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected parse failure');
    expect(parsed.code).toBe(FlowErrorCode.PARSE_FAILED);
    expect(parsed.detail).toContain(FlowParseNote.UNSUPPORTED_SHAPE);
    expect(parsed.detail).toContain('step 0');
    expect(parsed.detail).toContain('signal');
  });
});

describe('describeFlowZodFailure', () => {
  it('points at the step index and the key the schema could not accept', () => {
    const result = FlowFileSchema.safeParse(
      flowDoc({ signal: { count: 1 }, net: { method: 'POST' } }),
    );
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected schema failure');
    const detail = describeFlowZodFailure(result.error);
    expect(detail).toContain(FlowParseNote.UNSUPPORTED_SHAPE);
    expect(detail).toContain('step 0');
    expect(detail).toContain('signal');
  });
});

describe('coerceFlowFileExpects', () => {
  it('coerces both step expect and the flow-level success block', () => {
    const coerced = coerceFlowFileExpects({
      ...flowDoc(ALLOF_EXPECT),
      success: { kind: 'signal', name: 'scan:complete' },
    });
    expect(coerced.ok).toBe(true);
    if (!coerced.ok) throw new Error('expected ok');
    const file = coerced.value as { steps: { expect: unknown }[]; success: unknown };
    expect(file.steps[0]?.expect).toEqual(CANONICAL);
    expect(file.success).toEqual({ signal: 'scan:complete' });
  });
});
