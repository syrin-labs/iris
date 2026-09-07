/**
 * How another Reticle PROCESS announces itself to the daemon.
 *
 * The SDK announces in HELLO and the CLI reads /status, but the MCP server an agent spawns had no
 * announcement at all — and it is the piece the user actually hits: `npx @reticlehq/server mcp`
 * resolves from a cache, so an agent can be running a months-old MCP package against a current
 * daemon with nothing anywhere saying so.
 *
 * It rides the SSE connect the proxy already makes, as two query params. Query params rather than a
 * new message because the connection happens before any protocol exchange, and because an older
 * proxy that sends neither is handled correctly by describeSkew (absent contract + differing version
 * = a build that predates the field).
 */
import { CONTRACT_FINGERPRINT } from '@reticlehq/core';
import { SERVER_VERSION } from './server-version.js';
import { daemonFix, describeSkew, SkewPair } from './version-skew.js';
import { noteVersionSkew } from './version-nudge.js';

export const PEER_VERSION_PARAM = 'peerVersion';
export const PEER_CONTRACT_PARAM = 'peerContract';

/** Compare an attaching agent process against this daemon, and queue the nudge when they disagree. */
export function noteAgentPeer(version: string | null, contract: string | null): void {
  const skew = describeSkew(
    {
      what: "the agent's MCP server",
      version: version ?? undefined,
      contract: contract ?? undefined,
      // Inverted from cli-launch: here THIS process is the daemon and the peer is the agent's
      // MCP server, so the daemon is the newer half whenever the announcing agent is behind.
      fix: daemonFix(SERVER_VERSION, version ?? undefined),
    },
    { version: SERVER_VERSION, contract: CONTRACT_FINGERPRINT },
  );
  if (skew !== undefined) noteVersionSkew(SkewPair.DAEMON, skew);
}
