/**
 * Which side of a protocol mismatch is the stale one, and therefore what to tell the user to do.
 *
 * The close reason was a single fixed string — "upgrade @reticlehq/browser" — sent whichever way the
 * versions disagreed. That is correct only when the page is BEHIND the daemon, and the common real
 * skew runs the other way: the app's package.json pulls a current `@reticlehq/browser` while the
 * daemon is an older `@reticlehq/server` that npx resolved from cache. Observed in this repo's own
 * logs as `got: 2, expected: 1` — a browser two steps ahead, told to upgrade itself.
 *
 * Advice that names the wrong component is worse than none: the user upgrades the thing that was
 * already current, sees no change, and concludes the tool is broken.
 *
 * Kept short on purpose — a WebSocket close reason is capped at 123 BYTES, and a reason that
 * overflows is dropped by the socket layer, which would take the diagnosis with it.
 *
 * NOT a duplicate of `version/version-skew.ts`, and the two should not be merged. That module
 * describes peers which connected SUCCESSFULLY and then disagree about behaviour, so it has both
 * versions and a wire-contract fingerprint to reason from and a whole sentence to say it in. This
 * one runs where the hello was rejected outright: the connection never forms, a single integer is
 * all that is known, and the answer has to fit in a close frame. The remedies are worded to match
 * that module's, because a user who hits both should not be told two different things.
 */

/** The page is older than the daemon: its SDK cannot speak the protocol the daemon expects. */
export const BROWSER_IS_OLDER = 'protocol mismatch — upgrade @reticlehq/browser in this app';

/** The daemon is older than the page. Usually an npx cache serving a stale @reticlehq/server. */
export const DAEMON_IS_OLDER =
  'protocol mismatch — the daemon is older; run `reticle stop`, then retry';

/** The versions disagree but not in a direction we can read. */
export const SKEW_UNKNOWN = 'protocol version mismatch — @reticlehq/browser and server disagree';

/** The cap a WebSocket close reason must fit inside, in bytes. */
export const CLOSE_REASON_MAX_BYTES = 123;

/**
 * Name the stale component, given what the page announced and what this daemon speaks.
 *
 * `got` is the page's protocol version, `expected` is the daemon's. A `got` we could not read at
 * all falls back to naming both, which is vague but never actively misleading.
 */
export const protocolSkewReason = (got: number | null, expected: number): string => {
  if (null === got || !Number.isFinite(got)) return SKEW_UNKNOWN;
  if (got < expected) return BROWSER_IS_OLDER;
  if (got > expected) return DAEMON_IS_OLDER;
  return SKEW_UNKNOWN;
};
