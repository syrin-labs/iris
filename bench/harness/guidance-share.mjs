// What part of a tool result is GUIDANCE, and therefore not part of a competitor comparison.
//
// Reticle spends bytes telling an agent what to call next, how to instrument what it just found,
// and that feedback is welcome. A competitor's browser tool does none of that, so counting those
// bytes against us in a head-to-head measures the wrong thing.
//
// That argument is also the easiest place in the whole benchmark to cheat, because the
// classification produces the number. Three rules keep it honest:
//
//   1. **Field-level, never estimated.** A key is guidance or it is not, and the list is right here
//      to be argued with. No percentage is guessed.
//   2. **Ambiguous stays EVIDENCE.** The excluded share is a floor on guidance, never a ceiling.
//      `because` is the case that matters: it sometimes ends in advice, and it stays counted,
//      because its job is to name the deciding fact.
//   3. **A payload we cannot parse contributes ZERO.** Guessing at unparsed text would let the
//      exclusion grow on exactly the inputs nobody can check.
//
// Rule 2 and rule 3 both push the same way on purpose: every uncertainty makes Reticle look WORSE,
// so a win measured through this file is a win that survives the argument about it.

/**
 * Keys whose value is coaching rather than observation.
 *
 * `fix` is the interesting one: `instrumentationGaps[].fix` tells the agent what to write in its
 * own source. That is real work we do and a competitor cannot, and it is still not evidence about
 * the run, so it is excluded from the comparison rather than claimed as a win.
 */
export const GUIDANCE_KEYS = new Set([
  'feedback_invite',
  'cleanup_suggestion',
  'cleanup_hint',
  'IMPORTANT',
  'version_skew',
  'next',
  'next_steps',
  'hint',
  'fix',
  'suggestion',
]);

const sizeOf = (v) => Buffer.byteLength(JSON.stringify(v ?? null), 'utf8');

function walk(node, acc) {
  if (null === node || 'object' !== typeof node) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, acc);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    // The key itself is part of what the payload costs, so it is charged to the bucket it names.
    if (GUIDANCE_KEYS.has(k)) acc.guidance += sizeOf(v) + Buffer.byteLength(k, 'utf8') + 3;
    else walk(v, acc);
  }
}

/**
 * Guidance bytes in one tool result. Returns 0 for anything that is not JSON we can read — see
 * rule 3. Never throws: a benchmark that dies on one odd payload reports nothing at all.
 */
export function guidanceBytes(text) {
  if ('string' !== typeof text || '' === text) return 0;
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return 0;
  }
  const acc = { guidance: 0 };
  walk(doc, acc);
  return acc.guidance;
}

/**
 * The share of a payload that is guidance, as a fraction. Zero for an unreadable or empty payload,
 * for the same reason.
 */
export function guidanceShare(text) {
  const total = Buffer.byteLength(text ?? '', 'utf8');
  if (0 === total) return 0;
  return guidanceBytes(text) / total;
}
