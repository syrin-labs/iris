import { describe, expect, it, beforeEach } from 'vitest';
import { Presenter } from './presenter.js';

/**
 * An instrumented page whose bridge is dead used to look EXACTLY like a page with no Reticle in it:
 * the overlay mounted, the dock stayed off, and nothing on screen said why. That is the same
 * "silence reads as clean" failure the verdict layer refuses everywhere else, pointed at the user
 * instead of the agent — they cannot tell "I forgot to start the daemon" from "the install failed".
 */
describe('a bridge that never answered', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.querySelectorAll('style[data-reticle-overlay]').forEach((s) => s.remove());
  });

  const mount = (): Presenter => {
    const p = new Presenter();
    p.mount();
    return p;
  };

  const dockOn = (): string | null =>
    document.querySelector('[data-reticle-dock]')?.getAttribute('data-on') ?? null;

  it('is invisible before anything is known, so an idle page is not decorated', () => {
    mount();
    expect(dockOn()).not.toBe('1');
  });

  it('shows the HUD when the bridge could not be reached', () => {
    const p = mount();
    p.showUnreachable('ws://localhost:4460/reticle', 3);
    expect(dockOn()).toBe('1');
  });

  it('says WHICH url it tried, because the port is the usual answer', () => {
    const p = mount();
    p.showUnreachable('ws://localhost:4460/reticle', 3);
    expect(document.querySelector('.reticle-act')?.textContent ?? '').toContain('4460');
  });

  it('marks itself unreachable rather than posing as a live session', () => {
    const p = mount();
    p.showUnreachable('ws://localhost:4460/reticle', 3);
    expect(
      document.querySelector('div[data-reticle-overlay]')?.getAttribute('data-reticle-state'),
    ).toBe('unreachable');
    expect(p.sessionActive).toBe(false);
  });

  it('gives way the moment a bridge does answer', () => {
    const p = mount();
    p.showUnreachable('ws://localhost:4460/reticle', 3);
    p.sessionStart();
    expect(p.sessionActive).toBe(true);
    expect(
      document.querySelector('div[data-reticle-overlay]')?.getAttribute('data-reticle-state'),
    ).not.toBe('unreachable');
  });
});
