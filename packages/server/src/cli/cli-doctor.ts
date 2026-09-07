import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReticleEnv } from '@reticlehq/core';
import { readPid, reticleStateHome } from '../daemon/daemon.js';
import { PortPresence, probePresence } from '../daemon/port-presence.js';
import { probeDaemon } from '../mcp/mcp-proxy.js';
import { fetchStatus } from './cli-launch.js';
import { daemonLine, type DaemonIdentity } from './doctor-daemon-line.js';
import { projectWiringLine } from './doctor-project-line.js';
import { hasProjectConnectedBefore } from '../session/connection-memory.js';
import { sessionsLine, type SessionsLine } from './doctor-sessions-line.js';
import { captureLookup, describeForeignHolder, findPortHolder } from './port-holder.js';
import { chromiumHint, probeChromium } from './chromium-hint.js';
import { SERVER_VERSION } from '../version/server-version.js';
import { CONTRACT_FINGERPRINT } from '@reticlehq/core';
import { diagnoseDesktop, isDesktopProject } from '../init/desktop-doctor.js';
import { diagnoseWebCsp } from '../init/csp-doctor.js';
import {
  RETICLE_CONFIG_BASENAME,
  diagnosePortMismatch,
  readProjectId,
  readProjectPort,
} from './cli-port.js';
import { DoctorRow, doctorRow } from './doctor-rows.js';
import { attachState, describeAttachState } from '../mcp/attach-memory.js';
import { findOccupiedSiblings, siblingListenerNote } from './sibling-ports.js';
import {
  daemonsServingProjectElsewhere,
  resolveDaemonForProject,
  splitBrainNote,
  wrongDaemonNote,
} from '../daemon/daemon-resolve.js';
import { isAlive } from '../daemon/daemon.js';

/**
 * `reticle doctor` — collapse the ~6 independent first-run failure modes into one command. Checks the
 * Chromium install (the #1 silent failure), whether a daemon is up on the resolved bridge port, and
 * reminds the user which port the app must dial. Human-readable to stdout (not the JSON log).
 */

/** Narrow the `/status` payload to the two fields the daemon line reads. */
function asIdentity(payload: unknown): DaemonIdentity {
  if (typeof payload !== 'object' || null === payload) return {};
  const record = payload as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const value = record[key];
    return 'string' === typeof value && value.length > 0 ? value : undefined;
  };
  // Keys are OMITTED rather than set to undefined: `exactOptionalPropertyTypes` is on, and the
  // distinction is the point — "this daemon did not say" is not the same as "this daemon said none".
  const version = pick('version');
  const contract = pick('contract');
  return {
    ...(version === undefined ? {} : { version }),
    ...(contract === undefined ? {} : { contract }),
  };
}

/**
 * One project, two daemons — asked from whichever end this command is standing on.
 *
 * Shares the rule with `reticle status` rather than restating it: the empty daemon can see that the
 * app connected somewhere else, the daemon holding the app can only see that this project owns
 * another one, and a second copy of either half would be a second opinion waiting to disagree.
 */
function splitBrainLine(port: number, projectId: string | undefined): string | undefined {
  const home = reticleStateHome();
  const elsewhere = splitBrainNote(
    port,
    daemonsServingProjectElsewhere(projectId, port, home, isAlive, (other) =>
      hasProjectConnectedBefore(home, other, projectId),
    ),
  );
  return elsewhere ?? wrongDaemonNote(port, resolveDaemonForProject(projectId, home, isAlive));
}

export async function handleDoctor(port: number): Promise<void> {
  const line = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  line('reticle doctor');
  line(doctorRow(DoctorRow.NODE, process.version));
  // Filled in only on the daemon branch — there is nothing to ask when no daemon is answering, and
  // the branches below already say so in their own terms.
  let sessions: SessionsLine | undefined;
  line(doctorRow(DoctorRow.CHROMIUM, chromiumHint(await probeChromium())));
  // Ask the PORT, not just the pid file. "not running on :4400" has been printed about a port that
  // was demonstrably occupied, which sends the reader to start a daemon that cannot bind. The three
  // states are genuinely different problems with different fixes, so doctor names which one it is.
  const pid = readPid(port);
  const presence = await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus });
  if (presence === PortPresence.DAEMON) {
    // Name WHICH daemon. The /status payload already carries version + contract, and doctor was
    // throwing both away — while skew is invisible everywhere else, reaching the agent as a bare
    // -32000 naming no version. This is the command a human runs at exactly that moment.
    const payload = await fetchStatus(port);
    const status = asIdentity(payload);
    const built = daemonLine(port, pid, status, {
      version: SERVER_VERSION,
      contract: CONTRACT_FINGERPRINT,
    });
    line(built.text);
    if (built.skew !== undefined) line(doctorRow(DoctorRow.VERSION, `✗ ${built.skew}`));
    // The same payload already carries whether anything has CONNECTED, and doctor was reading
    // `version` off it and dropping the rest. Without this the command is silent on the one step the
    // funnel stalls on: wired correctly, daemon up, and no page has ever dialled in.
    sessions = sessionsLine('object' === typeof payload && null !== payload ? payload : {});
  } else if (presence === PortPresence.FOREIGN) {
    // Name the holder when we can. `doctor` exists for exactly this moment, and "another process"
    // leaves the reader to find a shell command themselves — the obvious one being the `lsof -ti`
    // pipeline that also kills the agent's own MCP proxy.
    // `pid` is what our pid file recorded for this port. When it matches the process actually
    // holding it, this is our OWN daemon wedged, not a stranger — and the fix is different.
    line(
      doctorRow(
        DoctorRow.DAEMON,
        `✗ ${describeForeignHolder(port, findPortHolder(port, captureLookup), pid)}`,
      ),
    );
  } else {
    line(
      doctorRow(
        DoctorRow.DAEMON,
        `✗ not running on :${port} — your agent runs \`reticle mcp\` (or \`reticle serve\`)`,
      ),
    );
  }
  if (sessions !== undefined) line(sessions.text);
  line(
    doctorRow(
      DoctorRow.BRIDGE_PORT,
      `${port}  (your app must dial THIS port, not your dev-server port)`,
    ),
  );
  const projectPort = readProjectPort(process.cwd());
  const mismatch = diagnosePortMismatch(port, projectPort);
  if (mismatch !== undefined) line(doctorRow(DoctorRow.PORT_CHECK, `✗ ${mismatch}`));

  const projectId = readProjectId(process.cwd());
  // The hop between the agent and this daemon, stated as its own row rather than inferred from the
  // ones above it. `sessions` says the BROWSER reached the daemon; nothing said whether the AGENT
  // did, and those two are exactly the pair a user cannot tell apart when one of them is broken.
  const attach = attachState(reticleStateHome(), port);
  const attachAction = describeAttachState(attach);
  // A SPLIT outranks the attach record, and this is the one place it can. Both records are per PORT,
  // so on a machine whose daemons have split in two the attach row reports "nothing has ever
  // attached here" and sends the reader to re-register a server that is registered and running —
  // the confident wrong answer for a link that is not missing but misaimed.
  const split = splitBrainLine(port, projectId);
  line(
    doctorRow(
      DoctorRow.AGENT_LINK,
      split !== undefined
        ? `✗ ${split}`
        : attachAction === undefined
          ? "✓ an MCP client has listed and called Reticle's tools on this port"
          : `✗ ${attachAction}`,
    ),
  );
  // Remaining half of #261. The SDK dialling a port we are not on is invisible as a refused inbound,
  // but a listener on a well-known Reticle port is visible. Report the observation; do not conclude
  // it is the daemon this app wants — somebody else's daemon looks the same from here.
  const occupiedSiblings = await findOccupiedSiblings(port, probeDaemon);
  const siblingNote = siblingListenerNote(port, occupiedSiblings);
  if (siblingNote !== undefined) line(doctorRow(DoctorRow.SIBLING, siblingNote));
  // The check this checklist was missing: is the APP wired, not just the tools. Everything above can
  // be green in a project that has never been through `init`, and that combination is precisely the
  // one `doctor` gets run to explain.
  line(
    projectWiringLine({
      projectId,
      previouslyConnected: hasProjectConnectedBefore(reticleStateHome(), port, projectId),
      // An absent config and a corrupt one both read back as "no id"; only this tells them apart,
      // and telling somebody a file is missing while it sits in front of them is its own dead end.
      configPresent: existsSync(join(process.cwd(), RETICLE_CONFIG_BASENAME)),
    }),
  );
  // Where to LOOK when something is wrong. The daemon has always written a structured log here and
  // nothing ever said so, so the first move in every investigation was reading source instead of
  // reading the log. `RETICLE_TRACE=1` turns the same stream into a per-stage trace — see
  // docs/debugging.md.
  line(doctorRow(DoctorRow.DAEMON_LOG, join(reticleStateHome(), `daemon-${String(port)}.log`)));
  line(
    doctorRow(
      DoctorRow.TRACING,
      `${ReticleEnv.TRACE}=1 on the daemon for per-stage timings in that log`,
    ),
  );

  // Below the checklist rather than inline: it is a paragraph, and a paragraph in the middle of a
  // column of one-line checks buries the checks under it. This is the daemon's own no-session
  // diagnosis, the same one an agent gets from an empty reticle_sessions.
  if (sessions?.why !== undefined) {
    line('');
    line('  nothing has connected. What the daemon can tell from here:');
    line(`    ${sessions.why}`);
  }

  // Desktop setup RCA. Every one of these fails SILENTLY — a Tauri app with the default CSP runs
  // perfectly and never connects; an Electron app without the preload line reports zero network
  // activity forever, which reads as "makes no backend calls" rather than "you are blind to them".
  const readProjectFile = (relative: string): string | undefined => {
    try {
      return readFileSync(join(process.cwd(), relative), 'utf8');
    } catch {
      return undefined;
    }
  };
  // The web sibling of the desktop findings below: a `connect-src` that excludes the bridge makes
  // the browser refuse the WebSocket and report it in ITS console only, so every check above passes
  // at an app that can never connect. Named, with the exact text to paste.
  const csp = diagnoseWebCsp(readProjectFile, port);
  if (csp.length > 0) {
    line('');
    line(`  csp          ✗ a Content-Security-Policy is blocking the Reticle bridge:`);
    for (const finding of csp) {
      line(`                 ${finding.file}`);
      line(`                   ${finding.problem}`);
      line(`                   fix: ${finding.fix}`);
    }
  }

  const desktop = diagnoseDesktop(readProjectFile, port);
  if (desktop.length > 0) {
    line('');
    line(
      doctorRow(
        DoctorRow.DESKTOP,
        `✗ ${String(desktop.length)} issue(s) — the app will look fine and not work:`,
      ),
    );
    for (const finding of desktop) {
      line(`                 ${finding.file}`);
      line(`                   ${finding.problem}`);
      line(`                   fix: ${finding.fix}`);
    }
  } else if (isDesktopProject(readProjectFile)) {
    // Say so explicitly. Silence would read as "not checked", which is the same ambiguity the
    // findings above exist to remove.
    line(doctorRow(DoctorRow.DESKTOP, '✓ desktop wiring looks right'));
  }
}
