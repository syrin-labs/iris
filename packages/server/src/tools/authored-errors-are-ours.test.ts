/**
 * A message Reticle wrote about the caller's arguments must never ask for a bug report.
 *
 * `RULES` is a denylist of message shapes, so every message we author defaults to "unrecognized",
 * and unrecognized attaches `FEEDBACK_ASK` — "this may be a defect in Reticle... call
 * reticle_feedback with a root-cause analysis before moving on".
 *
 * That default has now been patched FOUR times, each time for one more spelling of the same idea,
 * and the file records three of them: the browser's `executeAction` guards ("ALL of them used to
 * fall through to the feedback ask"), the destructive-action block, and the three spellings of
 * "potentially destructive ... blocked" where the rule matched one and "two thirds of the same
 * deliberate refusal still read as a possible defect".
 *
 * Measured live on 2026-08-23, the fourth: a drag naming an unresolvable `toRef` returns
 *
 *   error:    "drag target 'e999999' did not resolve to an element — pass a ref from
 *              reticle_snapshot or reticle_query as args.toRef (alias: args.target)"
 *   feedback: "This error is not one Reticle recognizes, which means it may be a defect in
 *              Reticle rather than in the app..."
 *
 * The message teaches the exact fix, and the payload immediately tells the agent the fix might be
 * a bug worth reporting. That costs a turn and files a false report about correct behaviour — and
 * this refusal is itself the fix for a previously-shipped drag false green.
 *
 * The catch-all it missed requires `reticle_x { ... }` WITH braces AND requires/must/expected. A
 * message that names a `reticle_*` tool or an `args.*` parameter is ours whatever its punctuation,
 * so the rule keys on that instead of on one sentence shape.
 */

import { describe, expect, it } from 'vitest';
import { recoveryFor } from './error-recovery.js';

/** The exact string measured from a live daemon. */
const DRAG =
  "drag target 'e999999' did not resolve to an element — pass a ref from reticle_snapshot or " +
  'reticle_query as args.toRef (alias: args.target)';

describe('a message we authored about the caller is recognized as ours', () => {
  it('recognizes the live drag refusal', () => {
    expect(recoveryFor(DRAG)).toBeDefined();
  });

  it('names a tool without braces and is still ours', () => {
    expect(recoveryFor('pass a ref from reticle_snapshot as args.toRef')).toBeDefined();
  });

  it('names an args.* parameter and is still ours', () => {
    expect(recoveryFor('upload needs args.path pointing at a file on disk')).toBeDefined();
  });

  /** The shape the old catch-all already handled must keep working. */
  it('keeps recognizing the braced form', () => {
    expect(recoveryFor('reticle_query { by } requires a string `value`')).toBeDefined();
  });
});

describe('it does not swallow genuine failures', () => {
  /**
   * The whole point of `FEEDBACK_ASK`: an unanticipated failure is the highest-value moment to hear
   * from the agent. Broadening the authored-message rule must not silence that.
   */
  it('leaves an unanticipated failure unrecognized', () => {
    expect(recoveryFor('ECONNRESET while reading from the bridge socket')).toBeUndefined();
  });

  it('leaves a bare internal error unrecognized', () => {
    expect(
      recoveryFor('Cannot read properties of undefined (reading Symbol.iterator)'),
    ).toBeUndefined();
  });

  /**
   * A crash whose stack merely mentions our package is NOT a message we authored about arguments.
   * Keying on `reticle_` alone would capture it, which is why the rule wants a tool name or an
   * `args.` parameter in prose, not a path.
   */
  it('leaves a stack trace through our own files unrecognized', () => {
    expect(
      recoveryFor('TypeError at /node_modules/@reticlehq/server/dist/tools/act-tools.js:412:9'),
    ).toBeUndefined();
  });
});
