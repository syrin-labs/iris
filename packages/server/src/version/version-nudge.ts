/**
 * Getting skew in front of the AGENT, on whatever tool it happens to be calling.
 *
 * Every check built before this reported into a place nobody looks: SDK skew landed in
 * `reticle_sessions.versionSkew`, which an agent driving a flow never calls, and daemon skew went to
 * a CLI log line no agent reads. So an agent could work an entire session against a mismatched pair,
 * watch tools behave oddly, and never be told the one fact that explains it.
 *
 * This is the delivery channel — the same one the update nudge uses, for the same reason: an
 * out-of-date install is worth mentioning whatever the agent is doing. It rides out on the next tool
 * result, then goes quiet until the skew CHANGES. Told, not nagged: a banner on every call is one an
 * agent learns to skip, and it would cost those tokens on every call for the rest of the session.
 */

import { EnvelopeKey } from '../tools/tool-kit.js';
import type { SkewPair } from './version-skew.js';

interface VersionSkewNudge {
  pair: SkewPair;
  action: string;
}

/** Pending per pair — the SDK and the daemon are different upgrades and each is worth saying once. */
const pending = new Map<SkewPair, string>();
/** The last message delivered for each pair, so the same skew is never repeated. */
const delivered = new Map<SkewPair, string>();

/**
 * Record a skew for delivery. Re-arms only when the message DIFFERS from the one already delivered:
 * a second tab on a third version is news; the same tab reconnecting is not.
 */
export function noteVersionSkew(pair: SkewPair, action: string): void {
  if (delivered.get(pair) === action) return;
  pending.set(pair, action);
}

/** The next undelivered skew, once. */
export function takeVersionSkew(): VersionSkewNudge | undefined {
  for (const [pair, action] of pending) {
    pending.delete(pair);
    delivered.set(pair, action);
    return { pair, action };
  }
  return undefined;
}

/**
 * Splice pending skew onto a tool-error payload.
 *
 * Successful calls already carry `version_skew` via `runTool`. Thrown errors never reached that
 * splice — they became a Playwright string plus `FEEDBACK_ASK`, so a caller debugs a CDP timeout
 * instead of the mismatched pair that caused it (#618). When the error was unrecognized, the
 * feedback ask is replaced: the skew IS the next move, and inviting a bug report about it is
 * backwards. A recognized recovery is kept; the envelope still rides along.
 */
export function takeVersionSkewOnto(payload: {
  error: string;
  recovery?: string;
  feedback?: string;
}): Record<string, unknown> {
  const skew = takeVersionSkew();
  if (skew === undefined) return payload;
  const { feedback, ...rest } = payload;
  return {
    ...rest,
    ...(feedback !== undefined && rest.recovery === undefined ? { recovery: skew.action } : {}),
    [EnvelopeKey.VERSION_SKEW]: skew,
  };
}

/** Tests only — drop the module state so each case starts clean. */
export function resetVersionSkew(): void {
  pending.clear();
  delivered.clear();
}
