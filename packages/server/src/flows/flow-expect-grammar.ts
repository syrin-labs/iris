/**
 * Accept the assertion grammar a drive already uses, in a saved flow file.
 *
 * FlowExpect is a flat object (`signal` is a name string; `net`/`state` sit beside it). Agents write
 * the `act_and_wait` shape instead — `{ kind: "allOf", predicates: [...] }`, or sibling channels
 * with `signal: { name, count }` — and replay answered `flow_parse_failed` / "malformed". That sent
 * people looking for a JSON syntax error in a file they had just written, and the workaround was to
 * drop every channel but one.
 *
 * Coercion happens at load: the on-disk schema does not move, FLOW_FILE_VERSION stays 1, and a
 * re-save writes the canonical shape. A kind a saved flow cannot enforce is refused, not stripped
 * to an empty expect that would grade asserted-while-unchecked.
 */
import { FlowErrorCode, FlowFileSchema, type FlowFile } from '@reticlehq/core';
import type { ZodError } from 'zod';
import { PredicateSchema } from '../events/predicate.js';
import { predicateToExpect } from './predicate-to-expect.js';
import type { FlowResult } from './flows.js';

export const FlowParseNote = {
  NOT_JSON: 'flow file is not valid JSON — fix the syntax or regenerate it with reticle_flow_save',
  MALFORMED: 'flow file is malformed — fix or regenerate it with reticle_flow_save',
  UNSUPPORTED_SHAPE: 'valid JSON, unsupported expect shape',
  UNENFORCED:
    'valid JSON, but this expect uses a predicate kind a saved flow cannot enforce (settled, route, animation, anyOf, not)',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return 'object' === typeof value && null !== value && !Array.isArray(value);
}

export type CoerceExpectResult = { ok: true; value: unknown } | { ok: false; detail: string };

/**
 * Flatten `signal: { name, count }` into the on-disk fields. Other channels already match FlowExpect.
 * Leave a signal object with no name alone so the schema failure can name the key.
 */
function flattenSignalObject(raw: Record<string, unknown>): Record<string, unknown> {
  const signal = raw['signal'];
  if (!isRecord(signal)) return raw;
  const name = signal['name'];
  if ('string' !== typeof name) return raw;
  const out: Record<string, unknown> = { ...raw, signal: name };
  if ('number' === typeof signal['count']) out['signalCount'] = signal['count'];
  if (undefined !== signal['dataMatches']) out['signalData'] = signal['dataMatches'];
  return out;
}

export function coerceFlowExpect(raw: unknown): CoerceExpectResult {
  if (isRecord(raw) && 'kind' in raw) {
    const parsed = PredicateSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, detail: describePredicateExpectFailure(parsed.error) };
    }
    const expect = predicateToExpect(parsed.data);
    if (undefined === expect) return { ok: false, detail: FlowParseNote.UNENFORCED };
    return { ok: true, value: expect };
  }
  if (!isRecord(raw)) return { ok: true, value: raw };
  return { ok: true, value: flattenSignalObject(raw) };
}

function describePredicateExpectFailure(error: ZodError): string {
  const issue = error.issues[0];
  if (undefined === issue) return FlowParseNote.UNSUPPORTED_SHAPE;
  const key = issue.path[0];
  if ('string' === typeof key || 'number' === typeof key) {
    return `${FlowParseNote.UNSUPPORTED_SHAPE} key "${String(key)}"`;
  }
  return FlowParseNote.UNSUPPORTED_SHAPE;
}

export function coerceFlowFileExpects(raw: unknown): CoerceExpectResult {
  if (!isRecord(raw)) return { ok: true, value: raw };
  const next: Record<string, unknown> = { ...raw };
  const stepsIn = next['steps'];
  if (Array.isArray(stepsIn)) {
    const steps: unknown[] = [];
    for (let i = 0; i < stepsIn.length; i++) {
      const step: unknown = stepsIn[i] as unknown;
      if (!isRecord(step) || undefined === step['expect']) {
        steps.push(step);
        continue;
      }
      const coerced = coerceFlowExpect(step['expect']);
      if (!coerced.ok) {
        return {
          ok: false,
          detail: `${FlowParseNote.UNSUPPORTED_SHAPE} at step ${String(i)}: ${coerced.detail}`,
        };
      }
      steps.push({ ...step, expect: coerced.value });
    }
    next['steps'] = steps;
  }
  if (undefined !== next['success']) {
    const coerced = coerceFlowExpect(next['success']);
    if (!coerced.ok) {
      return {
        ok: false,
        detail: `${FlowParseNote.UNSUPPORTED_SHAPE} at success: ${coerced.detail}`,
      };
    }
    next['success'] = coerced.value;
  }
  return { ok: true, value: next };
}

export function describeFlowZodFailure(error: ZodError): string {
  const issue = error.issues[0];
  if (undefined === issue) return FlowParseNote.MALFORMED;
  const path = issue.path;
  // A strict object reports an unrecognized key as `unrecognized_keys` on the OBJECT's path, with
  // the offending names in `keys` — not as an issue whose path ends in the key. Reading only the
  // path shape reported the one failure this exists to name as a bare "malformed", which sends the
  // author back to the file to find a typo we had already identified.
  if ('unrecognized_keys' === issue.code) {
    const named = issue.keys.map((k) => `"${k}"`).join(', ');
    if ('steps' === path[0] && 'number' === typeof path[1] && 'expect' === path[2]) {
      return `${FlowParseNote.UNSUPPORTED_SHAPE} at step ${String(path[1])} key ${named}`;
    }
    if ('success' === path[0]) return `${FlowParseNote.UNSUPPORTED_SHAPE} at success key ${named}`;
    return `${FlowParseNote.UNSUPPORTED_SHAPE} — unrecognized key ${named}`;
  }
  if (
    'steps' === path[0] &&
    'number' === typeof path[1] &&
    'expect' === path[2] &&
    'string' === typeof path[3]
  ) {
    return `${FlowParseNote.UNSUPPORTED_SHAPE} at step ${String(path[1])} key "${path[3]}"`;
  }
  if ('success' === path[0] && 'string' === typeof path[1]) {
    return `${FlowParseNote.UNSUPPORTED_SHAPE} at success key "${path[1]}"`;
  }
  return FlowParseNote.MALFORMED;
}

export function parseFlowFileText(text: string): FlowResult<FlowFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: FlowErrorCode.PARSE_FAILED, detail: FlowParseNote.NOT_JSON };
  }
  const coerced = coerceFlowFileExpects(parsed);
  if (!coerced.ok) {
    return { ok: false, code: FlowErrorCode.PARSE_FAILED, detail: coerced.detail };
  }
  const result = FlowFileSchema.safeParse(coerced.value);
  if (!result.success) {
    return {
      ok: false,
      code: FlowErrorCode.PARSE_FAILED,
      detail: describeFlowZodFailure(result.error),
    };
  }
  return { ok: true, value: result.data };
}
