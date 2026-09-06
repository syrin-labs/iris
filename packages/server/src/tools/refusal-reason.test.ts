import { describe, expect, it } from 'vitest';
import { RefusalReason } from '@reticlehq/core';
import { SELF_RECOVERING_MARKER } from '../session/no-session-diagnosis.js';
import { RECOVERY, recoveryFor, refusalReasonFor } from './error-recovery.js';

/**
 * `tool_refused` is only worth sending if the reason on it is the same fact the agent was told.
 *
 * These drive the messages the server actually throws — the strings the recovery table already keys
 * on — rather than a paraphrase, because a classifier tested against its own author's idea of the
 * message is a classifier that agrees with itself and nothing else.
 */
describe('why a tool refused', () => {
  it.each([
    ['no browser session connected', RefusalReason.NO_SESSION],
    ['multiple sessions connected', RefusalReason.NO_SESSION],
    ['no connected session with id abc', RefusalReason.NO_SESSION],
    ['session disconnected', RefusalReason.NO_SESSION],
    ["ref 'e12' no longer resolves to an element", RefusalReason.NO_MATCH],
    ['no baseline named checkout', RefusalReason.NO_MATCH],
    ['no <option> with value "gold"', RefusalReason.NO_MATCH],
    ['cannot fill a disabled <input>', RefusalReason.UNSUPPORTED],
    ['cannot type into a contenteditable region', RefusalReason.UNSUPPORTED],
    ['cannot hover without a real pointer', RefusalReason.UNSUPPORTED],
    ['potentially destructive action blocked', RefusalReason.UNSUPPORTED],
    ["unknown action 'clik'", RefusalReason.BAD_ARGS],
    ['invalid flow name: ../escape', RefusalReason.BAD_ARGS],
    ["command 'act' timed out after 5000ms", RefusalReason.NOT_READY],
    ['the target tab is throttled', RefusalReason.NOT_READY],
    ['browser pool unavailable', RefusalReason.NOT_READY],
    ['a pairing token is required', RefusalReason.NOT_READY],
  ])('classifies %s', (message, reason) => {
    expect(refusalReasonFor(message)).toBe(reason);
  });

  /**
   * The single largest refusal there is, and the one that never reaches the recovery table: the
   * no-session diagnosis inspects the machine and names the cause itself, so `recoveryFor` returns
   * nothing for it by design. Missing that would gut the metric while every other case passed.
   */
  it('classifies the self-diagnosing no-session message the recovery table deliberately skips', () => {
    const diagnosed = `nothing is listening on any dev-server port. ${SELF_RECOVERING_MARKER}`;
    expect(recoveryFor(diagnosed)).toBeUndefined();
    expect(refusalReasonFor(diagnosed)).toBe(RefusalReason.NO_SESSION);
  });

  it('renders a zod issue array before classifying it, as the agent-facing payload does', () => {
    const raw = JSON.stringify([{ code: 'unrecognized_keys', message: 'x', keys: ['value'] }]);
    expect(refusalReasonFor(raw)).toBe(RefusalReason.BAD_ARGS);
  });

  /**
   * A classifier that cannot say "I do not know" lies instead. A growing `other` is a finding about
   * the table above, not about anybody's app.
   */
  it('says other rather than guessing at a message nothing recognises', () => {
    expect(refusalReasonFor('the flux capacitor desynchronised')).toBe(RefusalReason.OTHER);
  });

  /**
   * The reason is looked up by hint TEXT, so two recoveries sharing a string would collapse into one
   * entry and hand a matched refusal somebody else's owner. That every recovery HAS a reason is
   * already a compile error to omit (`REASON_OF` is a Record over the keys); this is the half the
   * type system cannot see.
   */
  it('keeps every recovery hint distinct, so the reason lookup cannot collide', () => {
    const hints = Object.values(RECOVERY);
    expect(new Set(hints).size).toBe(hints.length);
  });
});
