/**
 * Does this peer speak our contract? The daemon is the only thing that asks.
 *
 * Reticle is three separately-installed pieces — the SDK in the page, this daemon, and the MCP
 * server the agent spawns — upgraded independently and therefore drifting constantly. Each pair
 * fails the same silent way: `protocolVersion` still matches, the connection succeeds, and only
 * BEHAVIOUR disagrees. A user hit exactly that with a 2.2.1 SDK against a 2.3.0 daemon and saw a
 * bare `-32000` with nothing on either side naming a version.
 *
 * Two decisions shape this file.
 *
 * The daemon is the SINGLE judge. Every piece announces itself at a connect it already makes — the
 * SDK in HELLO, the CLI and the MCP server over /status — and comparing happens here, once. Three
 * independent pairwise checks would be three copies to keep in step and three separate complaints
 * about one upgrade; a table in one place can say what is actually true: which pieces disagree, and
 * which one is behind.
 *
 * The signal is the CONTRACT FINGERPRINT, not the version. Version equality is wrong in both
 * directions: it fires on 2.4.0-vs-2.4.1 where nothing changed — so every patch release makes every
 * un-upgraded app cry wolf, and the warning becomes noise — and it cannot fire at all for two
 * different BUILDS of one version number, which is exactly what a stale daemon and a cached npx
 * install are. The fingerprint is derived from core's wire vocabulary, so it moves when a name on
 * the wire changes and stays put when internals do. Versions still ride along, because they are what
 * a human acts on.
 */

import { resolveSdkFix } from './sdk-fix.js';

/** Which pair disagreed. Named so the nudge can report each independently. */
export const SkewPair = {
  /** The SDK in the page vs this daemon. */
  SDK: 'sdk',
  /** Another Reticle process — a CLI, or the MCP server an agent spawned — vs this daemon. */
  DAEMON: 'daemon',
} as const;
export type SkewPair = (typeof SkewPair)[keyof typeof SkewPair];

/** What a piece says about itself when it connects. */
export interface PeerIdentity {
  /** Human-readable subject for the message: "the page", "the daemon on this port". */
  what: string;
  /** Package version, when the peer supplied one. Undefined on a hand-wired connect. */
  version: string | undefined;
  /** Contract fingerprint. Undefined means the peer predates the field — itself evidence of age. */
  contract: string | undefined;
  /** What the human runs to bring this piece into line. */
  fix: string;
}

/** Everything a build knows about itself. */
interface SelfIdentity {
  version: string;
  contract: string;
}

function versionPhrase(peer: PeerIdentity, self: SelfIdentity): string {
  return peer.version === undefined
    ? `${peer.what} is on an unknown version; this daemon is ${self.version}`
    : `${peer.what} is ${peer.version}; this daemon is ${self.version}`;
}

/**
 * The one sentence to tell the agent, or undefined when the pair agrees.
 *
 * Silent when the fingerprints MATCH, whatever the versions say — that is the point: a patch bump
 * that changed no wire name is not skew, and warning about it is how a real warning gets ignored.
 *
 * A peer with no fingerprint is treated as skewed ONLY when its version also differs from ours: the
 * field is absent exactly on builds that predate it, so "no fingerprint AND a different version" is
 * a build provably older than this daemon. With neither signal there is nothing to go on, and
 * inventing a warning would be as dishonest as staying silent about a real one.
 */
export function describeSkew(peer: PeerIdentity, self: SelfIdentity): string | undefined {
  if (peer.contract !== undefined && peer.contract === self.contract) return undefined;
  if (peer.contract === undefined) {
    if (peer.version === undefined || peer.version === self.version) return undefined;
    return (
      `version skew: ${versionPhrase(peer, self)}, and it is too old to report which wire contract ` +
      `it speaks. They connect anyway and then disagree about behaviour, which usually surfaces as ` +
      `a bare -32000 with nothing naming a version. ${peer.fix}`
    );
  }
  return (
    `version skew: ${versionPhrase(peer, self)}, and they speak DIFFERENT wire contracts ` +
    `(${peer.contract} vs ${self.contract}) — so this is a real mismatch, not a harmless patch ` +
    `difference. Tools will behave in ways neither side reports. ${peer.fix}`
  );
}

/**
 * The fix line for a page whose SDK disagrees with this daemon, with no project to read.
 *
 * Names the framework-neutral sensor and plain npm, because those are the answers that are never
 * actively wrong. When a project directory IS available, `resolveSdkFix` / `sdkFixForDirectory`
 * in sdk-fix.ts read the real packages and package manager — this used to hardcode
 * `@reticlehq/react` and told Vue projects to install a React package (#618).
 */
export function sdkFix(daemonVersion: string): string {
  return resolveSdkFix(daemonVersion);
}

/**
 * Compare two of our own version strings. Numeric dotted compare, prerelease tags ignored: both
 * sides are Reticle package versions, so this never sees a range or build metadata. Undefined when
 * either side does not parse, so the caller can decline to guess a direction.
 */
function compareVersions(a: string | undefined, b: string): number | undefined {
  const parts = (v: string): number[] | undefined => {
    const head = v.split('-')[0];
    if (head === undefined) return undefined;
    const nums = head.split('.').map((n) => parseInt(n, 10));
    return nums.some(isNaN) ? undefined : nums;
  };
  if (a === undefined) return undefined;
  const left = parts(a);
  const right = parts(b);
  if (left === undefined || right === undefined) return undefined;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (0 !== diff) return diff;
  }
  return 0;
}

/**
 * The fix line for another Reticle process that disagrees with the daemon it attached to.
 *
 * Branches on DIRECTION, which the old unconditional `reticle stop` did not (#618). Restarting the
 * daemon converges the pair only when the daemon is the OLDER half. When the daemon is newer — the
 * common case, because the MCP registration is deliberately unpinned and so resolves fresh while a
 * long-lived daemon does not — `reticle stop` starts another newer daemon and leaves the same two
 * contract hashes with the roles unchanged. Nothing the agent can do converges that, so say so and
 * ask for the one thing that does, exactly as the SDK branch already does when the page is stale.
 *
 * Both versions are named by ROLE, not by which side is calling: this is read from both ends — a
 * CLI judging the daemon it attached to, and the daemon judging an agent that announced itself —
 * and the advice depends on which piece is behind, not on who noticed.
 */
export function daemonFix(
  daemonVersion: string | undefined,
  agentVersion: string | undefined,
): string {
  const order =
    agentVersion === undefined ? undefined : compareVersions(daemonVersion, agentVersion);
  if (order !== undefined && order > 0) {
    return (
      'The daemon is NEWER than this process, so `reticle stop` will not converge them — it would ' +
      'replace it with another newer daemon and leave the same mismatch. Tell the human to restart ' +
      'the agent so it spawns a current MCP server (or update the package it spawns), then retry.'
    );
  }
  return (
    'A daemon outlives the agents attached to it, so it keeps serving its OWN code until it restarts ' +
    '— anything fixed in the newer package is simply absent. Run `reticle stop` and retry to replace ' +
    'it (other agents on that daemon will need to reconnect).'
  );
}

/**
 * Playwright wording when a CDP call cannot bind to the page.
 *
 * Under SDK/daemon version skew this text is a LIE: the page is still connected (DOM tools work),
 * and the agent spends turns re-acquiring leases and asking a human to sign into a fresh profile
 * (#688). Matched only so we can replace it with the skew sentence already on the session.
 */
const PLAYWRIGHT_CLOSED_ERROR =
  /target (?:page|context|browser) has been closed|browser has been closed|browser has disconnected/i;

/** True when `error` is Playwright's closed-target class — not proof the tab is gone. */
export function isPlaywrightClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return PLAYWRIGHT_CLOSED_ERROR.test(message);
}

/**
 * Replace a closed-target throw with the session's skew sentence when we already know the pair is
 * mismatched. Undefined when there is no skew to name, or the throw is something else.
 */
export function rewriteClosedAsSkew(error: unknown, skew: string | undefined): Error | undefined {
  if (skew === undefined || !isPlaywrightClosedError(error)) return undefined;
  return new Error(skew);
}
