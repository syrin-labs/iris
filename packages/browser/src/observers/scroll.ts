import { EventType, ScrollDirection } from '@reticlehq/core';
import { refs } from '../dom/refs.js';
import { nativeSetTimeout, nativeClearTimeout } from '../timers/native-timers.js';
import type { Emit, Teardown } from './types.js';

const THROTTLE_MS = 100;
const REVEAL_SELECTOR = '[data-reticle-reveal], [data-reveal], section';

/** Observe scroll position + reveal-on-scroll for modern scroll-reactive UIs. */
export function installScroll(emit: Emit): Teardown {
  const ac = new AbortController();
  const { signal } = ac;

  let lastEmit = 0;
  let lastY = 0;
  let trailingTimer: number | undefined;

  const emitPosition = (): void => {
    lastEmit = performance.now();
    const y = window.scrollY;
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    emit(EventType.SCROLL_POSITION, {
      x: window.scrollX,
      y,
      percent: Math.round((y / max) * 100),
      direction: y >= lastY ? ScrollDirection.DOWN : ScrollDirection.UP,
    });
    lastY = y;
  };

  const onScroll = (): void => {
    const elapsed = performance.now() - lastEmit;
    if (elapsed >= THROTTLE_MS) {
      if (trailingTimer !== undefined) {
        nativeClearTimeout(trailingTimer);
        trailingTimer = undefined;
      }
      emitPosition();
      return;
    }
    // Leading-edge only dropped the FINAL, resting position — an agent asserting "scrolled to the
    // footer" saw the last mid-scroll sample, not where the page settled. Schedule a trailing emit.
    if (trailingTimer === undefined) {
      trailingTimer = nativeSetTimeout(() => {
        trailingTimer = undefined;
        emitPosition();
      }, THROTTLE_MS - elapsed);
    }
  };
  window.addEventListener('scroll', onScroll, { passive: true, signal });

  let io: IntersectionObserver | undefined;
  if ('function' === typeof IntersectionObserver) {
    io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            emit(
              EventType.REVEAL_SHOWN,
              { ratio: entry.intersectionRatio },
              refs.refFor(entry.target),
            );
          }
        }
      },
      { threshold: 0.25 },
    );
    const observer = io;
    // Observe reveal targets present at install. Reveal-on-scroll sections are in the initial DOM by
    // design (they exist hidden and animate in on scroll), so this covers the real case. Watching the
    // whole body subtree for LATE-mounted reveal targets was tried and reverted: a second body-wide
    // MutationObserver on EVERY app — running querySelectorAll(section,...) per mutation batch — is
    // disproportionate overhead for a niche signal. Dynamically-mounted reveal targets are simply not
    // tracked (an honest blind spot, consistent with the rest of the SDK).
    for (const el of document.querySelectorAll(REVEAL_SELECTOR)) observer.observe(el);
  }

  return () => {
    ac.abort();
    if (trailingTimer !== undefined) nativeClearTimeout(trailingTimer);
    io?.disconnect();
  };
}
