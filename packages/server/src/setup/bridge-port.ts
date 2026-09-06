/**
 * The bridge port, checked before the connect wait.
 *
 * The bridge is the channel between the daemon and the SDK in the page. While something else holds
 * that port no session can ever appear, however correct the instrumentation is — so a run that goes
 * ahead spends its entire connect budget and then reports what looks like a wiring problem, sending
 * the reader to the one place that is fine.
 *
 * `serve` refuses a held port too, in prose written for somebody starting a daemon. This is the same
 * fact told to somebody installing, and it has to say what the bridge IS: that sentence is what
 * makes "no session appeared" mean something.
 */
import { PortPresence } from '../daemon/port-presence.js';

/** The refusal to print, or undefined when the port is usable. */
export function bridgeOccupied(presence: PortPresence, port: number): string | undefined {
  // DAEMON is the ordinary case — that is the daemon init is about to use. FREE is fine too: one
  // gets started. Only a stranger is fatal.
  if (PortPresence.FOREIGN !== presence) return undefined;
  return (
    `port ${String(port)} is held by something that is not a Reticle daemon. That is the bridge — ` +
    'the channel between the daemon and the SDK in your page — so no session can ever appear while ' +
    'it is occupied, however correct the wiring is. Free it, or re-run with --port <n> and set the ' +
    'same port in .reticle.json.'
  );
}
