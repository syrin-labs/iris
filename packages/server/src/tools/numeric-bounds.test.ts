/**
 * A known parameter carrying a value the code cannot honour is the same failure as an unknown
 * parameter: the result looks like an answer. #551.
 */
import { describe, expect, it } from 'vitest';
import { z, type ZodTypeAny } from 'zod';
import { ReticleTool } from './tool-names.js';
import { RAW_TOOLS, TOOLS } from './tools.js';
import {
  MAX_RESULT_COUNT,
  MAX_STATE_DEPTH,
  MAX_TIMEOUT_MS,
  countSchema,
  cursorSchema,
  depthSchema,
  ratioSchema,
  timeoutMsSchema,
} from './numeric-bounds.js';

function inputShape(name: string): z.ZodRawShape {
  const tool = RAW_TOOLS.find((t) => t.name === name) ?? TOOLS.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool.inputSchema;
}

function parseField(
  shape: z.ZodRawShape,
  key: string,
  value: unknown,
): z.SafeParseReturnType<unknown, unknown> {
  const field = shape[key];
  if (field === undefined) throw new Error(`missing field ${key}`);
  return z.object({ [key]: field }).safeParse({ [key]: value });
}

function unwrap(schema: ZodTypeAny): ZodTypeAny {
  let current: ZodTypeAny = schema;
  const seen = new Set<ZodTypeAny>();
  while (!seen.has(current)) {
    seen.add(current);
    const def = current._def as { typeName?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny };
    if (
      'ZodOptional' === def.typeName ||
      'ZodNullable' === def.typeName ||
      'ZodDefault' === def.typeName
    ) {
      if (def.innerType === undefined) break;
      current = def.innerType;
      continue;
    }
    if ('ZodEffects' === def.typeName) {
      if (def.schema === undefined) break;
      current = def.schema;
      continue;
    }
    break;
  }
  return current;
}

/** Cursors are positions in a stream — a floor of 0 is the bound; a max would refuse a real stamp. */
const CURSOR_KEYS = new Set(['since', 'until']);

function isUnderboundedNumber(schema: ZodTypeAny, key: string): boolean {
  const inner = unwrap(schema);
  const def = inner._def as { typeName?: string; checks?: readonly { kind: string }[] };
  if ('ZodNumber' !== def.typeName) return false;
  const checks = def.checks ?? [];
  const hasMin = checks.some((c) => 'min' === c.kind);
  const hasMax = checks.some((c) => 'max' === c.kind);
  if (CURSOR_KEYS.has(key)) return !hasMin;
  return !hasMin || !hasMax;
}

describe('numeric bound helpers', () => {
  it('depth refuses a negative (the reported silent-ignore) and a zero-level read', () => {
    expect(depthSchema.safeParse(-5).success).toBe(false);
    expect(depthSchema.safeParse(0).success).toBe(false);
    expect(depthSchema.safeParse(50).success).toBe(true);
    expect(depthSchema.safeParse(MAX_STATE_DEPTH).success).toBe(true);
    expect(depthSchema.safeParse(MAX_STATE_DEPTH + 1).success).toBe(false);
  });

  it('count refuses -1 and 1e9, and keeps 0 (return none)', () => {
    expect(countSchema.safeParse(-1).success).toBe(false);
    expect(countSchema.safeParse(0).success).toBe(true);
    expect(countSchema.safeParse(MAX_RESULT_COUNT).success).toBe(true);
    expect(countSchema.safeParse(1e9).success).toBe(false);
  });

  it('timeout_ms: 0 is evaluate-now; a hang-length wait is refused', () => {
    expect(timeoutMsSchema.safeParse(0).success).toBe(true);
    expect(timeoutMsSchema.safeParse(-1).success).toBe(false);
    expect(timeoutMsSchema.safeParse(MAX_TIMEOUT_MS + 1).success).toBe(false);
  });

  it('since: 0 is a real cursor; a negative is not', () => {
    expect(cursorSchema.safeParse(0).success).toBe(true);
    expect(cursorSchema.safeParse(-1).success).toBe(false);
  });

  it('ratio is 0..1, not an int', () => {
    expect(ratioSchema.safeParse(0.01).success).toBe(true);
    expect(ratioSchema.safeParse(-0.1).success).toBe(false);
    expect(ratioSchema.safeParse(1.1).success).toBe(false);
  });
});

describe('the reported silent-ignore cases are refusals on the tool schema', () => {
  it('reticle_state { depth: -5 } is refused, not a full unscoped store', () => {
    const parsed = parseField(inputShape(ReticleTool.STATE), 'depth', -5);
    expect(parsed.success).toBe(false);
  });

  it('reticle_network { limit: -1 } stays refused; { limit: 1e9 } is now refused too', () => {
    const shape = inputShape(ReticleTool.NETWORK);
    expect(parseField(shape, 'limit', -1).success).toBe(false);
    expect(parseField(shape, 'limit', 0).success).toBe(true);
    expect(parseField(shape, 'limit', 1e9).success).toBe(false);
  });

  it('reticle_assert { timeout_ms: 0 } still means evaluate now', () => {
    expect(parseField(inputShape(ReticleTool.ASSERT), 'timeout_ms', 0).success).toBe(true);
  });
});

/**
 * The class, not the instance. A new `z.number()` on a tool input with no min/max is how
 * `depth: -5` shipped: accepted, forwarded, silently dropped by capDepth. int() alone is not a
 * bound — viewport was `.int()` and still accepted 5 / 999999, then clamped.
 */
describe('every top-level numeric tool input has a bound', () => {
  it('refuses an unbounded z.number() on any handler input, advertised or not', () => {
    // RAW_TOOLS as well as TOOLS: a tool the profile hides is still a tool the daemon dispatches,
    // and a bound that only covers the advertised surface misses it the same way depth: -5 shipped.
    const seen = new Set<string>();
    const unbounded: string[] = [];
    for (const tool of [...RAW_TOOLS, ...TOOLS]) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      for (const [key, schema] of Object.entries(tool.inputSchema)) {
        if (isUnderboundedNumber(schema, key)) unbounded.push(`${tool.name}.${key}`);
      }
    }
    expect(unbounded, unbounded.join(', ')).toEqual([]);
  });
});
