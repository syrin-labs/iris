import { refs } from '../dom/refs.js';
import { hitTestOccluder } from '../dom/occlusion.js';
import { nativeFrame } from '../timers/native-timers.js';
import { asSyntheticInput } from './synthetic-input.js';

interface ClickGeometry {
  occluded: boolean;
  occludedBy: string | null;
  scrolledIntoView: boolean;
}
export const NO_GEOMETRY: ClickGeometry = {
  occluded: false,
  occludedBy: null,
  scrolledIntoView: false,
};

/**
 * Full click as a real user produces it: pointerdown -> mousedown -> focus -> pointerup -> mouseup
 * -> click. A bare `click` event skips pointer- and focus-gated handlers. Returns the click event's
 * `defaultPrevented` so the probe is unchanged. Focus only moves for focusable targets (tabIndex>=0),
 * so a plain <div> click still reports focusMoved=null.
 */
export async function fireClickSequence(
  el: HTMLElement,
  hold?: { ms: number; sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<{ prevented: boolean; heldMs: number }> {
  const doc = el.ownerDocument;
  const from: EventTarget = doc.activeElement ?? doc.body;
  firePointer(el, 'pointerdown', from);
  asSyntheticInput(() =>
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })),
  );
  if (el.tabIndex >= 0 && 'function' === typeof el.focus) el.focus();
  // The gap that makes hold-to-confirm driveable. Everything between down and up used to be
  // synchronous, so a control whose contract is "the button is down for N ms" could not be
  // expressed at all — the reported case cancelled its own confirm on the mouseup that arrived 7ms
  // later. `drag` already splits the pair across a gap; this is that shape with a timer.
  //
  // The ACHIEVED hold is measured and returned rather than echoed back: `holdMs: 1200` against a
  // 1200ms animation is a race by construction, and a caller needs to tell "held 1200" from
  // "held 1204". A backgrounded tab throttles timers, so this can legitimately overshoot by a lot.
  let heldMs = 0;
  if (hold !== undefined && hold.ms > 0) {
    const startedAt = hold.now();
    await hold.sleep(hold.ms);
    heldMs = hold.now() - startedAt;
  }
  firePointer(el, 'pointerup', from);
  asSyntheticInput(() =>
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })),
  );
  // Marked as ours so the annotator's capture-phase listener lets it through. Only the CHECK branch
  // used to do this, so the ordinary click action — which is this function — was swallowed whole in
  // annotate mode while still reporting `dispatched: true`.
  const notPrevented = asSyntheticInput(() =>
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
  );
  return { prevented: !notPrevented, heldMs };
}

/** A box has layout we can reason about (jsdom returns an all-zero box — nothing to hit-test). */
function isMeasurable(rect: DOMRect): boolean {
  return rect.width > 0 || rect.height > 0;
}

/** The center of `rect` falls outside the visible viewport. */
function isOffViewport(el: HTMLElement, rect: DOMRect): boolean {
  const win = el.ownerDocument.defaultView;
  if (null === win) return false;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return cx < 0 || cy < 0 || cx > win.innerWidth || cy > win.innerHeight;
}

/** Hit-test the center: occluded iff the top NON-Reticle element is a foreign subtree (not target/ancestor/descendant). */
function hitTest(el: HTMLElement, rect: DOMRect): { occluded: boolean; occludedBy: string | null } {
  const top = hitTestOccluder(el, rect);
  return null === top
    ? { occluded: false, occludedBy: null }
    : { occluded: true, occludedBy: refs.refFor(top) };
}

/**
 * Click-like geometry honesty: scroll an off-viewport target into view, then hit-test the click
 * point. Synthetic dispatch always reaches the target regardless — this is purely so the agent
 * learns when the target is off-screen or visually blocked instead of getting a false "it worked".
 */
export function clickGeometry(el: HTMLElement): ClickGeometry {
  if (typeof el.getBoundingClientRect !== 'function') return NO_GEOMETRY;
  let rect = el.getBoundingClientRect();
  if (!isMeasurable(rect)) return NO_GEOMETRY;
  let scrolledIntoView = false;
  if (isOffViewport(el, rect) && 'function' === typeof el.scrollIntoView) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    scrolledIntoView = true;
    rect = el.getBoundingClientRect();
  }
  return { ...hitTest(el, rect), scrolledIntoView };
}

export function firePointer(
  el: Element,
  type: string,
  relatedTarget: EventTarget | null = null,
): void {
  asSyntheticInput(() => {
    if ('function' === typeof PointerEvent) {
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, relatedTarget }));
    } else {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget }));
    }
  });
}

/** Enter/leave pointer events are non-bubbling per spec; keep them so to avoid double-firing. */
export function firePointerNonBubbling(
  el: Element,
  type: string,
  relatedTarget: EventTarget | null = null,
): void {
  asSyntheticInput(() => {
    if ('function' === typeof PointerEvent) {
      el.dispatchEvent(new PointerEvent(type, { bubbles: false, cancelable: true, relatedTarget }));
    } else {
      el.dispatchEvent(new MouseEvent(type, { bubbles: false, cancelable: true, relatedTarget }));
    }
  });
}

function makeDataTransfer(data: unknown): DataTransfer | null {
  if (typeof DataTransfer !== 'function') return null;
  const dt = new DataTransfer();
  // data: { mime, value } or [{ mime, value }, …]
  const entries = Array.isArray(data) ? data : data !== undefined ? [data] : [];
  for (const entry of entries) {
    if ('object' === typeof entry && entry !== null) {
      const e = entry as { mime?: unknown; value?: unknown };
      if ('string' === typeof e.mime && 'string' === typeof e.value) dt.setData(e.mime, e.value);
    }
  }
  return dt;
}

interface Point {
  x: number;
  y: number;
}

/** `buttons` bitmask for the primary button: 1 while held, 0 once released. */
const BUTTON_HELD = 1;
const BUTTON_RELEASED = 0;

/**
 * How many intermediate moves a drag emits.
 *
 * Enough to cross any realistic `activationConstraint: { distance: N }` while a sensor is watching,
 * and few enough that a drag stays a handful of frames rather than an animation.
 */
const DRAG_STEPS = 5;

/** The centre of an element in client coordinates — what a real pointer would be over. */
function centreOf(el: HTMLElement): Point {
  const box = el.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** A point `t` of the way from `a` to `b`, rounded — pointer coordinates are integers in practice. */
function lerp(a: Point, b: Point, t: number): Point {
  return { x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t) };
}

/**
 * Pointer-based drag (dnd-kit / react-beautiful-dnd) + best-effort HTML5 DnD. Async: yields a
 * frame between phases so React commits state between steps (fixes stale-closure handlers).
 *
 * Dispatches along a PATH with real client coordinates and a held button. Without those a
 * geometry-based library resolves the drop target as the source, so the action reports success over
 * an app that did not change — a false green produced by the tool rather than caught by it.
 */
export async function dragElement(
  source: HTMLElement,
  target: HTMLElement | null,
  data: unknown,
): Promise<boolean> {
  const dest = target ?? source;
  const from = centreOf(source);
  const to = centreOf(dest);
  /**
   * Dispatch ONE pointer/mouse pair with real coordinates and button state.
   *
   * Everything here was missing before, and each omission breaks a different, standard library
   * pattern: without coordinates a geometry-based collision resolver sees a zero delta and reports
   * the source as its own drop target; without `buttons: 1` the usual "was the mouse released?"
   * guard (`event.buttons === 0`) bails out mid-drag. Boundary events (`over`/`out` bubbling,
   * `enter`/`leave` not) do not bubble exactly when a real pointer's would not.
   */
  const fire = (
    el: Element,
    type: string,
    at: Point,
    buttons: number,
    related?: Element | null,
  ): void => {
    const bubbles = !(type.endsWith('enter') || type.endsWith('leave'));
    const init = {
      bubbles,
      cancelable: true,
      clientX: at.x,
      clientY: at.y,
      screenX: at.x,
      screenY: at.y,
      buttons,
      button: 0,
      ...(related !== undefined ? { relatedTarget: related } : {}),
    };
    if ('function' === typeof PointerEvent && type.startsWith('pointer')) {
      el.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, isPrimary: true }));
    } else {
      el.dispatchEvent(new MouseEvent(type, init));
    }
  };
  /** Is this path point inside an element's box? Rects are cached; jsdom reports zeros otherwise. */
  const sourceRect = source.getBoundingClientRect();
  const destRect = target !== null ? dest.getBoundingClientRect() : null;
  const crosses = (rect: DOMRect, p: Point): boolean =>
    p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;

  fire(source, 'pointerdown', from, BUTTON_HELD);
  fire(source, 'mousedown', from, BUTTON_HELD);
  await nativeFrame();
  // A path, not a jump. `activationConstraint: { distance: N }` is the standard way to keep a
  // draggable card clickable, and a sensor only starts a drag once it has SEEN the pointer travel
  // that far — which a single move from A to B never shows it.
  //
  // The crossing announces itself: the first step outside the source fires out/leave on it, and
  // the first step inside the destination fires over/enter on it, both with the button still held.
  // Without these, React never synthesises `onMouseEnter` on the destination (it derives that from
  // delegated `mouseover`/`mouseout`), so drag-to-select grids never extend their selection.
  let leftSource = false;
  let enteredDest = false;
  for (let step = 1; step <= DRAG_STEPS; step += 1) {
    const at = lerp(from, to, step / DRAG_STEPS);
    if (!leftSource && !crosses(sourceRect, at)) {
      leftSource = true;
      // relatedTarget is the element the pointer crossed TO/FROM; React's enter/leave synthesis
      // reads it off the delegated over/out pair to know which boundary was crossed.
      fire(source, 'pointerout', at, BUTTON_HELD, dest);
      fire(source, 'mouseout', at, BUTTON_HELD, dest);
      fire(source, 'pointerleave', at, BUTTON_HELD, dest);
      fire(source, 'mouseleave', at, BUTTON_HELD, dest);
    }
    if (leftSource && !enteredDest && destRect !== null && crosses(destRect, at)) {
      enteredDest = true;
      fire(dest, 'pointerover', at, BUTTON_HELD, source);
      fire(dest, 'mouseover', at, BUTTON_HELD, source);
      fire(dest, 'pointerenter', at, BUTTON_HELD, source);
      fire(dest, 'mouseenter', at, BUTTON_HELD, source);
    }
    fire(dest, 'pointermove', at, BUTTON_HELD);
    fire(dest, 'mousemove', at, BUTTON_HELD);
    await nativeFrame();
  }
  // A short hop whose sampled steps never land inside the destination box still crossed into it;
  // announce the arrival rather than silently skipping the pair.
  if (!enteredDest && destRect !== null) {
    fire(dest, 'pointerover', to, BUTTON_HELD, source);
    fire(dest, 'mouseover', to, BUTTON_HELD, source);
    fire(dest, 'pointerenter', to, BUTTON_HELD, source);
    fire(dest, 'mouseenter', to, BUTTON_HELD, source);
  }
  fire(dest, 'pointerup', to, BUTTON_RELEASED);
  fire(dest, 'mouseup', to, BUTTON_RELEASED);

  let dropPrevented = false;
  if ('function' === typeof DragEvent) {
    const dataTransfer = makeDataTransfer(data);
    const init: DragEventInit = { bubbles: true, cancelable: true };
    if (dataTransfer !== null) init.dataTransfer = dataTransfer;
    source.dispatchEvent(new DragEvent('dragstart', init));
    await nativeFrame();
    dest.dispatchEvent(new DragEvent('dragenter', init));
    dest.dispatchEvent(new DragEvent('dragover', init));
    await nativeFrame();
    dropPrevented = !dest.dispatchEvent(new DragEvent('drop', init));
    source.dispatchEvent(new DragEvent('dragend', init));
  }
  return dropPrevented;
}
