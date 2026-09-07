import { AppRuntime, isOpaqueOrigin } from '@reticlehq/core';

/**
 * Turn a bare command timeout into something the reader can act on.
 *
 * The default message — `command 'snapshot' timed out after 8000ms` — is eight seconds of silence
 * followed by a fact with no cause. For a Tauri app the cause is usually not a bug in the app: its
 * window was hidden before the webview had ever been PRESENTED, and a webview that has never been
 * presented never loads its page. The session stays connected, so nothing looks wrong, and the
 * developer goes hunting through their own code for a fault that is not there.
 *
 * This advice previously blamed occlusion — "macOS suspends an occluded or off-Space WKWebView" —
 * which is false for those states, and was the kind of wrong steer this function exists to prevent.
 * A LOADED Tauri webview keeps answering while minimized, occluded, and on another Space. `hide()`
 * after load is the remaining headless path: a hidden macOS WKWebView has been observed to go quiet
 * after a pause, but that is not something every machine demonstrates, so this message names it as
 * a candidate rather than a fact.
 *
 * It then over-corrected: it asserted the hidden-before-load ordering as FACT. But the only evidence
 * here is `hidden === true` — the ordering is never observed. Measured on a Tauri shell pointed at an
 * external http origin, whose window nothing ever hid: the message confidently prescribed a fix for a
 * mistake that had not been made, and two rounds of debugging went into the wrong place. A diagnostic
 * that names the wrong cause is worse than a bare timeout, because the bare timeout at least sends
 * the reader looking. So this now reports what is KNOWN and ranks the causes rather than picking one.
 *
 * The advice is ADDED, never substituted — the original fact still leads — and only for a runtime
 * that can actually suffer it, since misdirecting an Electron user costs them the same hour.
 */

/**
 * What the page told us about its shell, via PAGE_HEALTH. Undefined before the first report.
 *
 * An alias of core's AppRuntime rather than a second list of the same three strings: the SDK reports
 * this value, so it is a wire value, and two independent spellings of it is how one side gains a
 * runtime the other silently refuses to recognise.
 */
export type PageRuntime = AppRuntime;

interface TimeoutContext {
  url: string;
  /** The page's own last visibility report. */
  hidden: boolean;
  /** Reported by the SDK. A URL cannot distinguish a Tauri dev server from a plain localhost app. */
  runtime?: PageRuntime;
  /** ms since ANY inbound message from the SDK. Small = the page is demonstrably still running. */
  lastSeenMs?: number;
}

/**
 * Inbound silence beyond this means the page may genuinely be wedged; inside it, the SDK has spoken
 * recently enough that "the page is hung" is provably the wrong story. A page that is streaming
 * events is executing JavaScript by definition.
 */
const RECENTLY_HEARD_MS = 2000;

const ONE_WAY_ADVICE =
  'The page is ALIVE — the SDK last reported to the bridge %MS%ms ago — but it is not answering ' +
  'commands. A page that is still sending is executing JavaScript, so it is not hung, hidden or ' +
  'suspended: messages are getting OUT and not back IN. Look at the bridge→page direction (a socket ' +
  'replaced mid-session, a proxy buffering one way) rather than at your app.';

const HIDDEN_ADVICE =
  'The page last reported itself hidden, and this is a WKWebView (Tauri) window, so the webview is ' +
  'most likely not running the page at all. Two known causes, commonest first: (1) the window was ' +
  'hidden BEFORE its first page load — a webview that has never been presented never loads, so park ' +
  'it from `on_page_load` instead of `setup` (see `reticle_tauri::on_page_load`, which does this for ' +
  'RETICLE_HEADLESS=1). (2) the window was hidden after load and then went quiet — that has been ' +
  'observed on a hidden macOS WKWebView after a pause, even though capture still works; park it ' +
  'off-screen rather than calling hide. If neither fits, the page is reachable but not executing, ' +
  'which is worth reporting.';

/** True when this session is a WebKit desktop shell — the only runtime that suffers this. */
function isWebKitDesktop(context: TimeoutContext): boolean {
  if (AppRuntime.TAURI === context.runtime) return true;
  // A `tauri://` origin is unambiguous even before the first health report lands.
  if (context.runtime !== undefined) return false;
  return isOpaqueOrigin(context.url) && context.url.startsWith('tauri:');
}

export function commandTimeoutMessage(
  name: string,
  timeoutMs: number,
  context: TimeoutContext,
): string {
  const base = `command '${name}' timed out after ${String(timeoutMs)}ms`;
  // Checked FIRST, and it overrides the visibility story: a page that was heard from moments ago is
  // executing JavaScript, so "hidden, hung or never presented" cannot be the explanation whatever
  // `hidden` says. Deduced from the invariant, not from a measured incident — the Tauri case that
  // prompted it turned out to go fully silent instead, which this branch correctly does not claim.
  const heard = context.lastSeenMs;
  if (heard !== undefined && heard <= RECENTLY_HEARD_MS) {
    return `${base}. ${ONE_WAY_ADVICE.replace('%MS%', String(heard))}`;
  }
  if (!context.hidden || !isWebKitDesktop(context)) return base;
  return `${base}. ${HIDDEN_ADVICE}`;
}
