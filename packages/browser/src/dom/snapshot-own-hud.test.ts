/**
 * Reticle's own HUD is not the application's modal.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { buildSnapshot } from './snapshot.js';
import { setPresenterVisible } from './dom-ignore.js';

beforeEach(() => {
  document.body.innerHTML = '';
  setPresenterVisible(true); // the app under test IS Reticle — the only case where the HUD is visible
});

const appWithHud = (): void => {
  document.body.innerHTML = `
    <main><h1>Issues</h1><ul data-testid="issue-list"><li>a defect</li></ul></main>
    <div data-reticle-hud>
      <div role="dialog" aria-label="Reticle agent chat">chat</div>
    </div>`;
};

describe('the HUD never masquerades as the app', () => {
  it('is not reported as an open dialog', () => {
    appWithHud();
    const snap = buildSnapshot();
    // Telling an agent a modal is up when the app has none makes it dismiss something first —
    // wasted at best, and it dismisses a REAL dialog at worst.
    expect(snap.status?.visibleDialogs ?? []).not.toContain('Reticle agent chat');
  });

  it('a REAL app dialog is still reported alongside it', () => {
    appWithHud();
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div role="dialog" aria-label="Delete workspace">sure?</div>',
    );
    expect(buildSnapshot().status?.visibleDialogs ?? []).toStrictEqual(['Delete workspace']);
  });

  it('does not explain an empty page with itself', () => {
    // The app is aria-hidden, and the ONLY dialog present is ours. The overlay hint must not fire:
    // it would send the reader to dismiss a panel that was never the cause.
    document.body.innerHTML = `
      <main aria-hidden="true"><h1>Issues</h1></main>
      <div data-reticle-hud>
        <div role="dialog" aria-label="Reticle agent chat">chat</div>
      </div>`;
    const snap = buildSnapshot();
    expect(JSON.stringify(snap.status ?? {})).not.toContain('focus-trap modal');
  });
});
