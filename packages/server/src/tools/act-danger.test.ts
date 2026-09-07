/**
 * Native-click destructive guard. The SDK path is tested in the browser package; this is the
 * same list, on the descriptor the native inspector returns, because a role that never reaches
 * here is a Payment option that is still refused.
 */
import { describe, expect, it } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { assertNotDestructive } from './act-danger.js';

describe('assertNotDestructive', () => {
  it('does not block a Payment option — selecting a document type is not a payment', () => {
    expect(() =>
      assertNotDestructive(ActionType.CLICK, {}, { text: 'Payment', role: 'option' }),
    ).not.toThrow();
  });

  it('does not block Log out', () => {
    expect(() =>
      assertNotDestructive(ActionType.CLICK, {}, { text: 'Log out', role: 'menuitem' }),
    ).not.toThrow();
  });

  it('still blocks a Payment button', () => {
    expect(() =>
      assertNotDestructive(ActionType.CLICK, {}, { text: 'Send payment', role: 'button' }),
    ).toThrow(/confirmDangerous/);
  });
});
