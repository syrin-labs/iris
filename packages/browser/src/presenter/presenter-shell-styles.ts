/**
 * Floating HUD shell styles - FAB, morphing toolbar, and agent chat panel.
 * Split from presenter-styles.ts so the controller stays under the size cap.
 */
import { LOG_TIME_ATTR } from './presenter-log.js';
import {
  CHAT_ATTR,
  CHAT_PILL_ATTR,
  CHAT_PLACEMENT_ATTR,
  DOCK_ALIGN_ATTR,
  DOCK_ATTR,
  LOG_TIMESTAMPS_ATTR,
  MIN_ATTR,
  REDUCE_MOTION_ATTR,
  LIVENESS_ATTR,
} from './presenter-config.js';
import { HUD_DROP_SHADOW, HUD_SURFACE_FILL } from './presenter-hud-chrome.js';

const OVERLAY = 'data-reticle-overlay';
const HUD = 'data-reticle-hud';
const CHAT_PANEL = 'data-reticle-chat-panel';
const STATE = 'data-reticle-state';
const TONE = 'data-reticle-tone';

export const SHELL_CSS = `
/**
 * ONE colour says what the session is doing, and the user picks all three.
 *
 * --reticle-state resolves against the overlay's state attributes, and everything that signals -
 * the dot, the chat panel's wash and glow, the page edges, the collapsed FAB's halo - reads it.
 * The defaults are blue / amber / red; the settings panel writes --reticle-c-* from the swatches,
 * because a signal colour that disappears into the user's own palette is not a signal.
 */
[${OVERLAY}]{
  --reticle-c-active:#3b82f6;--reticle-c-idle:#eab308;--reticle-c-ended:#ef4444;
  --reticle-state:var(--reticle-c-idle);}
[${OVERLAY}][${LIVENESS_ATTR}="active"]{--reticle-state:var(--reticle-c-active);}
[${OVERLAY}][${STATE}="paused"]{--reticle-state:var(--reticle-c-idle);}
[${OVERLAY}][${STATE}="ended"]{--reticle-state:var(--reticle-c-ended);}
[${DOCK_ATTR}]{
  --reticle-surface:rgba(255,255,255,.06);
  /* No literal here: --reticle-accent is published on the overlay from the chosen status theme.
     Redefining it on the dock made every accented control - toolbar toggles, focus rings, the send
     button - stay blue no matter which theme was picked, because the dock's value won for its own
     subtree. The fallback only matters if the presenter is mounted without settings. */
  --reticle-accent:var(--reticle-c-active,#3b82f6);
  --reticle-accent-soft:color-mix(in srgb,var(--reticle-accent) 18%,transparent);
  --reticle-bg:#050506;--reticle-bg2:#0c0c10;
  --reticle-fg:#fff;--reticle-muted:rgba(255,255,255,.85);--reticle-faint:rgba(255,255,255,.5);
  --reticle-line:rgba(255,255,255,.12);--reticle-line2:rgba(255,255,255,.08);
  --reticle-read:#d4d4d4;--reticle-ok:#fafafa;--reticle-bad:#f5f5f5;
  --reticle-font:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --reticle-shell-ease:cubic-bezier(.22,1,.36,1);
  --reticle-shell-fast:.22s var(--reticle-shell-ease);
  --reticle-mark-accent:var(--reticle-accent);
  position:fixed;right:20px;bottom:20px;left:auto;
  z-index:2147483647;pointer-events:none;display:flex;flex-direction:column;align-items:flex-end;gap:8px;
  overflow:visible;max-width:calc(100vw - 24px);font-family:var(--reticle-font);-webkit-font-smoothing:antialiased;
  /**
   * ONE width for the dock and the chat above it. They were 420px and 320px, so the toolbar
   * overhung the panel it belongs to and the pair read as two unrelated widgets.
   */
  /* ONE width for the chat, the capsule and the toolbar. It used to be 440 with a "compact" 340
     toggle; 340 is the size that actually reads well beside an app, so it is simply the size. */
  --reticle-dock-w:340px;
  /* The log is the reason the panel exists, so it gets the height rather than the chrome. */
  --reticle-chat-h:660px;
  opacity:0;transform:translate3d(0,8px,0);transition:opacity var(--reticle-shell-fast),transform var(--reticle-shell-fast);}
[${DOCK_ATTR}][data-dragged="1"]{left:var(--reticle-hud-x);top:var(--reticle-hud-y);bottom:auto;right:auto;transform:none;}
[${DOCK_ATTR}][data-dragged="1"][data-on="1"]{transform:none;}
[${DOCK_ATTR}][data-on="1"]{opacity:1;transform:translate3d(0,0,0);pointer-events:none;}
[${DOCK_ATTR}][data-on="0"]{opacity:0;pointer-events:none;}
/**
 * The panel is GLASS, tinted by the state colour, with the glow sitting behind it - restored from
 * the version before this one, where a flat near-black card had replaced it. Kept at ~92% opacity
 * rather than a real backdrop-filter: blur(24px) here was measured as the single most expensive
 * thing in the whole SDK (+4pp of main thread on the hostile fixture), and the tint buys the look
 * without the bill.
 */
[${CHAT_PANEL}]{
  background:
    radial-gradient(130% 90% at 50% 0%,color-mix(in srgb,var(--reticle-c-active) 18%,transparent),transparent 62%),
    linear-gradient(180deg,rgba(13,15,22,.96),rgba(19,22,32,.94));
  border:1px solid color-mix(in srgb,var(--reticle-c-active) 26%,rgba(255,255,255,.1));
  display:none;position:absolute;right:0;left:auto;bottom:calc(100% + 8px);top:auto;z-index:5;
  box-sizing:border-box;width:var(--reticle-dock-w);max-width:min(var(--reticle-dock-w),calc(100vw - 16px));
  max-height:min(var(--reticle-chat-max-h,var(--reticle-chat-h)),calc(100vh - 120px));
  flex-direction:column;overflow:hidden;text-align:left;
  color:var(--reticle-fg);font-size:13px;line-height:1.5;
  border-radius:16px;
  box-shadow:${HUD_DROP_SHADOW},0 0 54px -18px var(--reticle-c-active);
  contain:layout style paint;
  transform:translateZ(0);
  pointer-events:none;}
[${DOCK_ATTR}][${CHAT_PLACEMENT_ATTR}="below"] [${CHAT_PANEL}]{
  bottom:auto;top:calc(100% + 8px);}
[${DOCK_ATTR}][${DOCK_ALIGN_ATTR}="start"] [${CHAT_PANEL}]{
  right:auto;left:0;}
[${OVERLAY}][${CHAT_ATTR}="1"] [${CHAT_PANEL}]{
  display:flex;pointer-events:auto;}
/**
 * Minimising the chat leaves a CAPSULE, not a hole: the same glass, the same state dot, the last
 * thing the agent did - sitting directly above the toolbar capsule and reopening the panel when
 * clicked. Minimise used to leave the toolbar alone above an empty gap, so a minimised session
 * looked identical to no session at all.
 */
[${CHAT_PILL_ATTR}]{
  display:none;position:absolute;right:0;left:auto;bottom:calc(100% + 8px);z-index:5;
  box-sizing:border-box;width:var(--reticle-dock-w);
  max-width:min(var(--reticle-dock-w),calc(100vw - 16px));
  align-items:center;gap:9px;padding:9px 16px;border-radius:999px;cursor:pointer;
  background:
    radial-gradient(120% 160% at 50% 0%,color-mix(in srgb,var(--reticle-state) 18%,transparent),transparent 70%),
    linear-gradient(180deg,rgba(13,15,22,.96),rgba(19,22,32,.94));
  border:1px solid color-mix(in srgb,var(--reticle-state) 26%,rgba(255,255,255,.1));
  box-shadow:${HUD_DROP_SHADOW},0 0 34px -14px var(--reticle-state);
  color:var(--reticle-muted);font-family:var(--reticle-font);font-size:11px;line-height:1;
  transition:transform .1s ease,border-color .2s ease;}
[${DOCK_ATTR}][${CHAT_PLACEMENT_ATTR}="below"] [${CHAT_PILL_ATTR}]{bottom:auto;top:calc(100% + 8px);}
[${DOCK_ATTR}][${DOCK_ALIGN_ATTR}="start"] [${CHAT_PILL_ATTR}]{right:auto;left:0;}
[${OVERLAY}][${MIN_ATTR}="0"]:not([${CHAT_ATTR}="1"]) [${CHAT_PILL_ATTR}]{
  display:inline-flex;pointer-events:auto;}
[${CHAT_PILL_ATTR}]:hover{border-color:color-mix(in srgb,var(--reticle-c-active) 45%,transparent);}
[${CHAT_PILL_ATTR}]:active{transform:scale(.98);}
/* No dot in the capsule: the mark, the border and the glow already carry the state colour, and a
   pulsing dot next to a line of text that changes on its own was two things moving for one fact. */
[${CHAT_PILL_ATTR}] .reticle-mark{flex:none;height:14px;width:auto;color:var(--reticle-fg);opacity:.9;}
/* Header: who this panel belongs to, and what the session is doing right now. */
[${CHAT_PANEL}] .reticle-chat-head{
  flex:none;display:flex;align-items:center;gap:8px;padding:11px 44px 9px 14px;
  border-bottom:1px solid rgba(255,255,255,.06);}
[${CHAT_PANEL}] .reticle-chat-brand{display:inline-flex;align-items:center;gap:7px;color:var(--reticle-fg);}
[${CHAT_PANEL}] .reticle-chat-brand .reticle-mark{height:14px;width:auto;}
[${CHAT_PANEL}] .reticle-chat-brandname{font-size:12.5px;font-weight:600;letter-spacing:.01em;}
/* No state word here: the activity strip immediately below already says "idle · 21s", and the
   dot in front of it carries the same colour. One fact, one place. */
[${CHAT_PILL_ATTR}] .reticle-chat-pill-text{
  flex:1;text-align:left;
  min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-variant-numeric:tabular-nums;letter-spacing:.01em;}
[${CHAT_PILL_ATTR}] .reticle-chat-pill-time{
  flex:none;color:var(--reticle-faint);font-variant-numeric:tabular-nums;}
[${CHAT_PILL_ATTR}] .reticle-chat-pill-caret{
  flex:none;display:inline-flex;color:var(--reticle-faint);line-height:0;transform:rotate(180deg);}
[${CHAT_PILL_ATTR}] .reticle-chat-pill-caret svg{
  display:block;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;}
/* Minimise the chat without collapsing the whole HUD — sits over the panel's top-right corner. */
[${DOCK_ATTR}] .reticle-chat-min{
  position:absolute;top:6px;right:6px;z-index:4;
  width:26px;height:26px;padding:0;border:none;border-radius:50%;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;
  background:transparent;color:rgba(255,255,255,.6);line-height:0;}
[${DOCK_ATTR}] .reticle-chat-min:hover{background:rgba(255,255,255,.07);color:var(--reticle-fg);}
[${DOCK_ATTR}] .reticle-chat-min svg{display:block;fill:none;stroke:currentColor;stroke-width:1.5;
  stroke-linecap:round;stroke-linejoin:round;}
[${OVERLAY}][${LOG_TIMESTAMPS_ATTR}="0"] [${LOG_TIME_ATTR}]{display:none;}
[${OVERLAY}][${REDUCE_MOTION_ATTR}="1"] [${HUD}],
[${OVERLAY}][${REDUCE_MOTION_ATTR}="1"] [${CHAT_PANEL}],
[${OVERLAY}][${REDUCE_MOTION_ATTR}="1"] [data-reticle-settings-panel]{
  transition-duration:.01ms !important;}
[${OVERLAY}][${REDUCE_MOTION_ATTR}="1"] .reticle-fab-pulse,
[${OVERLAY}][${REDUCE_MOTION_ATTR}="1"] .reticle-act-dot,
[${OVERLAY}][${REDUCE_MOTION_ATTR}="1"] [data-bump="1"]{animation:none !important;}
[${HUD}]{
  /* Centre the toolbar in the pill. The toolbar is 32px inside a 36px content box and, as a plain
     block child, sat flush against padding-top - every icon rode 2px high in a rounded bar, which
     is exactly the offset the eye picks up on a pill. */
  position:relative;box-sizing:border-box;pointer-events:auto;flex:none;
  display:flex;align-items:center;
  width:44px;height:44px;min-height:44px;max-height:44px;overflow:visible;
  background:${HUD_SURFACE_FILL};
  color:#fff;border:none;border-radius:22px;
  box-shadow:0 2px 12px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.06),0 0 0 1px rgba(255,255,255,.1);
  contain:layout style;
  transition:width .26s var(--reticle-shell-ease),border-radius .26s var(--reticle-shell-ease),
    transform var(--reticle-shell-fast),opacity .18s ease;
  will-change:width,border-radius,transform;}
[${OVERLAY}][${MIN_ATTR}="0"] [${HUD}]{
  box-shadow:0 4px 20px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.08),0 0 0 1px rgba(255,255,255,.12);}
[${HUD}] .reticle-hud-deco{
  position:absolute;inset:0;z-index:0;border-radius:inherit;pointer-events:none;
  opacity:0;visibility:hidden;}
[${OVERLAY}][${MIN_ATTR}="0"] [${HUD}] .reticle-hud-deco{
  opacity:1;visibility:visible;}
[${HUD}][data-on="0"]{opacity:0;transform:scale(.8);pointer-events:none;}
[${HUD}][data-on="1"]{opacity:1;transform:scale(1);}
/* The expanded HUD IS the shared column width; the toolbar fills its content box. Sizing the
   toolbar to the dock width instead pushed it past the HUD's padding, and the last button - Exit -
   rendered outside the rounded box it belongs to. */
[${OVERLAY}][${MIN_ATTR}="0"] [${HUD}]{
  width:min(calc(100vw - 24px),var(--reticle-dock-w));height:44px;min-height:44px;max-height:44px;
  min-width:44px;border-radius:24px;padding:4px 6px;}
[${HUD}] .reticle-fab{
  position:absolute;inset:0;z-index:2;display:inline-flex;align-items:center;justify-content:center;
  width:44px;height:44px;padding:0;margin:0;border:none;border-radius:22px;cursor:pointer;
  background:transparent;color:var(--reticle-fg);line-height:0;
  transition:background .15s ease,transform .1s ease;}
/**
 * Collapsed, the circle IS the whole HUD - so it has to say on its own whether Reticle is working,
 * waiting or done. It carries the state colour as a halo: breathing while the agent drives, a
 * steady soft ring while idle, and a flat dim ring once the session has ended.
 */
[${OVERLAY}][${MIN_ATTR}="1"] [${HUD}] .reticle-fab{
  cursor:grab;touch-action:none;user-select:none;
  box-shadow:0 0 0 1px color-mix(in srgb,var(--reticle-state) 55%,transparent),
    0 0 14px -2px color-mix(in srgb,var(--reticle-state) 45%,transparent);}
[${OVERLAY}][${MIN_ATTR}="1"][${LIVENESS_ATTR}="active"] [${HUD}] .reticle-fab{
  animation:reticle-fab-breathe 1.6s ease-in-out infinite;}
[${OVERLAY}][${MIN_ATTR}="1"][${STATE}="ended"] [${HUD}] .reticle-fab{
  animation:none;box-shadow:0 0 0 1px color-mix(in srgb,var(--reticle-state) 40%,transparent);}
@keyframes reticle-fab-breathe{
  0%,100%{box-shadow:0 0 0 1px color-mix(in srgb,var(--reticle-state) 70%,transparent),
    0 0 16px -2px color-mix(in srgb,var(--reticle-state) 55%,transparent)}
  50%{box-shadow:0 0 0 2px var(--reticle-state),
    0 0 28px 2px color-mix(in srgb,var(--reticle-state) 70%,transparent)}}
[${OVERLAY}][${REDUCE_MOTION_ATTR}="1"] [${HUD}] .reticle-fab{animation:none;}
[${OVERLAY}][${MIN_ATTR}="1"] [${HUD}] .reticle-fab.reticle-drag-handle--dragging{
  cursor:grabbing;}
[${HUD}] .reticle-fab-mark{height:22px;width:auto;pointer-events:none;}
[${HUD}] .reticle-fab:hover{background:rgba(255,255,255,.08);}
[${HUD}] .reticle-fab:active{transform:scale(.95);}
[${HUD}] .reticle-fab:focus-visible{outline:2px solid color-mix(in srgb,var(--reticle-accent) 75%,transparent);outline-offset:2px;}
[${HUD}] .reticle-fab-pulse{
  position:absolute;top:6px;right:6px;width:6px;height:6px;border-radius:50%;
  background:var(--reticle-accent);opacity:0;transform:scale(.6);transition:opacity .2s,transform .2s;}
[${HUD}] .reticle-fab[data-pulse="1"] .reticle-fab-pulse{opacity:1;transform:scale(1);}
[${HUD}] .reticle-fab-badge{
  position:absolute;top:-13px;right:-13px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;
  background:var(--reticle-accent);color:#fff;font-size:10px;font-weight:600;
  display:flex;align-items:center;justify-content:center;pointer-events:none;
  box-shadow:0 1px 3px rgba(0,0,0,.15);}
[${HUD}] .reticle-fab-badge[hidden]{display:none;}
[${OVERLAY}][${MIN_ATTR}="0"] [${HUD}] .reticle-fab{
  opacity:0;pointer-events:none;visibility:hidden;}
/* The toolbar is the third element in the same column, so it carries the same width as the chat
   and the capsule above it and spreads its groups across it, rather than hugging its icons. */
[${HUD}] .reticle-toolbar{
  position:relative;z-index:1;display:none;align-items:center;justify-content:space-between;
  box-sizing:border-box;width:100%;
  gap:4px;height:32px;padding:0 2px;
  overflow:visible;opacity:0;transform:scale(.94);pointer-events:none;
  transition:opacity .2s var(--reticle-shell-ease),transform .18s var(--reticle-shell-ease);}
[${OVERLAY}][${MIN_ATTR}="0"] [${HUD}] .reticle-toolbar{
  display:flex;opacity:1;transform:scale(1);pointer-events:auto;}
[${HUD}] .reticle-toolbar-drag{cursor:grab;touch-action:none;user-select:none;}
[${HUD}] .reticle-toolbar-drag.reticle-drag-handle--dragging{cursor:grabbing;}
[${HUD}] .reticle-toolbar-actions{
  display:inline-flex;align-items:center;gap:2px;flex:none;
  padding:2px;border-radius:999px;background:rgba(0,0,0,.2);}
[${HUD}] .reticle-toolbar-chrome{display:inline-flex;align-items:center;gap:2px;flex:none;}
[${HUD}] .reticle-tb-sep{width:1px;height:14px;background:rgba(255,255,255,.12);margin:0 4px;flex:none;align-self:center;}
[${HUD}] .reticle-tb-wrap{position:relative;display:flex;align-items:center;justify-content:center;overflow:visible;}
[${HUD}] .reticle-tb-btn{
  flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:32px;height:32px;padding:0;border:none;border-radius:50%;cursor:pointer;
  background:transparent;color:rgba(255,255,255,.85);line-height:0;
  transition:background-color .15s ease,color .15s ease,transform .1s ease,opacity .2s ease;}
[${HUD}] .reticle-tb-btn:hover{background:rgba(255,255,255,.12);color:#fff;}
[${HUD}] .reticle-tb-btn:active{transform:scale(.92);}
[${HUD}] .reticle-tb-btn:focus-visible{outline:2px solid color-mix(in srgb,var(--reticle-accent) 65%,transparent);outline-offset:1px;}
[${HUD}] .reticle-tb-btn:disabled{opacity:.35;cursor:not-allowed;transform:none;}
[${HUD}] .reticle-tb-btn[data-active="1"]{color:var(--reticle-accent);
  background:color-mix(in srgb, var(--reticle-accent) 25%, transparent);}
[${HUD}] .reticle-tb-btn--toggle[data-active="1"]{
  color:var(--reticle-accent);background:transparent;}
[${HUD}] .reticle-tb-btn--toggle[data-active="1"]:hover{background:rgba(255,255,255,.06);color:var(--reticle-accent);}
[${HUD}] .reticle-hi-toggle{
  position:relative;display:inline-flex;align-items:center;justify-content:center;
  width:18px;height:18px;line-height:0;flex:none;}
[${HUD}] .reticle-hi-toggle .reticle-hi-icon{
  position:absolute;inset:0;display:inline-flex;align-items:center;justify-content:center;
  transition:opacity .14s ease;}
[${HUD}] .reticle-hi-toggle .reticle-hi-icon--solid{opacity:0;}
[${HUD}] .reticle-hi-toggle .reticle-hi-icon--solid svg{
  transform:scale(1.12);transform-origin:center;}
/*
 * Active toggles keep the OUTLINE icon. They used to swap to the solid heroicon, which is a filled
 * glyph next to 1.5px strokes everywhere else, so the pressed button read as a heavier typeface
 * rather than as a state. The state is already carried by accent colour and a background above,
 * which is enough and does not change the icon's weight.
 */
[${HUD}] .reticle-tb-btn--toggle[data-active="1"] .reticle-hi-icon--outline{opacity:1;}
[${HUD}] .reticle-tb-btn--toggle .reticle-hi-icon--solid{opacity:0;}
[${HUD}] .reticle-tb-btn--toggle .reticle-hi-icon--solid svg{color:inherit;}
[${HUD}] .reticle-tb-btn--primary[data-active="1"]{
  color:#fff;background:rgba(255,255,255,.14);}
[${HUD}] .reticle-tb-btn[data-danger]:hover:not(:disabled){color:#ff383c;
  background:color-mix(in srgb, #ff383c 25%, transparent);}
/**
 * The toolbar is a FIXED number of slots.
 *
 * Copy and Export appear when a session ends, and they used to be added to a bar that was already
 * full - eleven icons in a pill sized for nine, so the last one rendered outside the rounded box.
 * They take the two slots that Pause and End vacate: neither can do anything to a session that has
 * already ended, so the bar swaps two dead controls for two live ones and never changes width.
 */
[${HUD}] .reticle-tb-btn--export{display:none;}
[${OVERLAY}][${STATE}="ended"] [${HUD}] .reticle-tb-btn--export{display:inline-flex;}
[${OVERLAY}][${STATE}="ended"] [${HUD}] [data-reticle-pause],
[${OVERLAY}][${STATE}="ended"] [${HUD}] [data-reticle-end]{display:none;}
[${HUD}] .reticle-tb-tip{
  position:absolute;bottom:calc(100% + 14px);left:50%;transform:translateX(-50%) scale(.95);
  padding:6px 10px;background:#1a1a1a;color:rgba(255,255,255,.9);font-size:12px;font-weight:500;
  border-radius:8px;white-space:nowrap;opacity:0;visibility:hidden;pointer-events:none;z-index:3;
  box-shadow:0 2px 8px rgba(0,0,0,.3);transition:opacity .135s ease,transform .135s ease,visibility .135s;}
[${HUD}] .reticle-tb-tip::after{
  content:"";position:absolute;top:calc(100% - 4px);left:50%;transform:translateX(-50%) rotate(45deg);
  width:8px;height:8px;background:#1a1a1a;border-radius:0 0 2px 0;}
[${HUD}] .reticle-tb-wrap:hover .reticle-tb-tip{
  opacity:1;visibility:visible;transform:translateX(-50%) scale(1);transition-delay:.3s;}
[${HUD}] .reticle-tb-wrap:has(.reticle-tb-btn:disabled):hover .reticle-tb-tip{opacity:0;visibility:hidden;}
[${HUD}] .reticle-tb-wrap--pause:hover .reticle-pause-badge{opacity:0;}
[${HUD}] .reticle-tb-kbd{margin-left:4px;opacity:.5;}
[${HUD}] .reticle-pause-badge{
  display:none;position:absolute;bottom:calc(100% + 5px);left:50%;transform:translateX(-50%);
  align-items:center;flex:none;font-weight:600;letter-spacing:.08em;font-size:7px;
  color:var(--reticle-fg);border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.55);
  padding:2px 6px;border-radius:999px;white-space:nowrap;pointer-events:none;z-index:2;
  transition:opacity .12s ease;}
[${OVERLAY}][${STATE}="paused"] [data-reticle-badge]{display:inline-flex;}
/**
 * The mode, ON the status row rather than under it.
 *
 * The action text beside it is flex:1, so this claims the right edge of the row and takes its space
 * from the elided action text. Nothing above or below moves: the panel used to grow and shrink by
 * the height of this pill on every single tool call, which is what made one status line look like a
 * second UI appearing and leaving.
 */
[${DOCK_ATTR}] .reticle-chip{display:none;flex:none;align-items:center;gap:4px;font-size:8px;font-weight:600;letter-spacing:.06em;
  height:16px;padding:0 7px;line-height:1;border-radius:999px;text-transform:uppercase;
  background:rgba(255,255,255,.06);opacity:0;transition:opacity .12s ease;}
[${DOCK_ATTR}] .reticle-chip[data-mode="reading"],
[${DOCK_ATTR}] .reticle-chip[data-mode="acting"]{opacity:1;}
[${DOCK_ATTR}] .reticle-chip[data-mode="reading"],
[${DOCK_ATTR}] .reticle-chip[data-mode="acting"]{display:inline-flex;color:var(--reticle-fg);}
[${DOCK_ATTR}] .reticle-tally[hidden]{display:none;}
[${DOCK_ATTR}] .reticle-tally{align-self:center;flex:none;}
[${DOCK_ATTR}] .reticle-pill-group{
  display:inline-flex;align-items:stretch;flex:none;border-radius:999px;overflow:hidden;
  background:rgba(255,255,255,.06);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);}
[${DOCK_ATTR}] .reticle-pill-segment{
  display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;
  font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1;color:var(--reticle-fg);}
[${DOCK_ATTR}] .reticle-pill-segment[data-z="1"]{opacity:.4;}
[${DOCK_ATTR}] .reticle-t-pass.reticle-pill-segment{background:rgba(34,197,94,.14);color:#bbf7d0;}
[${DOCK_ATTR}] .reticle-t-fail.reticle-pill-segment{background:rgba(239,68,68,.14);color:#fecaca;}
[${DOCK_ATTR}] .reticle-pill-sep{width:1px;align-self:stretch;background:rgba(255,255,255,.12);flex:none;margin:0;}
[${DOCK_ATTR}] .reticle-pill-count{min-width:1ch;}
[${DOCK_ATTR}] .reticle-tally .reticle-hi-icon{opacity:.92;}
@keyframes reticle-tally-pop{0%{transform:scale(1)}38%{transform:scale(1.3)}100%{transform:scale(1)}}
[${DOCK_ATTR}] .reticle-tally [data-bump="1"]{display:inline-flex;animation:reticle-tally-pop .36s cubic-bezier(.16,1,.3,1);}
[${HUD}] .reticle-hi-icon{display:inline-flex;align-items:center;justify-content:center;line-height:1;flex-shrink:0;color:inherit;}
[${HUD}] .reticle-hi-icon svg{display:block;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;}
[${HUD}] .reticle-live{display:none;}
[${CHAT_PANEL}] .reticle-act-strip{flex:none;display:flex;align-items:center;gap:8px;padding:10px 14px;
  border-bottom:1px solid rgba(255,255,255,.07);background:rgba(0,0,0,.22);}
[${CHAT_PANEL}] .reticle-act-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--reticle-faint);
  box-shadow:0 0 0 2px rgba(255,255,255,.04);transition:background .2s,box-shadow .2s;}
/**
 * The status dot carries the session state in COLOUR, not only in the word next to it - and in the
 * user's own colour for that state, so it reads against their app rather than ours.
 */
[${CHAT_PANEL}] .reticle-act-strip[data-liveness="active"] .reticle-act-dot,
[${CHAT_PANEL}] .reticle-act-strip[data-liveness="idle"] .reticle-act-dot{
  background:var(--reticle-state);
  box-shadow:0 0 0 2px color-mix(in srgb,var(--reticle-state) 18%,transparent),
    0 0 8px color-mix(in srgb,var(--reticle-state) 45%,transparent);}
[${CHAT_PANEL}] .reticle-act-strip[data-liveness="idle"] .reticle-act-dot{
  animation:reticle-idle-pulse 2.4s ease-in-out infinite;}
/**
 * Unreachable: present, and plainly not working.
 *
 * Muted rather than alarming. Nothing is broken in the user's app — Reticle simply has nobody to
 * talk to — and a dev overlay that shouts about its own plumbing is one the user turns off.
 */
[${OVERLAY}][${STATE}="unreachable"]{--reticle-state:var(--reticle-faint);}
[${OVERLAY}][${STATE}="unreachable"] [${CHAT_PANEL}] .reticle-act-dot{animation:none;}
[${OVERLAY}][${STATE}="paused"] [${CHAT_PANEL}] .reticle-act-dot,
[${OVERLAY}][${STATE}="ended"] [${CHAT_PANEL}] .reticle-act-dot{animation:none;}
@keyframes reticle-idle-pulse{0%,100%{opacity:.45;transform:scale(.92)}50%{opacity:1;transform:scale(1)}}
[${CHAT_PANEL}] .reticle-act{display:block;flex:1;min-width:0;color:var(--reticle-muted);font-size:11px;
  font-variant-numeric:tabular-nums;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[${CHAT_PANEL}] .reticle-act-strip[data-liveness="active"] .reticle-act{color:var(--reticle-fg);}
[${HUD}] .reticle-pass{color:var(--reticle-ok);}[${HUD}] .reticle-fail{color:var(--reticle-bad);}
/**
 * Paused and ended keep the STATE colour rather than washing out to grey.
 *
 * These three rules predate the status theme and forced the accent to a fixed grey, so the moment a
 * session paused or ended every lit control in the toolbar lost its colour - the HUD read as
 * switched off exactly when the person is looking at it to find out what happened. The colour is
 * the theme's own paused/ended colour now, so "which state am I in" is answered by the same hue
 * everywhere: the dot, the glow, the FAB halo, and the toolbar.
 */
[${OVERLAY}][${STATE}="paused"] [${HUD}],
[${OVERLAY}][${STATE}="ended"] [${HUD}],
[${OVERLAY}][${TONE}="waiting"] [${HUD}]{
  --reticle-accent:var(--reticle-state);
  --reticle-accent-soft:color-mix(in srgb,var(--reticle-state) 18%,transparent);}
[${OVERLAY}][${TONE}="ask"] [${HUD}],
[${OVERLAY}][${TONE}="warn"] [${HUD}]{
  --reticle-accent:var(--reticle-state);
  --reticle-accent-soft:color-mix(in srgb,var(--reticle-state) 18%,transparent);}
@media (max-width:480px){
  [${CHAT_PANEL}]{width:min(100vw - 24px,320px);max-height:min(360px,calc(100vh - 100px));}
  [${OVERLAY}][${MIN_ATTR}="0"] [${HUD}]{max-width:calc(100vw - 24px);}
}`;
