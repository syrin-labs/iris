/**
 * Drag-to-select through React's own delegation, the shape reported in the field.
 *
 * `onMouseDown` on a cell sets the selection anchor, `onMouseEnter` extends the selection while
 * that anchor lives, and a window-level `mouseup` clears it. React never delivers `onMouseEnter`
 * from a native `mouseenter`: its root-level plugin synthesises enter/leave pairs from delegated
 * native `mouseover`/`mouseout` as the pointer crosses element boundaries. So if the drag action
 * does not announce the crossing with those bubbling boundary events, the extend handler never
 * runs and the selection stays one cell. The rendered `data-selected` attributes are the oracle;
 * the assertion reads what the app rendered, not what our events did.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, createElement, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActionType } from '@reticlehq/core';
import { executeAction, refs } from '@reticlehq/browser';

type CellRef = ReturnType<typeof refs.refFor>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CELL_COUNT = 4;
const CELL_W = 100;
const CELL_GAP = 50;

function boxed(el: HTMLElement, index: number): HTMLElement {
  const left = index * (CELL_W + CELL_GAP);
  el.getBoundingClientRect = () =>
    ({
      x: left,
      y: 0,
      left,
      top: 0,
      right: left + CELL_W,
      bottom: 40,
      width: CELL_W,
      height: 40,
    }) as DOMRect;
  return el;
}

describe('React drag-to-select grid driven by the drag action', () => {
  let container: HTMLDivElement;
  let cellRefs: CellRef[];

  /** The #510 app shape, verbatim: including its window-level mouseup that clears the anchor. */
  function Grid(): ReturnType<typeof createElement> {
    const [sel, setSel] = useState<ReadonlySet<number>>(new Set());
    const anchor = useRef<number | null>(null);
    useEffect(() => {
      const clear = (): void => {
        anchor.current = null;
      };
      window.addEventListener('mouseup', clear);
      return (): void => window.removeEventListener('mouseup', clear);
    }, []);
    return createElement(
      'div',
      null,
      Array.from({ length: CELL_COUNT }, (_, i) =>
        createElement('div', {
          key: i,
          'data-testid': `cell-${String(i)}`,
          'data-selected': sel.has(i) ? 'true' : 'false',
          style: { width: `${CELL_W}px`, height: '40px' },
          onMouseDown: (): void => {
            anchor.current = i;
            setSel((prev) => new Set(prev).add(i));
          },
          onMouseEnter: (): void => {
            if (anchor.current !== null) setSel((prev) => new Set(prev).add(i));
          },
        }),
      ),
    );
  }

  const selectedIds = (): string[] =>
    [...container.querySelectorAll('[data-selected="true"]')].flatMap((el) => {
      const id = el.getAttribute('data-testid');
      return id !== null ? [id] : [];
    });

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      await Promise.resolve();
      root.render(createElement(Grid));
    });
    cellRefs = [];
    for (let i = 0; i < CELL_COUNT; i += 1) {
      const el = container.querySelector<HTMLElement>(`[data-testid="cell-${String(i)}"]`);
      if (null === el) throw new Error(`cell ${String(i)} did not mount`);
      cellRefs.push(refs.refFor(boxed(el, i)));
    }
  });

  afterEach(() => {
    container.remove();
  });

  it('mousedown on A anchors, dragging to C extends the selection through delegation', async () => {
    const sourceEl = container.querySelector<HTMLElement>('[data-testid="cell-0"]');
    expect(sourceEl).not.toBeNull();
    sourceEl?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await act(async () => {});
    expect(selectedIds()).toEqual(['cell-0']);

    const sourceRef = cellRefs[0];
    const targetRef = cellRefs[2];
    if (sourceRef === undefined || targetRef === undefined) throw new Error('refs missing');
    await act(async () => {
      await executeAction(sourceRef, ActionType.DRAG, { toRef: targetRef });
    });

    expect(selectedIds()).toEqual(['cell-0', 'cell-2']);
  });

  it('the drag-ending mouseup clears the anchor, so later enters extend nothing', async () => {
    const sourceEl = container.querySelector<HTMLElement>('[data-testid="cell-0"]');
    sourceEl?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await act(async () => {});

    const sourceRef = cellRefs[0];
    const targetRef = cellRefs[2];
    if (sourceRef === undefined || targetRef === undefined) throw new Error('refs missing');
    await act(async () => {
      await executeAction(sourceRef, ActionType.DRAG, { toRef: targetRef });
    });
    expect(selectedIds()).toEqual(['cell-0', 'cell-2']);

    // The anchor was cleared by the window mouseup the drag ended with, so hovering another
    // cell afterwards must not grow the old selection.
    const other = container.querySelector<HTMLElement>('[data-testid="cell-1"]');
    other?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await act(async () => {});
    expect(selectedIds()).toEqual(['cell-0', 'cell-2']);
  });
});
