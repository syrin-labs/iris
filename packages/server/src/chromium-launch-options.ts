/**
 * The launch options every Reticle-driven Chromium gets, in one place.
 *
 * A pooled browser serves several lease contexts while only one page is ever the visible one, and a
 * driven page can sit in a window the host does not treat as visible. For everyone else Chromium
 * throttles timers, suspends rAF, and deprioritizes the renderer, which is exactly the state a
 * session reports as `throttled: true`: WebSocket- and timer-driven DOM updates land seconds late,
 * asserts time out on content that appears right after the timeout, with no refetch, because the
 * app was fine and the browser was parked. The three switches below are the documented opt-outs,
 * shared by both launch sites so the pooled path (`playwright-launcher`) and the drive path
 * (`real-input`) cannot drift apart.
 */

/**
 * Chromium switches that keep background pages running at full speed. Named individually rather
 * than as one free string per call site, so a typo is a test failure instead of a silently ignored
 * argument.
 */
export const CHROMIUM_ANTI_THROTTLING_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
] as const;

/** The options object handed to `chromium.launch` at both launch sites. */
interface ChromiumLaunchOptions {
  headless: boolean;
  args: string[];
}

/**
 * Build the launch options for a headless or headed Chromium. Pure; returns a fresh mutable array
 * each call so no caller can mutate the constant behind everyone else's back.
 */
export function chromiumLaunchOptions(headless: boolean): ChromiumLaunchOptions {
  return { headless, args: [...CHROMIUM_ANTI_THROTTLING_ARGS] };
}
