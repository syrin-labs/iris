/** Small pure helpers shared by the MCP tool handlers. */

interface InteractiveItem {
  ref: string;
  desc: string;
}

/** Parse interactive elements (with refs) out of a snapshot tree for exploration. */
export function parseInteractive(tree: string): InteractiveItem[] {
  const items: InteractiveItem[] = [];
  for (const line of tree.split('\n')) {
    const match = /\(ref=(e\d+)\)/.exec(line);
    if (match !== null) {
      items.push({ ref: match[1] ?? '', desc: line.replace(/\s*\(ref=e\d+\)/, '').trim() });
    }
  }
  return items;
}

export function asString(value: unknown): string | undefined {
  return 'string' === typeof value ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return 'number' === typeof value ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return 'object' === typeof value && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * The session this call is aimed at: a top-level `sessionId`, or the same key on sequence steps.
 *
 * `reticle_act_sequence` describes each step as equivalent to one `reticle_act`, so an agent that
 * learned the escape hatch on the single-action tool puts `sessionId` on the step. Reading only the
 * top-level key then auto-selects a different tab, the step refs miss, and the refusal reads as a
 * stale ref — a confident diagnosis of the wrong thing. Top-level still wins when both are given.
 *
 * Mixed step ids refuse rather than pick: two named tabs is a guess we will not make.
 */
export function sessionIdFromArgs(args: Record<string, unknown>): string | undefined {
  const top = asString(args['sessionId']);
  if (top !== undefined) return top;
  const steps = args['steps'];
  if (!Array.isArray(steps)) return undefined;
  let found: string | undefined;
  for (const raw of steps) {
    const id = asString(asRecord(raw)['sessionId']);
    if (id === undefined) continue;
    if (found !== undefined && found !== id) {
      throw new Error(
        `reticle_act_sequence steps name different sessionIds ('${found}' and '${id}'). ` +
          'Pass one sessionId at the top level to target a tab. Nothing was acted on.',
      );
    }
    found = id;
  }
  return found;
}

/**
 * The ref this call is about to spend: a top-level `ref`, or the first sequence step's.
 *
 * Wrong-tab refusal keys off this. A sequence that only carries refs inside `steps` used to look
 * like a call with no ref, so auto-selection could pick a different tab and the miss was blamed
 * on the DOM.
 */
export function spentRefFromArgs(args: Record<string, unknown>): string | undefined {
  const top = asString(args['ref']);
  if (top !== undefined) return top;
  const steps = args['steps'];
  if (!Array.isArray(steps) || 0 === steps.length) return undefined;
  return asString(asRecord(steps[0])['ref']);
}

/**
 * A `{ file, line }` source location off an untrusted result payload, or undefined.
 *
 * The browser sends this alongside an act's anchor so a failure can name the file to open. Validated
 * rather than cast: it crosses the wire, and a half-formed location rendered as "undefined:NaN" is
 * worse than no location at all — it looks like an answer.
 */
export function sourceOf(
  value: unknown,
): { file: string; line: number; column?: number } | undefined {
  if (null === value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const file = record['file'];
  const line = record['line'];
  if (typeof file !== 'string' || 0 === file.length || typeof line !== 'number') return undefined;
  const out: { file: string; line: number; column?: number } = { file, line };
  if ('number' === typeof record['column']) out.column = record['column'];
  return out;
}
