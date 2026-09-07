import { EventType } from '@reticlehq/core';
import { refs } from '../dom/refs.js';
import { isReticleOverlay } from '../dom/dom-ignore.js';
import type { Emit, Teardown } from './types.js';

/** Observe CSS animations + transitions and emit anim.start / anim.end. */
export function installAnimation(emit: Emit): Teardown {
  const ac = new AbortController();
  const { signal } = ac;

  const onStart = (event: AnimationEvent): void => {
    const target = event.target;
    // Skip Reticle's own HUD keyframes (reticle-pulse/reticle-shimmer/…) so observe/record never
    // self-pollute the agent's view of the app (matches the DOM observer's overlay filter).
    if (target instanceof Element && !isReticleOverlay(target)) {
      emit(EventType.ANIM_START, { name: event.animationName }, refs.refFor(target));
    }
  };
  const onEnd = (event: AnimationEvent): void => {
    const target = event.target;
    if (target instanceof Element && !isReticleOverlay(target)) {
      emit(EventType.ANIM_END, { name: event.animationName }, refs.refFor(target));
    }
  };
  const onTransitionEnd = (event: TransitionEvent): void => {
    const target = event.target;
    if (target instanceof Element && !isReticleOverlay(target)) {
      emit(
        EventType.ANIM_END,
        { name: event.propertyName, kind: 'transition' },
        refs.refFor(target),
      );
    }
  };

  document.addEventListener('animationstart', onStart, { capture: true, signal });
  document.addEventListener('animationend', onEnd, { capture: true, signal });
  document.addEventListener('transitionend', onTransitionEnd, { capture: true, signal });

  return () => ac.abort();
}
