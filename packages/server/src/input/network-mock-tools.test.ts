import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CDP_NO_PROVIDER_REASON } from '@reticlehq/core';
import { NETWORK_MOCK_TOOLS } from './network-mock-tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import type { MockRule } from './network-mock.js';
import type { RealInputProvider } from './real-input.js';
import type { SessionManager } from '../session/session.js';
import type { ToolDeps } from '../tools/tools.js';

function tool() {
  const t = NETWORK_MOCK_TOOLS.find((x) => x.name === ReticleTool.NETWORK_MOCK);
  if (t === undefined) throw new Error('no reticle_network_mock tool');
  return t;
}

function depsWith(
  realInput: RealInputProvider | undefined,
  pool?: { setMocksLease: (id: string, rules: MockRule[]) => Promise<boolean> },
): ToolDeps {
  const sessions: Partial<SessionManager> = {
    resolve: () => ({ id: 'lease-1', url: 'http://localhost:5173/checkout' }) as never,
  };
  return { sessions: sessions as SessionManager, realInput, pool } as unknown as ToolDeps;
}

interface MockResult {
  applied: boolean;
  count: number;
  ok?: boolean;
  reason?: string;
}

describe('reticle_network_mock tool', () => {
  it('returns the no-provider envelope when nothing is driving the page', async () => {
    const res = (await tool().handler(depsWith(undefined), {
      mocks: [{ urlContains: '/api/pay', status: 500 }],
    })) as MockResult;
    expect(res.applied).toBe(false);
    expect(res.ok).toBe(false);
    // NOT the visual code: this tool mocks requests / resizes windows, and an agent gating on
    // "no-visual-provider" here would be matching on a false statement about what it asked for.
    expect(res.reason).toBe(CDP_NO_PROVIDER_REASON);
  });

  /**
   * A lease IS a Playwright-owned page. The tool used to look only at `realInput` (reticle drive /
   * RETICLE_CDP_URL) and refuse the isolated context the docs point agents at. Screenshot and hover
   * already fall through to the pool; mocking has to as well.
   */
  it('applies the rules to a leased page when no drive provider is attached', async () => {
    let captured: { id: string; rules: MockRule[] } | undefined;
    const res = (await tool().handler(
      depsWith(undefined, {
        setMocksLease: (id, rules) => {
          captured = { id, rules };
          return Promise.resolve(true);
        },
      }),
      { mocks: [{ urlContains: '/api/pay', status: 500 }] },
    )) as MockResult;
    expect(res.applied).toBe(true);
    expect(res.count).toBe(1);
    expect(captured?.id).toBe('lease-1');
    expect(captured?.rules).toEqual([{ urlContains: '/api/pay', status: 500 }]);
  });

  it('does not consult the pool when the driven provider already applied', async () => {
    const setMocksLease = (): Promise<boolean> => {
      throw new Error('lease must not run when drive applied');
    };
    const provider = {
      isAvailableFor: () => Promise.resolve(true),
      perform: () => Promise.resolve({ performed: true, center: { cx: 0, cy: 0 } }),
      setMocks: () => Promise.resolve(true),
    } as unknown as RealInputProvider;
    const res = (await tool().handler(depsWith(provider, { setMocksLease }), {
      mocks: [{ urlContains: '/api/pay', status: 500 }],
    })) as MockResult;
    expect(res.applied).toBe(true);
  });

  it('falls through to the lease when the driven provider is attached but cannot match this URL', async () => {
    let leased = false;
    const provider = {
      isAvailableFor: () => Promise.resolve(true),
      perform: () => Promise.resolve({ performed: true, center: { cx: 0, cy: 0 } }),
      setMocks: () => Promise.resolve(false),
    } as unknown as RealInputProvider;
    const res = (await tool().handler(
      depsWith(provider, {
        setMocksLease: () => {
          leased = true;
          return Promise.resolve(true);
        },
      }),
      { mocks: [{ urlContains: '/api/pay', status: 500 }] },
    )) as MockResult;
    expect(leased).toBe(true);
    expect(res.applied).toBe(true);
    expect(res.count).toBe(1);
  });

  it('applies the rules to the driven page and reports the count', async () => {
    let captured: { url: string; rules: MockRule[] } | undefined;
    const provider = {
      isAvailableFor: () => Promise.resolve(true),
      perform: () => Promise.resolve({ performed: true, center: { cx: 0, cy: 0 } }),
      setMocks: (url: string, rules: MockRule[]) => {
        captured = { url, rules };
        return Promise.resolve(true);
      },
    } as unknown as RealInputProvider;

    const res = (await tool().handler(depsWith(provider), {
      mocks: [{ urlContains: '/api/pay', method: 'POST', status: 500, abort: undefined }],
    })) as MockResult;
    expect(res.applied).toBe(true);
    expect(res.count).toBe(1);
    expect(captured?.url).toBe('http://localhost:5173/checkout');
    // undefined optional keys are stripped (exactOptionalPropertyTypes safety).
    expect(captured?.rules[0]).toEqual({ urlContains: '/api/pay', method: 'POST', status: 500 });
  });

  it('clear:true sends an empty rule set (mocking off)', async () => {
    let captured: MockRule[] | undefined;
    const provider = {
      isAvailableFor: () => Promise.resolve(true),
      perform: () => Promise.resolve({ performed: true, center: { cx: 0, cy: 0 } }),
      setMocks: (_url: string, rules: MockRule[]) => {
        captured = rules;
        return Promise.resolve(true);
      },
    } as unknown as RealInputProvider;

    const res = (await tool().handler(depsWith(provider), { clear: true })) as MockResult;
    expect(captured).toEqual([]);
    expect(res.applied).toBe(true);
    expect(res.count).toBe(0);
  });
});

describe('the mocks description names the rule shape (#345)', () => {
  /** Field names the `mocks` description advertises, e.g. `{ urlContains, method?, ... }`. */
  function advertisedFields(description: string): string[] {
    const shape = /\{([^}]*)\}/.exec(description);
    const inner = shape?.[1];
    if (undefined === inner) return [];
    return inner
      .split(',')
      .map((f) => f.trim().replace(/\?$/, ''))
      .filter((f) => f.length > 0);
  }

  function mocksSchema(): z.ZodTypeAny {
    const schema = tool().inputSchema['mocks'];
    if (undefined === schema) throw new Error('no mocks param');
    return schema;
  }

  function mocksDescription(): string {
    return mocksSchema().description ?? '';
  }

  /** The rule schema's own field names, read off the wired tool. */
  function ruleFields(): string[] {
    const mocks = mocksSchema();
    const array: unknown = mocks instanceof z.ZodOptional ? mocks.unwrap() : mocks;
    if (!(array instanceof z.ZodArray)) throw new Error('mocks is no longer an array schema');
    const element: unknown = array.element;
    if (!(element instanceof z.ZodObject)) throw new Error('mocks elements are no longer objects');
    const shape: unknown = element.shape;
    if (null === shape || 'object' !== typeof shape) throw new Error('rule schema has no shape');
    return Object.keys(shape);
  }

  it('names every field of the rule schema', () => {
    // The params view flattens nested schemas, so the array's own description is
    // the only place an agent can learn the shape. Deriving the expectation from
    // the schema is what makes this catch the direction that bites: a field added
    // to the rule and never advertised. A hardcoded list only catches the reverse.
    expect(advertisedFields(mocksDescription())).toEqual(ruleFields());
  });

  it('still says how to clear, which is the other half of the contract', () => {
    expect(mocksDescription()).toMatch(/clear/i);
  });

  it('says a leased tab is a driven context, not only reticle drive', () => {
    expect(tool().description).toMatch(/lease/i);
  });
});
