import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installAnimation } from './animation.js';
import type { Emit } from './types.js';

interface Emitted {
  type: EventType;
  data: Record<string, unknown>;
}

function collect(): { emit: Emit; events: Emitted[] } {
  const events: Emitted[] = [];
  const emit: Emit = (type, data) => {
    events.push({ type, data });
  };
  return { emit, events };
}

/** jsdom lacks AnimationEvent/TransitionEvent constructors — synthesize the props the observer reads. */
function fireAnim(
  el: Element,
  type: 'animationstart' | 'animationend',
  animationName: string,
): void {
  const e = new Event(type, { bubbles: true });
  Object.assign(e, { animationName });
  el.dispatchEvent(e);
}

function fireTransitionEnd(el: Element, propertyName: string): void {
  const e = new Event('transitionend', { bubbles: true });
  Object.assign(e, { propertyName });
  el.dispatchEvent(e);
}

describe('animation observer: overlay self-pollution', () => {
  let teardown: (() => void) | undefined;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it('emits anim.start for a normal app element', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const { emit, events } = collect();
    teardown = installAnimation(emit);

    fireAnim(el, 'animationstart', 'fade');

    expect(events.map((e) => e.type)).toContain(EventType.ANIM_START);
  });

  it('does NOT emit for an element inside the Reticle presenter overlay', () => {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-reticle-overlay', '');
    const row = document.createElement('div');
    overlay.appendChild(row);
    document.body.appendChild(overlay);
    const { emit, events } = collect();
    teardown = installAnimation(emit);

    // The HUD's own reticle-pulse/reticle-shimmer keyframes used to flood observed timelines.
    fireAnim(row, 'animationstart', 'reticle-pulse');
    fireAnim(row, 'animationend', 'reticle-pulse');
    fireTransitionEnd(row, 'opacity');

    expect(events).toHaveLength(0);
  });

  it('still emits transitionend for a normal app element', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const { emit, events } = collect();
    teardown = installAnimation(emit);

    fireTransitionEnd(el, 'height');

    expect(events.map((e) => e.type)).toContain(EventType.ANIM_END);
  });

  it('stops emitting after teardown', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const { emit, events } = collect();
    teardown = installAnimation(emit);
    teardown();
    teardown = undefined;
    events.length = 0;

    fireAnim(el, 'animationstart', 'fade');
    fireAnim(el, 'animationend', 'fade');
    fireTransitionEnd(el, 'opacity');

    expect(events).toHaveLength(0);
  });
});
