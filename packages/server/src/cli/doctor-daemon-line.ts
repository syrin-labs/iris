/**
 * What `doctor` says about the daemon it found — pure, so it can be tested without a socket.
 *
 * Doctor already stopped lying about the PORT: `probePresence` separates "a daemon is here" from "a
 * stranger holds it" from "nothing is listening", which was the load-bearing half of the report. It
 * still did not say WHICH daemon, though the `/status` payload it already fetches carries `version`
 * and `contract` and it discarded both.
 *
 * That is the gap worth closing, because skew is invisible everywhere else: a CLI and a daemon on
 * different contracts connect anyway and then disagree about behaviour, which reaches the agent as a
 * bare `-32000` naming no version at all. Doctor is the command a human runs at exactly that moment.
 *
 * Same split as `classifyPort`/`probePresence`: the rule lives here and is tested; the fetching stays
 * at the call site.
 */

import { describeSkew } from '../version/version-skew.js';
import { DoctorRow, doctorRow } from './doctor-rows.js';

/** The fields of `/status` this line cares about. Both optional — an old daemon reports neither. */
export interface DaemonIdentity {
  version?: string;
  contract?: string;
}

interface DaemonLine {
  /** The `daemon ✓ …` line itself. */
  text: string;
  /** A skew sentence to print underneath, when this CLI and that daemon disagree. */
  skew?: string;
}

/**
 * `reticle stop`, not `reticle kill`.
 *
 * The first version of this said `reticle kill`, which this CLI does not dispatch — it is a proposal
 * (#114), described as a gap in docs/system-map.md, and I read it there as if it shipped. A remedy
 * naming a command that errors is a second dead end handed to someone already stuck, on the one
 * command they run when they are confused.
 */
const FIX =
  'Restart it so both ends are the same build: `reticle stop`, then let your agent reconnect (it ' +
  'spawns a fresh daemon on the next tool call).';

/**
 * Build the daemon line for a port that answered `/status`.
 *
 * `pid` comes from the pid file and is genuinely optional — a daemon started by another user, or one
 * whose pid file was cleaned up, still answers. Printing `(pid null)` would be worse than printing
 * nothing, which is the same class of mistake as the port lie this command already fixed.
 */
export function daemonLine(
  port: number,
  pid: number | null,
  peer: DaemonIdentity,
  self: { version: string; contract: string },
): DaemonLine {
  const parts: string[] = [];
  if (null !== pid) parts.push(`pid ${String(pid)}`);
  if (peer.version !== undefined) parts.push(`v${peer.version}`);
  const detail = 0 === parts.length ? '' : ` (${parts.join(', ')})`;
  const skew = describeSkew(
    { what: 'the daemon on this port', version: peer.version, contract: peer.contract, fix: FIX },
    self,
  );
  const line: DaemonLine = {
    text: doctorRow(DoctorRow.DAEMON, `✓ running on :${String(port)}${detail}`),
  };
  return skew === undefined ? line : { ...line, skew };
}
