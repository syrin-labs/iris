/**
 * Human-facing HUD/notice copy that crosses the wire to the panel or surfaces on tool results.
 * Kept apart from the wire enums in constants.ts so the prose can grow without bloating that file.
 */

/**
 * Tone of a PRESENTER push, rides the command as optional `tone`. Lets the panel tell apart the ways
 * a session can stop, so the human on the browser always knows the agent's mode:
 * calm — a normal, human/agent-driven end ("done").
 * waiting — the agent finished its turn / went idle; it will resume on your next message.
 * ask — the agent is blocked and needs your input to continue (carries the question as text).
 * warn — the agent stopped unexpectedly (crashed / disconnected) — switch to your terminal.
 */
export const PresenterTone = {
  CALM: 'calm',
  WAITING: 'waiting',
  ASK: 'ask',
  WARN: 'warn',
} as const;
export type PresenterTone = (typeof PresenterTone)[keyof typeof PresenterTone];

/** Narrow an unknown wire value to a PresenterTone (defaults handled by the caller). */
export function isPresenterTone(value: unknown): value is PresenterTone {
  return (
    value === PresenterTone.CALM ||
    value === PresenterTone.WAITING ||
    value === PresenterTone.ASK ||
    value === PresenterTone.WARN
  );
}

/**
 * Surfaced on observe/network/console results once the event ring buffer has evicted anything (age
 * or size cap). Converts a silent false negative into an honest one: a "no such event" answer after
 * eviction may be "I dropped the evidence", not "it never happened" — widen the buffer / grade
 * sooner. Rides in a `buffer` block only when `dropped > 0` (silence ⇒ nothing lost).
 */
export const BUFFER_EVICTION_WARNING =
  'event buffer evicted older events (age/size cap): a negative result here may be a false negative; the evidence may have expired. Grade sooner or widen the buffer.';

/**
 * Thrown when a tool needs a live browser session and none is connected. Names the #1 real cause in a
 * multi-repo / multi-agent setup — a PORT MISMATCH between the app's SDK and the daemon — so the agent
 * checks the wiring instead of only the "is the SDK enabled?" dead end.
 *
 * It used to end by naming `reticle_wait_ready`, which is retired (see RETIRED_FROM_SURFACE) and
 * answers `unknown tool`. This is the most-thrown error in the product — `resolve` raises it on
 * every tool call while nothing is connected — so the one sentence carrying the ACTION sent the
 * reader to a tool that does not exist, at the moment they had least idea what to do next.
 *
 * `reticle_sessions` is the live answer and a strictly better one: it returns the ranked diagnosis
 * (which of the causes above this actually is, plus the port scan and a next action) rather than
 * blocking and telling you nothing. It is the same tool `#unknownSessionError` already points at,
 * so the two no-session paths now agree.
 */
export const NO_SESSION_CONNECTED_ERROR =
  "no browser session connected. Two things to check: (1) your app is running with @reticlehq/browser enabled, and (2) it points at THIS daemon's port — a mismatch between the app's reticle({ port }) / VITE_RETICLE_WS_URL and the daemon's RETICLE_PORT is the usual cause. Call reticle_sessions for the diagnosis — it names which of these it is, and what to do next — rather than retrying this call.";

/** Surfaced on act/assert results when the target tab is throttled. */
export const THROTTLED_WARNING =
  'tab throttled; timer/rAF/pointer gestures may silently no-op; refocus before driving';

/**
 * Prefixed onto a wait/assert miss when the session is throttled. A background tab is starved by
 * the browser, so a timeout there is not evidence the UI is absent — it may never have rendered.
 * `inconclusive` on the verdict (this string) is what stops that miss being graded as a product
 * failure. The CLI escape hatch is named second; an MCP-only agent has no shell.
 */
export const THROTTLED_STARVED_NOTE =
  'this tab is throttled and has not rendered; a miss here is not evidence the UI is absent. ' +
  'acquire a scriptable context with reticle_run { tool: "reticle_lease", action: "acquire", url } ' +
  '(the human can run `reticle drive <url>` if they have a shell)';

/**
 * Pushed to the panel when the last agent's MCP connection drops — the agent (any of
 * Codex/OpenCode/Claude/Hermes) has stopped or is waiting on you. Tells the human, who is
 * on the browser, that control is back on the terminal so a typed prompt isn't silently lost.
 */
export const AGENT_STOPPED_NOTICE = 'Agent stopped — switch to your terminal to continue.';

/**
 * Prefixes any human notes typed into the panel but not yet read when the session ends — folded into
 * the end banner so a prompt sent in the death-race (agent stops mid-keystroke) is surfaced back to
 * the human, copyable, instead of vanishing into a dead inbox.
 */
export const UNDELIVERED_NOTES_LABEL = 'Undelivered (paste into your terminal):';

/** Panel notice when the agent yields after finishing its turn (reticle_yield mode:'waiting'). */
export const AGENT_WAITING_NOTICE =
  'Agent finished its turn — your move. Continue in your terminal.';

/** Panel notice prefix when the agent is blocked on you (reticle_yield mode:'ask'); the question follows. */
export const AGENT_ASK_NOTICE = 'Agent needs your input — answer in your terminal';

/**
 * Returned by `reticle_session` yield/end when the turn ends with no browser session connected.
 *
 * Ending a turn is not an operation on a tab. The agent is reporting that it has stopped driving,
 * and that is true whether or not anything was ever connected — so refusing it made the agent fail
 * a call it was told is MANDATORY, on the most common state a session is in. Reported agents skip
 * yield entirely and note the gap in prose, which is the outcome this notice exists to remove.
 *
 * Said back to the caller rather than swallowed, so "the panel showed nothing" is a fact the agent
 * can put in its report instead of an absence it has to infer.
 */
export const YIELD_WITHOUT_SESSION_NOTE =
  'No browser session was connected, so there was no panel to update. The turn end was still ' +
  'recorded. If you expected an app to be attached, that is the thing to look into.';

/**
 * What leasing COSTS, said once and appended to every recommendation that offers it.
 *
 * A lease is a separate pooled context. It is the highest-value path in the product for autonomous
 * work — and it is invisible to the person sitting in front of the app, because the HUD lives in
 * THEIR tab. Recommending it without saying so produced exactly the failure it invites: an agent
 * took the advice, drove fifteen calls into a context nobody could see, and the developer watching
 * an empty HUD asked why nothing was running. The product looked broken while working correctly.
 *
 * The tradeoff is the whole content of the hint. An agent that knows a human is watching should
 * spend a slower tab to stay visible; one working alone should lease and not think about it.
 */
export const LEASE_IS_INVISIBLE_NOTE =
  'note that a lease is a SEPARATE context: the human watching this tab sees nothing of what you do there, so prefer this tab while someone is following along';

/**
 * A tab that is HIDDEN — backgrounded, or in another window.
 *
 * The genuinely risky case, and the one this recommendation was written for. A background tab has
 * its timers and rAF clamped hard, so synthetic events can land on a page that never advances, and
 * Reticle cannot bring it to the front. Naming the limit is the honest move.
 *
 * Names the escape hatch the AGENT can take first (`reticle_lease` through `reticle_run`, since
 * lease is not on the default surface) and leaves `reticle drive` as the human-side equivalent: an
 * MCP-only agent has no shell, so a CLI sentence is advice it cannot follow.
 */
/**
 * A DESKTOP window that has gone to the background, which is a different problem with a different fix.
 *
 * The web answer — acquire a lease, or run `reticle drive <url>` — is unavailable here and saying it
 * is worse than saying nothing. A lease opens a headless BROWSER context; an Electron or Tauri app's
 * window IS the client, and a browser pointed at the same dev-server URL is a different program with
 * no main process, no preload and no Rust commands. Driven on MarkText, a shipped Electron editor:
 * its window went behind, the session reported hidden+throttled, and the only advice offered was the
 * one thing that could not be done — while the thing that works, bringing the window forward, went
 * unsaid.
 *
 * No `reticle_lease` and no `reticle drive` in this sentence, deliberately. Both are checked by test.
 */
export const DESKTOP_WINDOW_BACKGROUNDED =
  "this app window is in the background, and a backgrounded webview clamps its timers and rAF — a synthetic action can land on a page that never advances. Bring the app window to the front and retry. A lease is NOT the answer for a desktop app: it opens a browser context, which has none of this app's IPC or commands.";

export const HIDDEN_TAB_RECOMMENDATION =
  'tab hidden and may be un-focusable from here; timers and rAF are clamped in a background tab, so an action can land on a page that never advances. Refocus it, or acquire a guaranteed scriptable context yourself with `reticle_run { tool: "reticle_lease", action: "acquire", url }` (a human can equivalently run `reticle drive <url>`) — ' +
  LEASE_IS_INVISIBLE_NOTE;

/**
 * A tab that is NOT hidden but has gone quiet — the `throttled` flag without `hidden`.
 *
 * Worth being exact, because the flag's name oversells it: `throttled` is `hidden || stale`, and
 * stale only means no health heartbeat arrived inside the window. For a tab that is not hidden that
 * usually means nothing worse than a quiet page, and such a tab is very often driveable.
 *
 * Split out because the old single message treated this as equivalent to hidden and it is not.
 * Measured in the field: a session flagged throttled took a sign-in and two clean net-grade verdicts
 * with no retries, while the recommendation had already sent the agent into a lease the watching
 * human could not see. One flag produced advice that cost the product's main trust surface and
 * bought nothing.
 *
 * So this reports the uncertainty honestly — it MAY be slow, timing-sensitive work is what suffers —
 * and offers the precise instrument for that (`refuseWhenThrottled`) rather than a different
 * browser.
 */
export const THROTTLED_TAB_RECOMMENDATION =
  'tab is not hidden but has not reported health recently — usually a quiet page rather than a stuck one, and very often still driveable. This is also the tab a human can see, so try it first. Timing-sensitive work (animations, debounces, gestures) is what degrades: pass `refuseWhenThrottled: true` to refuse rather than act over events that may not land. Lease a separate context only if a drive here actually fails; ' +
  LEASE_IS_INVISIBLE_NOTE;

/**
 * @deprecated Use {@link HIDDEN_TAB_RECOMMENDATION} or {@link THROTTLED_TAB_RECOMMENDATION}.
 * Retained so an older consumer pinned to this name still compiles; it is the hidden-tab wording,
 * which is the case the single message was actually correct for.
 */
export const UNSCRIPTABLE_TAB_RECOMMENDATION = HIDDEN_TAB_RECOMMENDATION;
