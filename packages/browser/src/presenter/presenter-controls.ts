import { HumanControlKind, PresenterTone, SessionState, type FlowChip } from '@reticlehq/core';
import { nativeSetTimeout, nativeClearTimeout } from '../timers/native-timers.js';
import { CHAT_TOGGLE_ATTR, CLEAR_MARKS_ATTR, MARKERS_BTN_ATTR } from './presenter-config.js';
import {
  PresenterIcon,
  PRESENTER_ICON_SIZE,
  hiIcon,
  hiIconHtml,
  hiToggleIconHtml,
} from './presenter-icons.js';
import { getPresenterSettings } from './presenter-settings.js';
import { mountWorkspaceSelector, workspaceRowHtml } from './presenter-workspace.js';
import type { HeroIconBodyKey } from './presenter-heroicons-data.js';
// Live-control panel: the two-way control surface inside the floating HUD - Pause/Resume + End
// (header), a message input + Send (footer), and the data-reticle-state visual machine. Split out of
// presenter.ts to keep both files under the 500-line cap (mirrors the presenter-log.ts split).
// All nodes carry data-reticle-* attrs so they're excluded from snapshots (see dom-ignore.ts). The
// strings here are presenter-only UI; the control kinds + state values reuse protocol constants.
/** data-reticle-state attribute on the overlay root; its value is always a SessionState. */
const DATA_RETICLE_STATE = 'data-reticle-state';
/** data-reticle-tone on the overlay root - waiting/ask/warn distinguishes how the agent handed back. */
const DATA_RETICLE_TONE = 'data-reticle-tone';
const DATA_ON = 'data-on';
const GLOW_OFF = '0';
/** Button copy (presenter-only UI; never a wire string). */
const CONTROL_LABEL = {
  PAUSE: 'Pause',
  RESUME: 'Resume',
  END: 'End',
  SEND: 'Send',
};
const INPUT_PLACEHOLDER = 'Tell the agent something…';
/** Accessible name for the composer (a placeholder is not an accessible name). */
const INPUT_ARIA_LABEL = 'Message to the agent';
const PAUSED_BADGE_TEXT = 'PAUSED';
const ENDED_BANNER_TEXT = 'Session ended';
const COPY_LABEL = 'Copy run';
const EXPORT_LABEL = 'Export';
const FLOWS_LABEL = 'Replay a flow';
const COPIED_TEXT = 'Copied ✓';
/** Download filename for the exported run state. */
const RUN_FILENAME = 'reticle-run.json';
/** Border fade-out delay after a session ends (native timer; presenter-only tunable). */
export const ENDED_FADE_MS = 4000;
/** Max composer height (px) before it scrolls. One source for both the CSS cap and the JS auto-grow
 * clamp - they measure the same border-box, so the scrollbar appears exactly when growth stops. */
const MSG_MAX_H = 96;

/** Payload the panel hands to its host when the human drives a control. */
export interface ControlIntent {
  kind: HumanControlKind;
  text?: string;
}
export type ControlHandler = (intent: ControlIntent) => void;

/** CSS for the control surface (injected with the rest of the presenter stylesheet). */
export const CONTROLS_CSS = `
[data-reticle-chat-panel] [data-reticle-foot]{flex:none;padding:8px 10px 10px;border-top:1px solid rgba(255,255,255,.07);
  background:linear-gradient(180deg,rgba(0,0,0,.35) 0%,rgba(0,0,0,.55) 100%);pointer-events:auto;}
[data-reticle-chat-panel] .reticle-hud-log-well{margin:0 0 4px;}
[data-reticle-chat-panel] .reticle-composer-stack{display:flex;flex-direction:column;gap:6px;}
[data-reticle-chat-panel] .reticle-workspace-wrap{position:relative;align-self:flex-start;max-width:100%;}
[data-reticle-chat-panel] .reticle-workspace{
  display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:3px 8px 3px 6px;border-radius:999px;cursor:pointer;
  border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:rgba(255,255,255,.78);
  font:inherit;font-size:11px;font-weight:500;line-height:1.2;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.05);transition:background .15s,border-color .15s,color .15s;}
[data-reticle-chat-panel] .reticle-workspace:hover{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.14);color:#fff;}
[data-reticle-chat-panel] .reticle-workspace[aria-expanded="true"]{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.16);color:#fff;}
[data-reticle-chat-panel] .reticle-workspace-icon,
[data-reticle-chat-panel] .reticle-workspace-caret{display:inline-flex;align-items:center;opacity:.72;flex:none;}
[data-reticle-chat-panel] .reticle-workspace-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:min(200px,calc(100vw - 120px));}
[data-reticle-chat-panel] .reticle-workspace[aria-expanded="true"] .reticle-workspace-caret{transform:rotate(180deg);}
[data-reticle-chat-panel] .reticle-workspace-caret{transition:transform .18s ease;}
[data-reticle-chat-panel] .reticle-workspace-menu{
  position:absolute;left:0;bottom:calc(100% + 6px);z-index:8;min-width:min(268px,calc(100vw - 48px));max-width:min(300px,calc(100vw - 48px));
  padding:10px 12px;border-radius:12px;background:#000;color:rgba(255,255,255,.86);font-size:11px;line-height:1.35;
  box-shadow:0 12px 32px rgba(0,0,0,.58),inset 0 1px 0 rgba(255,255,255,.07),0 0 0 1px rgba(255,255,255,.1);
  transform:translateY(4px) scale(.98);opacity:0;pointer-events:none;visibility:hidden;
  transition:opacity .16s ease,transform .2s cubic-bezier(.19,1,.22,1),visibility .16s;}
[data-reticle-chat-panel] .reticle-workspace[aria-expanded="true"] + .reticle-workspace-menu,
[data-reticle-chat-panel] .reticle-workspace-menu[aria-hidden="false"]{
  transform:translateY(0) scale(1);opacity:1;pointer-events:auto;visibility:visible;}
[data-reticle-chat-panel] .reticle-workspace-menu-head{
  display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;}
[data-reticle-chat-panel] .reticle-workspace-menu-title{
  color:rgba(255,255,255,.42);font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;}
[data-reticle-chat-panel] .reticle-workspace-copy{
  display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:none;border-radius:6px;
  background:rgba(255,255,255,.06);color:rgba(255,255,255,.7);cursor:pointer;line-height:0;transition:background .12s,color .12s;}
[data-reticle-chat-panel] .reticle-workspace-copy:hover:not(:disabled){background:rgba(255,255,255,.12);color:#fff;}
[data-reticle-chat-panel] .reticle-workspace-copy:disabled{opacity:.35;cursor:not-allowed;}
[data-reticle-chat-panel] .reticle-workspace-menu-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:4px 0;}
[data-reticle-chat-panel] .reticle-workspace-menu-k{flex:none;color:rgba(255,255,255,.42);}
[data-reticle-chat-panel] .reticle-workspace-menu-v{min-width:0;text-align:right;color:rgba(255,255,255,.9);font-weight:500;word-break:break-all;}
[data-reticle-chat-panel] .reticle-composer{display:flex;align-items:center;gap:6px;background:rgba(255,255,255,.03);
  border:1px solid rgba(255,255,255,.1);border-radius:999px;padding:4px 4px 4px 14px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.05);transition:border-color .2s,box-shadow .2s,background .2s;}
[data-reticle-chat-panel] .reticle-composer:focus-within{
  border-color:color-mix(in srgb,var(--reticle-accent) 50%,transparent);background:rgba(255,255,255,.06);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.06),
    0 0 0 1px color-mix(in srgb,var(--reticle-accent) 50%,transparent);}
[data-reticle-chat-panel] .reticle-msg{flex:1;min-width:0;pointer-events:auto;background:transparent;border:none;outline:none;resize:none;
  box-sizing:border-box;color:var(--reticle-fg);font-family:var(--reticle-font);font-size:12.5px;line-height:18px;
  height:28px;min-height:28px;max-height:${MSG_MAX_H}px;padding:5px 0;overflow-y:auto;
  scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.14) transparent;}
[data-reticle-chat-panel] .reticle-msg::-webkit-scrollbar{width:9px;}
[data-reticle-chat-panel] .reticle-msg::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:9px;border:2px solid transparent;background-clip:content-box;}
[data-reticle-chat-panel] .reticle-msg::placeholder{color:var(--reticle-faint);}
[data-reticle-chat-panel] .reticle-msg:disabled{opacity:.5;}
[data-reticle-chat-panel] .reticle-send{flex:none;width:28px;height:28px;padding:0;border-radius:50%;border:none;cursor:pointer;pointer-events:auto;
  background:var(--reticle-accent);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;
  transition:background .15s,transform .1s,box-shadow .15s;
  box-shadow:0 1px 3px color-mix(in srgb,var(--reticle-accent) 30%,transparent);}
[data-reticle-chat-panel] .reticle-send:hover{
  background:color-mix(in srgb,var(--reticle-accent) 85%,#000);
  box-shadow:0 2px 6px color-mix(in srgb,var(--reticle-accent) 40%,transparent);}
[data-reticle-chat-panel] .reticle-send:active{transform:scale(.92);}
[data-reticle-chat-panel] .reticle-send:disabled{background:#374151;color:#9ca3af;box-shadow:none;opacity:.5;cursor:default;}
[data-reticle-chat-panel] .reticle-banner{display:none;flex:none;align-items:center;gap:8px;padding:10px 14px;color:var(--reticle-fg);
  font-size:12px;font-weight:500;border-bottom:1px solid var(--reticle-line2);background:var(--reticle-surface);}
[data-reticle-overlay][data-reticle-state="ended"] [data-reticle-chat-panel] .reticle-banner{display:block;}
[data-reticle-overlay][data-reticle-state="paused"] [data-reticle-glow][data-on="1"]{
  box-shadow:inset 0 0 0 2px rgba(255,255,255,.2);}
[data-reticle-overlay][data-reticle-state="ended"] [data-reticle-glow][data-on="1"]{
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.12);}
[data-reticle-overlay][data-reticle-tone="waiting"] [data-reticle-chat-panel]{
  --reticle-accent:var(--reticle-state);
  --reticle-accent-soft:color-mix(in srgb,var(--reticle-state) 18%,transparent);}
[data-reticle-overlay][data-reticle-tone="waiting"] [data-reticle-banner]{font-weight:500;color:var(--reticle-fg);}
[data-reticle-overlay][data-reticle-tone="waiting"] [data-reticle-glow][data-on="1"]{
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.16);}
[data-reticle-overlay][data-reticle-tone="ask"] [data-reticle-chat-panel],
[data-reticle-overlay][data-reticle-tone="warn"] [data-reticle-chat-panel]{
  --reticle-accent:var(--reticle-state);
  --reticle-accent-soft:color-mix(in srgb,var(--reticle-state) 18%,transparent);}
[data-reticle-overlay][data-reticle-tone="ask"] [data-reticle-banner],
[data-reticle-overlay][data-reticle-tone="warn"] [data-reticle-banner]{font-weight:500;color:var(--reticle-fg);}
[data-reticle-overlay][data-reticle-tone="ask"] [data-reticle-glow][data-on="1"],
[data-reticle-overlay][data-reticle-tone="warn"] [data-reticle-glow][data-on="1"]{
  box-shadow:inset 0 0 0 2px rgba(255,255,255,.22);}
[data-reticle-chat-panel] .reticle-flows{display:none;flex:none;flex-wrap:wrap;align-content:flex-start;gap:6px;
  padding:9px 12px;border-top:1px solid var(--reticle-line2);max-height:88px;overflow-y:auto;overscroll-behavior:contain;
  pointer-events:auto;touch-action:pan-y;}
[data-reticle-chat-panel] .reticle-flows[data-has="1"]{display:flex;}
[data-reticle-chat-panel] .reticle-flows::-webkit-scrollbar{width:9px;}
[data-reticle-chat-panel] .reticle-flows::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:9px;border:2px solid transparent;background-clip:content-box;}
[data-reticle-chat-panel] .reticle-flows-cap{flex:0 0 100%;margin-bottom:1px;color:var(--reticle-faint);font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;}
[data-reticle-chat-panel] .reticle-flow{pointer-events:auto;cursor:pointer;display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 10px;
  border-radius:7px;border:1px solid var(--reticle-line);background:rgba(255,255,255,.04);color:var(--reticle-muted);
  font-family:var(--reticle-font);font-size:11px;font-weight:500;transition:background .15s,color .15s,border-color .15s,transform .1s;}
[data-reticle-chat-panel] .reticle-flow:hover{color:var(--reticle-fg);background:var(--reticle-accent-soft);border-color:var(--reticle-accent);}
[data-reticle-chat-panel] .reticle-flow:active{transform:scale(.95);}
[data-reticle-overlay][data-reticle-state="paused"] [data-reticle-hud] .reticle-tb-btn--primary{
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.16),0 0 12px rgba(255,255,255,.04);}
[data-reticle-hud] .reticle-export-msg{position:absolute;width:1px;height:1px;margin:-1px;padding:0;
  overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0;}
` as string;
/** Swap pause/resume icon + accessible label without visible text clutter in the toolbar. */
function paintPauseBtn(btn: HTMLButtonElement, paused: boolean): void {
  const iconName: HeroIconBodyKey = paused ? PresenterIcon.PLAY : PresenterIcon.PAUSE;
  const labelText = paused ? CONTROL_LABEL.RESUME : CONTROL_LABEL.PAUSE;
  btn.setAttribute('aria-label', labelText);
  btn.setAttribute('title', labelText);
  btn.replaceChildren(hiIcon(iconName, PRESENTER_ICON_SIZE.TOOLBAR));
  btn.classList.toggle('reticle-tb-btn--primary', paused);
  btn.setAttribute('data-active', paused ? '1' : '0');
}
const CHAT_LABEL = 'Agent chat';
const MARKERS_LABEL = 'Hide markers';
const CLEAR_MARKS_LABEL = 'Clear all';
const TB = PRESENTER_ICON_SIZE.TOOLBAR;
function tbWrap(btn: string, tip: string, kbd?: string): string {
  const shortcut = kbd === undefined ? '' : `<span class="reticle-tb-kbd">${kbd}</span>`;
  return `<div class="reticle-tb-wrap">${btn}<span class="reticle-tb-tip">${tip}${shortcut}</span></div>`;
}
function pauseToolbarHtml(): string {
  const btn = `<button type="button" data-reticle-pause class="reticle-tb-btn" title="${CONTROL_LABEL.PAUSE}" aria-label="${CONTROL_LABEL.PAUSE}">${hiIconHtml(PresenterIcon.PAUSE, TB)}</button>`;
  const badge = `<span data-reticle-badge class="reticle-pause-badge">${PAUSED_BADGE_TEXT}</span>`;
  const tip = `<span class="reticle-tb-tip">${CONTROL_LABEL.PAUSE}</span>`;
  return `<div class="reticle-tb-wrap reticle-tb-wrap--pause">${btn}${badge}${tip}</div>`;
}
/** Icon toolbar: pause, chat, markers, end, clear - copy/export appear after a run ends. */
export const CONTROLS_TOOLBAR_HTML = [
  pauseToolbarHtml(),
  tbWrap(
    `<button type="button" ${CHAT_TOGGLE_ATTR} class="reticle-tb-btn reticle-tb-btn--toggle" title="${CHAT_LABEL}" aria-label="${CHAT_LABEL}" aria-pressed="false" data-active="0">${hiToggleIconHtml(PresenterIcon.MESSAGE, TB)}</button>`,
    CHAT_LABEL,
  ),
  tbWrap(
    `<button type="button" ${MARKERS_BTN_ATTR} class="reticle-tb-btn reticle-tb-btn--toggle" title="${MARKERS_LABEL}" aria-label="${MARKERS_LABEL}" aria-pressed="false" data-active="0" disabled>${hiToggleIconHtml(PresenterIcon.VIEW, TB)}</button>`,
    MARKERS_LABEL,
    'H',
  ),
  tbWrap(
    `<button type="button" data-reticle-end class="reticle-tb-btn" title="${CONTROL_LABEL.END}" aria-label="${CONTROL_LABEL.END}">${hiIconHtml(PresenterIcon.STOP, TB)}</button>`,
    CONTROL_LABEL.END,
  ),
  tbWrap(
    `<button type="button" ${CLEAR_MARKS_ATTR} class="reticle-tb-btn" title="${CLEAR_MARKS_LABEL}" aria-label="${CLEAR_MARKS_LABEL}" data-danger disabled>${hiIconHtml(PresenterIcon.TRASH, TB)}</button>`,
    CLEAR_MARKS_LABEL,
    'X',
  ),
  `<button type="button" data-reticle-copy class="reticle-tb-btn reticle-tb-btn--export" title="${COPY_LABEL}" aria-label="${COPY_LABEL}" hidden>${hiIconHtml(PresenterIcon.COPY, TB)}</button>`,
  `<button type="button" data-reticle-export class="reticle-tb-btn reticle-tb-btn--export" title="${EXPORT_LABEL}" aria-label="${EXPORT_LABEL}" hidden>${hiIconHtml(PresenterIcon.DOWNLOAD, TB)}</button>`,
  '<span data-reticle-export-msg class="reticle-export-msg" aria-live="polite"></span>',
].join('');
/** Banner markup (between head and log, hidden unless ended). */
export const CONTROLS_BANNER_HTML = `<div data-reticle-banner class="reticle-banner">${ENDED_BANNER_TEXT}</div>`;
/** Replay-a-flow row (between log and footer); buttons are filled in by setFlows once flows arrive. */
export const CONTROLS_FLOWS_HTML = `<div data-reticle-flows class="reticle-flows"><span class="reticle-flows-cap">${FLOWS_LABEL}</span></div>`;
/** Footer markup: composer only (export icons live in the toolbar). */
export const CONTROLS_FOOT_HTML = `<div data-reticle-foot><div class="reticle-composer-stack">${workspaceRowHtml()}<div class="reticle-composer"><textarea data-reticle-input class="reticle-msg" rows="1" aria-label="${INPUT_ARIA_LABEL}" placeholder="${INPUT_PLACEHOLDER}"></textarea><button type="button" data-reticle-send class="reticle-send" aria-label="${CONTROL_LABEL.SEND}">${hiIconHtml(PresenterIcon.SEND, PRESENTER_ICON_SIZE.SEND)}</button></div></div></div>`;

interface ControlRefs {
  pauseBtn: HTMLButtonElement | undefined;
  endBtn: HTMLButtonElement | undefined;
  input: HTMLTextAreaElement | undefined;
  sendBtn: HTMLButtonElement | undefined;
  banner: HTMLElement | undefined;
  copyBtn: HTMLButtonElement | undefined;
  exportBtn: HTMLButtonElement | undefined;
  exportMsg: HTMLElement | undefined;
  flows: HTMLElement | undefined;
}

function queryControlRefs(root: HTMLElement): ControlRefs {
  return {
    pauseBtn: root.querySelector<HTMLButtonElement>('[data-reticle-pause]') ?? undefined,
    endBtn: root.querySelector<HTMLButtonElement>('[data-reticle-end]') ?? undefined,
    input: root.querySelector<HTMLTextAreaElement>('[data-reticle-input]') ?? undefined,
    sendBtn: root.querySelector<HTMLButtonElement>('[data-reticle-send]') ?? undefined,
    banner: root.querySelector<HTMLElement>('[data-reticle-banner]') ?? undefined,
    copyBtn: root.querySelector<HTMLButtonElement>('[data-reticle-copy]') ?? undefined,
    exportBtn: root.querySelector<HTMLButtonElement>('[data-reticle-export]') ?? undefined,
    exportMsg: root.querySelector<HTMLElement>('[data-reticle-export-msg]') ?? undefined,
    flows: root.querySelector<HTMLElement>('[data-reticle-flows]') ?? undefined,
  };
}

interface ControlPanelHost {
  emit: (kind: HumanControlKind, text?: string) => void;
  logHuman: (text: string) => void;
  endedFadeMs: number;
  runState: () => unknown;
  clearRunLog?: () => void;
  onStateChange?: (state: SessionState) => void;
}

/**
 * The live-control panel: owns the control element refs, the SessionState, the ended-fade timer,
 * the DOM wiring, and the data-reticle-state visual machine. Split out of Presenter to keep both files
 * under the 500-line cap. A click handler both emits a control AND optimistically applies state; the
 * server's PRESENTER echo re-syncs via setState only (never emits) so a control is delivered once.
 */
export class ControlPanel {
  #refs: ControlRefs = {
    pauseBtn: undefined,
    endBtn: undefined,
    input: undefined,
    sendBtn: undefined,
    banner: undefined,
    copyBtn: undefined,
    exportBtn: undefined,
    exportMsg: undefined,
    flows: undefined,
  };
  #state: SessionState = SessionState.ACTIVE;
  #fadeTimer: ReturnType<typeof nativeSetTimeout> | undefined;
  #root: HTMLElement | undefined;
  #glow: HTMLElement | undefined;
  /** The full replayable-flow list from the last push; re-filtered per page on route change. */
  #flowItems: FlowChip[] = [];
  #workspaceTeardown: (() => void) | undefined;
  /**
   * One signal for every listener this controller registers.
   *
   * All eight are anonymous closures over `this`, so there was no reference to hand
   * `removeEventListener` and teardown removed none of them — each kept the controller reachable
   * for as long as its element lived, and a second mount stacked another set on top.
   */
  #listeners: AbortController | undefined;
  readonly #host: ControlPanelHost;

  constructor(host: ControlPanelHost) {
    this.#host = host;
  }
  get state(): SessionState {
    return this.#state;
  }
  /** Query control refs out of the mounted root and bind the DOM listeners, then paint active. */
  mount(root: HTMLElement, glow: HTMLElement | undefined): void {
    this.#listeners = new AbortController();
    const { signal } = this.#listeners;
    this.#root = root;
    this.#glow = glow;
    this.#refs = queryControlRefs(root);
    const pauseBtn = this.#refs.pauseBtn;
    if (pauseBtn !== undefined) {
      paintPauseBtn(pauseBtn, this.#state === SessionState.PAUSED);
    }
    this.#refs.pauseBtn?.addEventListener('click', () => this.#onPauseToggle(), { signal });
    this.#refs.endBtn?.addEventListener('click', () => this.#onEnd(), { signal });
    this.#refs.sendBtn?.addEventListener('click', () => this.#onSend(), { signal });
    this.#refs.input?.addEventListener(
      'keydown',
      (e) => {
        // Enter sends; Shift+Enter inserts a newline (falls through to the textarea's default).
        if (e instanceof KeyboardEvent && 'Enter' === e.key && !e.shiftKey) {
          e.preventDefault();
          this.#onSend();
        }
      },
      { signal },
    );
    this.#refs.input?.addEventListener('input', () => this.#autosize(), { signal });
    // Replay-a-flow: one ▶ click re-runs a saved flow (no agent). Delegated so it covers all chips.
    this.#refs.flows?.addEventListener(
      'click',
      (e) => {
        const target = e.target;
        if (!(target instanceof HTMLElement)) return;
        const name = target.closest('[data-reticle-replay]')?.getAttribute('data-reticle-replay');
        if (name !== null && name !== undefined && name.length > 0) {
          this.#host.emit(HumanControlKind.REPLAY, name);
        }
      },
      { signal },
    );
    this.#refs.copyBtn?.addEventListener('click', () => this.#onCopy(), { signal });
    this.#refs.exportBtn?.addEventListener('click', () => this.#onExport(), { signal });
    this.#workspaceTeardown = mountWorkspaceSelector(root);
    this.setState(SessionState.ACTIVE);
  }
  /** Serialize the run state to pretty JSON for Copy/Export. */
  #runJson(): string {
    return JSON.stringify(this.#host.runState(), null, 2);
  }
  /** Copy the run state to the clipboard (with a brief "Copied ✓" flash). */
  #onCopy(): void {
    void navigator.clipboard?.writeText(this.#runJson());
    if (getPresenterSettings().clearOnCopy) {
      this.#host.clearRunLog?.();
    }
    const msg = this.#refs.exportMsg;
    if (msg !== undefined) {
      msg.textContent = COPIED_TEXT;
      msg.setAttribute('data-show', '1');
      nativeSetTimeout(() => msg.setAttribute('data-show', '0'), 1600);
    }
  }
  /** Download the run state as reticle-run.json. */
  #onExport(): void {
    const blob = new Blob([this.#runJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = RUN_FILENAME;
    a.click();
    URL.revokeObjectURL(url);
    if (getPresenterSettings().clearOnCopy) {
      this.#host.clearRunLog?.();
    }
  }
  /** Clear any pending ended-fade timer (called from Presenter.destroy). */
  teardown(): void {
    // All eight registrations, in one call that cannot drift from mount().
    this.#listeners?.abort();
    this.#listeners = undefined;
    this.#workspaceTeardown?.();
    this.#workspaceTeardown = undefined;
    if (this.#fadeTimer !== undefined) nativeClearTimeout(this.#fadeTimer);
    this.#fadeTimer = undefined;
  }
  #onPauseToggle(): void {
    if (this.#state === SessionState.PAUSED) {
      this.#host.emit(HumanControlKind.RESUME);
      this.setState(SessionState.ACTIVE);
    } else if (this.#state === SessionState.ACTIVE) {
      this.#host.emit(HumanControlKind.PAUSE);
      this.setState(SessionState.PAUSED);
    }
  }
  #onEnd(): void {
    if (this.#state === SessionState.ENDED) return;
    this.#host.emit(HumanControlKind.END);
    this.setState(SessionState.ENDED);
  }
  #onSend(): void {
    if (this.#state === SessionState.ENDED) return;
    const text = (this.#refs.input?.value ?? '').trim();
    if (0 === text.length) return;
    this.#host.emit(HumanControlKind.MESSAGE, text);
    this.#host.logHuman(text);
    if (getPresenterSettings().clearOnCopy) {
      this.#host.clearRunLog?.();
    }
    if (this.#refs.input !== undefined) this.#refs.input.value = '';
    this.#autosize();
  }
  /** Grow the composer to fit its content (up to the CSS max-height), then shrink back - soothing,
   * no scrollbar until it's genuinely long. Driven on input and after a send clears the field. */
  #autosize(): void {
    const el = this.#refs.input;
    if (el === undefined) return;
    el.style.height = 'auto';
    el.style.height = `${String(Math.min(el.scrollHeight, MSG_MAX_H))}px`;
  }
  /** Render the replayable-flow chips from the server push. Each ▶ click re-runs that flow, no agent.
   * Takes the raw wire value and narrows it here (the panel is the consumer of this push). */
  setFlows(flows: unknown): void {
    const list: unknown[] = Array.isArray(flows) ? flows : [];
    this.#flowItems = list
      .map((f): FlowChip | null => {
        if ('string' === typeof f) return f.length > 0 ? { name: f } : null;
        if ('object' === typeof f && f !== null) {
          const rec = f as Record<string, unknown>;
          const name = rec['name'];
          if (typeof name !== 'string' || 0 === name.length) return null;
          const start = rec['start'];
          return 'string' === typeof start && start.length > 0 ? { name, start } : { name };
        }
        return null;
      })
      .filter((c): c is FlowChip => c !== null);
    this.#renderFlows();
  }
  /**
   * Re-render the replay chips for the CURRENT page. A flow "starts here" iff its first step's anchor
   * (a testid `start` hint) is present in the live DOM; flows with no start hint (signal/role-first,
   * un-checkable) always show. Called on connect and on every route change so the list tracks the page -
   * so you never see (or click) a flow that can't replay from where you are. Existing flows benefit
   * without re-recording, since the hint is derived from the first step, not stored on the flow.
   */
  refilterFlows(): void {
    this.#renderFlows();
  }
  #renderFlows(): void {
    const el = this.#refs.flows;
    if (el === undefined) return;
    const doc = el.ownerDocument;
    const testids = new Set(
      Array.from(doc.querySelectorAll('[data-testid]')).map((n) => n.getAttribute('data-testid')),
    );
    const visible = this.#flowItems.filter((f) => f.start === undefined || testids.has(f.start));
    el.querySelectorAll('[data-reticle-replay]').forEach((b) => b.remove()); // rebuild, keep the caption
    for (const flow of visible) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'reticle-flow';
      btn.setAttribute('data-reticle-replay', flow.name); // setAttribute → no markup injection from a name
      btn.textContent = `▶ ${flow.name}`;
      el.appendChild(btn);
    }
    el.setAttribute('data-has', visible.length > 0 ? '1' : '0');
  }
  /**
   * Drive the panel's visual state. Idempotent; NEVER emits a control - the shared path for both the
   * optimistic local click and the authoritative server PRESENTER echo. Only the ended-border fade
   * touches a clock, via the injected native timer.
   */
  setState(state: SessionState, text?: string, tone?: PresenterTone): void {
    this.#state = state;
    this.#root?.setAttribute(DATA_RETICLE_STATE, state);
    // A handoff tone (waiting/ask/warn) drives a distinct panel treatment; calm/undefined = a plain end.
    const handoff = tone !== undefined && tone !== PresenterTone.CALM;
    if (handoff) this.#root?.setAttribute(DATA_RETICLE_TONE, tone);
    else this.#root?.removeAttribute(DATA_RETICLE_TONE);
    if (this.#fadeTimer !== undefined) {
      nativeClearTimeout(this.#fadeTimer);
      this.#fadeTimer = undefined;
    }
    const refs = this.#refs;
    const ended = state === SessionState.ENDED;
    if (refs.pauseBtn !== undefined) {
      paintPauseBtn(refs.pauseBtn, state === SessionState.PAUSED);
      refs.pauseBtn.disabled = ended;
    }
    if (refs.endBtn !== undefined) refs.endBtn.disabled = ended;
    if (refs.copyBtn !== undefined) {
      if (ended) refs.copyBtn.removeAttribute('hidden');
      else refs.copyBtn.setAttribute('hidden', '');
    }
    if (refs.exportBtn !== undefined) {
      if (ended) refs.exportBtn.removeAttribute('hidden');
      else refs.exportBtn.setAttribute('hidden', '');
    }
    if (refs.sendBtn !== undefined) refs.sendBtn.disabled = ended;
    if (refs.input !== undefined) refs.input.disabled = ended;
    // A calm end leads with "Session ended"; a handoff (waiting/ask/warn) leads with the notice itself,
    // since the toned styling already conveys "ended" and the notice is the actionable headline.
    if (refs.banner !== undefined) {
      const summary = text !== undefined && text.trim().length > 0 ? text.trim() : '';
      refs.banner.textContent =
        handoff && summary.length > 0
          ? summary
          : `${ENDED_BANNER_TEXT}${summary.length > 0 ? ` · ${summary}` : ''}`;
    }
    if (ended) {
      // End the run: fade out the page BORDER (testing is over) but KEEP the panel so the human can
      // read the result and Copy/Export the run state. The composer disables; the export row reveals.
      const glow = this.#glow;
      this.#fadeTimer = nativeSetTimeout(() => {
        glow?.setAttribute(DATA_ON, GLOW_OFF);
      }, this.#host.endedFadeMs);
    }
    this.#host.onStateChange?.(state);
  }
}
