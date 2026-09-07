/**
 * The artwork constants are annotated `: string` deliberately.
 *
 * Without the annotation TypeScript infers a literal type, and every one of these SVG and HTML
 * strings is copied verbatim into the emitted `.d.ts` as its own type. That duplicated the artwork
 * into the published package twice over: this file's declarations alone were 16KB of a 900KB
 * budget, carrying type information nobody can use - no caller cares about the literal type of a
 * `<path d=...>`.
 */
/**
 * Brand marks, inlined. The SDK is bundled into someone else's page: it cannot read
 * `assets/logo/*.svg` from disk at runtime and must never fetch from our own domain, so the mark
 * lives here as a string (same precedent as SEND_ICON in presenter-controls.ts).
 * Minified - editor metadata, clip paths, masks and sub-0.01 precision stripped - and painted
 * with `currentColor` so the mark tracks --reticle-fg instead of hardcoding the export's #FAFAFA.
 */
/** Accessible name of the HUD. */
export const BRAND_NAME = 'Reticle';
/** The two glyph paths of the mark. */
const MARK_PATHS: string = `<path d="M92.82 92.16C93.07 93.4 91.77 94.4 90.63 93.83C89.62 93.33 88.62 92.82 87.63 92.3C71.14 83.78 54.79 72.27 39.61 57.96C39.09 57.49 38.57 56.98 38.06 56.49C22.45 41.52 9.78 25.14 .33 8.52C0.29 8.45 .25 8.38 .2 8.31C-0.44 7.2 .51 5.84 1.79 6.05L24.07 9.71C43.06 12.83 60.63 11.75 75.55 6.53L93.95 .09C95.15-0.33 96.31 .78 95.93 1.98L90.1 20.49C85.37 35.48 84.9 52.97 88.69 71.73L92.83 92.16H92.82Z"/><path d="M58.72 89.23L6.15 92.8C5.24 92.86 4.48 92.13 4.51 91.22L6.56 30.39C6.61 28.91 8.51 28.36 9.35 29.57C16.23 39.43 24.98 52.35 33.01 61.26C41.05 70.17 50.6 78.72 59.62 86.56C60.65 87.45 60.08 89.13 58.72 89.23Z"/>`;
/** Mark alone (shown in the FAB and compact toolbar). */
export const MARK_SVG: string = `<svg class="reticle-mark" viewBox="0 0 96 94" fill="currentColor" aria-hidden="true">${MARK_PATHS}</svg>`;
/** FAB-sized mark for the collapsed circular control. */
const FAB_MARK_SVG: string = `<svg class="reticle-fab-mark" viewBox="0 0 96 94" fill="currentColor" aria-hidden="true">${MARK_PATHS}</svg>`;
/** Collapsed FAB control - Reticle mark only. */
export const FAB_TOGGLE_HTML: string = `<button type="button" class="reticle-fab" data-reticle-fab aria-label="Start ${BRAND_NAME}" aria-expanded="false">${FAB_MARK_SVG}<span class="reticle-fab-pulse" aria-hidden="true"></span><span data-reticle-mark-count class="reticle-fab-badge" hidden>0</span></button>`;
