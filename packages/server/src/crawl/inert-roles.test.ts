/**
 * A live region is not a dead control.
 *
 * `dead-control` is the strongest claim the crawler makes — "your button does nothing" is a finding
 * a reader acts on immediately — and the rule is built accordingly: it clicks twice before saying
 * so, and excludes controls that are legitimately inert.
 *
 * The exclusion list covered inputs and disabled controls, and not the ARIA live-region roles.
 * `alert` and `status` exist to be READ: a screen reader announces them, and nothing is supposed to
 * happen when you click one. Clicking twice and observing nothing is therefore the correct
 * behaviour, reported as a defect.
 *
 * Found by driving a real app: `reticle demo` on the bench app reported
 *
 *   dead-control — - alert "Invalid email or password"
 *
 * which is the login form correctly telling the user their password was wrong. That would have been
 * the FIRST finding a new user ever saw from Reticle, about an app that was working, which is the
 * most expensive kind of false positive there is.
 */

import { describe, expect, it } from 'vitest';
import { legitimatelyInert } from './crawl.js';

describe('roles that exist to be read, not clicked', () => {
  it.each(['alert', 'status', 'log', 'timer', 'marquee'])('%s is inert', (role) => {
    expect(legitimatelyInert(`- ${role} "Invalid email or password"`)).toBe(true);
  });

  /** The exact string measured from the bench app. */
  it('excludes the real one that was misreported', () => {
    expect(legitimatelyInert('- alert "Invalid email or password"')).toBe(true);
  });
});

describe('what it already covered still holds', () => {
  it.each(['textbox', 'searchbox', 'combobox', 'spinbutton'])('%s is inert', (role) => {
    expect(legitimatelyInert(`- ${role} "Email"`)).toBe(true);
  });

  it('a disabled control is inert', () => {
    expect(legitimatelyInert('- button "Save" [disabled]')).toBe(true);
  });
});

describe('it does not silence real controls', () => {
  /**
   * The whole value of `dead-control` is that a button doing nothing gets reported. Widening the
   * exclusion list must not reach the things the rule exists for.
   */
  it.each(['button', 'link', 'menuitem', 'tab', 'checkbox'])('%s is NOT inert', (role) => {
    expect(legitimatelyInert(`- ${role} "Sign in"`)).toBe(false);
  });

  /** A word merely containing a role name must not match — `alertdialog` IS interactive. */
  it('does not treat an alertdialog as inert', () => {
    expect(legitimatelyInert('- alertdialog "Confirm delete"')).toBe(false);
  });
});
