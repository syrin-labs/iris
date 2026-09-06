import { PresenterReport, reportPanelHtml } from './presenter-report.js';
import {
  CHAT_MIN_ATTR,
  CHAT_PILL_ATTR,
  REPORT_ATTR,
  REPORT_BTN_ATTR,
  ANNOTATE_BTN_ATTR,
  CHAT_ATTR,
  CHAT_TOGGLE_ATTR,
  CHAT_PANEL_ATTR,
  DOCK_ATTR,
  FAB_ATTR,
  MIN_ATTR,
  SETTINGS_ATTR,
  SETTINGS_BTN_ATTR,
} from './presenter-config.js';
import { BRAND_NAME, FAB_TOGGLE_HTML, MARK_SVG } from './presenter-brand.js';
import { settleLogAtLatest } from './presenter-log.js';
import { installHudDragHandles, installHudPositionGuards } from './presenter-drag.js';
import { scheduleSyncDockLayout } from './presenter-dock-layout.js';
import {
  hiIconHtml,
  hiToggleIconHtml,
  PRESENTER_ICON_SIZE,
  PresenterIcon,
} from './presenter-icons.js';
import { HUD_SURFACE_CLASS, HUD_LOG_WELL_CLASS } from './presenter-hud-chrome.js';
import { CONTROLS_TOOLBAR_HTML } from './presenter-controls.js';
import {
  PresenterSettingsPanel,
  settingsPanelHtml,
  type SettingsHost,
} from './presenter-settings.js';
const DRAG_HANDLE_CLASS = 'reticle-toolbar-drag';
const TRANSITION_LOCK_MS = 120;
const ANNOTATE_LABEL = 'Annotate';
const CHAT_MIN_LABEL = 'Minimise chat';
/** The minimised chat capsule's label - it reopens the panel. */
const CHAT_PILL_LABEL = 'Open agent chat';
/** The toolbar entry to the impact report. */
const REPORT_LABEL = 'Impact';
const SETTINGS_LABEL = 'Settings';
const EXIT_LABEL = 'Exit';

interface HudShellCallbacks {
  onChatOpen?: () => void;
  onChatClose?: () => void;
  onExpand?: () => void;
  /** The user pressed the annotate toggle. `on` is the state they asked for. */
  onAnnotateToggle?: (on: boolean) => void;
  onCollapse?: () => void;
  settings?: SettingsHost;
}
/**
 * Morphing HUD shell: circular FAB ↔ icon toolbar, plus the agent chat panel above.
 * Expand enters annotation mode; the page stays clickable except for captured annotate clicks.
 */
export class HudShell {
  #root: HTMLElement | undefined;
  #dock: HTMLElement | undefined;
  #fab: HTMLButtonElement | undefined;
  #chatPanel: HTMLElement | undefined;
  #chatToggle: HTMLElement | undefined;
  #collapseBtn: HTMLButtonElement | undefined;
  #settings: PresenterSettingsPanel;
  #dragTeardown: (() => void) | undefined;
  #layoutTeardown: (() => void) | undefined;
  #transitionLock = false;
  #suppressFabClick = false;
  #annotateBtn: HTMLButtonElement | undefined;
  /**
   * Whether the USER wants to annotate. Distinct from whether annotation is currently possible,
   * which also needs a live session and an expanded HUD — this is the half the user controls, and
   * conflating the two is why there was no way to keep the HUD open without annotating.
   *
   * OFF until asked for. It began as `true` to preserve the old behaviour where expanding the HUD
   * silently entered annotate mode, and that is exactly what made the toolbar icon look permanently
   * lit: the toolbar is only visible while expanded, so an intent that defaults to on is on every
   * time you can see it. Annotate mode also captures clicks, so defaulting it on means a click lands
   * as a mark before anyone asked for one. It is a mode now, and modes are entered deliberately.
   */
  #annotateOn = false;
  #toggleSync: MutationObserver | undefined;
  /**
   * One signal for every listener this shell registers, so teardown cannot drift from mount.
   *
   * The click handlers below are anonymous closures over `this`: there is no reference to hand to
   * `removeEventListener`, so before this they were never removed at all. Mounting twice onto the
   * same root therefore stacked a second set, and every handler kept the shell reachable for as
   * long as its element lived.
   */
  #listeners: AbortController | undefined;
  readonly #report = new PresenterReport({
    onBeforeOpen: () => {
      // One panel at a time in the slot above the toolbar. The chat, the settings and the report
      // all anchor there, so opening one over another stacks two glass cards and reads as a bug.
      this.#settings.close();
      this.closeChat();
    },
  });
  #callbacks: HudShellCallbacks;
  constructor(callbacks: HudShellCallbacks = {}) {
    this.#callbacks = callbacks;
    this.#settings = new PresenterSettingsPanel({
      ...callbacks.settings,
      onBeforeOpen: () => {
        // Settings takes the slot from BOTH neighbours. Closing only the chat left the report
        // sitting behind the settings card - two glass panels stacked in one anchor.
        this.closeChat();
        this.#report.close();
        callbacks.settings?.onBeforeOpen?.();
      },
    });
  }
  /** Markup for the dock wrapper (chat panel + morphing HUD shell). */
  static dockHtml(
    actStripHtml: string,
    bannerHtml: string,
    logAttr: string,
    flowsHtml: string,
    footHtml: string,
  ): string {
    const annotate = hiToggleIconHtml(PresenterIcon.ANNOTATE, PRESENTER_ICON_SIZE.TOOLBAR);
    const chart = hiToggleIconHtml(PresenterIcon.CHART, PRESENTER_ICON_SIZE.TOOLBAR);
    const gear = hiToggleIconHtml(PresenterIcon.GEAR, PRESENTER_ICON_SIZE.TOOLBAR);
    const exit = hiIconHtml(PresenterIcon.REMOVE, PRESENTER_ICON_SIZE.TOOLBAR);
    return `<div ${DOCK_ATTR}>
      <div ${CHAT_PANEL_ATTR} class="reticle-chat-panel ${HUD_SURFACE_CLASS}" role="dialog" aria-label="Reticle agent chat" aria-hidden="true">
        <div class="reticle-chat-head">
          <span class="reticle-chat-brand">${MARK_SVG}<span class="reticle-chat-brandname">${BRAND_NAME}</span></span>
        </div>
        <button type="button" ${CHAT_MIN_ATTR} class="reticle-chat-min" title="${CHAT_MIN_LABEL}" aria-label="${CHAT_MIN_LABEL}">${hiIconHtml(PresenterIcon.CARET_DOWN, PRESENTER_ICON_SIZE.TOOLBAR)}</button>
        ${actStripHtml}
        <span class="reticle-tally" data-reticle-tally hidden></span>
        ${bannerHtml}
        <div class="${HUD_LOG_WELL_CLASS}"><div ${logAttr}></div></div>
        ${flowsHtml}
        ${footHtml}
      </div>
      <button type="button" ${CHAT_PILL_ATTR} class="reticle-chat-pill" title="${CHAT_PILL_LABEL}" aria-label="${CHAT_PILL_LABEL}">
        ${MARK_SVG}
        <span class="reticle-chat-pill-text" data-reticle-chat-pill-text></span>
        <span class="reticle-chat-pill-time" data-reticle-chat-pill-time></span>
        <span class="reticle-chat-pill-caret" aria-hidden="true">${hiIconHtml(PresenterIcon.CARET_DOWN, PRESENTER_ICON_SIZE.TOOLBAR)}</span>
      </button>
      ${settingsPanelHtml()}
      ${reportPanelHtml()}
      <div data-reticle-hud>
        <div class="reticle-hud-deco" aria-hidden="true"></div>
        ${FAB_TOGGLE_HTML}
        <div class="reticle-toolbar ${DRAG_HANDLE_CLASS}" role="toolbar" aria-label="Reticle controls">
          <div class="reticle-toolbar-actions">${CONTROLS_TOOLBAR_HTML}</div>
          <span class="reticle-tb-sep" aria-hidden="true"></span>
          <div class="reticle-toolbar-chrome">
            <div class="reticle-tb-wrap">
              <button type="button" ${ANNOTATE_BTN_ATTR} class="reticle-tb-btn reticle-tb-btn--toggle" title="${ANNOTATE_LABEL}" aria-label="${ANNOTATE_LABEL}" aria-pressed="false" data-active="0">${annotate}</button>
              <span class="reticle-tb-tip">${ANNOTATE_LABEL}</span>
            </div>
            <div class="reticle-tb-wrap">
              <button type="button" ${REPORT_BTN_ATTR} class="reticle-tb-btn reticle-tb-btn--toggle" title="${REPORT_LABEL}" aria-label="${REPORT_LABEL}" aria-pressed="false" data-active="0">${chart}</button>
              <span class="reticle-tb-tip">${REPORT_LABEL}</span>
            </div>
            <div class="reticle-tb-wrap">
              <button type="button" ${SETTINGS_BTN_ATTR} class="reticle-tb-btn reticle-tb-btn--toggle" title="${SETTINGS_LABEL}" aria-label="${SETTINGS_LABEL}" aria-pressed="false" data-active="0">${gear}</button>
              <span class="reticle-tb-tip">${SETTINGS_LABEL}</span>
            </div>
            <div class="reticle-tb-wrap">
              <button type="button" data-reticle-min-btn class="reticle-tb-btn" title="${EXIT_LABEL}" aria-label="${EXIT_LABEL}">${exit}</button>
              <span class="reticle-tb-tip">${EXIT_LABEL}<span class="reticle-tb-kbd">Esc</span></span>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }
  /** The impact report, so the presenter can feed it and the chat can open it. */
  get report(): PresenterReport {
    return this.#report;
  }

  /** Light exactly the toolbar buttons whose panels are open. */
  #syncToolbarToggles(): void {
    const root = this.#root;
    if (root === undefined) return;
    const lit = (btnAttr: string, on: boolean): void => {
      const btn = root.querySelector(`[${btnAttr}]`);
      btn?.setAttribute('data-active', on ? '1' : '0');
      btn?.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    lit(CHAT_TOGGLE_ATTR, '1' === root.getAttribute(CHAT_ATTR));
    lit(SETTINGS_BTN_ATTR, '1' === root.getAttribute(SETTINGS_ATTR));
    lit(REPORT_BTN_ATTR, '1' === root.getAttribute(REPORT_ATTR));
  }

  /** Does the user currently want to annotate? */
  isAnnotateOn(): boolean {
    return this.#annotateOn;
  }
  /** Set the toggle and reflect it on the button, without firing the callback. */
  setAnnotateOn(on: boolean): void {
    this.#annotateOn = on;
    this.#annotateBtn?.setAttribute('aria-pressed', on ? 'true' : 'false');
    this.#annotateBtn?.setAttribute('data-active', on ? '1' : '0');
  }
  mount(root: HTMLElement): void {
    this.#listeners = new AbortController();
    const { signal } = this.#listeners;
    this.#root = root;
    this.#dock = root.querySelector<HTMLElement>(`[${DOCK_ATTR}]`) ?? undefined;
    const fabEl = root.querySelector(`[${FAB_ATTR}]`);
    this.#fab = fabEl instanceof HTMLButtonElement ? fabEl : undefined;
    const chatPanelEl = root.querySelector(`[${CHAT_PANEL_ATTR}]`);
    this.#chatPanel = chatPanelEl instanceof HTMLElement ? chatPanelEl : undefined;
    const chatToggleEl = root.querySelector(`[${CHAT_TOGGLE_ATTR}]`);
    this.#chatToggle = chatToggleEl instanceof HTMLElement ? chatToggleEl : undefined;
    const annotateEl = root.querySelector(`[${ANNOTATE_BTN_ATTR}]`);
    this.#annotateBtn = annotateEl instanceof HTMLButtonElement ? annotateEl : undefined;
    this.#annotateBtn?.addEventListener(
      'click',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setAnnotateOn(!this.#annotateOn);
        this.#callbacks.onAnnotateToggle?.(this.#annotateOn);
      },
      { signal },
    );
    const pillEl = root.querySelector(`[${CHAT_PILL_ATTR}]`);
    pillEl?.addEventListener(
      'click',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showChat();
      },
      { signal },
    );
    const chatMinEl = root.querySelector(`[${CHAT_MIN_ATTR}]`);
    chatMinEl?.addEventListener(
      'click',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.closeChat();
      },
      { signal },
    );
    const collapseEl = root.querySelector('[data-reticle-min-btn]');
    this.#collapseBtn = collapseEl instanceof HTMLButtonElement ? collapseEl : undefined;
    root.setAttribute(MIN_ATTR, '1');
    root.setAttribute(SETTINGS_ATTR, '0');
    root.removeAttribute(CHAT_ATTR);
    this.#settings.mount(root);
    this.#report.mount(root);
    // The toolbar's lit state FOLLOWS the panels, rather than being set by whoever was clicked.
    // Set at click time, a button stayed lit after its panel was closed by the panel that replaced
    // it - two icons active, one panel open. The observer is the only place that can be right for
    // every path: the toolbar, Escape, click-outside, and one panel closing another.
    this.#toggleSync = new MutationObserver(() => this.#syncToolbarToggles());
    this.#toggleSync.observe(root, {
      attributes: true,
      attributeFilter: [CHAT_ATTR, SETTINGS_ATTR, REPORT_ATTR],
    });
    this.#syncToolbarToggles();
    root.querySelector(`[${REPORT_BTN_ATTR}]`)?.addEventListener(
      'click',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.#report.toggle();
      },
      { signal },
    );
    this.#fab?.addEventListener(
      'click',
      (e) => {
        e.stopPropagation();
        if (this.#suppressFabClick) {
          this.#suppressFabClick = false;
          return;
        }
        this.expand();
      },
      { signal },
    );
    this.#collapseBtn?.addEventListener(
      'click',
      (e) => {
        e.stopPropagation();
        this.collapse();
      },
      { signal },
    );
    this.#chatToggle?.addEventListener(
      'click',
      (e) => {
        e.stopPropagation();
        this.toggleChat();
      },
      { signal },
    );
    const toolbarDrag = root.querySelector(`.${DRAG_HANDLE_CLASS}`);
    const dragHandles = [this.#fab, toolbarDrag].filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    );
    if (this.#dock !== undefined && dragHandles.length > 0) {
      this.#dragTeardown = installHudDragHandles(this.#dock, dragHandles, {
        onDragMove: () => {
          this.#suppressFabClick = true;
        },
        onDragEnd: (moved) => {
          if (moved && this.isCollapsed()) this.#suppressFabClick = true;
        },
      });
      this.#layoutTeardown = installHudPositionGuards(this.#dock, root);
    }
    document.addEventListener('pointerdown', this.#onDocPointerDown, { signal });
    document.addEventListener('keydown', this.#onKeyDown, { signal });
  }
  teardown(): void {
    // One call for all nine registrations. It cannot fall out of step with mount() the way a list
    // of removeEventListener calls can, which is the whole point.
    this.#listeners?.abort();
    this.#listeners = undefined;
    // NOT covered by the signal: a MutationObserver takes no `signal` option. This disconnect was
    // missing entirely, so the observer kept `root` — and through it the shell — alive after
    // teardown, and a re-mount left the previous one still firing.
    this.#toggleSync?.disconnect();
    this.#toggleSync = undefined;
    this.#dragTeardown?.();
    this.#dragTeardown = undefined;
    this.#layoutTeardown?.();
    this.#layoutTeardown = undefined;
    this.#settings.teardown();
    this.#root = undefined;
    this.#dock = undefined;
    this.#fab = undefined;
    this.#chatPanel = undefined;
    this.#chatToggle = undefined;
    this.#collapseBtn = undefined;
  }
  isCollapsed(): boolean {
    return '1' === this.#root?.getAttribute(MIN_ATTR);
  }
  isChatOpen(): boolean {
    return '1' === this.#root?.getAttribute(CHAT_ATTR);
  }
  expand(): void {
    if (this.#root === undefined || !this.isCollapsed()) return;
    if (this.#transitionLock) return;
    this.#lockTransition();
    this.#root.setAttribute(MIN_ATTR, '0');
    if (this.#fab !== undefined) this.#fab.setAttribute('aria-expanded', 'true');
    this.#callbacks.onExpand?.();
    // The chat IS the HUD's content: expanding to a toolbar with nothing above it made the agent's
    // log something you had to know to go looking for. Unconditional on purpose — the way to a bare
    // toolbar is the chat's own minimise button, not a preference. `Auto-open chat` is a different
    // question (should it appear with no click at all, at session start) and stays separate, because
    // wiring expand to it made session start expand the HUD and the FAB never appeared.
    // `openChat` re-enters `expand` only when collapsed, and MIN_ATTR is already cleared above.
    this.openChat();
    if (this.#dock !== undefined) scheduleSyncDockLayout(this.#dock, this.#root);
  }
  collapse(): void {
    if (this.#root === undefined) return;
    this.#transitionLock = false;
    this.closeChat();
    this.#settings.close();
    this.#root.setAttribute(MIN_ATTR, '1');
    if (this.#fab !== undefined) this.#fab.setAttribute('aria-expanded', 'false');
    this.#callbacks.onCollapse?.();
  }
  openChat(): void {
    if (this.#root === undefined) return;
    if (this.isCollapsed()) this.expand();
    this.#settings.close();
    if (this.isChatOpen()) return;
    this.#root.setAttribute(CHAT_ATTR, '1');
    // The panel had no layout while it was closed, so its feed could not follow the newest row.
    // Now that it does, put it there before it is looked at.
    const log = this.#root.querySelector<HTMLElement>('[data-reticle-log]');
    if (log !== null) settleLogAtLatest(log);
    this.#chatPanel?.setAttribute('aria-hidden', 'false');
    this.#chatToggle?.setAttribute('data-active', '1');
    this.#chatToggle?.setAttribute('aria-pressed', 'true');
    this.#callbacks.onChatOpen?.();
    if (this.#dock !== undefined) scheduleSyncDockLayout(this.#dock, this.#root);
    const input = this.#root.querySelector<HTMLTextAreaElement>('[data-reticle-input]');
    if (input !== null && !input.disabled) {
      requestAnimationFrame(() => input.focus());
    }
  }
  closeChat(): void {
    if (this.#root === undefined || !this.isChatOpen()) return;
    this.#root.removeAttribute(CHAT_ATTR);
    this.#chatPanel?.setAttribute('aria-hidden', 'true');
    this.#chatToggle?.setAttribute('data-active', '0');
    this.#chatToggle?.setAttribute('aria-pressed', 'false');
    this.#callbacks.onChatClose?.();
    if (this.#dock !== undefined) scheduleSyncDockLayout(this.#dock, this.#root);
  }
  toggleChat(): void {
    if (this.isChatOpen()) this.closeChat();
    else this.showChat();
  }

  /**
   * The chat, asked for by a PERSON - so it takes the slot from the report.
   *
   * `openChat` is also called by `expand`, which the agent triggers at session start; routing that
   * through here closed the impact report every time the agent touched the app, which is precisely
   * when you are reading it.
   */
  showChat(): void {
    this.#report.close();
    this.openChat();
  }
  /** Pulse the FAB when new activity arrives while collapsed. */
  pulseFab(active: boolean): void {
    this.#fab?.setAttribute('data-pulse', active ? '1' : '0');
  }
  #lockTransition() {
    this.#transitionLock = true;
    window.setTimeout(() => {
      this.#transitionLock = false;
    }, TRANSITION_LOCK_MS);
  }
  /**
   * A click on the page dismisses the SETTINGS popover - and nothing else.
   *
   * The chat used to close here too, which was wrong from three directions: Reticle's own clicks
   * land on the page (synthetic in-page, or a genuine OS event when it drives through CDP), a click
   * in annotate mode is placing a mark, and a person clicking around their app while watching the
   * log is not asking for the log to go away. The chat has three deliberate ways out - its minimise
   * button, the toolbar toggle, and Escape - and that is all it needs.
   */
  #onDocPointerDown = (e: PointerEvent): void => {
    if (this.#root === undefined || this.#dock === undefined) return;
    if (!this.#settings.isOpen()) return;
    const target = e.target;
    if (!(target instanceof Node)) return;
    if (this.#dock.contains(target)) return;
    if (this.#settings.contains(target)) return;
    this.#settings.close();
  };
  #onKeyDown = (e: KeyboardEvent): void => {
    if ('Escape' !== e.key || this.#root === undefined) return;
    const target = e.target;
    if (
      target instanceof HTMLElement &&
      ('INPUT' === target.tagName ||
        'TEXTAREA' === target.tagName ||
        true === target.isContentEditable)
    ) {
      return;
    }
    if (this.isChatOpen()) {
      e.preventDefault();
      this.closeChat();
      return;
    }
    if (this.#settings.isOpen()) {
      e.preventDefault();
      this.#settings.close();
      return;
    }
    if (!this.isCollapsed()) {
      e.preventDefault();
      this.collapse();
    }
  };
}
