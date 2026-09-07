import { describe, expect, it } from 'vitest';
import { isDangerousActionText, isLoopbackHostname } from './security.js';

describe('isLoopbackHostname', () => {
  it('accepts literal IPv4, IPv6, and localhost loopback hosts', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('127.255.255.254')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
  });

  it('rejects DNS lookalikes and invalid IPv4 literals', () => {
    expect(isLoopbackHostname('127.evil.example')).toBe(false);
    expect(isLoopbackHostname('localhost.example')).toBe(false);
    expect(isLoopbackHostname('127.0.0.999')).toBe(false);
  });
});

describe('isDangerousActionText', () => {
  it('matches destructive labels and separator-delimited tool names', () => {
    expect(isDangerousActionText('Delete account')).toBe(true);
    expect(isDangerousActionText('delete_account')).toBe(true);
    expect(isDangerousActionText('transfer-funds')).toBe(true);
  });

  it('does not block ordinary read-only controls', () => {
    expect(isDangerousActionText('Search records')).toBe(false);
    expect(isDangerousActionText('Open settings')).toBe(false);
  });
});

/**
 * "Send" is not a destructive verb, and treating it as one taxed ordinary buttons.
 *
 * Reported from the field: `Send check-in` (POST that logs a text message) and `I'm safe / arrived`
 * (a positive status update) were both blocked as potentially destructive, costing an extra
 * round-trip each on a routine verification pass. Neither deletes, removes or revokes anything.
 *
 * `send` was in the list to cover moving money, and it caught every ordinary "send a message",
 * "send an invite", "send a check-in" alongside it. The money cases are still guarded — through the
 * thing being sent rather than the act of sending — so `Send payment` is still blocked while
 * `Send message` is not.
 *
 * The guard is deliberately asymmetric: a false block costs one round-trip, a missed block can
 * charge somebody's card. So this narrows the trigger without lowering the money coverage, and the
 * assertions below pin BOTH directions to keep it that way.
 */
describe('the destructive-action classifier does not tax ordinary verbs', () => {
  it.each([
    'Send check-in',
    "I'm safe / arrived",
    'Send message',
    'Send invite',
    'Send feedback',
    'Resend code',
  ])('does not block %s', (label) => {
    expect(isDangerousActionText(label)).toBe(false);
  });

  it.each([
    'Send payment',
    'Send money',
    'Confirm payment',
    'Delete account',
    'Remove item',
    'Transfer funds',
    'Withdraw',
    'Revoke access',
    'Place order',
  ])('still blocks %s', (label) => {
    expect(isDangerousActionText(label)).toBe(true);
  });
});

/**
 * Signing out is reversible, and the word fires on almost every authenticated drive.
 *
 * Reported from the field: a `role=menuitem` labelled `Log out` was blocked on every session, and
 * `Payment` as a Radix Select option (a document type on a petty-cash form) was blocked as
 * money-moving. A guard that costs a turn on a control it was never written to catch trains agents
 * to pass `confirmDangerous` reflexively, which is worse than not having it.
 *
 * Logout comes off the list. `payment` stays — "Send payment" / "Confirm payment" are still money —
 * but an `option` is a value picker, not an action, so the role is consulted before the text.
 */
describe('the destructive-action classifier does not tax logout or a Payment option', () => {
  it.each(['Log out', 'Logout', 'Sign out', 'sign_out'])('does not block %s', (label) => {
    expect(isDangerousActionText(label)).toBe(false);
  });

  it('does not block Payment when the control is an option in a select', () => {
    expect(isDangerousActionText('Payment', 'option')).toBe(false);
  });

  it('still blocks a Payment button, which is the money-moving case the list is for', () => {
    expect(isDangerousActionText('Send payment', 'button')).toBe(true);
    expect(isDangerousActionText('Confirm payment')).toBe(true);
  });

  it('still blocks a destructive menuitem — the role exemption is for value pickers, not menus', () => {
    expect(isDangerousActionText('Delete account', 'menuitem')).toBe(true);
  });
});

describe('consequential is not the same as destructive', () => {
  /**
   * The guard's own contract, at the top of act-danger.ts: it exists to stop "a money-moving or
   * destructive control". A deploy is neither — nothing is destroyed and no money moves. It is
   * consequential and it is CREATIVE, and the list is not a list of consequential things or half
   * the buttons in a dev tool would be on it.
   *
   * Measured, which is why this changed: three benchmark runs lost their whole budget to "New
   * deploy" being refused. Improving the refusal's wording did not rescue the last of them — the
   * agent spent its remaining turns weighing a bug report about the block and hunting a webmcp
   * workaround. A guard that costs a run on a control it was never written to catch is not
   * protecting anything; it is teaching agents to route around it.
   */
  it('does not block a deploy or a publish', () => {
    expect(isDangerousActionText('New deploy')).toBe(false);
    expect(isDangerousActionText('Deploy to production')).toBe(false);
    expect(isDangerousActionText('Publish')).toBe(false);
    expect(isDangerousActionText('publish-post')).toBe(false);
  });

  /** Everything the guard IS for stays exactly as it was. */
  it('still blocks destruction and money', () => {
    for (const label of [
      'Delete account',
      'Remove member',
      'Revoke token',
      'Terminate instance',
      'Refund payment',
      'Transfer funds',
      'Withdraw',
      'Place order',
      'Cancel subscription',
    ]) {
      expect(isDangerousActionText(label)).toBe(true);
    }
  });
});
