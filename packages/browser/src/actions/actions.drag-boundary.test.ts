/**
 * A drag that never announces where the pointer went cannot drive drag-to-select.
 *
 * Reported on a plain-HTML data grid: `onMouseDown` on a cell sets the selection anchor,
 * `onMouseEnter` on other cells extends the selection while that anchor is set, and a window-level
 * `mouseup` clears it. The drag dispatched a real held-button `mousedown` and a stepped path of
 * moves, but never the boundary events a real pointer produces when it crosses from one element to
 * another, so React (which synthesises `onMouseEnter` from delegated `mouseover`/`mouseout`) never
 * called the extend handler and the selection never grew.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { dragElement } from './actions-dom.js';

interface Captured {
  type: string;
  buttons: number;
}

function boxed(el: HTMLElement, x: number, y: number, w = 100, h = 40): HTMLElement {
  el.getBoundingClientRect = () =>
    ({ x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }) as DOMRect;
  return el;
}

function recorder(el: HTMLElement, log: Captured[]): void {
  for (const type of [
    'pointerdown',
    'mousedown',
    'pointerout',
    'mouseout',
    'pointerleave',
    'mouseleave',
    'pointerover',
    'mouseover',
    'pointerenter',
    'mouseenter',
    'pointermove',
    'mousemove',
    'pointerup',
    'mouseup',
  ]) {
    el.addEventListener(type, (e) => {
      log.push({ type, buttons: (e as MouseEvent).buttons });
    });
  }
}

describe('dragElement boundary events', () => {
  let source: HTMLElement;
  let dest: HTMLElement;
  let onSource: Captured[];
  let onDest: Captured[];

  beforeEach(() => {
    document.body.innerHTML = '';
    source = boxed(document.createElement('div'), 0, 0);
    dest = boxed(document.createElement('div'), 300, 0);
    document.body.append(source, dest);
    onSource = [];
    onDest = [];
    recorder(source, onSource);
    recorder(dest, onDest);
  });

  const seen = (log: Captured[], type: string): Captured[] => log.filter((c) => c.type === type);

  it('the source sees out/leave and the destination sees over/enter, button still held', async () => {
    await dragElement(source, dest, undefined);

    for (const type of ['pointerout', 'mouseout', 'pointerleave', 'mouseleave']) {
      const events = seen(onSource, type);
      expect(events, `source should see ${type}`).toHaveLength(1);
      expect(events[0]?.buttons).toBe(1);
    }
    for (const type of ['pointerover', 'mouseover', 'pointerenter', 'mouseenter']) {
      const events = seen(onDest, type);
      expect(events, `destination should see ${type}`).toHaveLength(1);
      expect(events[0]?.buttons).toBe(1);
    }
  });

  it('boundary events fire between mousedown and mouseup, in the crossing order', async () => {
    await dragElement(source, dest, undefined);

    const sourceOrder = onSource.map((c) => c.type);
    expect(sourceOrder.indexOf('mouseout')).toBeGreaterThan(sourceOrder.indexOf('mousedown'));
    const destOrder = onDest.map((c) => c.type);
    expect(destOrder.indexOf('mouseover')).toBeGreaterThan(-1);
    expect(destOrder.indexOf('mouseup')).toBeGreaterThan(destOrder.indexOf('mouseover'));
    // The enter pair arrives while the button is still held, not as part of release cleanup.
    expect(seen(onDest, 'mouseenter')[0]?.buttons).toBe(1);
    expect(seen(onDest, 'mouseup')[0]?.buttons).toBe(0);
  });

  it('a free drag (no target) crosses no boundary and fires no enter/leave pair', async () => {
    await dragElement(source, null, undefined);
    expect(seen(onSource, 'mouseenter')).toHaveLength(0);
    expect(seen(onSource, 'mouseleave')).toHaveLength(0);
    expect(seen(onSource, 'mousemove').length).toBeGreaterThan(0);
  });

  it('over/out bubble and enter/leave do not, matching what a real pointer emits', async () => {
    const bubbles: Record<string, boolean> = {};
    const watch = (el: HTMLElement): void => {
      for (const type of ['mouseover', 'mouseout', 'mouseenter', 'mouseleave']) {
        el.addEventListener(type, (e) => {
          bubbles[type] = e.bubbles;
        });
      }
    };
    watch(source);
    watch(dest);
    await dragElement(source, dest, undefined);
    expect(bubbles['mouseover']).toBe(true);
    expect(bubbles['mouseout']).toBe(true);
    expect(bubbles['mouseenter']).toBe(false);
    expect(bubbles['mouseleave']).toBe(false);
  });
});
