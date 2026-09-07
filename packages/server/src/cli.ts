#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { openFailureNote } from './cli/open-note.js';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirProblem } from './daemon/state-dir.js';
import { statusNextAction } from './cli/status-next-action.js';
import { readDevServers } from './daemon/dev-servers.js';
import { hasConnectedBefore, hasProjectConnectedBefore } from './session/connection-memory.js';
import { attachStatusFields } from './mcp/attach-memory.js';
import { reticleStateHome } from './daemon/daemon.js';
import { handleMcp } from './cli/mcp-command.js';
import { daemonSpawnArgs, daemonStartOptions } from './cli/daemon-start-options.js';
import {
  daemonsServingProjectElsewhere,
  resolveDaemonForProject,
  splitBrainNote,
  wrongDaemonNote,
} from './daemon/daemon-resolve.js';
import {
  handleWatch,
  handleCapsules,
  handleGate,
  loadNamedFlows,
  resolveChangedFiles,
} from './cli/cli-flow-commands.js';
import {
  RETICLE_DEFAULT_PORT,
  ReticleDir,
  ReticleEnv,
  devServersForProject,
} from '@reticlehq/core';
import { loadDotEnv } from './telemetry/dev-repo.js';
import { licenseKeyFromEnvFiles } from './license/license-env.js';
import { LICENSE_KEY_ENV } from './license/license.js';
import { createNodeFileSystem } from './project/fs-port.js';
import { affectedSavedFlows } from './flows/flow-sources.js';

import { availableUpdate } from './update/update-nudge.js';
import { handleUpdate, handleRollback } from './cli/cli-update-commands.js';

import { startDaemon, RETICLE_VERIFY_DEFAULT_PORT } from './index.js';
import { verifyEndpointMismatch } from './status-payload.js';
import { isCloudCommand, runCloudCommand } from './cli/cloud-cli.js';
import { SERVER_VERSION } from './version/server-version.js';
import { log } from './log.js';
import {
  readPid,
  isAlive,
  removePid,
  spawnDaemon,
  discoverDaemonPort,
  writeDaemonRegistry,
  logPath,
} from './daemon/daemon.js';
import {
  PortPresence,
  probePresence,
  presenceIsUsable,
  describePresence,
} from './daemon/port-presence.js';
import { waitForDaemon, probeDaemon } from './mcp/mcp-proxy.js';
import {
  installDaemonResilience,
  recordExitReason,
  DaemonExitReason,
} from './daemon/daemon-resilience.js';
import { IdleShutdown, resolveIdleShutdownMs, resolveIdleCheckMs } from './daemon/idle-shutdown.js';
import { DaemonHeartbeat, resolveHeartbeatMs } from './daemon/heartbeat.js';
import { everServedToolCall } from './daemon/daemon-usefulness.js';
import { DAEMON_START_FAILED_EVENT, readDaemonStartupCause } from './daemon/startup-failure.js';
import {
  fetchStatus,
  summarizeStatus,
  warnOnDaemonSkew,
  decideOpen,
  openInBrowser,
  openCommand,
} from './cli/cli-launch.js';
import { handleDrive } from './cli/drive-command.js';
import { handleVerify } from './cli/cli-verify.js';
import { runKill } from './cli/cli-kill.js';
import { summarizeHunt, type HuntAnomaly, type HuntRun } from './hunt/hunt-report.js';
import { runInit } from './init/run.js';
import { continueAfterInit } from './setup/init-runtime.js';
import { handleDoctor } from './cli/cli-doctor.js';
import { buildNodeIo } from './init/node-io.js';
import { describeLicense } from './license/license.js';
import {
  isLikelyDevServerPort,
  devServerPortWarning,
  readProjectPort,
  readProjectId,
} from './cli/cli-port.js';
import type { StartOptions } from './index.js';

import { DAEMON_INNER_COMMAND, PORT_FLAG, parseCliArgs, CLI_USAGE } from './cli/cli-parse.js';
import { handleFeedback, handleIdentify, handleTelemetry } from './telemetry/feedback-cli.js';
import { installDaemonTelemetry } from './telemetry/daemon-telemetry.js';
import { reportCliRun } from './telemetry/cli-telemetry.js';

// Re-exported so existing imports (and the CLI tests) keep resolving from './cli.js'.
export { parseCliArgs, CLI_USAGE };
export type { CliResult } from './cli/cli-parse.js';

function handleInit(parsed: {
  port: number | undefined;
  mcp: boolean;
  dryRun: boolean;
  install: boolean;
  app?: string | undefined;
  flow?: string | undefined;
  env?: string[] | undefined;
  filesOnly?: boolean | undefined;
  captureBodies?: boolean | undefined;
  licenseKey?: string | undefined;
  json?: boolean | undefined;
  drive?: boolean | undefined;
  open?: boolean | undefined;
  agents?: boolean | undefined;
  url?: string | undefined;
  timeoutSeconds?: number | undefined;
  driveModel?: string | undefined;
}): void {
  const cwd = process.cwd();
  const io = buildNodeIo(cwd);
  const result = runInit(
    {
      cwd,
      port: parsed.port,
      mcp: parsed.mcp,
      dryRun: parsed.dryRun,
      install: parsed.install,
      ...(parsed.app === undefined ? {} : { app: parsed.app }),
      captureBodies: true === parsed.captureBodies,
      // The outcome is reported by confirmInstall instead, once it knows whether an app connected —
      // `init` writing files was never the same thing as `init` working (#269).
      deferOutcome: true,
      continuesToRuntime: true !== parsed.filesOnly && true !== parsed.dryRun,
    },
    io,
  );
  void continueAfterInit(parsed, result, io, cwd);
}

function handleServe(parsed: {
  port: number;
  driveUrl?: string;
  headless: boolean;
  http: boolean;
  httpPort?: number;
  httpToken?: string;
}): void {
  void serveWithHonestExit(parsed);
}

/**
 * Report the BIND, not the spawn.
 *
 * `serve` used to log `reticle_daemon_spawned` and exit 0 unconditionally, while the child died at
 * `reticle_daemon_start_failed` with an EADDRINUSE nothing joined back to the parent. Three surfaces
 * then disagreed about what was true and none of them named the port.
 *
 * Two changes, both about saying what is actually the case: refuse up front when the port is held by
 * something that is not a Reticle daemon (a spawn there cannot succeed), and after spawning, wait
 * for the daemon to actually answer before claiming it started.
 */
async function serveWithHonestExit(parsed: {
  port: number;
  driveUrl?: string;
  headless: boolean;
  http: boolean;
  httpPort?: number;
  httpToken?: string;
}): Promise<void> {
  const presence = await probePresence(parsed.port, {
    tcpOpen: probeDaemon,
    status: fetchStatus,
  });
  if (presence === PortPresence.DAEMON) {
    // A daemon that is already up was started with ITS flags, not these — `serve` only attaches.
    // Exiting 0 here regardless is how `--http-port` came to be accepted and ignored (#687): the
    // running daemon kept serving whatever it was started with, and the flag vanished without a
    // word. Ask the daemon which verify port it actually serves and refuse when it is not the one
    // requested — a flag that cannot be honoured must say so, not report success.
    if (parsed.http) {
      const mismatch = verifyEndpointMismatch(
        await fetchStatus(parsed.port),
        parsed.httpPort ?? RETICLE_VERIFY_DEFAULT_PORT,
      );
      if (mismatch !== undefined) {
        log('reticle_daemon_start_refused', { port: parsed.port, reason: mismatch });
        process.stderr.write(`${mismatch}\n`);
        process.exit(1);
        return;
      }
    }
    log('reticle_daemon_already_running', { port: parsed.port });
    return;
  }
  if (presence === PortPresence.FOREIGN) {
    log('reticle_daemon_start_refused', {
      port: parsed.port,
      presence,
      reason: describePresence(presence, parsed.port),
    });
    process.stderr.write(`${describePresence(presence, parsed.port)}\n`);
    process.exit(1);
    return;
  }
  const scriptPath = process.argv[1];
  if (scriptPath === undefined) {
    log('reticle_serve_no_script', {});
    process.exit(1);
    return;
  }
  const daemonArgs = daemonSpawnArgs(parsed);
  const startupStartedAt = Date.now();
  spawnDaemon(process.execPath, scriptPath, daemonArgs, parsed.port);
  // The child binds asynchronously and, when it cannot, exits 1 long after this process would have
  // reported success. Wait for it to ANSWER — `/status` responding is the only evidence a daemon
  // exists that does not come from the pid file the child may never have earned.
  const bound = await waitForPresence(parsed.port, PortPresence.DAEMON, SERVE_BIND_TIMEOUT_MS);
  if (!bound) {
    const settled = await probePresence(parsed.port, { tcpOpen: probeDaemon, status: fetchStatus });
    const startupCause = readDaemonStartupCause(logPath(parsed.port), startupStartedAt);
    log('reticle_daemon_start_failed_parent', {
      port: parsed.port,
      presence: settled,
      reason: describePresence(settled, parsed.port),
      log: logPath(parsed.port),
      stateDir: stateDirProblem(reticleStateHome()) === undefined ? 'writable' : 'unwritable',
      ...(startupCause === undefined ? {} : { cause: startupCause }),
    });
    // Name the CAUSE when we can see it. An unwritable state directory is a first-run failure mode
    // (locked-down home, read-only container mount, managed profile) that produced only "nothing is
    // listening" — the symptom restated — and then pointed at a log INSIDE that directory, which
    // cannot exist. Found by stress-testing 2.6.0 with `chmod 555 ~/.reticle`.
    const dirProblem = stateDirProblem(reticleStateHome());
    process.stderr.write(
      dirProblem === undefined
        ? startupCause === undefined
          ? `the daemon did not come up on :${String(parsed.port)} — ${describePresence(settled, parsed.port)}\n` +
            `see ${logPath(parsed.port)}\n`
          : `the daemon did not come up on :${String(parsed.port)}.\n${startupCause}\n` +
            `see ${logPath(parsed.port)}\n`
        : `the daemon did not come up on :${String(parsed.port)}.\n${dirProblem}\n`,
    );
    process.exit(1);
    return;
  }
  log('reticle_daemon_spawned', { port: parsed.port, ...(parsed.http ? { http: true } : {}) });
}

/** How long `serve` waits for the child to bind. Generous: a cold daemon start is seconds. */
const SERVE_BIND_TIMEOUT_MS = 15_000;
const PRESENCE_POLL_MS = 150;

/** How long a daemon gets to shut down on its own before `stop` stops asking politely. */
const GRACEFUL_STOP_MS = 5000;
/** How long after SIGKILL before we accept the process is not ours to kill and say so. */
const FORCED_STOP_MS = 2000;

async function waitForPresence(
  port: number,
  want: PortPresence,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const presence = await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus });
    if (presence === want) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, PRESENCE_POLL_MS));
  }
}

function handleStop(port: number, quiet: boolean): void {
  const pid = readPid(port);
  if (null === pid || !isAlive(pid)) {
    removePid(port);
    if (!quiet) log('reticle_daemon_not_running', { port });
    return;
  }
  process.kill(pid, 'SIGTERM');
  const started = Date.now();
  let escalated = false;
  const poll = setInterval(() => {
    if (!isAlive(pid)) {
      clearInterval(poll);
      removePid(port);
      if (!quiet) log('reticle_daemon_stopped', { port, pid, ...(escalated ? { escalated } : {}) });
      return;
    }
    const waited = Date.now() - started;
    // A daemon that ignores SIGTERM is WEDGED — which is the one situation `stop` exists for. Giving
    // up here left the port held, the pid file stale, and a human running `kill -9` by hand at the
    // first two minutes of setup. Escalate instead: graceful first, then unconditional.
    if (!escalated && waited > GRACEFUL_STOP_MS) {
      escalated = true;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone between the liveness check and here — the next tick reports it stopped.
      }
      return;
    }
    if (waited > GRACEFUL_STOP_MS + FORCED_STOP_MS) {
      clearInterval(poll);
      // Surviving SIGKILL means the pid is not ours to kill (permissions) or is an unkillable
      // zombie. Neither is retryable, and both need the pid named so a human can act on it.
      if (!quiet) log('reticle_daemon_stop_timeout', { port, pid, escalated });
      process.exit(1);
    }
  }, 100);
}

/**
 * `reticle restart` — free the port, then put a daemon back on it and prove it bound.
 *
 * The two halves are reported separately on purpose. A restart that killed the old daemon and then
 * could not start a new one leaves the user in a different place from one that could not kill
 * anything at all, and a single `ok: false` cannot tell them which happened.
 */
async function handleRestart(port: number, force: boolean): Promise<void> {
  const freed = await runKill(port, force);
  if (!freed) {
    log('reticle_restart_aborted', {
      port,
      reason: 'the port was not freed, so nothing was started — the old holder is still there',
    });
    process.exit(1);
    return;
  }
  // Reuses `serve`'s path, which waits for the daemon to ANSWER before claiming it started and exits
  // non-zero when it does not. A restart that reports success for a daemon that never bound is the
  // same lie `serve` already stopped telling.
  await serveWithHonestExit({ port, headless: true, http: false });
}

/** `{ nextAction }` when there is one, `{}` when a session is connected — so the success case is silent. */
function withNextAction(facts: {
  running: boolean;
  sessionCount: number;
  previouslyConnected: boolean;
  initialized: boolean;
  devServerPorts?: readonly number[];
}): { nextAction?: string } {
  const next = statusNextAction(facts);
  return next === undefined ? {} : { nextAction: next };
}

/**
 * What `status` says about a project whose daemons have split in two.
 *
 * Both halves in one place because they are one condition asked from two positions, and a command
 * can be standing on either. Silent — no key at all — when there is nothing to report, so a healthy
 * run reads exactly as it did.
 */
function splitBrainFields(port: number, projectId: string | undefined): { splitBrain?: string } {
  const home = reticleStateHome();
  const elsewhere = splitBrainNote(
    port,
    daemonsServingProjectElsewhere(projectId, port, home, isAlive, (other) =>
      hasProjectConnectedBefore(home, other, projectId),
    ),
  );
  const note =
    elsewhere ?? wrongDaemonNote(port, resolveDaemonForProject(projectId, home, isAlive));
  return note === undefined ? {} : { splitBrain: note };
}

export async function handleStatus(port: number): Promise<void> {
  const pid = readPid(port);
  // Durable, so it survives the daemon idling out — which is the state `status` is most often run in.
  const projectId = readProjectId(process.cwd());
  const previouslyConnected = hasConnectedBefore(reticleStateHome(), port, projectId);
  // Whether `init` has run HERE. Registering the MCP server does not wire the app, and more than one
  // path does the first without the second — so this is the commonest reason `status` has nothing to
  // report, and it was not among the facts this command could state.
  const initialized = projectId !== undefined;
  // The OTHER half of the install, and the half this command could not see. A host that registers
  // Reticle and never lists its tools looks exactly like an abandoned install from here — same idle
  // daemon, same zero sessions — and the user sees a tool that does nothing. See attach-memory.ts.
  const client = attachStatusFields(reticleStateHome(), port);
  // What the dev servers themselves said. The reason this command could previously only guess at
  // whether the app was running is that it had no way to see one; now the ones carrying Reticle
  // announce, and the advice below stops contradicting the terminal the reader is looking at.
  // Scoped to THIS project: the registry is machine-wide, and an unrelated app's dev server must
  // not make this project look like it is running.
  const devServerPorts = devServersForProject(readDevServers(reticleStateHome()), {
    projectId,
    root: process.cwd(),
  }).map((d) => d.port);
  // The failure where every individual check is green and the chain is broken: the agent's proxy and
  // the app resolved their ports independently and landed on two different daemons. Reported from
  // BOTH stances, because neither one can see it alone.
  const split = splitBrainFields(port, projectId);
  // Doctor and status must answer the same liveness question. A live pid only says that some
  // process exists; a Reticle daemon is running only when the shared port probe reaches /status.
  const presence = await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus });
  if (!presenceIsUsable(presence)) {
    log('reticle_status', {
      port,
      running: false,
      presence,
      ...(presence === PortPresence.FOREIGN ? { reason: describePresence(presence, port) } : {}),
      // `init` promises this command says why the app has not connected. Without it the answer was
      // `running: false` and nothing else, which reads as "Reticle is broken" for what is usually
      // just a daemon that has not been asked to do anything yet.
      ...withNextAction({
        running: false,
        sessionCount: 0,
        previouslyConnected,
        initialized,
        devServerPorts,
      }),
      ...client,
      ...split,
    });
    return;
  }
  // The daemon answered the same probe doctor trusts — ask it for live sessions + health.
  const payload = await fetchStatus(port);
  // `status` is the second-most-run command and the one a HUMAN types. The update nudge otherwise
  // only rides a tool result, which the majority of daemons never produce — so the people most in
  // need of an upgrade were the ones with no path to hearing about it.
  const update = availableUpdate();
  const nudge = update === undefined ? {} : { updateAvailable: update };
  if (payload === undefined) {
    log('reticle_status', {
      port,
      running: true,
      pid,
      ...nudge,
      ...withNextAction({
        running: true,
        sessionCount: 0,
        previouslyConnected,
        initialized,
        devServerPorts,
      }),
      ...client,
      ...split,
    });
    return;
  }
  const summary = summarizeStatus(payload);
  // Only when the daemon did NOT already explain itself. It has the whole diagnosis in-process and
  // puts it on the wire as `why`; printing a second, thinner opinion beside it risks two confident
  // answers pointing different ways, which is worse than one.
  const next =
    summary.why === undefined
      ? withNextAction({
          running: true,
          ...summary,
          previouslyConnected,
          initialized,
          devServerPorts,
        })
      : {};
  log('reticle_status', {
    port,
    running: true,
    pid,
    ...summary,
    ...next,
    ...client,
    ...split,
    ...nudge,
  });
}

/** Print the running package version (resolved once in server-version.ts). */
function handleVersion(): void {
  log('reticle_version', { version: SERVER_VERSION });
}

/** `reticle license` — show enterprise activation resolved from the environment (offline; nothing leaves). */
function handleLicense(): void {
  log('reticle_license', { ...describeLicense(Date.now()) });
}

/**
 * `reticle affected <file...>` — print which saved flows must re-verify for the given changed files.
 * Environment-side (costs the agent nothing per turn); the foundation of watch/gate. Never throws:
 * a load error is logged, not fatal.
 */

async function handleAffected(files: string[], since: string | undefined): Promise<void> {
  try {
    const fs = createNodeFileSystem();
    const reticleRoot = join(process.cwd(), ReticleDir.ROOT);
    const changed = await resolveChangedFiles(files, since);
    const result = affectedSavedFlows(await loadNamedFlows(fs, reticleRoot), changed);
    log('reticle_affected', {
      changedFiles: changed,
      affected: result.affected,
      unknownProvenance: result.unknownProvenance,
    });
  } catch (error) {
    log('reticle_affected_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * `reticle hunt <dir>` — aggregate crawl reports from many checkouts into one number.
 *
 * Detection already exists (`reticle_crawl`). This is the arithmetic that turns a pile of runs into
 * the claim worth making: over N already-merged, already-green changes, how many carried a candidate
 * false green? No control arm is needed, because those changes SHIPPED — the counterfactual is
 * already established, which is what makes this the cheapest credible evidence available.
 *
 * Each file in <dir> is one crawl result. Producing them is a shell loop over a commit range:
 * check out, boot the app, `reticle_crawl`, write the JSON here.
 */
async function handleHunt(dir: string): Promise<void> {
  try {
    const fs = createNodeFileSystem();
    const names: string[] = await fs.readdir(dir);
    const runs: HuntRun[] = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const raw = await fs.readFile(join(dir, name));
      if (raw === undefined) continue;
      const parsed: unknown = JSON.parse(raw);
      const report = parsed as { anomalies?: HuntAnomaly[]; stepsRun?: number; label?: string };
      runs.push({
        label: report.label ?? name.replace(/\.json$/, ''),
        anomalies: report.anomalies ?? [],
        ...(report.stepsRun === undefined ? {} : { stepsRun: report.stepsRun }),
      });
    }
    log('reticle_hunt', { ...summarizeHunt(runs) });
  } catch (error) {
    log('reticle_hunt_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Ensure a daemon is reachable on `port` (probe the real port; spawn + wait only if nothing's there). */
function ensureDaemon(port: number): Promise<void> {
  return probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus }).then(
    async (presence) => {
      // Attaching to whatever already owns the port is the whole point of a daemon — but it means an
      // upgrade does NOT take effect until that daemon dies, and nothing used to say so. Say it here,
      // where both versions are in hand, and keep attaching: killing another agent's daemon on a
      // version bump is worse than a loud warning.
      if (presenceIsUsable(presence)) return warnOnDaemonSkew(port);
      // Not free, not a daemon: a stranger holds the port. Spawning here is guaranteed to fail —
      // the child cannot bind — and `waitForDaemon` would then report READY anyway, because its
      // probe is the same bare TCP connect and the stranger accepts. That is the "serve reports
      // success for a daemon that never bound" shape. Refuse instead, with the sentence `doctor`
      // says.
      if (PortPresence.FREE !== presence) throw new Error(describePresence(presence, port));
      const scriptPath = process.argv[1];
      if (scriptPath === undefined) throw new Error('cannot locate the reticle daemon script');
      spawnDaemon(
        process.execPath,
        scriptPath,
        [DAEMON_INNER_COMMAND, PORT_FLAG, String(port)],
        port,
      );
      return waitForDaemon(port);
    },
  );
}

/**
 * `reticle open [url]` — the one-command "show me the app". Resolves the port (the requested one if a
 * daemon's there, else a running daemon it discovers — so the user never hunts for the port), ensures
 * the daemon, then reuses the already-connected tab or opens a new browser at the url. Idempotent:
 * re-running never piles up duplicate tabs.
 */
/** How long `reticle open` waits for the launched page to register before reporting on it. */
const OPEN_SESSION_WAIT_MS = 8000;

/**
 * Poll until a NEW session shows up, or the wait runs out. Returns whether one did.
 *
 * Compares against the count taken before launching rather than against zero, so opening a second
 * app while one is already connected is not reported as an instant success.
 */
async function waitForNewSession(port: number, before: number): Promise<boolean> {
  const deadline = Date.now() + OPEN_SESSION_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const { sessions } = summarizeStatus(await fetchStatus(port));
    if (sessions.length > before) return true;
  }
  return false;
}

function handleOpen(requestedPort: number, url: string | undefined): void {
  // Our project's daemon first: `discoverDaemonPort` returns the LOWEST live daemon on the machine,
  // whoever it belongs to, so on a machine running two projects `reticle open` could drive the other
  // one's browser. It stays as the last resort for a caller with no project id, where any daemon is
  // better than none and there is no identity to confuse.
  const myProject = readProjectId(process.cwd());
  probeDaemon(requestedPort)
    .then((here) =>
      here
        ? requestedPort
        : (resolveDaemonForProject(myProject, reticleStateHome(), isAlive) ??
          discoverDaemonPort() ??
          requestedPort),
    )
    .then(async (port) => {
      await ensureDaemon(port);
      const { sessions } = summarizeStatus(await fetchStatus(port));
      const decision = decideOpen(sessions, url);
      if ('need-url' === decision.action) {
        log('reticle_open', {
          port,
          error:
            'no app connected — pass a url: reticle open <url>. Desktop app (Electron/Tauri)? ' +
            'There is no url to open: start it as you normally would and it connects to this bridge itself.',
        });
        return;
      }
      if ('reuse' === decision.action) {
        log('reticle_open', { port, reusing: decision.url });
        return;
      }
      // A tab on the right origin, on the WRONG page. Kept (that is what stops a tab piling up per
      // run) but never reported as done: `reusing` here read as "your url is open" for a page nobody
      // had opened.
      if ('left-as-is' === decision.action) {
        log('reticle_open', {
          port,
          reusing: decision.url,
          requested: decision.requested,
          note:
            `a tab is connected on this origin but sitting on ${decision.url} — it was LEFT THERE, ` +
            `not navigated to ${decision.requested}. Drive it with reticle_navigate, or open the url ` +
            'in the browser yourself.',
        });
        return;
      }
      const launchError = await openInBrowser(decision.url);
      if (launchError !== null) {
        log('reticle_open', {
          port,
          error: `could not launch a browser: ${launchError}`,
          // Points at the OS handler, not at `reticle doctor`. Doctor's browser check is about
          // Reticle's own Chromium, which this command never touches — the same misdirect the
          // no-session note below spells out at length, left standing here for one more release.
          recovery:
            'Nothing was opened. This command asks the OS to open a url in your default browser ' +
            `(\`${openCommand(decision.url, process.platform).cmd}\` on this platform) and that ` +
            'failed, so the fix is on the OS side: open the url yourself, or set a default browser.',
        });
        process.exit(1);
        return;
      }
      // Say whether a SESSION appeared, not merely that a launcher was invoked. `{"opened": url}`
      // was printed unconditionally, so a run where nothing ever opened looked identical to a run
      // where it did — reported from the field as twenty minutes lost to a phantom port problem.
      const connected = await waitForNewSession(port, sessions.length);
      log('reticle_open', {
        port,
        ...(port === requestedPort ? {} : { requestedPort }),
        opened: decision.url,
        connected,
        ...(connected
          ? {}
          : {
              // Two claims used to live here that this command cannot support. It said the browser
              // "was launched" — it asked the OS to open a URL and cannot see whether a window
              // appeared — and it offered "the app may still be loading" as a cause with equal
              // weight to the real one. It then pointed at `reticle doctor`, whose Chromium check is
              // about a browser THIS command never uses, so a missing Chromium reads as the
              // explanation for a session that is missing for an unrelated reason. Both misdirects
              // were reported from the field, each costing several calls of app-side wiring hunt.
              note: openFailureNote(port, requestedPort),
            }),
      });
    })
    .catch((err: unknown) => {
      log('reticle_open', { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
}

function handleDaemonInner(parsed: {
  port: number;
  driveUrl?: string;
  headless: boolean;
  http: boolean;
  httpPort?: number;
  httpToken?: string;
}): void {
  const options: StartOptions = daemonStartOptions(parsed);

  startDaemon(options)
    .then((server) => {
      log('reticle_daemon_ready', { port: parsed.port, pid: process.pid });
      // Daemon lifecycle telemetry: started, a one-shot project profile, the periodic counter flush,
      // and the rich summary on shutdown. All of it lives in one module — see daemon-telemetry.ts.
      const daemonTelemetry = installDaemonTelemetry(process.cwd(), undefined, parsed.port);
      // Publish to the discovery registry so a build plugin can find this daemon by projectId — no
      // hand-reconciled port. Written from the child (only it knows its cwd); removePid drops it.
      const registryProjectId = readProjectId(process.cwd());
      writeDaemonRegistry(parsed.port, {
        pid: process.pid,
        cwd: process.cwd(),
        startedAt: Date.now(),
        ...(registryProjectId !== undefined ? { projectId: registryProjectId } : {}),
      });
      // The daemon serves many agents — keep it alive through one agent's stray async error; only a
      // genuine uncaught throw takes it down (cleanly, so the next `reticle mcp` respawns it fresh).
      installDaemonResilience(process, log, () => {
        removePid(parsed.port);
        process.exit(1);
      });
      const shutdown = (reason: DaemonExitReason): void => {
        // Recorded BEFORE the async chain: `installExitTrace` reads it when Node is on its way out,
        // which is after everything below has run. Without it the exit line says `code: 0` and a
        // reader cannot tell a tidy stop from the bridge disappearing — see #123.
        recordExitReason(reason);
        // Say so on the wire before anything closes. The proxy on the other end sees a clean stream
        // end whether we retired on schedule or died under it, and it has no other way to tell —
        // which is how a designed shutdown came to dominate the metric that means "the agent lost
        // its tools". Told, the proxy classifies its own drop honestly. First, because the send has
        // to reach a socket that is still open.
        server.announceShutdown?.();
        // Awaited before the close/exit chain: `process.exit(0)` kills an in-flight POST, and this is
        // the one event carrying the whole session. A failed send resolves anyway (emit swallows its
        // own errors), so this can delay the exit by at most the send timeout, never prevent it.
        void daemonTelemetry
          // The reason rides out on the session summary, which is the only event that fires at this
          // exact moment. The proxy emits the matching `mcp_connection_lost` and cannot know it —
          // it sees a socket end and nothing more, which is how a scheduled idle exit came to make up
          // the large majority of "outages". See SessionSummary.exit.
          .shutdown(reason)
          .then(() => server.close())
          .then(() => {
            removePid(parsed.port);
            process.exit(0);
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            log('reticle_daemon_close_error', { error: message });
            removePid(parsed.port);
            process.exit(1);
          });
      };
      // Wrapped rather than passed directly: a signal handler receives the signal name as its first
      // argument, which would otherwise arrive as the reason.
      process.on('SIGTERM', () => shutdown(DaemonExitReason.SIGNAL));
      process.on('SIGINT', () => shutdown(DaemonExitReason.SIGNAL));
      // Self-shut-down when idle so a detached daemon (and any headless Chromium it launched) never
      // lingers on the user's machine after the editor closes. Reuses the same clean shutdown path.
      const attachedGraceEnv = process.env[ReticleEnv.IDLE_ATTACHED];
      const idleShutdown = new IdleShutdown({
        graceMs: resolveIdleShutdownMs(process.env[ReticleEnv.IDLE_SHUTDOWN]),
        checkIntervalMs: resolveIdleCheckMs(process.env[ReticleEnv.IDLE_CHECK]),
        isIdle: server.isIdle ?? (() => false),
        ...(server.agentAttached === undefined ? {} : { agentAttached: server.agentAttached }),
        // Only when the var is actually SET. `resolveIdleShutdownMs(undefined)` returns the 5-minute
        // DEFAULT, so passing it unconditionally would override the derived attached grace with the
        // very number this change exists to stop using — shipping the bug while looking fixed.
        ...(attachedGraceEnv === undefined || '' === attachedGraceEnv.trim()
          ? {}
          : { attachedGraceMs: resolveIdleShutdownMs(attachedGraceEnv) }),
        onShutdown: () => {
          log('reticle_daemon_idle_exit', { port: parsed.port });
          shutdown(DaemonExitReason.IDLE);
        },
      });
      idleShutdown.start();
      // Say so, regularly, so a GAP in this log is itself evidence. `installExitTrace` hooks
      // `'exit'`, which a SIGKILL never fires — so a killed daemon left nothing behind, and the one
      // that exited tidily logged `code: 0`. A reader could not tell "shut down cleanly" from "the
      // bridge every app on this machine needs is gone", and a correct SvelteKit install was written
      // up as an install failure on exactly that ambiguity. See daemon/heartbeat.ts.
      new DaemonHeartbeat({
        log,
        intervalMs: resolveHeartbeatMs(process.env[ReticleEnv.HEARTBEAT]),
        facts: () => ({
          sessions: server.bridge.sessions.count(),
          served: everServedToolCall(),
        }),
      }).start();
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log(DAEMON_START_FAILED_EVENT, { error: message });
      removePid(parsed.port);
      process.exit(1);
    });
}

export function main(): void {
  // Before anything reads process.env — notably the telemetry gate and the bridge's security
  // options — fold in a project-local `.env`. Values already in the environment always win.
  loadDotEnv(process.cwd());
  // The licence key specifically is searched for HARDER than the rest of the environment, because
  // the daemon is spawned without an explicit cwd and inherits the editor's. A key in the app's own
  // `.env` — or in the repo root when the editor started inside the app — was never read, and the
  // customer then produced events that said `missing`, which is indistinguishable from having no
  // licence at all. Only the key is taken; see license-env.ts for why nothing else is.
  const licenseKey = licenseKeyFromEnvFiles(process.cwd());
  if (licenseKey !== undefined) process.env[LICENSE_KEY_ENV] = licenseKey;
  const argv = process.argv.slice(2);
  // Every invocation passes through here — the single chokepoint for the "how often is it used / how
  // many distinct machines + projects" metrics. Fire-and-forget: a metric must never delay or fail a run.
  //
  // `_daemon` is EXCLUDED, and that exclusion is the whole point of this branch. `reticle mcp` and
  // `reticle serve` start the daemon by re-running this very binary, so the child re-entered main()
  // and emitted a second event for what a person experienced as one action. The old `invoke` metric
  // was therefore inflated ~2x — and inflated worst on the agent-driven sessions that matter most,
  // while one-shot commands like `version` counted once. That skewed the RATIO between commands, not
  // just the scale, which is the kind of error you cannot correct for after the fact. The daemon's
  // own lifecycle is already reported by `daemon_started` / `daemon_stopped`; it is not a CLI run.
  reportCliRun(argv);
  // Cloud subcommands (login/link/project/config/push) are a distinct family with their own async client;
  // handle them before the local typed parser so `reticle login` etc. work as one tool.
  if (isCloudCommand(argv[0])) {
    void runCloudCommand(argv).then((code) => process.exit(code));
    return;
  }
  const portEnv = process.env[ReticleEnv.PORT];
  const envPort = portEnv !== undefined ? parseInt(portEnv, 10) : undefined;
  const projectPort = readProjectPort(process.cwd());
  // Say so rather than letting the daemon fight the dev server for the port and fail with an
  // EADDRINUSE that mentions neither file nor cause.
  if (projectPort !== undefined && isLikelyDevServerPort(projectPort)) {
    process.stderr.write(`${devServerPortWarning(projectPort)}\n`);
  }
  // Registry BEFORE the default, and after both explicit sources.
  //
  // This is the line that ends the split brain. Build plugins have always asked the registry which
  // daemon serves this project; the CLI asked a number and then attached to whoever owned it. So
  // every project on the machine funnelled into one daemon whose identity was whichever project won
  // the race, and one kill on one well-known port was a machine-wide outage.
  //
  // An explicit port still wins, because a person who typed one is answering this question
  // themselves. Below that, our OWN daemon wherever it is listening. Only then the default, which is
  // now a starting preference rather than an assumption.
  const myProjectId = readProjectId(process.cwd());
  const myDaemonPort = resolveDaemonForProject(myProjectId, reticleStateHome(), isAlive);
  const defaultPort = envPort ?? projectPort ?? myDaemonPort ?? RETICLE_DEFAULT_PORT;
  // Headed by default; hidden only where there is no display to be headed on. A run nobody can see
  // is a run nobody trusts, and every "did it actually do anything?" cost a human round-trip.
  const parsed = parseCliArgs(argv, defaultPort, process.env['CI'] !== undefined);

  switch (parsed.kind) {
    case 'error':
      // Two audiences, two channels. The structured line is for logs and scripts; the plain text is
      // for the person who just typed the command. Emitting only the JSON meant a single typo came
      // back as an escaped one-line wall of the entire help text — see the ParseError builders.
      log('reticle_usage_error', { message: parsed.message });
      process.stderr.write(
        parsed.message === CLI_USAGE ? `${CLI_USAGE}\n` : `${parsed.message}\n\n${CLI_USAGE}\n`,
      );
      process.exit(1);
      break;
    case 'init':
      handleInit(parsed);
      break;
    case 'serve':
      handleServe(parsed);
      break;
    case 'stop':
      handleStop(parsed.port, parsed.quiet);
      break;
    case 'kill':
      void runKill(parsed.port, parsed.force).then((freed) => {
        if (!freed) process.exit(1);
      });
      break;
    case 'restart':
      void handleRestart(parsed.port, parsed.force);
      break;
    case 'status':
      void handleStatus(parsed.port);
      break;
    case 'license':
      handleLicense();
      break;
    case 'telemetry':
      handleTelemetry(parsed.action);
      break;
    case 'feedback':
      void handleFeedback(
        parsed.text,
        parsed.rating,
        parsed.bug,
        parsed.feedbackKind,
        parsed.agent,
      );
      break;
    case 'identify':
      void handleIdentify(parsed);
      break;
    case 'version':
      handleVersion();
      break;
    case 'help':
      process.stdout.write(`${CLI_USAGE}\n`);
      break;
    case 'doctor':
      void handleDoctor(parsed.port);
      break;
    case 'open':
      handleOpen(parsed.port, parsed.url);
      break;
    case 'drive':
      handleDrive(parsed);
      break;
    case 'verify':
      handleVerify(parsed);
      break;
    case 'capsules':
      void handleCapsules();
      break;
    case 'affected':
      void handleAffected(parsed.files, parsed.since);
      break;
    case 'hunt':
      void handleHunt(parsed.dir);
      break;
    case 'gate':
      void handleGate(parsed.files, parsed.since, parsed.hook);
      break;
    case 'watch':
      handleWatch();
      break;
    case 'update':
      void handleUpdate();
      break;
    case 'rollback':
      void handleRollback();
      break;
    case 'mcp':
      void handleMcp(parsed);
      break;
    case '_daemon':
      handleDaemonInner(parsed);
      break;
  }
}

/**
 * True when this module is the process entry point. Resolves argv[1] through the realpath because
 * package managers (notably pnpm) symlink `node_modules/<pkg>` into a store dir: the bin shim runs
 * `node node_modules/@reticlehq/core/dist/cli.js` (the symlink) while ESM `import.meta.url` is the
 * realpath. A plain string compare is false there, so `reticle <cmd>` would silently no-op.
 */
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main();
}
