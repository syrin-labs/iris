import { describe, it, expect, afterEach } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installScroll } from './scroll.js';
import type { Teardown } from './types.js';

interface Captured {
  type: EventType;
  data: Record<string, unknown>;
}

function setScrollY(y: number): void {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
}

describe('installScroll — trailing edge captures the resting position', () => {
  let teardown: Teardown | undefined;
  afterEach(() => {
    teardown?.();
    teardown = undefined;
    setScrollY(0);
  });

  it('emits the FINAL resting position after scrolling stops, not just the leading sample', async () => {
    const events: Captured[] = [];
    teardown = installScroll((type, data) => events.push({ type, data }));

    setScrollY(100);
    window.dispatchEvent(new Event('scroll')); // leading-edge emit at y=100
    setScrollY(500);
    window.dispatchEvent(new Event('scroll')); // within the throttle window → schedules a trailing emit

    const positions = (): Captured[] => events.filter((e) => e.type === EventType.SCROLL_POSITION);
    expect(positions().at(-1)?.data['y']).toBe(100); // only the leading sample so far

    // Poll for the trailing emit rather than sleeping past it. A fixed `setTimeout(160)` is a
    // statement about the MACHINE: it passed alone and failed inside the full unit gate, where the
    // trailing timer competes with every other suite for the event loop. The invariant is that the
    // resting position eventually arrives, not that it arrives within 160ms — see the note on
    // timing assertions in CLAUDE.md.
    const deadline = Date.now() + 5000;
    while (positions().at(-1)?.data['y'] !== 500 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // The resting position (500) must be reported — a leading-only throttle dropped it entirely.
    expect(positions().at(-1)?.data['y']).toBe(500);
  });

  it('teardown removes the scroll listener', () => {
    const events: Captured[] = [];
    const td = installScroll((type, data) => events.push({ type, data }));
    td();
    events.length = 0;

    setScrollY(200);
    window.dispatchEvent(new Event('scroll'));
    expect(events.filter((e) => e.type === EventType.SCROLL_POSITION)).toHaveLength(0);
  });
});
