/**
 * `reticle mcp` — the process an editor launches, and the one whose failure a user experiences as
 * "the MCP server disconnected".
 *
 * Split out of `cli.ts` when that file passed the 1000-line backstop. It earns its own module rather
 * than being an arbitrary slice: everything here is about ONE decision — which daemon this agent
 * talks to for the rest of its life — and the port resolution at the top is the fix for agents on
 * different projects silently sharing one daemon, one identity and one blast radius.
 */

import { log } from '../log.js';
import { isAlive, spawnDaemon, reticleStateHome } from '../daemon/daemon.js';
import {
  PortPresence,
  probePresence,
  presenceIsUsable,
  describePresence,
} from '../daemon/port-presence.js';
import {
  waitForDaemon,
  startMcpProxy,
  probeDaemon,
  proxyLog,
  setProxyLogPort,
} from '../mcp/mcp-proxy.js';
import { installProxyResilience } from '../daemon/daemon-resilience.js';
import { readProjectId } from './cli-port.js';
import { resolveMcpPort, daemonProjectAt } from '../daemon/daemon-resolve.js';
import { daemonSpawnArgs } from './daemon-start-options.js';
import { WakeAction, decideWake } from '../daemon/wake-decision.js';
import { pickDaemonPortToBind } from '../daemon/free-port.js';
import { fetchStatus } from './cli-launch.js';
import { migrateApprovals } from '../setup/approval-migration.js';
import { ReticleEnv } from '@reticlehq/core';
import { agentIo } from '../setup/agent-io.js';
import { SERVER_VERSION } from '../version/server-version.js';
import { homedir } from 'node:os';
import type { PlatformPaths } from '../setup/agent-configs.js';

/**
 * MCP proxy mode: ensures the daemon is running, then bridges Claude Code's
 * stdin/stdout to the daemon's SSE endpoint. This is the recommended way to
 * configure Reticle in.mcp.json — users never need to manage the daemon manually.
 *
 * Pass --drive <url> to have the daemon launch its own Playwright browser at that
 * URL. The agent then has full autonomous control without relying on the user's browser.
 */
export async function handleMcp(opts: {
  port: number;
  driveUrl?: string;
  headless: boolean;
  http: boolean;
  httpPort?: number;
  httpToken?: string;
}): Promise<void> {
  const { driveUrl, headless, http, httpPort, httpToken } = opts;
  // Decided before anything else, because every line below is about ONE port and the wrong one means
  // serving another project's daemon. `resolveMcpPort` prefers our own daemon wherever it moved to,
  // takes the requested port when it is free or unclaimed, and relocates to an OS-assigned port
  // rather than adopting a daemon that belongs to somebody else.
  //
  // Synchronous-looking on purpose: a probe is one loopback connect, and doing it here keeps the
  // proxy's transport built around a single fixed number. Making the proxy chase a moving port would
  // mean reworking the reconnect path, which is the one piece whose failure reads to a user as
  // "the MCP server disappeared mid-session".
  // Read once and reused by the wake path below: the boot resolution and every later wake must be
  // defending the SAME identity, and computing it twice is how they drift apart.
  // Before the port work, because it is the only moment we are guaranteed to get on a machine that
  // installed Reticle before the pre-approval rules existed. Once per version, never a create that
  // supersedes an allowlist we cannot read, and it cannot throw: see approval-migration.
  // A sandboxed state dir means a test, a gate or a fixture, none of which are asking us to rewrite
  // the real user's editor configuration.
  if (undefined === process.env[ReticleEnv.STATE_DIR]) {
    migrateApprovals({
      io: agentIo,
      home: homedir(),
      platform: process.platform as keyof PlatformPaths,
      stateHome: reticleStateHome(),
      version: SERVER_VERSION,
      log,
    });
  }

  const projectId = readProjectId(process.cwd());
  const port = await resolveMcpPort(opts.port, projectId, reticleStateHome(), {
    alive: isAlive,
    daemonPresent: async (p: number): Promise<boolean> =>
      presenceIsUsable(await probePresence(p, { tcpOpen: probeDaemon, status: fetchStatus })),
    pickPort: (p: number): Promise<number> => pickDaemonPortToBind(p),
  });
  if (port !== opts.port) {
    log('reticle_mcp_port_relocated', {
      requested: opts.port,
      port,
      reason: 'the requested port serves a different project',
    });
  }
  // The proxy IS the MCP server the editor launched. Nothing respawns it, so an uncaught throw here
  // is what a user experiences as "the MCP server disconnected — open /mcp and reconnect". Log it,
  // report it, keep serving: the reconnect and dormant paths already know how to rebuild the only
  // state this process has. See installProxyResilience for why its rule inverts the daemon's.
  // The proxy's crash handlers must write to the proxy's LOG FILE, not just stderr. The editor
  // swallows stderr, so wiring these to `log` meant a crash was handled and then unrecorded — the
  // failure a user reports as "it disconnected" left nothing behind to read.
  setProxyLogPort(port);
  installProxyResilience(process, proxyLog);
  /**
   * Make sure a daemon is on the port, spawning one if not.
   *
   * Called on first start AND on every reconnect. The proxy used to only retry the socket, so a
   * daemon that exited — crashed, `reticle stop`, or self-shut-down as idle — meant the retries hit
   * a dead port until the budget ran out and the agent's MCP server exited with it. Reticle simply
   * disappeared mid-session with nothing said. Respawning here makes the reconnect self-healing.
   */
  const ensure = async (): Promise<void> => {
    // The same question every other surface asks. It used to be a bare TCP connect, so a stranger on
    // the bridge port answered "a daemon is here" — the proxy connected, the stream ended, and each
    // client request woke into the identical non-answer. Rejecting here is what puts the proxy
    // dormant with a reason, instead of pretending the wake succeeded.
    const presence = await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus });
    // Identity, not just presence. `resolveMcpPort` above already refuses to adopt a stranger's
    // daemon at boot; this is the same question asked on every WAKE, which is where it was missing.
    //
    // Reachable by ordinary use, with no error anywhere: a daemon retires on its idle timer and
    // frees the port, another project's daemon binds it, and this project's dormant proxy wakes
    // straight onto it. The agent then drives, asserts and reports a verdict about a DIFFERENT
    // APPLICATION. That is worse than the disconnect it was reintroduced under the cover of, because
    // a disconnect is visible and this is a false green wearing a valid session.
    const wake = decideWake(presence, daemonProjectAt(port, reticleStateHome()), projectId);
    if (WakeAction.USE === wake) return;
    if (WakeAction.REFUSE === wake) {
      throw new Error(
        PortPresence.DAEMON === presence
          ? `the daemon on port ${String(port)} belongs to a different project, so this one will ` +
              'not adopt it. Stop it, or start this project on its own port.'
          : describePresence(presence, port),
      );
    }
    const scriptPath = process.argv[1];
    if (scriptPath === undefined) {
      log('reticle_mcp_no_script', {});
      process.exit(1);
    }
    const daemonArgs = daemonSpawnArgs({
      port,
      headless,
      http,
      ...(driveUrl !== undefined ? { driveUrl } : {}),
      ...(httpPort !== undefined ? { httpPort } : {}),
      ...(httpToken !== undefined ? { httpToken } : {}),
    });
    spawnDaemon(process.execPath, scriptPath, daemonArgs, port);
    // Announce the daemon only once the PORT ACCEPTS. This line used to be written the instant the
    // child was spawned, which on a Windows first bootstrap meant `reticle_mcp_daemon_started`
    // followed about ten seconds later by `reticle_mcp_daemon_unavailable` and a first
    // `reticle_sessions` that expired. A readiness signal that precedes readiness is worse than
    // none: a client that believes it stops waiting for the thing that has not happened.
    await waitForDaemon(port);
    log('reticle_mcp_daemon_started', { port, ...(driveUrl !== undefined ? { driveUrl } : {}) });
  };
  // Start the proxy WHATEVER happened to the daemon.
  //
  // This used to exit(1) when `ensure` failed, which is the third way an MCP server disappears on a
  // user: something else is holding the bridge port — a foreign daemon from another project, a
  // half-dead process, a port a colleague's tool grabbed — the spawned daemon cannot bind, and the
  // editor shows a server that failed to start. Nothing about that is unrecoverable: the proxy
  // answers `initialize` itself, serves the cached catalog, and its wake path retries a daemon on
  // every client request. Present-and-complaining beats absent, because absent needs a human.
  // `void`: the chain handles its own failure and the process must not wait on it — the proxy is
  // started from `finally` either way.
  void ensure()
    .catch((err: unknown) => {
      log('reticle_mcp_daemon_unavailable', {
        error: err instanceof Error ? err.message : String(err),
        note: 'serving anyway — the next tool call will try to start a daemon again',
      });
    })
    .finally(() => {
      // Also `void`: the proxy runs for the life of the process and is never awaited by anyone.
      //
      // The `.catch` is load-bearing despite that. `startMcpProxy` rejects when its FIRST connect
      // fails — which is precisely the case this block exists to tolerate, a daemon that is not
      // there yet — and with nothing attached that reject became an unhandledRejection. Reported
      // from a win32 user as a crash reading `connect ECONNREFUSED` with an EMPTY frame list,
      // because the stack of a refused socket is entirely node internals and the privacy filter
      // keeps only Reticle frames. So the one path we most want diagnosable arrived as an anonymous
      // crash. The proxy itself is unaffected — it has already installed its stdin reader and goes
      // on serving from cache, waking a daemon on the next request — which is exactly why this
      // must be logged as the expected condition it is rather than reported as a defect.
      void startMcpProxy(port, ensure).catch((err: unknown) => {
        log('reticle_mcp_proxy_first_connect_failed', {
          port,
          error: err instanceof Error ? err.message : String(err),
          note: 'serving from cache; the next client request will try to start a daemon',
        });
      });
    });
}
