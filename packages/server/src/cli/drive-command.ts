/**
 * The `reticle drive <url>` command: decide who gets the bridge port, then do the right thing.
 *
 * Lifted out of cli.ts as one unit — the decision, the attach, and the bind are three answers to a
 * single question and reading one without the others is how the port fight got shipped in the first
 * place. The pure parts (which mode, and every sentence a user reads) live next door in
 * drive-attach.ts, which is where the reasoning for attaching is written down.
 */

import { start, type StartOptions } from '../index.js';
import { log } from '../log.js';
import { probePresence, describePresence } from '../daemon/port-presence.js';
import { probeDaemon } from '../mcp/mcp-proxy.js';
import { readPid } from '../daemon/daemon.js';
import { fetchStatus } from './cli-launch.js';
import { captureLookup, findPortHolder } from './port-holder.js';
import {
  DriveMode,
  decideDriveMode,
  describeAttached,
  driveForeignHolder,
  driveHeadlessOnAttach,
  driveRaceLost,
  requestDriveSession,
} from './drive-attach.js';

export function handleDrive(parsed: { port: number; driveUrl: string; headless: boolean }): void {
  void driveWithHonestConflict(parsed);
}

/**
 * Decide who gets the port BEFORE binding it — and when the answer is "the daemon", ask it instead.
 *
 * `drive` went straight to `start`, which binds. The listen error surfaces asynchronously on the
 * server object long after `start` has resolved, so the `.catch` on that promise could never see it
 * and the process died with the raw `node:net` EADDRINUSE stack — in the one situation this command
 * is most often run in, since `reticle_sessions` recommends `reticle drive` for a throttled tab and
 * a throttled tab nearly always coexists with the daemon holding the port. Refusing politely was
 * only half a fix: the way out it named (`reticle stop`, then retry) is a race the user loses,
 * because the MCP proxy respawns a daemon into the gap. So a healthy daemon is now ATTACHED to —
 * see cli/drive-attach.ts.
 */
async function driveWithHonestConflict(parsed: {
  port: number;
  driveUrl: string;
  headless: boolean;
}): Promise<void> {
  const presence = await probePresence(parsed.port, { tcpOpen: probeDaemon, status: fetchStatus });
  const mode = decideDriveMode(presence);
  if (DriveMode.REFUSE === mode) {
    const reason = driveForeignHolder(
      describePresence(presence, parsed.port, {
        ourPid: readPid(parsed.port),
        holderPid: findPortHolder(parsed.port, captureLookup)?.pid,
      }),
    );
    log('reticle_drive_port_conflict', { port: parsed.port, presence, reason });
    process.stderr.write(`${reason}\n`);
    process.exit(1);
    return;
  }
  if (DriveMode.ATTACH === mode) {
    await attachToRunningDaemon(parsed.port, parsed.driveUrl, parsed.headless);
    return;
  }
  // The probe cannot close the race: something can take the port between here and the bind, and the
  // bind reports it on the server, outside every promise this function holds. Catching it at the
  // process is the only place that sees it at all — and only EADDRINUSE, so a genuine crash still
  // crashes rather than being dressed up as a port conflict.
  process.on('uncaughtException', (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if ('EADDRINUSE' !== code) throw error;
    const reason = driveRaceLost(parsed.port, parsed.driveUrl);
    log('reticle_drive_port_race_lost', { port: parsed.port, reason });
    process.stderr.write(`${reason}\n`);
    process.exit(1);
  });
  const options: StartOptions = {
    port: parsed.port,
    driveUrl: parsed.driveUrl,
    headless: parsed.headless,
  };
  try {
    await start(options);
    log('reticle_started', { port: parsed.port });
  } catch (error: unknown) {
    log('reticle_start_failed', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}

/**
 * Drive through the daemon that already owns the port.
 *
 * Exits once the session exists rather than holding the foreground: the thing the caller needs is
 * the sessionId, the session belongs to the daemon (it outlives this process, and any tool call
 * against it renews its lease), and a foreground hold here could only keep it alive by faking tool
 * calls at it.
 */
async function attachToRunningDaemon(port: number, url: string, headless: boolean): Promise<void> {
  const result = await requestDriveSession(port, url);
  if (!result.ok) {
    log('reticle_drive_attach_failed', { port, url, reason: result.reason });
    process.stderr.write(`${result.reason}\n`);
    process.exit(1);
    return;
  }
  log('reticle_drive_attached', {
    port,
    url,
    sessionId: result.session.sessionId,
    ready: result.session.ready,
  });
  process.stderr.write(`${describeAttached(port, url, result.session)}\n`);
  // The command's own default is headed, and this path cannot deliver that. Said out loud rather
  // than left for the user to discover by watching a window that never opens.
  if (!headless) process.stderr.write(`${driveHeadlessOnAttach(port, url)}\n`);
  // A tab that never connected is not a drive session, and reporting one is the false green this
  // command exists to avoid.
  if (!result.session.ready) process.exit(1);
}
