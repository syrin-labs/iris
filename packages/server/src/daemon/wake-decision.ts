/**
 * What a woken MCP proxy may do with whatever is sitting on its port.
 *
 * Pulled out as a pure function because the wake path lives inside a long side-effecting closure in
 * `mcp-command.ts`, and the decision it was getting wrong is three lines of reasoning that deserve a
 * test of their own.
 *
 * `resolveMcpPort` asks the identity question at BOOT and relocates rather than adopting a stranger.
 * The wake path asked only whether a daemon answered, so after an idle exit freed the port and
 * another project's daemon bound it, a dormant proxy could reattach to a daemon that was not its
 * own — and then serve an agent verdicts about a different application. `adoptable` is the same rule
 * boot uses; this is just the wake path finally asking it.
 */

import { PortPresence } from './port-presence.js';
import { adoptable } from './daemon-resolve.js';

export const WakeAction = {
  /** A daemon we may use is already here. */
  USE: 'use',
  /** Nothing is listening: start one. */
  SPAWN: 'spawn',
  /** Somebody else's. Go dormant with a reason rather than pretend the wake succeeded. */
  REFUSE: 'refuse',
} as const;
export type WakeAction = (typeof WakeAction)[keyof typeof WakeAction];

/**
 * Identity is asked only of a port that actually holds a daemon.
 *
 * A FREE port must stay spawnable whatever the registry says about it, because a stale entry is the
 * registry's ordinary state for the moment after any daemon exits — and refusing there would turn
 * every idle retirement into a permanent lockout, which is the failure this whole path exists to
 * prevent.
 */
export function decideWake(
  presence: PortPresence,
  daemonProjectId: string | undefined,
  callerProjectId: string | undefined,
): WakeAction {
  if (PortPresence.FREE === presence) return WakeAction.SPAWN;
  if (PortPresence.DAEMON !== presence) return WakeAction.REFUSE;
  return adoptable(daemonProjectId, callerProjectId) ? WakeAction.USE : WakeAction.REFUSE;
}
