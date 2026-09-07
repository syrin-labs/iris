import { z } from 'zod';
import { CDP_NO_PROVIDER_REASON, CDP_NO_PROVIDER_RECOMMENDATION } from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { sessionIdShape } from '../tools/tool-kit.js';
import { delayMsSchema, httpStatusSchema } from '../tools/numeric-bounds.js';
import { asString } from '../tools/tools-helpers.js';
import type { RealInputProvider } from './real-input.js';
import type { MockRule } from './network-mock.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';

/** A provider that can install network mocks — narrows the optional capability so callers branch once. */
type MockCapable = RealInputProvider & {
  setMocks(sessionUrl: string, rules: MockRule[]): Promise<boolean>;
};

function mockProvider(deps: ToolDeps): MockCapable | undefined {
  const p = deps.realInput;
  return p !== undefined && 'function' === typeof p.setMocks ? (p as MockCapable) : undefined;
}

const ruleShape = z.object({
  urlContains: z
    .string()
    .min(1)
    .describe('Substring the request URL must contain, e.g. "/api/pay".'),
  method: z.string().optional().describe('Optional method filter (GET/POST/…), case-insensitive.'),
  status: httpStatusSchema.optional().describe('Fulfill with this HTTP status (default 200).'),
  body: z.string().optional().describe('Response body to fulfill with.'),
  contentType: z.string().optional().describe('Response content type (default application/json).'),
  delayMs: delayMsSchema.optional().describe('Delay (ms) before fulfilling — simulate a slow API.'),
  abort: z
    .boolean()
    .optional()
    .describe('Simulate a network failure (offline) instead of a response.'),
});

/**
 * Narrow the validated tool args into MockRule[], omitting undefined keys (exactOptionalPropertyTypes).
 *
 * THROWS on a malformed rule rather than falling back to `[]`, because `[]` is not a neutral value
 * here — it is the documented way to clear every active mock. A rule with a wrong field name used to
 * produce exactly the call that turns mocking OFF, and the handler then reported `applied: true`
 * with `count: 0`. For a tool whose entire job is forcing an error state, that means the agent
 * checks the app's failure handling against the real backend, sees the happy path, and reports that
 * the error state works.
 *
 * Same rule as the action arguments: an argument that could not be understood is refused by name,
 * never reinterpreted into a destructive default. A valueless `fill` used to wipe the field and
 * report ok; it throws now, for this reason.
 *
 * `undefined` and `[]` still mean "clear" — those are deliberate, documented requests, not failures
 * to parse.
 */
export function toRules(value: unknown): MockRule[] {
  if (value === undefined) return [];
  const parsed = z.array(ruleShape).safeParse(value);
  if (!parsed.success) {
    const problem = parsed.error.issues
      .map((i) => `${0 === i.path.length ? 'mocks' : `mocks.${i.path.join('.')}`}: ${i.message}`)
      .join('; ');
    throw new Error(
      `reticle_network_mock could not read \`mocks\` (${problem}). Nothing was applied and mocking ` +
        'was left unchanged — an unreadable rule is NOT treated as a request to clear. A rule is ' +
        '{ urlContains, method?, status?, body?, contentType?, delayMs?, abort? }; pass `clear: true` ' +
        'or an empty array if you meant to turn mocking off.',
    );
  }
  return parsed.data.map((r) => {
    const rule: MockRule = { urlContains: r.urlContains };
    if (r.method !== undefined) rule.method = r.method;
    if (r.status !== undefined) rule.status = r.status;
    if (r.body !== undefined) rule.body = r.body;
    if (r.contentType !== undefined) rule.contentType = r.contentType;
    if (r.delayMs !== undefined) rule.delayMs = r.delayMs;
    if (r.abort !== undefined) rule.abort = r.abort;
    return rule;
  });
}

export const NETWORK_MOCK_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.NETWORK_MOCK,
    description:
      'Stub or intercept network requests on a driven page (`reticle drive` / RETICLE_CDP_URL) or a ' +
      'leased Playwright tab (`reticle_lease acquire`): return a 500, force offline (abort), or delay ' +
      'a response — so you can deterministically test error and edge states without touching the ' +
      'backend ("verify the app handles a failed payment"). Pass `mocks` (first matching rule wins); ' +
      'pass an empty array or `clear: true` to turn mocking off.',
    inputSchema: {
      // The rule fields each carry their own `.describe()` on `ruleShape`, but the params
      // view reads only the top-level description of each entry, so those are flattened
      // away before an agent sees them. Naming the shape here is what keeps the tool
      // callable from its own description instead of by guessing and failing first.
      mocks: z
        .array(ruleShape)
        .optional()
        .describe(
          'Interception rules, first match wins: { urlContains, method?, status?, body?, contentType?, delayMs?, abort? }. Omit or pass [] to clear.',
        ),
      clear: z.boolean().optional().describe('Clear all active mocks (same as mocks: []).'),
      ...sessionIdShape,
    },
    outputSchema: {
      applied: z.boolean(),
      count: z.number(),
      ok: z.boolean().optional(),
      reason: z.string().optional(),
      recommendation: z.string().optional(),
    },
    handler: async (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const rules = true === args['clear'] ? [] : toRules(args['mocks']);
      const provider = mockProvider(deps);
      if (provider !== undefined) {
        const applied = await provider.setMocks(session.url, rules);
        if (applied) return { applied: true, count: rules.length };
      }
      // A lease is a Playwright-owned page — CDP intercept was always there, this tool just had no
      // route to it. Tried after the driven provider: when both exist, drive is the page the caller
      // means, and a lease is the fallback rather than a competitor.
      const leased = await deps.pool?.setMocksLease(session.id, rules);
      if (true === leased) return { applied: true, count: rules.length };
      return {
        applied: false,
        count: 0,
        ok: false,
        reason: CDP_NO_PROVIDER_REASON,
        recommendation: CDP_NO_PROVIDER_RECOMMENDATION,
      };
    },
  },
];
