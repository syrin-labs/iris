/**
 * The escape hatch for the one app Reticle cannot otherwise verify: itself.
 *
 * Reticle's presenter is hidden from every tool by design, and the reason is sound — an agent that
 * can drive Reticle's own interface can fabricate its own impact report, and Reticle chrome is noise
 * in every other app on earth. The cost is that a HUD change is the only kind of change Reticle
 * cannot be used to check, because the panel rendering it is invisible to everything that could
 * look at it.
 *
 * So the hatch must be: off by default, total when open, and impossible to have open without
 * anybody noticing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  isIgnored,
  isPresenterVisible,
  setIgnoreSelectors,
  setPresenterVisible,
} from './dom-ignore.js';
import { getCapabilities } from '../registry/capabilities.js';

const el = (html: string): Element => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild as Element;
};

afterEach(() => {
  setPresenterVisible(false);
  setIgnoreSelectors([]);
});

describe('closed by default', () => {
  it('hides Reticle’s own HUD', () => {
    expect(isIgnored(el('<div data-reticle-hud><span>impact</span></div>'))).toBe(true);
  });

  it('hides every part of the presenter, not just the HUD', () => {
    for (const attr of ['data-reticle-overlay', 'data-reticle-cursor', 'data-reticle-glow']) {
      expect(isIgnored(el(`<div ${attr}></div>`)), attr).toBe(true);
    }
  });

  it('reports nothing in capabilities, because closed is the ordinary case', () => {
    expect(getCapabilities().presenterExposed).toBeUndefined();
  });
});

describe('open', () => {
  it('makes the HUD visible to snapshots and queries', () => {
    setPresenterVisible(true);
    expect(isIgnored(el('<div data-reticle-hud><span>impact</span></div>'))).toBe(false);
  });

  it('still hides third-party dev overlays — somebody else’s furniture is not the subject', () => {
    setPresenterVisible(true);
    expect(isIgnored(el('<nextjs-portal></nextjs-portal>'))).toBe(true);
    expect(isIgnored(el('<div data-agentation></div>'))).toBe(true);
  });

  it('still honours selectors the app asked to ignore', () => {
    setPresenterVisible(true);
    setIgnoreSelectors(['.my-dev-widget']);
    expect(isIgnored(el('<div class="my-dev-widget"></div>'))).toBe(true);
  });

  it('ANNOUNCES itself, so a verdict drawn with it open is never mistaken for an ordinary one', () => {
    setPresenterVisible(true);
    expect(getCapabilities().presenterExposed).toBe(true);
  });

  it('closes again cleanly', () => {
    setPresenterVisible(true);
    setPresenterVisible(false);
    expect(isPresenterVisible()).toBe(false);
    expect(isIgnored(el('<div data-reticle-hud></div>'))).toBe(true);
  });

  it('leaves ordinary app elements alone either way', () => {
    for (const open of [false, true]) {
      setPresenterVisible(open);
      expect(isIgnored(el('<button data-testid="submit">Go</button>')), String(open)).toBe(false);
    }
  });
});
