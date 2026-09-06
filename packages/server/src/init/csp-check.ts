/**
 * Does this app's Content-Security-Policy let the browser reach the Reticle bridge?
 *
 * Two independent field reports, both Next: `init` reported every step successful, the SDK mounted,
 * the dial URL was correct, and the app never connected because a strict `connect-src` excluded
 * `ws://localhost:<port>`. The browser blocks the WebSocket and says so in its own console, which
 * nothing on the Reticle side reads — so `status` and `doctor` reported perfect health at an app
 * that could not connect at all, forever. A setup step that exits 0 while leaving the user broken is
 * the worst failure mode this repo has.
 *
 * A TEXT SCAN, deliberately. `headers()` is a function; `init` cannot execute a user's Next config
 * without importing their whole app, and the thing worth finding is the policy string a developer
 * typed — in `next.config.*`, in middleware, or in a `<meta http-equiv>` tag. The scan finds the
 * string wherever it is written.
 *
 * NARROW on purpose: it fires only when a `connect-src` exists AND does not admit the bridge. No
 * CSP, or one that already covers us, produces nothing. A warning that fires on a working setup
 * costs precisely what a green check on a broken one costs, and this file exists because of the
 * second kind.
 */

/** Sources that admit any ws origin, so the bridge is already reachable. */
const WILDCARDS: readonly string[] = ['*', 'ws:', 'wss:', 'ws://*', 'https:'];

/** The two hosts the SDK may dial. `localhost` and the IPv4 loopback are different CSP sources. */
function bridgeOrigins(port: number): string[] {
  return [`ws://localhost:${String(port)}`, `ws://127.0.0.1:${String(port)}`];
}

/**
 * The `connect-src` directive's source list, or undefined when the text declares none.
 *
 * Matches to the end of the directive (`;`) or the end of the enclosing quoted string, which is how
 * these are written in both a Next `headers()` value and a `<meta content="...">`.
 */
function directiveSources(text: string, directive: string): string[] | undefined {
  // Stops at the directive separator or the closing double quote of the enclosing string. Single
  // quotes are NOT terminators: `'self'` is a source, not the end of the list.
  const match = new RegExp(`${directive}([^;"]*)`, 'i').exec(text);
  const list = match?.[1];
  if (list === undefined) return undefined;
  return list
    .split(/\s+/)
    .map((source) => source.trim())
    .filter((source) => source.length > 0);
}

/**
 * What this policy allows a WebSocket to reach — `connect-src`, or `default-src` when it is absent.
 *
 * The fallback is the CSP spec's, and leaving it out made the check blind to the commonest strict
 * policy there is. MarkText, a production Electron editor, declares
 * `default-src 'self'; script-src 'self'; …` with NO `connect-src`: its WebSockets are restricted to
 * 'self', the bridge is blocked, and this returned "no problem" because it was looking for a
 * directive that was not written. Every fetch-directive falls back to `default-src`; that is what
 * `default` means, and it is why an author does not repeat themselves.
 *
 * Still undefined when NEITHER is present — a policy that constrains neither is not blocking us.
 */
function connectSrcSources(text: string): string[] | undefined {
  return directiveSources(text, 'connect-src') ?? directiveSources(text, 'default-src');
}

/**
 * The problem with this app's `connect-src`, or undefined if there is not one.
 *
 * `https:` counts as a wildcard here only in the sense that a policy written that loosely will not
 * be the thing blocking a dev WebSocket; the check stays quiet rather than arguing about it.
 */
export function cspConnectSrcProblem(text: string, port: number): string | undefined {
  const sources = connectSrcSources(text);
  if (sources === undefined || 0 === sources.length) return undefined;
  if (sources.some((source) => WILDCARDS.includes(source))) return undefined;
  const wanted = bridgeOrigins(port);
  // BOTH, not either: the SDK picks its host from how the page was served, and a policy that admits
  // one is a coin flip. A coin flip that fails is indistinguishable from every other silent
  // non-connect, which is the whole cost being avoided here.
  if (wanted.every((origin) => sources.includes(origin))) return undefined;
  const missing = wanted.filter((origin) => !sources.includes(origin));
  return (
    `this app declares a Content-Security-Policy whose \`connect-src\` does not admit the Reticle ` +
    `bridge: ${missing.join(' and ')} ${1 === missing.length ? 'is' : 'are'} missing. The browser ` +
    `will block the WebSocket and report it in ITS console only — every check on the Reticle side ` +
    `will pass while the app never connects. ${devCspAddition(port)}`
  );
}

/** The exact addition to paste. Text to copy, not advice to interpret. */
export function devCspAddition(port: number): string {
  return (
    `Add to \`connect-src\` in development only (e.g. behind ` +
    `\`process.env.NODE_ENV === 'development'\`): ` +
    `${bridgeOrigins(port).join(' ')}`
  );
}

/** The step title, named here so `doctor` and the plan cannot drift apart on what this check is called. */
export const CSP_STEP_TITLE = 'Content-Security-Policy';

/**
 * The first blocking policy among the sources `init` already has in hand, or undefined.
 *
 * At most one finding: a second copy of the same policy in a second file is the same problem, and
 * two identical notices read as two problems.
 */
export function cspPlanProblem(
  sources: readonly (string | null | undefined)[],
  port: number,
): string | undefined {
  for (const source of sources) {
    if ('string' !== typeof source) continue;
    const problem = cspConnectSrcProblem(source, port);
    if (problem !== undefined) return problem;
  }
  return undefined;
}
