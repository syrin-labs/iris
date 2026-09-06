/**
 * Whose defect was that tool error?
 *
 * `toolErrors` was one number covering three failures with three different fixes, so the top-line
 * count could be acted on only by unpacking `errors[]` by hand and reading the prose. Measured over
 * 2026-08-10/11: 60 `state`, 22 `refusal`, 20 `schema` (serialized zod arrays) and 20 stale refs.
 * Read as "126 tool errors" that hides the sixth of them where OUR schema failed to explain itself —
 * which is the only bucket we can fix by writing better descriptions.
 *
 * Classified from the message SHAPE, never stored raw: this returns a bucket, and the caller keeps
 * counts. The full message is already fingerprinted and skeletonised elsewhere.
 */

/** Whose defect. Ordered by which fix it implies. */
const ErrorClass = {
  /** Missing/unknown parameter, wrong type, unparseable predicate. **Our schema is unclear.** */
  SCHEMA: 'schema',
  /** No session, stale ref, disconnected. The world moved under the agent; not a schema problem. */
  STATE: 'state',
  /** We said no on purpose — a destructive block, an unsupported capability. Working as intended. */
  REFUSAL: 'refusal',
  /** Unrecognised. The bucket to watch: a large one is a blind spot, not a long tail. */
  OTHER: 'other',
} as const;
type ErrorClass = (typeof ErrorClass)[keyof typeof ErrorClass];

/**
 * Patterns, most specific first.
 *
 * REFUSAL is tested before STATE because a destructive block often names a session too, and
 * "we refused on purpose" is the more useful reading of that event.
 */
const PATTERNS: readonly (readonly [RegExp, ErrorClass])[] = [
  [/confirmdangerous|destructive action blocked/i, ErrorClass.REFUSAL],
  [
    /\brefus(e|ed|es|ing)\b|not supported|unsupported|cannot .* a <|contenteditable|cannot hover/i,
    ErrorClass.REFUSAL,
  ],
  [
    /did not parse|unknown field|unrecognized_keys|missing required|requires a (string|number)|invalid parameter|expected .* received|is larger than/i,
    ErrorClass.SCHEMA,
  ],
  [
    /no browser session connected|no connected session|multiple sessions connected|session disconnected|no longer resolves|no such session|not connected/i,
    ErrorClass.STATE,
  ],
];

/** Which bucket this message belongs to. Never throws — a classifier must not break a tool path. */
export function classifyError(message: string): ErrorClass {
  for (const [pattern, cls] of PATTERNS) {
    if (pattern.test(message)) return cls;
  }
  return ErrorClass.OTHER;
}
