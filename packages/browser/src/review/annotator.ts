import { isSyntheticInput } from '../actions/synthetic-input.js';
import { EventType } from '@reticlehq/core';
import { isReticleUi, isReticleOverlay } from '../dom/dom-ignore.js';
import { resolveMarkAnchor, type MarkAnchor } from './mark-anchor.js';
import { nativeSetTimeout, nativeClearTimeout } from '../timers/native-timers.js';
import {
  ANNOTATOR_CSS,
  ANNOTATOR_ROOT_HTML,
  MARK_CANCEL,
  MARK_PENDING_GLYPH,
  MARK_PLACEHOLDER,
  MARK_SUBMIT,
} from './annotator-styles.js';

/** The cursor must rest this long before the outline boxes the element under it - calm, not jumpy. */
const HIGHLIGHT_REST_MS = 130;
const SHAKE_MS = 250;
const POP_W = 280;
const POP_H = 170;
const EDGE = 8;
const MARK_ATTR = 'data-reticle-mark';
const ACTIVE_ATTR = 'data-reticle-mark-active';
const sel = (role: string): string => `[${MARK_ATTR}="${role}"]`;

/**
 * What the HUD is told about a mark the moment it is placed.
 *
 * The row used to get the note and the anchor's label - "generic: my feedback" - which names
 * neither the element nor which of several marks it is. The pin on the page is numbered, so the
 * row carries the same number, plus the source the anchor already resolved.
 */
interface MarkReport {
  note: string;
  /** The anchor the agent will look the element up by, e.g. `[data-testid="deploy-submit"]`. */
  anchor: string;
  label: string;
  /** 1-based, matching the number drawn in the pin. */
  index: number;
  /** file:line, when the app is source-stamped. */
  source?: string;
}

export interface AnnotatorDeps {
  emit: (type: EventType, data: Record<string, unknown>) => void;
  now: () => number;
  onMark?: (mark: MarkReport) => void;
  shouldBlock?: () => boolean;
  onCountChange?: (count: number) => void;
}

export interface AnnotatorChrome {
  markersBtn?: HTMLElement;
  clearBtn?: HTMLElement;
  countEl?: HTMLElement;
}

interface StoredMark {
  id: string;
  note: string;
  label: string;
  anchor: string;
  route: string;
  xPct: number;
  yDoc: number;
  clientX: number;
  clientY: number;
  isFixed: boolean;
  pin: HTMLElement;
  target: Element | undefined;
  source: string | undefined;
}

export class Annotator {
  readonly #emit: AnnotatorDeps['emit'];
  readonly #now: AnnotatorDeps['now'];
  readonly #onMark: AnnotatorDeps['onMark'];
  readonly #shouldBlock: () => boolean;
  readonly #onCountChange: AnnotatorDeps['onCountChange'];
  #root: HTMLElement | undefined;
  #hi: HTMLElement | undefined;
  #hiLabel: HTMLElement | undefined;
  #selBox: HTMLElement | undefined;
  #pop: HTMLElement | undefined;
  #pending: HTMLElement | undefined;
  #hiTimer: ReturnType<typeof nativeSetTimeout> | undefined;
  #shakeTimer: ReturnType<typeof nativeSetTimeout> | undefined;
  #active = false;
  #marks: StoredMark[] = [];
  #editing: StoredMark | undefined;
  #pendingKey: string | undefined;
  #pendingTarget: Element | undefined;
  #markersBtn: HTMLElement | undefined;
  #clearBtn: HTMLElement | undefined;
  #countEl: HTMLElement | undefined;
  #accent: string | undefined;
  #onClick: ((ev: MouseEvent) => void) | undefined;
  #onKeydown: ((ev: KeyboardEvent) => void) | undefined;
  #onMove: ((ev: MouseEvent) => void) | undefined;
  #onScroll: (() => void) | undefined;
  #onResize: (() => void) | undefined;
  #mo: MutationObserver | undefined;

  constructor(deps: AnnotatorDeps) {
    this.#emit = deps.emit;
    this.#now = deps.now;
    this.#onMark = deps.onMark;
    this.#shouldBlock = deps.shouldBlock ?? ((): boolean => true);
    this.#onCountChange = deps.onCountChange;
  }

  get active(): boolean {
    return this.#active;
  }

  get markCount(): number {
    return this.#marks.length;
  }

  mount(): void {
    if (this.#root !== undefined || 'undefined' === typeof document) return;
    const style = document.createElement('style');
    style.setAttribute(MARK_ATTR, 'style');
    style.textContent = ANNOTATOR_CSS;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.setAttribute(MARK_ATTR, 'root');
    root.innerHTML = ANNOTATOR_ROOT_HTML;
    document.body.appendChild(root);
    this.#root = root;
    this.#hi = root.querySelector<HTMLElement>(sel('hi')) ?? undefined;
    this.#hiLabel = root.querySelector<HTMLElement>(sel('hilabel')) ?? undefined;
    this.#selBox = root.querySelector<HTMLElement>(sel('sel')) ?? undefined;

    this.#onClick = (ev: MouseEvent): void => this.#handleClick(ev);
    document.addEventListener('click', this.#onClick, { capture: true });
    this.#onMove = (ev: MouseEvent): void => this.#scheduleMove(ev);
    document.addEventListener('mousemove', this.#onMove, { passive: true, capture: true });
    this.#onKeydown = (ev: KeyboardEvent): void => this.#handleKey(ev);
    document.addEventListener('keydown', this.#onKeydown);
    this.#onScroll = (): void => this.#reposition();
    this.#onResize = (): void => this.#reposition();
    window.addEventListener('scroll', this.#onScroll, true);
    window.addEventListener('resize', this.#onResize);
    this.#mo = new MutationObserver(() => this.syncAnchors());
    this.#mo.observe(document.documentElement, { childList: true, subtree: true });
    if (undefined !== this.#accent) this.setAccent(this.#accent);
  }

  /** Drive marker/highlight chrome from the HUD accent swatch. */
  setAccent(hex: string): void {
    this.#accent = hex;
    this.#root?.style.setProperty('--reticle-mark-accent', hex);
  }

  /** @deprecated HUD expand/collapse owns annotate mode; chrome buttons are hide/clear. */
  attachFlagButton(btn: HTMLElement): void {
    this.attachChrome({ markersBtn: btn });
  }

  attachChrome(chrome: AnnotatorChrome): void {
    this.#markersBtn = chrome.markersBtn;
    this.#clearBtn = chrome.clearBtn;
    this.#countEl = chrome.countEl;
    this.#markersBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#toggleMarkers();
    });
    this.#clearBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.clearAll();
    });
    this.#syncChrome();
  }

  destroy(): void {
    if (this.#onClick !== undefined) {
      document.removeEventListener('click', this.#onClick, { capture: true });
      this.#onClick = undefined;
    }
    if (this.#onKeydown !== undefined) {
      document.removeEventListener('keydown', this.#onKeydown);
      this.#onKeydown = undefined;
    }
    if (this.#onMove !== undefined) {
      document.removeEventListener('mousemove', this.#onMove, { capture: true });
      this.#onMove = undefined;
    }
    if (this.#onScroll !== undefined) {
      window.removeEventListener('scroll', this.#onScroll, true);
      this.#onScroll = undefined;
    }
    if (this.#onResize !== undefined) {
      window.removeEventListener('resize', this.#onResize);
      this.#onResize = undefined;
    }
    this.#mo?.disconnect();
    this.#mo = undefined;
    if (this.#hiTimer !== undefined) nativeClearTimeout(this.#hiTimer);
    if (this.#shakeTimer !== undefined) nativeClearTimeout(this.#shakeTimer);
    this.#closePopover();
    document.documentElement.removeAttribute(ACTIVE_ATTR);
    this.#root?.remove();
    document.querySelectorAll(`style[${MARK_ATTR}="style"]`).forEach((s) => s.remove());
    this.#root = undefined;
    this.#active = false;
    this.#marks = [];
  }

  toggle(on?: boolean): void {
    this.#active = on ?? !this.#active;
    if (this.#active) document.documentElement.setAttribute(ACTIVE_ATTR, '1');
    else {
      document.documentElement.removeAttribute(ACTIVE_ATTR);
      this.#hideHighlight();
      this.#closePopover();
    }
    this.#syncChrome();
  }

  clearAll(): void {
    this.#closePopover();
    for (const mark of this.#marks) mark.pin.remove();
    this.#marks = [];
    this.#syncChrome();
  }

  syncAnchors(): void {
    const route = currentRoute();
    for (const mark of this.#marks) {
      const live = mark.target !== undefined && document.contains(mark.target);
      if (!live) {
        mark.target = undefined;
        mark.pin.setAttribute('data-stale', '1');
      } else {
        mark.pin.removeAttribute('data-stale');
      }
      mark.pin.hidden = mark.route !== route;
    }
    this.#paintSelection();
  }

  #toggleMarkers(): void {
    const root = this.#root;
    if (root === undefined) return;
    const hide = '1' === root.getAttribute('data-hide') ? '0' : '1';
    if ('1' === hide) root.setAttribute('data-hide', '1');
    else root.removeAttribute('data-hide');
    this.#markersBtn?.setAttribute('data-active', '0' === hide ? '0' : '1');
    this.#markersBtn?.setAttribute('aria-pressed', '1' === hide ? 'true' : 'false');
  }

  #syncChrome(): void {
    const n = this.#marks.length;
    this.#onCountChange?.(n);
    if (this.#countEl !== undefined) {
      this.#countEl.textContent = String(n);
      this.#countEl.hidden = 0 === n;
    }
    this.#clearBtn?.toggleAttribute('disabled', 0 === n);
    this.#markersBtn?.toggleAttribute('disabled', 0 === n);
  }

  #handleKey(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape' || !this.#active) return;
    if (this.#pop !== undefined) {
      ev.preventDefault();
      this.#closePopover();
      return;
    }
    this.toggle(false);
  }

  #handleClick(ev: MouseEvent): void {
    if (!this.#active) return;
    // A click Reticle dispatched is the agent driving the app, not a person placing a mark. Without
    // this, expanding the HUD silently disabled every `reticle_act` click while the action still
    // reported success — a false green in our own UI. See synthetic-input.ts.
    if (isSyntheticInput()) return;
    const raw = ev.target;
    if (!(raw instanceof Element)) return;
    // The page blocker is a full-viewport shield Reticle puts up WHILE annotating, so with it on
    // every click lands on Reticle's own UI and was discarded as such — annotate mode looked
    // completely dead, because the one thing standing between the user and the page is the thing
    // annotate mode turns on. Resolve what is underneath instead of giving up on the click.
    const target = raw.hasAttribute(BLOCKER_ATTR_NAME)
      ? pageElementAt(ev.clientX, ev.clientY)
      : raw;
    if (target === undefined) return;
    if (isReticleOverlay(target)) return;
    if (true === this.#markersBtn?.contains(target)) return;
    if (true === this.#clearBtn?.contains(target)) return;
    if (target.closest(sel('pin')) !== null) return;
    if (target.closest(sel('pop')) !== null) return;

    if (this.#pop !== undefined) {
      ev.preventDefault();
      ev.stopPropagation();
      this.#shakePopover();
      return;
    }

    const el = target instanceof HTMLElement ? target : target.parentElement;
    if (null === el) return;
    if (this.#shouldBlock()) {
      ev.preventDefault();
      ev.stopPropagation();
    } else {
      ev.preventDefault();
    }

    const key = markKey(el);
    const existing = this.#marks.find((m) => m.anchor === key && m.route === currentRoute());
    if (existing !== undefined) {
      this.#openEdit(existing);
      return;
    }
    this.#openPopover(el, ev.clientX, ev.clientY);
  }

  #scheduleMove(ev: MouseEvent): void {
    if (this.#hiTimer !== undefined) nativeClearTimeout(this.#hiTimer);
    this.#hiTimer = nativeSetTimeout(() => {
      this.#hiTimer = undefined;
      this.#handleMove(ev);
    }, HIGHLIGHT_REST_MS);
  }

  #handleMove(ev: MouseEvent): void {
    if (this.#hi === undefined) return;
    const raw = ev.target;
    // Same shield as in #handleClick: while annotating, a full-viewport blocker sits over the page,
    // so EVERY mousemove reports it as the target. Resolving only there left the outline suppressed
    // on every element - a crosshair with no indication of what it was on. See #handleClick.
    const target =
      raw instanceof Element && raw.hasAttribute(BLOCKER_ATTR_NAME)
        ? pageElementAt(ev.clientX, ev.clientY)
        : raw;
    const skip =
      !this.#active ||
      this.#pop !== undefined ||
      !(target instanceof Element) ||
      isReticleOverlay(target) ||
      target.closest(sel('pin')) !== null;
    if (skip) {
      this.#hi.setAttribute('data-on', '0');
      return;
    }
    const rect = target.getBoundingClientRect();
    if (0 === rect.width && 0 === rect.height) {
      this.#hi.setAttribute('data-on', '0');
      return;
    }
    this.#hi.style.left = `${String(rect.left)}px`;
    this.#hi.style.top = `${String(rect.top)}px`;
    this.#hi.style.width = `${String(rect.width)}px`;
    this.#hi.style.height = `${String(rect.height)}px`;
    this.#hi.setAttribute('data-on', '1');
    if (this.#hiLabel !== undefined) this.#hiLabel.textContent = describeEl(target);
  }

  #hideHighlight(): void {
    if (this.#hiTimer !== undefined) {
      nativeClearTimeout(this.#hiTimer);
      this.#hiTimer = undefined;
    }
    this.#hi?.setAttribute('data-on', '0');
  }

  #openEdit(mark: StoredMark): void {
    this.#closePopover();
    this.#editing = mark;
    this.#pendingKey = mark.anchor;
    this.#pendingTarget = mark.target;
    this.#hideHighlight();
    // Where the element is NOW, not where it was when the mark was made. The popover is
    // position:fixed, so it is placed in viewport coordinates, and the stored clientX/clientY are
    // viewport coordinates from an earlier scroll position. Reopening a mark after scrolling put the
    // note somewhere unrelated to the thing it annotates — further away the further you had scrolled.
    const at = this.#currentPoint(mark);
    this.#mountPopover(mark.label, at.x, at.y, mark.note);
    this.#dropPending(at.x, at.y);
    this.#paintSelection();
  }

  /**
   * The viewport point a mark's popover should open at.
   *
   * Prefers the element's live box, because that is what the note is ABOUT. Falls back to the stored
   * coordinates only when the element is gone, where there is nothing better and the mark is already
   * shown as stale.
   */
  #currentPoint(mark: StoredMark): { x: number; y: number } {
    const el = mark.target;
    if (el !== undefined && el.isConnected) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return { x: mark.clientX, y: mark.isFixed ? mark.clientY : mark.yDoc - window.scrollY };
  }

  #openPopover(el: Element, x: number, y: number): void {
    const resolved = resolveMarkAnchor(el);
    const key = resolved.anchor;
    if (this.#pendingKey === key && this.#pop !== undefined) {
      this.#shakePopover();
      return;
    }
    this.#closePopover();
    this.#hideHighlight();
    this.#editing = undefined;
    this.#pendingKey = key;
    this.#pendingTarget = el;
    const where =
      resolved.source !== undefined
        ? `${resolved.label} · ${resolved.source.file}:${String(resolved.source.line)}`
        : resolved.label;
    this.#mountPopover(where, x, y, '');
    this.#dropPending(x, y);
    this.#paintSelection();
    this.#bindSubmit(resolved, x, y);
  }

  #mountPopover(where: string, x: number, y: number, initial: string): void {
    const pop = document.createElement('div');
    pop.setAttribute(MARK_ATTR, 'pop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', MARK_PLACEHOLDER);
    pop.innerHTML = `<div class="reticle-mark-where"></div>
      <textarea rows="2" placeholder="${MARK_PLACEHOLDER}"></textarea>
      <div class="reticle-mark-row">
        <button type="button" data-cancel>${MARK_CANCEL}</button>
        <button type="button" data-send disabled>${MARK_SUBMIT}</button>
      </div>`;
    const whereEl = pop.querySelector('.reticle-mark-where');
    if (whereEl !== null) whereEl.textContent = where;
    const pos = clampPop(x, y);
    pop.style.left = `${String(pos.left)}px`;
    pop.style.top = `${String(pos.top)}px`;
    this.#root?.appendChild(pop);
    this.#pop = pop;
    requestAnimationFrame(() => pop.setAttribute('data-in', '1'));

    const textarea = pop.querySelector('textarea');
    const send = pop.querySelector<HTMLButtonElement>('button[data-send]');
    if (textarea !== null) {
      textarea.value = initial;
      if (send !== null) send.disabled = 0 === textarea.value.trim().length;
      textarea.addEventListener('input', () => {
        if (send !== null) send.disabled = 0 === textarea.value.trim().length;
      });
      textarea.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.isComposing) return;
        if ('Escape' === e.key) {
          e.preventDefault();
          this.#closePopover();
        } else if ('Enter' === e.key && !e.shiftKey) {
          e.preventDefault();
          this.#submitOpen();
        }
      });
      nativeSetTimeout(() => textarea.focus(), 50);
    }
    pop.querySelector('button[data-cancel]')?.addEventListener('click', () => this.#closePopover());
    send?.addEventListener('click', () => this.#submitOpen());
    this.#pendingResolved = undefined;
    this.#pendingXY = { x, y };
  }

  #pendingResolved: MarkAnchor | undefined;
  #pendingXY = { x: 0, y: 0 };

  #bindSubmit(resolved: MarkAnchor, x: number, y: number): void {
    this.#pendingResolved = resolved;
    this.#pendingXY = { x, y };
  }

  #submitOpen(): void {
    const note = this.#pop?.querySelector('textarea')?.value.trim() ?? '';
    if (0 === note.length) return;
    const editing = this.#editing;
    if (editing !== undefined) {
      editing.note = note;
      const tipn = editing.pin.querySelector(sel('tipn'));
      if (tipn !== null) tipn.textContent = note;
      this.#emit(EventType.HUMAN_MARK, {
        note,
        anchor: editing.anchor,
        label: editing.label,
        route: editing.route,
      });
      this.#report(
        note,
        editing.anchor,
        editing.label,
        this.#marks.indexOf(editing) + 1,
        editing.source,
      );
      this.#closePopover();
      return;
    }
    const resolved = this.#pendingResolved;
    if (resolved === undefined) return;
    this.#sendMark(note, resolved, this.#pendingXY.x, this.#pendingXY.y);
    this.#closePopover();
  }

  #shakePopover(): void {
    const pop = this.#pop;
    if (pop === undefined) return;
    pop.classList.remove('reticle-mark-shake');
    void pop.offsetWidth;
    pop.classList.add('reticle-mark-shake');
    if (this.#shakeTimer !== undefined) nativeClearTimeout(this.#shakeTimer);
    this.#shakeTimer = nativeSetTimeout(() => {
      pop.classList.remove('reticle-mark-shake');
      this.#shakeTimer = undefined;
    }, SHAKE_MS);
  }

  #sendMark(note: string, resolved: MarkAnchor, x: number, y: number): void {
    const data: Record<string, unknown> = {
      note,
      anchor: resolved.anchor,
      strategy: resolved.strategy,
      label: resolved.label,
      route: currentRoute(),
    };
    if (resolved.source !== undefined) data['source'] = resolved.source;
    this.#emit(EventType.HUMAN_MARK, data);
    this.#now();
    this.#dropPin(resolved, note, x, y);
    this.#report(note, resolved.anchor, resolved.label, this.#marks.length, sourceLabel(resolved));
  }

  /** Hand the HUD everything it needs to name this mark in one row. */
  #report(
    note: string,
    anchor: string,
    label: string,
    index: number,
    source: string | undefined,
  ): void {
    const mark: MarkReport = { note, anchor, label, index };
    if (source !== undefined) mark.source = source;
    this.#onMark?.(mark);
  }

  #dropPending(x: number, y: number): void {
    this.#pending?.remove();
    const pending = document.createElement('div');
    pending.setAttribute(MARK_ATTR, 'pending');
    pending.textContent = MARK_PENDING_GLYPH;
    pending.style.left = `${String(x)}px`;
    pending.style.top = `${String(y)}px`;
    this.#root?.appendChild(pending);
    this.#pending = pending;
  }

  #dropPin(resolved: MarkAnchor, note: string, x: number, y: number): void {
    if (this.#root === undefined) return;
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.setAttribute(MARK_ATTR, 'pin');
    pin.setAttribute('aria-label', resolved.label);
    const n = this.#marks.length + 1;
    pin.innerHTML = `<span>${String(n)}</span><span ${MARK_ATTR}="tip"><span ${MARK_ATTR}="tipq"></span><span ${MARK_ATTR}="tipn"></span></span>`;
    const q = pin.querySelector(sel('tipq'));
    const tn = pin.querySelector(sel('tipn'));
    if (q !== null) q.textContent = resolved.label;
    if (tn !== null) tn.textContent = note;
    const isFixed = isElementFixed(this.#pendingTarget);
    const yDoc = isFixed ? y : y + window.scrollY;
    pin.style.left = `${String((x / window.innerWidth) * 100)}%`;
    pin.style.top = `${String(isFixed ? y : yDoc - window.scrollY)}px`;
    this.#root.appendChild(pin);
    const mark: StoredMark = {
      id: `${resolved.anchor}:${String(this.#now())}:${String(n)}`,
      note,
      label: resolved.label,
      anchor: resolved.anchor,
      route: currentRoute(),
      xPct: (x / window.innerWidth) * 100,
      yDoc,
      clientX: x,
      clientY: y,
      isFixed,
      pin,
      target: this.#pendingTarget,
      source: sourceLabel(resolved),
    };
    pin.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.#active) return;
      this.#openEdit(mark);
    });
    this.#marks.push(mark);
    this.#syncChrome();
  }

  #paintSelection(): void {
    const box = this.#selBox;
    if (box === undefined) return;
    const el = this.#pendingTarget;
    if (el === undefined || !document.contains(el) || this.#pop === undefined) {
      box.hidden = true;
      return;
    }
    const rect = el.getBoundingClientRect();
    box.hidden = false;
    box.style.left = `${String(rect.left)}px`;
    box.style.top = `${String(rect.top)}px`;
    box.style.width = `${String(rect.width)}px`;
    box.style.height = `${String(rect.height)}px`;
  }

  #reposition(): void {
    for (const mark of this.#marks) {
      if (mark.isFixed) {
        mark.pin.style.top = `${String(mark.clientY)}px`;
        continue;
      }
      mark.pin.style.top = `${String(mark.yDoc - window.scrollY)}px`;
    }
    this.#repositionPopover();
    this.#paintSelection();
  }

  /**
   * Keep an OPEN popover attached to its element while the page scrolls.
   *
   * The pins were repositioned here and the popover was not, so scrolling with a note open slid the
   * note off its target and left it floating over unrelated content.
   */
  #repositionPopover(): void {
    const pop = this.#pop;
    const mark = this.#editing;
    if (pop === undefined || mark === undefined) return;
    const at = this.#currentPoint(mark);
    const pos = clampPop(at.x, at.y);
    pop.style.left = `${String(pos.left)}px`;
    pop.style.top = `${String(pos.top)}px`;
  }

  #closePopover(): void {
    this.#pop?.remove();
    this.#pop = undefined;
    this.#pending?.remove();
    this.#pending = undefined;
    this.#pendingKey = undefined;
    this.#pendingTarget = undefined;
    this.#pendingResolved = undefined;
    this.#editing = undefined;
    if (this.#selBox !== undefined) this.#selBox.hidden = true;
  }
}

/** "file:line" for a resolved anchor, when the app carries source stamps. */
function sourceLabel(resolved: MarkAnchor): string | undefined {
  return resolved.source === undefined
    ? undefined
    : `${resolved.source.file}:${String(resolved.source.line)}`;
}

function currentRoute(): string {
  return 'undefined' === typeof location ? '' : location.pathname + location.search;
}

function markKey(el: Element): string {
  return resolveMarkAnchor(el).anchor;
}

function isElementFixed(el: Element | undefined): boolean {
  if (el === undefined || 'undefined' === typeof getComputedStyle) return false;
  const pos = getComputedStyle(el).position;
  return 'fixed' === pos || 'sticky' === pos;
}

/** The blocker Reticle raises over the page while annotating; see the click handler. */
const BLOCKER_ATTR_NAME = 'data-reticle-blocker';

/**
 * The topmost element of the HOST PAGE at a point, seeing past Reticle's own overlays.
 *
 * `elementsFromPoint` returns the whole stack topmost-first, so the page element is simply the first
 * entry that is not ours. Returns undefined where the API is unavailable (jsdom) or nothing but
 * Reticle UI is there, and the caller drops the click rather than guessing at a target.
 */
function pageElementAt(x: number, y: number): Element | undefined {
  const from = document.elementsFromPoint.bind(document) as
    ((cx: number, cy: number) => Element[]) | undefined;
  if (from === undefined) return undefined;
  for (const el of from(x, y)) {
    if (!isReticleUi(el)) return el;
  }
  return undefined;
}

function clampPop(x: number, y: number): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(x, EDGE + POP_W / 2), vw - EDGE - POP_W / 2);
  let top = y + 12;
  if (top + POP_H > vh - EDGE) top = Math.max(EDGE, y - POP_H - 12);
  return { left, top };
}

function describeEl(el: Element): string {
  const testid = el.getAttribute('data-testid');
  if (testid !== null && testid.length > 0) return testid;
  const tag = el.tagName.toLowerCase();
  const aria = el.getAttribute('aria-label');
  if (aria !== null && aria.length > 0) return `${tag} "${aria}"`;
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  return text.length > 0 ? `${tag} "${text}"` : tag;
}

export function installAnnotator(deps: AnnotatorDeps): Annotator {
  const annotator = new Annotator(deps);
  annotator.mount();
  return annotator;
}
