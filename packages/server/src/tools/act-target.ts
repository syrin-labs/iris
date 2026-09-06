/**
 * Turn what the caller named into a ref: `ref` outright, or `target` via one page query.
 *
 * Split out of act-tools.ts when it crossed the 1000-line cap. Chosen deliberately over the ACT
 * dispatcher, which looks like the more obvious seam and is not: `dispatch-attribution` asserts
 * file-by-file that anything sending an ACT also opens an attribution window, so moving the
 * dispatch out of the file that opens the window would have weakened a real invariant to satisfy a
 * line count. This resolves a TARGET and dispatches only QUERY, so that guard is untouched.
 */
import { ReticleCommand } from '@reticlehq/core';
import type { Session } from '../session/session.js';
import { normalizeQueryArgs } from './query-shape.js';
import { resolveTargetRef, type TargetResolution } from './resolve-target.js';
import { asRecord, asString } from './tools-helpers.js';

/**
 * Resolve an action's element: an explicit `ref`, or a `target` query resolved in the SAME call.
 *
 * Requiring a ref meant every verification paid a `reticle_query` turn first just to learn one
 * string, and the advertised tool surface is re-sent on every turn — measured on the wire, a
 * two-turn verification spent 10,756 of 11,235 tokens on schema and 479 on the actual answers. The
 * lookup still happens; it just stops costing a round trip through the model.
 *
 * `ref` wins when both are given, because it is the more specific instruction and silently
 * preferring the query would act on something the caller did not name.
 */
export async function resolveActTarget(
  session: Session,
  args: Record<string, unknown>,
): Promise<TargetResolution> {
  const ref = asString(args['ref']);
  if (ref !== undefined && ref.length > 0) return { kind: 'ref', ref };
  const target = args['target'];
  if (target === undefined) {
    return {
      kind: 'error',
      message:
        'pass `ref` (from reticle_query/reticle_snapshot) or `target` (e.g. { testid } or { role, name }).',
    };
  }
  const q = normalizeQueryArgs(asRecord(target));
  const out = await session.command(ReticleCommand.QUERY, {
    by: q['by'],
    value: q['value'],
    name: q['name'],
    scope: q['scope'],
  });
  if (!out.ok) return { kind: 'error', message: out.error ?? 'target query failed' };
  const elements = asRecord(out.result)['elements'];
  return resolveTargetRef(Array.isArray(elements) ? elements : []);
}
