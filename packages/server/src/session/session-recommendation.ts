import {
  AppRuntime,
  DESKTOP_WINDOW_BACKGROUNDED,
  HIDDEN_TAB_RECOMMENDATION,
  THROTTLED_TAB_RECOMMENDATION,
} from '@reticlehq/core';

/**
 * The session flags the recommendation is derived from. All already exist on every
 * Session (fed by PAGE_HEALTH events) — no new browser API is needed.
 */
export interface RecommendationInputs {
  hidden: boolean;
  throttled: boolean;
  focused: boolean;
  /**
   * The shell this session runs in, as the SDK reported it at handshake. Undefined for an older SDK
   * that does not report one — and an unknown runtime keeps the WEB advice, because a browser tab is
   * what most sessions are and withholding a usable escape hatch is the worse error.
   */
  runtime?: string | undefined;
}

/**
 * A human-readable hint when a tab is hidden or throttled. Returns undefined for a healthy tab so
 * the field stays ABSENT (not empty). A merely-unfocused but live tab is still scriptable, so blur
 * alone does not trigger it. Pure.
 *
 * HIDDEN and THROTTLED get DIFFERENT answers, which is the fix. They used to share one message that
 * said "may be un-focusable; acquire a guaranteed scriptable context" — correct for a background
 * tab, and actively harmful for a visible one. A visible throttled tab is driveable; measured in the
 * field, one took a sign-in and two clean net-grade verdicts with no retries, while that message had
 * already sent the agent into a lease the watching human could not see. One flag, advice that cost
 * the product's main trust surface, and nothing bought.
 *
 * Hidden outranks throttled when both are set: a background tab is the stronger fact, and its
 * failure mode (events landing on a page that never advances) is the one worth warning about.
 */
export function buildSessionRecommendation(inputs: RecommendationInputs): string | undefined {
  if (!inputs.hidden && !inputs.throttled) return undefined;
  // A desktop window gets the one answer it can act on. Checked BEFORE hidden/throttled are told
  // apart, because the distinction between them is about browser tab lifecycle and neither of its
  // two answers exists for an app whose window is the client. See DESKTOP_WINDOW_BACKGROUNDED.
  if (AppRuntime.ELECTRON === inputs.runtime || AppRuntime.TAURI === inputs.runtime) {
    return DESKTOP_WINDOW_BACKGROUNDED;
  }
  if (inputs.hidden) return HIDDEN_TAB_RECOMMENDATION;
  return THROTTLED_TAB_RECOMMENDATION;
}
