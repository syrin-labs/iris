import {
  SETTINGS_ATTR,
  SETTINGS_BTN_ATTR,
  SETTINGS_PANEL_ATTR,
  SETTINGS_CLOSE_ATTR,
  SETTING_KEY_ATTR,
  SETTINGS_STORAGE_KEY,
  AMBIENT_GLOW_ATTR,
  BLOCK_ATTR,
  HIDDEN_UNTIL_RESTART_ATTR,
  LOG_TIMESTAMPS_ATTR,
  REDUCE_MOTION_ATTR,
  DOCK_ATTR,
  MCP_DOCS_URL,
} from './presenter-config.js';
import { PresenterIcon, PRESENTER_ICON_SIZE, setHiIcon, hiIconHtml } from './presenter-icons.js';
import { HUD_SURFACE_CLASS } from './presenter-hud-chrome.js';
import { resetHudDockPosition } from './presenter-drag.js';
import { findDock, scheduleSyncDockLayout } from './presenter-dock-layout.js';
import { SETTINGS_CSS } from './presenter-settings-styles.js';

export { SETTINGS_CSS };

/** How much detail lands in copied/exported run state. */
export const OutputDetail = {
  MINIMAL: 'minimal',
  STANDARD: 'standard',
  VERBOSE: 'verbose',
} as const;
export type OutputDetail = (typeof OutputDetail)[keyof typeof OutputDetail];

/**
 * Status themes: ONE choice, three colours.
 *
 * This was four separate pickers - a chrome accent plus a swatch row per state - which is 28
 * decisions to land on a set that works together. A theme is a combination we have already checked
 * reads as a progression (working -> waiting -> done) and against a dark app, so the choice is
 * "which mood", not "which four hex values".
 */
export const StatusThemeId = {
  SIGNAL: 'signal',
  TRAFFIC: 'traffic',
  MONO: 'mono',
  NEON: 'neon',
  EMBER: 'ember',
} as const;
export type StatusThemeId = (typeof StatusThemeId)[keyof typeof StatusThemeId];

interface StatusTheme {
  id: StatusThemeId;
  label: string;
  active: string;
  idle: string;
  ended: string;
}

export const STATUS_THEMES: readonly StatusTheme[] = [
  {
    id: StatusThemeId.SIGNAL,
    label: 'Signal',
    active: '#3b82f6',
    idle: '#eab308',
    ended: '#ef4444',
  },
  {
    id: StatusThemeId.TRAFFIC,
    label: 'Traffic',
    active: '#22c55e',
    idle: '#eab308',
    ended: '#ef4444',
  },
  { id: StatusThemeId.MONO, label: 'Mono', active: '#fafafa', idle: '#a3a3a3', ended: '#525252' },
  { id: StatusThemeId.NEON, label: 'Neon', active: '#06b6d4', idle: '#a855f7', ended: '#f43f5e' },
  { id: StatusThemeId.EMBER, label: 'Ember', active: '#f97316', idle: '#facc15', ended: '#7f1d1d' },
];

const FALLBACK_THEME: StatusTheme = {
  id: StatusThemeId.SIGNAL,
  label: 'Signal',
  active: '#3b82f6',
  idle: '#eab308',
  ended: '#ef4444',
};

export function statusTheme(id: StatusThemeId): StatusTheme {
  return STATUS_THEMES.find((t) => t.id === id) ?? FALLBACK_THEME;
}

export interface PresenterSettings {
  outputDetail: OutputDetail;
  /**
   * The colours the HUD signals session state with - the dot, the panel wash, the page glow, the
   * FAB halo and the annotation marks all read from whichever one is current. One choice, because
   * the three have to work as a set and against the user's own app.
   */
  statusThemeId: StatusThemeId;
  /** The page-edge glow. Off leaves every other signal (dot, panel, FAB) in place. */
  ambientGlow: boolean;
  reactComponents: boolean;
  hideUntilRestart: boolean;
  clearOnCopy: boolean;
  blockPageInteractions: boolean;
  showTally: boolean;
  showTimestamps: boolean;
  autoOpenChat: boolean;
  reduceMotion: boolean;
}

const OUTPUT_DETAIL_OPTIONS: { value: OutputDetail; label: string }[] = [
  { value: OutputDetail.MINIMAL, label: 'Minimal' },
  { value: OutputDetail.STANDARD, label: 'Standard' },
  { value: OutputDetail.VERBOSE, label: 'Verbose' },
];

const DEFAULT_SETTINGS: PresenterSettings = {
  outputDetail: OutputDetail.STANDARD,
  statusThemeId: StatusThemeId.SIGNAL,
  ambientGlow: true,
  reactComponents: false,
  hideUntilRestart: false,
  clearOnCopy: false,
  blockPageInteractions: true,
  showTally: false,
  showTimestamps: true,
  // ON by default: the chat IS the HUD's content, and shipping it off meant the default experience
  // was a bare toolbar until somebody found the toggle. `expand()` has always opened the chat for
  // the same reason; this is the other half — session start, with no click at all.
  //
  // Safe to default because `openChat()` expands a collapsed HUD, and session start is the one
  // moment where that is what you want. A user who prefers the bare toolbar turns this off and it
  // stays off: a stored `false` is honoured over the default, which is pinned in
  // presenter-chat-default.test.ts so the product cannot change somebody's answer behind their back.
  autoOpenChat: true,
  reduceMotion: false,
};

let activeSettings: PresenterSettings = loadPresenterSettings();

export function getPresenterSettings(): PresenterSettings {
  return activeSettings;
}

export function loadPresenterSettings(): PresenterSettings {
  if ('undefined' === typeof localStorage) return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (null === raw) return { ...DEFAULT_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if ('object' !== typeof parsed || null === parsed) return { ...DEFAULT_SETTINGS };
    const o = parsed as Record<string, unknown>;
    return {
      outputDetail: isOutputDetail(o['outputDetail'])
        ? o['outputDetail']
        : DEFAULT_SETTINGS.outputDetail,
      reactComponents: true === o['reactComponents'],
      // NOT read back from storage. "Until restart" has to mean until restart: persisted, it
      // survived the reload that was supposed to undo it, and the only way back was clearing
      // localStorage by hand - the HUD was simply gone, including the settings panel that turned
      // it off. It is a this-page-only switch, so it lives only in memory.
      hideUntilRestart: false,
      statusThemeId: isStatusThemeId(o['statusThemeId'])
        ? o['statusThemeId']
        : DEFAULT_SETTINGS.statusThemeId,
      ambientGlow:
        'boolean' === typeof o['ambientGlow'] ? o['ambientGlow'] : DEFAULT_SETTINGS.ambientGlow,
      clearOnCopy: true === o['clearOnCopy'],
      blockPageInteractions:
        'boolean' === typeof o['blockPageInteractions']
          ? o['blockPageInteractions']
          : DEFAULT_SETTINGS.blockPageInteractions,
      showTally: 'boolean' === typeof o['showTally'] ? o['showTally'] : DEFAULT_SETTINGS.showTally,
      showTimestamps:
        'boolean' === typeof o['showTimestamps']
          ? o['showTimestamps']
          : DEFAULT_SETTINGS.showTimestamps,
      autoOpenChat:
        'boolean' === typeof o['autoOpenChat'] ? o['autoOpenChat'] : DEFAULT_SETTINGS.autoOpenChat,
      reduceMotion:
        'boolean' === typeof o['reduceMotion'] ? o['reduceMotion'] : DEFAULT_SETTINGS.reduceMotion,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function isOutputDetail(v: unknown): v is OutputDetail {
  return v === OutputDetail.MINIMAL || v === OutputDetail.STANDARD || v === OutputDetail.VERBOSE;
}

function isStatusThemeId(v: unknown): v is StatusThemeId {
  return STATUS_THEMES.some((t) => t.id === v);
}

function persistSettings(next: PresenterSettings): void {
  activeSettings = next;
  if ('undefined' === typeof localStorage) return;
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode - settings still apply for this page */
  }
}

function patchSettings(patch: Partial<PresenterSettings>): PresenterSettings {
  const next = { ...activeSettings, ...patch };
  persistSettings(next);
  return next;
}

function settingsHelpIcon(): string {
  return hiIconHtml(PresenterIcon.HELP, PRESENTER_ICON_SIZE.HELP);
}

function settingsLabel(text: string, helpTitle: string): string {
  const help = settingsHelpIcon();
  return `<span class="reticle-settings-label">${text}<button type="button" class="reticle-settings-help" title="${helpTitle}" aria-label="${helpTitle}">${help}</button></span>`;
}

function settingsToggleRow(key: string, label: string, helpTitle: string, extra = ''): string {
  return `<div class="reticle-settings-row" ${extra}>
    ${settingsLabel(label, helpTitle)}
    <button type="button" class="reticle-settings-toggle" ${SETTING_KEY_ATTR}="${key}" role="switch" aria-checked="false"></button>
  </div>`;
}

function settingsCheckRow(key: string, label: string, checked: boolean): string {
  const on = checked ? 'true' : 'false';
  return `<label class="reticle-settings-checkrow" data-reticle-check-row="${key}">
    <span class="reticle-settings-check" data-reticle-check="${key}" role="checkbox" aria-checked="${on}" tabindex="0"></span>
    <span class="reticle-settings-check-label">${label}</span>
  </label>`;
}

/** Settings panel markup - anchored above the gear in the toolbar. */
export function settingsPanelHtml(): string {
  const close = hiIconHtml(PresenterIcon.REMOVE, PRESENTER_ICON_SIZE.MIN);
  const caret = hiIconHtml(PresenterIcon.CARET_RIGHT, PRESENTER_ICON_SIZE.HELP);
  const outputHelp = 'How much detail is included when you copy or export the run';
  const reactHelp = 'Include React component paths in exported run state when available';
  const hideHelp = 'Hide the Reticle HUD until you reload the page';
  const tallyHelp = 'Show the pass/fail score pill in the toolbar';
  const timestampsHelp = 'Show relative timestamps on each activity-log row';
  const autoChatHelp =
    'On by default. Opens the agent chat by itself when a session starts and when you expand the HUD. Off leaves the toolbar bare until you ask for the chat.';
  const motionHelp = 'Reduce HUD animations for accessibility';
  const glowHelp =
    'Glow the page edges in the status colour while a session is live. Off keeps the HUD signals and leaves your app alone.';
  return `<div ${SETTINGS_PANEL_ATTR} class="reticle-settings ${HUD_SURFACE_CLASS}" role="dialog" aria-label="Reticle settings" aria-hidden="true">
    <div class="reticle-settings-inner">
      <div class="reticle-settings-head">
        <span class="reticle-settings-title">Settings</span>
        <button type="button" ${SETTINGS_CLOSE_ATTR} class="reticle-settings-close" title="Close settings" aria-label="Close settings">${close}</button>
      </div>
      <div class="reticle-settings-body">
        <div class="reticle-settings-section">Session</div>
        <div class="reticle-settings-row">
          ${settingsLabel('Output Detail', outputHelp)}
          <button type="button" class="reticle-settings-cycle" data-reticle-settings-cycle="outputDetail"><span data-reticle-cycle-label></span><span class="reticle-settings-dots" data-reticle-cycle-dots></span></button>
        </div>
        ${settingsToggleRow('autoOpenChat', 'Auto-open chat', autoChatHelp)}
        ${settingsToggleRow('showTimestamps', 'Show timestamps', timestampsHelp)}
        ${settingsToggleRow('showTally', 'Show verdict tally', tallyHelp)}
        <div class="reticle-settings-section">Inspector</div>
        ${settingsToggleRow('reactComponents', 'React Components', reactHelp, 'data-reticle-settings-react-row')}
        <div class="reticle-settings-section">Interaction</div>
        ${settingsCheckRow('blockPageInteractions', 'Block page interactions', true)}
        ${settingsCheckRow('clearOnCopy', 'Clear on copy/send', false)}
        ${settingsToggleRow('hideUntilRestart', 'Hide Until Restart', hideHelp)}
        ${settingsToggleRow('reduceMotion', 'Reduce motion', motionHelp)}
        <div class="reticle-settings-section">Status theme</div>
        ${settingsToggleRow('ambientGlow', 'Page glow', glowHelp)}
        <div class="reticle-settings-themes" data-reticle-settings-themes></div>
      </div>
      <div class="reticle-settings-foot">
        <button type="button" class="reticle-settings-reset" data-reticle-settings-reset>Reset HUD position</button>
        <button type="button" class="reticle-settings-link" data-reticle-settings-mcp>Manage MCP &amp; Webhooks<span class="reticle-settings-link-caret" aria-hidden="true">${caret}</span></button>
      </div>
    </div>
  </div>`;
}

export interface SettingsHost {
  onHideUntilRestart?: () => void;
  onSettingsChange?: (settings: PresenterSettings) => void;
  onBeforeOpen?: () => void;
}

/** Apply persisted settings onto the overlay + dock. */
export function applyPresenterSettings(root: HTMLElement, settings: PresenterSettings): void {
  const theme = statusTheme(settings.statusThemeId);
  root.style.setProperty('--reticle-mark-accent', theme.active);
  root.style.setProperty('--reticle-accent', theme.active);
  root.style.setProperty('--reticle-c-active', theme.active);
  root.style.setProperty('--reticle-c-idle', theme.idle);
  root.style.setProperty('--reticle-c-ended', theme.ended);
  root.setAttribute(AMBIENT_GLOW_ATTR, settings.ambientGlow ? '1' : '0');
  if (settings.hideUntilRestart) {
    root.setAttribute(HIDDEN_UNTIL_RESTART_ATTR, '1');
  } else {
    root.removeAttribute(HIDDEN_UNTIL_RESTART_ATTR);
  }
  root.setAttribute(LOG_TIMESTAMPS_ATTR, settings.showTimestamps ? '1' : '0');
  root.setAttribute(REDUCE_MOTION_ATTR, settings.reduceMotion ? '1' : '0');
  const tally = root.querySelector('[data-reticle-tally]');
  if (tally instanceof HTMLElement && !settings.showTally) {
    tally.setAttribute('hidden', '');
  }
}

/**
 * Toggle the full-page blocker. Only active while annotate mode is live AND the user opted in -
 * never on a collapsed FAB, so real hover/click on the host app still works.
 */
export function syncPageBlocker(
  root: HTMLElement,
  settings: PresenterSettings,
  annotateLive: boolean,
): void {
  root.setAttribute(BLOCK_ATTR, settings.blockPageInteractions && annotateLive ? '1' : '0');
}

/** Blocker node - sits under Reticle UI, above the host page. */
export function blockerHtml(): string {
  return '<div data-reticle-blocker aria-hidden="true"></div>';
}

export class PresenterSettingsPanel {
  #root: HTMLElement | undefined;
  #panel: HTMLElement | undefined;
  #btn: HTMLElement | undefined;
  #host: SettingsHost;

  constructor(host: SettingsHost = {}) {
    this.#host = host;
    activeSettings = loadPresenterSettings();
  }

  contains(node: Node): boolean {
    return true === this.#panel?.contains(node);
  }

  mount(root: HTMLElement): void {
    this.#root = root;
    const panel = root.querySelector(`[${SETTINGS_PANEL_ATTR}]`);
    this.#panel = panel instanceof HTMLElement ? panel : undefined;
    this.#panel?.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    const btn = root.querySelector(`[${SETTINGS_BTN_ATTR}]`);
    this.#btn = btn instanceof HTMLElement ? btn : undefined;
    const closeBtn = root.querySelector(`[${SETTINGS_CLOSE_ATTR}]`);
    if (closeBtn instanceof HTMLElement) {
      setHiIcon(closeBtn, PresenterIcon.REMOVE, PRESENTER_ICON_SIZE.MIN);
    }
    if (this.#btn !== undefined) {
      setHiIcon(this.#btn, PresenterIcon.GEAR, PRESENTER_ICON_SIZE.TOOLBAR);
      this.#btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggle();
      });
    }
    root
      .querySelector(`[data-reticle-settings-cycle="outputDetail"]`)
      ?.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = OUTPUT_DETAIL_OPTIONS.findIndex((o) => o.value === activeSettings.outputDetail);
        const next = OUTPUT_DETAIL_OPTIONS[(idx + 1) % OUTPUT_DETAIL_OPTIONS.length];
        if (next !== undefined) this.#update({ outputDetail: next.value });
      });
    for (const help of root.querySelectorAll('.reticle-settings-help')) {
      help.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }
    for (const toggle of root.querySelectorAll(`[${SETTING_KEY_ATTR}]`)) {
      const activateToggle = (): void => {
        if (!(toggle instanceof HTMLElement)) return;
        const key = toggle.getAttribute(SETTING_KEY_ATTR);
        if ('reactComponents' === key) {
          this.#update({ reactComponents: !activeSettings.reactComponents });
        } else if ('hideUntilRestart' === key) {
          const next = !activeSettings.hideUntilRestart;
          this.#update({ hideUntilRestart: next });
          if (next) this.#host.onHideUntilRestart?.();
        } else if ('showTally' === key) {
          this.#update({ showTally: !activeSettings.showTally });
        } else if ('autoOpenChat' === key) {
          this.#update({ autoOpenChat: !activeSettings.autoOpenChat });
        } else if ('showTimestamps' === key) {
          this.#update({ showTimestamps: !activeSettings.showTimestamps });
        } else if ('reduceMotion' === key) {
          this.#update({ reduceMotion: !activeSettings.reduceMotion });
        } else if ('ambientGlow' === key) {
          this.#update({ ambientGlow: !activeSettings.ambientGlow });
        }
      };
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        activateToggle();
      });
      toggle.addEventListener('keydown', (e) => {
        if (e instanceof KeyboardEvent && (' ' === e.key || 'Enter' === e.key)) {
          e.preventDefault();
          e.stopPropagation();
          activateToggle();
        }
      });
    }
    for (const check of root.querySelectorAll('[data-reticle-check]')) {
      const activate = (): void => {
        if (!(check instanceof HTMLElement)) return;
        const key = check.getAttribute('data-reticle-check');
        if ('clearOnCopy' === key) {
          this.#update({ clearOnCopy: !activeSettings.clearOnCopy });
        } else if ('blockPageInteractions' === key) {
          this.#update({ blockPageInteractions: !activeSettings.blockPageInteractions });
        }
      };
      const row = check.closest('[data-reticle-check-row]');
      row?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.target instanceof HTMLElement && e.target.classList.contains('reticle-settings-help'))
          return;
        activate();
      });
      check.addEventListener('keydown', (e) => {
        if (e instanceof KeyboardEvent && (' ' === e.key || 'Enter' === e.key)) {
          e.preventDefault();
          activate();
        }
      });
    }
    root.querySelector('[data-reticle-settings-mcp]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(MCP_DOCS_URL, '_blank', 'noopener,noreferrer');
    });
    root.querySelector('[data-reticle-settings-reset]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const dock = root.querySelector(`[${DOCK_ATTR}]`);
      if (dock instanceof HTMLElement) resetHudDockPosition(dock);
    });
    closeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close();
    });
    this.#buildThemes();
    this.#syncUi();
    applyPresenterSettings(root, activeSettings);
    this.#host.onSettingsChange?.(activeSettings);
  }

  teardown(): void {
    this.#root = undefined;
    this.#panel = undefined;
    this.#btn = undefined;
  }

  isOpen(): boolean {
    return '1' === this.#root?.getAttribute(SETTINGS_ATTR);
  }

  open(): void {
    if (this.#root === undefined) return;
    this.#host.onBeforeOpen?.();
    this.#root.setAttribute(SETTINGS_ATTR, '1');
    this.#panel?.setAttribute('aria-hidden', 'false');
    this.#btn?.setAttribute('data-active', '1');
    this.#syncDockLayout();
  }

  close(): void {
    if (this.#root === undefined) return;
    this.#root.setAttribute(SETTINGS_ATTR, '0');
    this.#panel?.setAttribute('aria-hidden', 'true');
    this.#btn?.setAttribute('data-active', '0');
    this.#syncDockLayout();
  }

  #syncDockLayout(): void {
    if (this.#root === undefined) return;
    const dock = findDock(this.#root);
    if (dock !== undefined) scheduleSyncDockLayout(dock, this.#root);
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  #update(patch: Partial<PresenterSettings>): void {
    const next = patchSettings(patch);
    if (this.#root !== undefined) applyPresenterSettings(this.#root, next);
    this.#syncUi();
    this.#host.onSettingsChange?.(next);
  }

  #syncUi(): void {
    const s = activeSettings;
    const label = this.#panel?.querySelector('[data-reticle-cycle-label]');
    if (label !== null && label !== undefined) {
      label.textContent =
        OUTPUT_DETAIL_OPTIONS.find((o) => o.value === s.outputDetail)?.label ?? 'Standard';
    }
    const dots = this.#panel?.querySelector('[data-reticle-cycle-dots]');
    if (dots !== null && dots !== undefined) {
      dots.replaceChildren(
        ...OUTPUT_DETAIL_OPTIONS.map((o) => {
          const dot = document.createElement('span');
          dot.className = 'reticle-settings-dot';
          dot.setAttribute('data-on', o.value === s.outputDetail ? '1' : '0');
          return dot;
        }),
      );
    }
    this.#paintToggle('reactComponents', s.reactComponents);
    this.#paintToggle('hideUntilRestart', s.hideUntilRestart);
    this.#paintToggle('showTally', s.showTally);
    this.#paintToggle('autoOpenChat', s.autoOpenChat);
    this.#paintToggle('showTimestamps', s.showTimestamps);
    this.#paintToggle('reduceMotion', s.reduceMotion);
    this.#paintToggle('ambientGlow', s.ambientGlow);
    this.#paintCheck('clearOnCopy', s.clearOnCopy);
    this.#paintCheck('blockPageInteractions', s.blockPageInteractions);
    for (const chip of this.#panel?.querySelectorAll('[data-reticle-theme]') ?? []) {
      if (chip instanceof HTMLElement) {
        chip.setAttribute(
          'data-on',
          chip.getAttribute('data-reticle-theme') === s.statusThemeId ? '1' : '0',
        );
      }
    }
  }

  #paintToggle(key: string, on: boolean): void {
    const el = this.#panel?.querySelector(`[${SETTING_KEY_ATTR}="${key}"]`);
    if (el instanceof HTMLElement) {
      el.setAttribute('data-on', on ? '1' : '0');
      el.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  #paintCheck(key: string, on: boolean): void {
    const el = this.#panel?.querySelector(`[data-reticle-check="${key}"]`);
    if (el instanceof HTMLElement) {
      el.setAttribute('data-on', on ? '1' : '0');
      el.setAttribute('aria-checked', on ? 'true' : 'false');
      el.textContent = on ? '✓' : '';
    }
  }

  /** One row of themes: each chip shows the whole set - active, idle, ended - in order. */
  #buildThemes(): void {
    const host = this.#panel?.querySelector('[data-reticle-settings-themes]');
    if (null === host || undefined === host) return;
    host.replaceChildren(
      ...STATUS_THEMES.map((t) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'reticle-settings-theme';
        btn.setAttribute('data-reticle-theme', t.id);
        btn.title = t.label;
        btn.setAttribute('aria-label', `${t.label} status theme`);
        for (const color of [t.active, t.idle, t.ended]) {
          const band = document.createElement('span');
          band.className = 'reticle-settings-theme-band';
          band.style.background = color;
          btn.appendChild(band);
        }
        const name = document.createElement('span');
        name.className = 'reticle-settings-theme-name';
        name.textContent = t.label;
        btn.appendChild(name);
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.#update({ statusThemeId: t.id });
        });
        return btn;
      }),
    );
  }
}
