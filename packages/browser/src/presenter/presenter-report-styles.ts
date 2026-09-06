import { HUD_DROP_SHADOW } from './presenter-hud-chrome.js';
import { DOCK_ALIGN_ATTR, DOCK_ATTR, REPORT_ATTR, REPORT_PANEL_ATTR } from './presenter-config.js';

const OVERLAY = 'data-reticle-overlay';

/**
 * The impact report's surface.
 *
 * Same glass as the chat panel and anchored in the same slot above the toolbar, because it is the
 * same object seen a different way: what this session is doing, and what every session has done.
 */
export const REPORT_CSS = `
[${REPORT_PANEL_ATTR}]{
  position:absolute;right:0;left:auto;bottom:calc(100% + 12px);z-index:31;
  box-sizing:border-box;display:flex;flex-direction:column;width:var(--reticle-dock-w);
  max-width:min(var(--reticle-dock-w),calc(100vw - 16px));max-height:calc(100vh - 140px);
  opacity:0;visibility:hidden;transform:translate3d(0,6px,0) scale(.98);pointer-events:none;
  border-radius:16px;border:1px solid color-mix(in srgb,var(--reticle-c-active) 26%,rgba(255,255,255,.1));
  background:
    radial-gradient(130% 90% at 50% 0%,color-mix(in srgb,var(--reticle-c-active) 18%,transparent),transparent 62%),
    linear-gradient(180deg,rgba(13,15,22,.96),rgba(19,22,32,.94));
  box-shadow:${HUD_DROP_SHADOW},0 0 54px -18px var(--reticle-c-active);
  color:var(--reticle-fg);font-family:var(--reticle-font);
  transition:opacity .18s ease,transform .18s ease,visibility .18s;}
[${DOCK_ATTR}][${DOCK_ALIGN_ATTR}="start"] [${REPORT_PANEL_ATTR}]{right:auto;left:0;}
[${OVERLAY}][${REPORT_ATTR}="1"] [${REPORT_PANEL_ATTR}]{
  opacity:1;visibility:visible;transform:translate3d(0,0,0) scale(1);pointer-events:auto;}
[${REPORT_PANEL_ATTR}] .reticle-report-inner{
  display:flex;flex-direction:column;min-height:0;overflow:hidden;}
[${REPORT_PANEL_ATTR}] .reticle-report-head{
  flex:none;display:flex;align-items:center;gap:8px;padding:11px 12px 9px 14px;
  border-bottom:1px solid rgba(255,255,255,.06);}
[${REPORT_PANEL_ATTR}] .reticle-report-title{font-size:12.5px;font-weight:600;}
[${REPORT_PANEL_ATTR}] .reticle-report-scope{
  margin-left:auto;padding:3px 9px;border-radius:999px;cursor:pointer;
  border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);
  color:var(--reticle-muted);font:inherit;font-size:10.5px;}
[${REPORT_PANEL_ATTR}] .reticle-report-scope:hover{background:rgba(255,255,255,.08);color:var(--reticle-fg);}
[${REPORT_PANEL_ATTR}] .reticle-report-close{
  flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;
  border:none;background:transparent;color:var(--reticle-faint);cursor:pointer;line-height:0;}
[${REPORT_PANEL_ATTR}] .reticle-report-close svg{display:block;fill:none;stroke:currentColor;stroke-width:1.6;}
[${REPORT_PANEL_ATTR}] .reticle-report-body{
  min-height:0;overflow-y:auto;padding:12px 14px 6px;
  scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.14) transparent;}
[${REPORT_PANEL_ATTR}] .reticle-report-empty{
  margin:0;padding:22px 6px;text-align:center;color:var(--reticle-faint);font-size:11.5px;}
/* The streak sits above the hero, as a flame and a number: it is the one stat that is about
   TODAY, so it reads first and never competes with the count it sits over. */
[${REPORT_PANEL_ATTR}] .reticle-report-streak{
  display:inline-flex;align-items:baseline;gap:5px;margin-bottom:8px;padding:3px 9px;
  border-radius:999px;background:rgba(255,255,255,.05);
  border:1px solid color-mix(in srgb,var(--reticle-c-active) 22%,transparent);
  font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;}
[${REPORT_PANEL_ATTR}] .reticle-report-streak-label{
  color:var(--reticle-faint);font-size:9.5px;font-weight:400;letter-spacing:.04em;text-transform:uppercase;}
[${REPORT_PANEL_ATTR}] .reticle-report-hero{display:flex;flex-direction:column;gap:2px;margin-bottom:10px;}
[${REPORT_PANEL_ATTR}] .reticle-report-hero-value{
  font-size:34px;font-weight:700;line-height:1;letter-spacing:-.02em;color:var(--reticle-c-active);}
[${REPORT_PANEL_ATTR}] .reticle-report-hero-label{color:var(--reticle-muted);font-size:11.5px;}
[${REPORT_PANEL_ATTR}] .reticle-report-verdicts{display:flex;gap:6px;margin-bottom:12px;}
[${REPORT_PANEL_ATTR}] .reticle-report-verdict{
  flex:1;padding:5px 8px;border-radius:8px;font-size:10.5px;text-align:center;
  background:rgba(255,255,255,.05);color:var(--reticle-muted);}
[${REPORT_PANEL_ATTR}] .reticle-report-verdict[data-kind="fail"]{color:#fca5a5;}
[${REPORT_PANEL_ATTR}] .reticle-report-verdict[data-kind="unknown"]{color:#fcd34d;}
[${REPORT_PANEL_ATTR}] .reticle-report-grid{
  display:grid;grid-template-columns:repeat(3,1fr);gap:6px;}
[${REPORT_PANEL_ATTR}] .reticle-report-card{
  display:flex;flex-direction:column;gap:2px;padding:8px;border-radius:10px;
  background:rgba(255,255,255,.04);}
[${REPORT_PANEL_ATTR}] .reticle-report-value{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;}
[${REPORT_PANEL_ATTR}] .reticle-report-label{color:var(--reticle-faint);font-size:9.5px;line-height:1.3;}
/* An estimate is labelled as one, and its label carries what it is measured against. */
[${REPORT_PANEL_ATTR}] .reticle-report-basis{
  display:block;margin-top:2px;color:var(--reticle-c-active);opacity:.8;
  font-size:8.5px;letter-spacing:.06em;text-transform:uppercase;cursor:help;}
[${REPORT_PANEL_ATTR}] .reticle-report-defects-wrap{margin-top:14px;}
[${REPORT_PANEL_ATTR}] .reticle-report-defects{
  display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;}
/* A left rule rather than a card per row: ten cards in a 320px panel is a wall, and the rule keeps
   the list scannable as a list — which is what a person is doing when they open this. */
[${REPORT_PANEL_ATTR}] .reticle-report-defect{
  display:flex;flex-direction:column;gap:1px;padding:4px 0 4px 8px;
  border-left:2px solid color-mix(in srgb,#f87171 70%,transparent);}
[${REPORT_PANEL_ATTR}] .reticle-report-defect-title{
  font-size:11px;line-height:1.35;overflow-wrap:anywhere;}
[${REPORT_PANEL_ATTR}] .reticle-report-defect-detail{
  color:var(--reticle-faint);font-size:10px;line-height:1.35;overflow-wrap:anywhere;}
[${REPORT_PANEL_ATTR}] .reticle-report-defect-source{
  color:var(--reticle-faint);font-size:9.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  overflow-wrap:anywhere;}
[${REPORT_PANEL_ATTR}] .reticle-report-defects-more{
  display:inline-block;margin-top:8px;font-size:10px;color:var(--reticle-c-active);
  text-decoration:none;}
[${REPORT_PANEL_ATTR}] .reticle-report-defects-more:hover{text-decoration:underline;}
[${REPORT_PANEL_ATTR}] .reticle-report-local-only{
  margin:14px 0 0;padding-top:10px;border-top:1px solid var(--reticle-line);
  color:var(--reticle-faint);font-size:10px;line-height:1.45;}
[${REPORT_PANEL_ATTR}] .reticle-report-local-only code{
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--reticle-c-active);}
[${REPORT_PANEL_ATTR}] .reticle-report-chart-wrap{margin-top:12px;}
[${REPORT_PANEL_ATTR}] .reticle-report-section{
  display:block;margin-bottom:6px;color:var(--reticle-faint);font-size:9.5px;
  letter-spacing:.06em;text-transform:uppercase;}
/* Thirty fixed slots, not a flex row: one recorded day is one thin bar on a month's axis, and a
   single stretched block would read as "a month of solid work" on the day you install it. */
[${REPORT_PANEL_ATTR}] .reticle-report-chart{
  display:grid;grid-template-columns:repeat(30,1fr);align-items:end;gap:2px;height:44px;padding:0 1px;}
[${REPORT_PANEL_ATTR}] .reticle-report-bar{
  min-width:2px;border-radius:2px 2px 0 0;
  background:color-mix(in srgb,var(--reticle-c-active) 55%,transparent);}
[${REPORT_PANEL_ATTR}] .reticle-report-bar[data-hot="1"]{background:#f87171;}
[${REPORT_PANEL_ATTR}] .reticle-report-foot{
  flex:none;display:flex;flex-wrap:wrap;gap:6px;padding:10px 14px 8px;
  border-top:1px solid rgba(255,255,255,.06);}
[${REPORT_PANEL_ATTR}] .reticle-report-share{
  padding:5px 10px;border-radius:8px;cursor:pointer;font:inherit;font-size:11px;
  border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:var(--reticle-muted);}
[${REPORT_PANEL_ATTR}] .reticle-report-share:hover{background:rgba(255,255,255,.09);color:var(--reticle-fg);}
[${REPORT_PANEL_ATTR}] .reticle-report-refer{
  border-color:color-mix(in srgb,var(--reticle-c-active) 45%,transparent);color:var(--reticle-fg);}
[${REPORT_PANEL_ATTR}] .reticle-report-links{
  flex:none;display:flex;gap:12px;padding:0 14px 12px;}
[${REPORT_PANEL_ATTR}] .reticle-report-links a{
  color:var(--reticle-faint);font-size:10.5px;text-decoration:none;}
[${REPORT_PANEL_ATTR}] .reticle-report-links a:hover{color:var(--reticle-fg);text-decoration:underline;}
`;
