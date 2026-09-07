import { describe, expect, it } from 'vitest';
import { ActionType, AnchorKind, FLOW_FILE_VERSION } from './constants.js';
import { FlowFileSchema, RecordedFlowSchema } from './flow-types.js';

/**
 * Protocol schema tests. Lock back-compat for flow files and the
 * new in-page → wire recorded-flow payload. Anchors stay semantic (testid/role/signal) — never refs.
 */
describe('FlowFileSchema', () => {
  it('a FlowFile with no dynamic/success still parses (back-compat)', () => {
    const stageA = {
      version: FLOW_FILE_VERSION,
      name: 'create-drop',
      createdAt: 1234,
      steps: [
        {
          tool: 'reticle_act',
          anchor: { kind: AnchorKind.TESTID, value: 'new-drop' },
          action: ActionType.CLICK,
          args: {},
        },
      ],
    };
    const parsed = FlowFileSchema.safeParse(stageA);
    expect(parsed.success).toBe(true);
  });

  it('accepts a component (auto-anchor) step — component + source', () => {
    const flow = {
      version: FLOW_FILE_VERSION,
      name: 'auto-anchor-flow',
      createdAt: 1234,
      steps: [
        {
          tool: 'reticle_act',
          anchor: {
            kind: AnchorKind.COMPONENT,
            component: 'NewDeployButton',
            source: { file: 'src/Deployments.tsx', line: 107, column: 4 },
          },
          action: ActionType.CLICK,
          args: {},
        },
      ],
    };
    expect(FlowFileSchema.safeParse(flow).success).toBe(true);
  });

  it('accepts an optional business intent (and a flow without it still parses)', () => {
    const base = {
      version: FLOW_FILE_VERSION,
      name: 'ship-deploy',
      createdAt: 1234,
      steps: [
        {
          tool: 'reticle_act',
          anchor: { kind: AnchorKind.TESTID, value: 'new-deploy' },
          action: ActionType.CLICK,
          args: {},
        },
      ],
    };
    const withIntent = FlowFileSchema.safeParse({
      ...base,
      intent: 'ship a deploy to production',
      success: { signal: 'deploy:shipped' },
    });
    expect(withIntent.success).toBe(true);
    if (withIntent.success) expect(withIntent.data.intent).toBe('ship a deploy to production');
    // back-compat: the same flow without intent still parses
    expect(FlowFileSchema.safeParse(base).success).toBe(true);
  });

  it('accepts an optional projectId (the recording project) and stays parseable without it', () => {
    const base = {
      version: FLOW_FILE_VERSION,
      name: 'add-task',
      createdAt: 1234,
      steps: [{ tool: 'reticle_act', anchor: { kind: AnchorKind.TESTID, value: 'task-input' } }],
    };
    const scoped = FlowFileSchema.safeParse({ ...base, projectId: 'demo-app-abc123' });
    expect(scoped.success).toBe(true);
    if (scoped.success) expect(scoped.data.projectId).toBe('demo-app-abc123');
    // back-compat: a flow with no projectId (legacy/global) still parses
    expect(FlowFileSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a step expect combining several currently-documented fields (no regression)', () => {
    const flow = {
      version: FLOW_FILE_VERSION,
      name: 'checkout',
      createdAt: 1234,
      steps: [
        {
          tool: 'reticle_act',
          anchor: { kind: AnchorKind.TESTID, value: 'submit' },
          action: ActionType.CLICK,
          args: {},
          expect: {
            signal: 'order:placed',
            net: { method: 'POST', urlContains: '/orders', status: 201, count: 1 },
            console: { absent: true },
            element: { testid: 'order-confirmation' },
            state: { store: 'cart', path: 'items.length', equals: 0 },
          },
        },
      ],
    };
    expect(FlowFileSchema.safeParse(flow).success).toBe(true);
  });

  it("rejects a step expect with an unrecognized key (e.g. a predicate kind this schema doesn't model)", () => {
    const flow = {
      version: FLOW_FILE_VERSION,
      name: 'checkout',
      createdAt: 1234,
      steps: [
        {
          tool: 'reticle_act',
          anchor: { kind: AnchorKind.TESTID, value: 'submit' },
          action: ActionType.CLICK,
          args: {},
          expect: { signal: 'order:placed', allOf: [{ signal: 'a' }, { signal: 'b' }] },
        },
      ],
    };
    // Previously silently dropped `allOf` and parsed as a bare `{ signal: 'order:placed' }` —
    // a strictly weaker assertion than the one the author wrote. Must now fail to parse.
    expect(FlowFileSchema.safeParse(flow).success).toBe(false);
  });

  it('rejects an unrecognized key nested under `expect.net` (strictness applies at every level)', () => {
    const flow = {
      version: FLOW_FILE_VERSION,
      name: 'checkout',
      createdAt: 1234,
      steps: [
        {
          tool: 'reticle_act',
          anchor: { kind: AnchorKind.TESTID, value: 'submit' },
          action: ActionType.CLICK,
          args: {},
          expect: { net: { method: 'POST', bogusField: 1 } },
        },
      ],
    };
    expect(FlowFileSchema.safeParse(flow).success).toBe(false);
  });

  it('rejects a flow-level `success` with an unrecognized key', () => {
    const flow = {
      version: FLOW_FILE_VERSION,
      name: 'checkout',
      createdAt: 1234,
      steps: [{ tool: 'reticle_act', anchor: { kind: AnchorKind.TESTID, value: 'submit' } }],
      success: { signal: 'order:placed', bogusField: true },
    };
    expect(FlowFileSchema.safeParse(flow).success).toBe(false);
  });
});

describe('RecordedFlowSchema (in-page recording payload)', () => {
  function compiled(): unknown {
    return {
      name: 'recorded-flow',
      flow: {
        version: FLOW_FILE_VERSION,
        name: 'recorded-flow',
        createdAt: 1234,
        steps: [
          {
            tool: 'reticle_act',
            anchor: { kind: AnchorKind.TESTID, value: 'save' },
            action: ActionType.CLICK,
            args: {},
            expect: { signal: 'diff:shown' },
          },
        ],
        dynamic: [{ kind: AnchorKind.TESTID, value: 'caption-text' }],
        success: { signal: 'diff:shown' },
      },
    };
  }

  it('accepts a compiled recording (steps + expect + dynamic + success)', () => {
    expect(RecordedFlowSchema.safeParse(compiled()).success).toBe(true);
  });

  it('rejects a ref-bearing anchor (anchors are testid/role/signal only)', () => {
    const bad = {
      name: 'x',
      flow: {
        version: FLOW_FILE_VERSION,
        name: 'x',
        createdAt: 0,
        steps: [{ tool: 'reticle_act', anchor: { kind: 'ref', value: 'e34' }, args: {} }],
      },
    };
    expect(RecordedFlowSchema.safeParse(bad).success).toBe(false);
  });
});
