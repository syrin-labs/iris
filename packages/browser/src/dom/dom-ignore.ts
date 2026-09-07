/**
 * Selectors for Reticle's own presenter overlay (cursor, HUD, glow) + the annotator's
 * UI (`data-reticle-mark`) - never observed/snapshotted. The annotator mounts by DEFAULT with the
 * presenter, so omitting its selector here leaked annotation chrome into every snapshot.
 */
export const RETICLE_OVERLAY: string =
  '[data-reticle-overlay],[data-reticle-cursor],[data-reticle-hud],[data-reticle-glow],[data-reticle-mark],[data-reticle-blocker]';

/** Known third-party dev overlays to keep out of snapshots (Agentation, Next dev UI). */
const DEV_OVERLAYS =
  '[data-agentation],#__next-build-watcher,nextjs-portal,[data-nextjs-dialog],[data-nextjs-toast]';

let extraIgnore = '';

/**
 * Whether Reticle's OWN UI is visible to snapshots and queries.
 *
 * Off, always, unless an app opts in — and the opt-in exists for exactly one situation: the app
 * under test IS Reticle. A HUD change is otherwise the only kind of change Reticle cannot be used to
 * check, because the panel that renders it is invisible to every tool that could look at it.
 *
 * It stays off by default because the reason for hiding it is sound: an agent that can drive
 * Reticle's own interface can fabricate its own impact report, and a snapshot full of Reticle chrome
 * is noise in every other app on earth. This is a hatch for contributors, not a setting.
 *
 * Third-party dev overlays stay ignored either way — they are somebody else's furniture and were
 * never the thing being verified.
 */
let presenterVisible = false;

/**
 * Make Reticle's own presenter visible to snapshots and queries. Contributors only.
 *
 * Deliberately a function rather than a field on the ignore set, so the one place that decides
 * "is this ours" also decides "may it be seen", and no caller can half-apply it.
 */
export function setPresenterVisible(visible: boolean): void {
  presenterVisible = visible;
}

/** Whether the hatch is open — reported in the app's capabilities so a verdict is never mistaken. */
export function isPresenterVisible(): boolean {
  return presenterVisible;
}

/** Let the host app add selectors to exclude from snapshots (e.g. its own dev widgets). */
export function setIgnoreSelectors(selectors: string[]): void {
  extraIgnore = selectors.join(',');
}

/** True if the element is part of Reticle's own presenter overlay. */
export function isReticleOverlay(el: Element): boolean {
  return el.closest(RETICLE_OVERLAY) !== null;
}

/**
 * True iff the element is part of Reticle's OWN UI - the presenter overlay, the HUD, the synthetic
 * cursor, the glow, or the annotator's marks - or lives inside one of them.
 *
 * The rule used to be "any ancestor carries a data-reticle* attribute", which is wrong twice over.
 * `data-reticle-mark-active` sits on <html> while annotate mode is live, so the whole document
 * answered yes; and `data-reticle-source` is stamped by the Vite/Babel plugins on every element the
 * APP renders, so in an instrumented app - which is the only kind there is - most of the page
 * answered yes too. Those attributes describe page content; they do not make it ours.
 *
 * Two things read this and both failed silently. `pageElementAt` (annotator) skipped every stamped
 * element and anchored the note to the outermost unstamped ancestor, i.e. the app shell instead of
 * the control under the cursor. `occlusion.ts` reads a yes as "nothing to report", so occlusion
 * detection - a bug class Reticle advertises catching - came back clean wherever the stamp reached.
 */
export function isReticleUi(node: Element | null): boolean {
  return node !== null && node.closest(RETICLE_OVERLAY) !== null;
}

/** True if the element should be excluded from snapshots/queries (Reticle overlay or dev overlay). */
export function isIgnored(el: Element): boolean {
  // With the hatch open, Reticle's own overlay drops out of the ignore set — but the third-party
  // dev overlays do not. They are somebody else's furniture and were never the thing being verified.
  const ours = presenterVisible ? '' : RETICLE_OVERLAY;
  const sel = [ours, DEV_OVERLAYS, extraIgnore].filter((part) => part.length > 0).join(',');
  return el.closest(sel) !== null;
}
