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

/**
 * What this policy allows a SCRIPT to be — `script-src`, or `default-src` when it is absent.
 *
 * Same fallback and same reason as {@link connectSrcSources}: every fetch-directive falls back to
 * `default-src`, which is why an author writing `default-src 'self'` does not repeat themselves.
 */
function scriptSrcSources(text: string): string[] | undefined {
  return directiveSources(text, 'script-src') ?? directiveSources(text, 'default-src');
}

/**
 * Would this policy stop the pasted connect snippet from RUNNING?
 *
 * The `connect-src` check above assumes the SDK got as far as opening a socket. Under a policy
 * without `'unsafe-inline'` it never does: the snippet `init` prints is an inline
 * `<script type="module">`, the browser refuses to execute it, and there is no SDK, no socket and
 * nothing for `connect-src` to block. `reticle open` then reports "no session / app carries no SDK",
 * which sends diagnosis at the wrong cause entirely (#679).
 *
 * The rule is the spec's, not a guess:
 *
 * - `'unsafe-inline'` is the ONLY source that admits an inline script. `*` does not — a host
 *   wildcard says nothing about inline code, and reading it as permission is the commonest CSP
 *   misconception there is.
 * - a nonce, a hash, or `'strict-dynamic'` makes browsers IGNORE `'unsafe-inline'` entirely. A
 *   policy carrying both is a policy that blocks inline scripts, and one carrying a nonce blocks
 *   ours specifically: the nonce is minted for the app's own tags, not for a snippet pasted in by
 *   hand.
 */
function blocksInlineScript(sources: readonly string[]): boolean {
  const overridesUnsafeInline = sources.some(
    (source) =>
      source.startsWith("'nonce-") || source.startsWith("'sha") || "'strict-dynamic'" === source,
  );
  if (overridesUnsafeInline) return true;
  return !sources.includes("'unsafe-inline'");
}

/**
 * The problem with this app's `script-src`, or undefined if there is not one.
 *
 * Reports the remedy that works under `'self'` — serve the connect code as an external module file —
 * rather than telling anyone to weaken their policy with `'unsafe-inline'`.
 */
export function cspInlineScriptProblem(text: string, port: number): string | undefined {
  const sources = scriptSrcSources(text);
  if (sources === undefined || 0 === sources.length) return undefined;
  if (!blocksInlineScript(sources)) return undefined;
  return (
    `this app declares a Content-Security-Policy whose \`script-src\` does not admit an inline ` +
    `script, so the connect snippet never executes. Nothing on the Reticle side can see this: with ` +
    `no SDK there is no socket, and \`reticle open\` reports "no session / app carries no SDK" — ` +
    `the wrong cause. ${externalScriptRemedy()} ${devCspAddition(port)}`
  );
}

/** Where the external connect module goes, for an app served from a static directory. */
export const EXTERNAL_CONNECT_PATH = 'public/reticle-connect.js';

/** The remedy that works under `script-src 'self'`, as text to copy. */
export function externalScriptRemedy(): string {
  return (
    `Serve the connect code as an EXTERNAL module instead: put it in ` +
    `\`${EXTERNAL_CONNECT_PATH}\` and reference it with ` +
    `\`<script type="module" src="/reticle-connect.js"></script>\`, which \`script-src 'self'\` ` +
    `already allows. Note that an external module is DEFERRED, so the app's own classic scripts run ` +
    `first and requests they fire before the SDK attaches are not observed.`
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
