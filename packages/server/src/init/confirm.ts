/**
 * The step `init` never took: stay and watch for an app to connect.
 *
 * The install has two halves. Registering the MCP server gives the agent the tools; getting the SDK
 * into a running page gives it something to look at. Almost everyone finishes the first, and nothing
 * joined "init finished" to "an app connected" — so `init` exited 0 having written files, and the
 * person left with a config file and no instrumented page was never told (#269).
 *
 * The capability existed in three places and was used together by none of them: the poll behind
 * `reticle open`, the install gate (which calls this exact check "the only step that proves the
 * install works"), and the event that measures whether it ever happened.
 *
 * WHY NO FLAG, and no dev-server management:
 *
 *  - No flag, because the people this is for are the ones who do not know to ask. `--verify` would
 *    be typed by the users who already run `status` afterwards, which is exactly the cohort that is
 *    not being lost. The gate instead is whether a HUMAN IS AT THE TERMINAL: `init` waits when
 *    stdout is a TTY and skips the wait entirely otherwise, so a scripted or agent-driven `init`
 *    keeps today's cost and today's exit behaviour, and blocking never happens where blocking is
 *    wrong. The signal is the standard "am I being piped" one and needs no argument parsing, which
 *    also keeps `init`'s documented flag surface where it is.
 *  - The DAEMON never starts anything. A dev server started by a long-lived daemon is invisible to
 *    the person whose machine it runs on and orphans when the daemon exits, so the daemon stays out
 *    of it. Note what that reasoning is actually about: attributability, not abstinence. A
 *    foreground `init` somebody ran satisfies it — the command is in their transcript, and it stops
 *    what it started if setup fails or is interrupted — which is why the runtime phase is allowed
 *    to boot one where the daemon is not. This function keeps its own shape either way: confirm the
 *    app if it connects, otherwise name the ONE command that is outstanding and the one that proves
 *    it worked.
 */
import { InitConfirmation, RETICLE_DEFAULT_PORT } from '@reticlehq/core';
import type { DevServerEntry, InitOutcome } from '@reticlehq/core';
import { fetchStatus, summarizeStatus } from '../cli/cli-launch.js';
import { readDevServers } from '../daemon/dev-servers.js';
import { devServersForProject } from '@reticlehq/core';
import { readProjectId } from '../cli/cli-port.js';
import { reticleStateHome } from '../daemon/daemon.js';
import { reportInitOutcome } from '../telemetry/init-telemetry.js';

/**
 * How long a human is asked to wait.
 *
 * Long enough for a page that is already loading to finish dialling, short enough that somebody who
 * has not restarted their dev server yet is not held hostage by a wait that cannot succeed — they
 * have not typed the command that would make it succeed, and the message tells them which one.
 */
const CONFIRM_WINDOW_MS = 12_000;
const CONFIRM_POLL_MS = 500;

export interface ConfirmDeps {
  /** Session ids connected right now, or null when nothing is listening on the bridge port. */
  listSessionIds: () => Promise<readonly string[] | null>;
  /**
   * The dev servers that have announced themselves, read at the END of the wait rather than the
   * start: a dev server booting alongside `init` is the common case, and asking before it has
   * finished listening would report the state we are trying to move away from.
   *
   * Optional so every existing construction of these deps — and any embedder's — keeps working and
   * simply gets today's less specific message.
   */
  listDevServers?: () => readonly DevServerEntry[];
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  windowMs?: number;
  pollMs?: number;
}

/** The narrow slice of the init IO this needs — it prints, and nothing else. */
interface PrintIo {
  print: (line: string) => void;
}

/** What `runInit` hands back; `outcome` is present only on a real (non-dry) run. */
interface ConfirmableResult {
  ok: boolean;
  applied: number;
  manual: number;
  outcome?: InitOutcome;
}

/**
 * Poll until an app connects or the window runs out.
 *
 * A session that was ALREADY there when the wait began does not count, and this is the whole reason
 * the check reads ids rather than a count. A daemon is shared across every project on the machine,
 * so "a session exists" is satisfied by another app, by a stray tab, by yesterday's work — and
 * confirming this install on somebody else's session is a false green in the one message a user
 * reads to decide whether they are done. `reticle open` refuses the same way, for the same reason.
 *
 * The conservative direction is deliberate: an app that reconnects under an id it already held is
 * reported as not-yet-connected, and the message it gets sends them to `status`, which shows it. A
 * missed confirmation costs one command; a false one costs the whole point of confirming.
 */
export async function confirmAppConnected(deps: ConfirmDeps): Promise<InitConfirmation> {
  const deadline = deps.now() + (deps.windowMs ?? CONFIRM_WINDOW_MS);
  let before: ReadonlySet<string> | undefined;
  for (;;) {
    const ids = await deps.listSessionIds();
    // A port nobody is listening on cannot receive a session, and no amount of waiting changes that.
    // One look settles it; polling on would spend the whole window to re-learn the first answer.
    if (null === ids) return InitConfirmation.NO_DAEMON;
    const baseline = before;
    if (baseline === undefined) before = new Set(ids);
    else if (ids.some((id) => !baseline.has(id))) return InitConfirmation.CONNECTED;
    if (deadline <= deps.now()) return InitConfirmation.NO_SESSION;
    await deps.sleep(deps.pollMs ?? CONFIRM_POLL_MS);
  }
}

const PROVE_COMMAND = '`npx @reticlehq/server status`';

/**
 * What the user reads, in the marks the rest of the report already uses: `⚠` means work left to do
 * and nothing else, `ℹ` is worth reading but is not work, `✓` happened.
 *
 * Only NO_SESSION earns a `⚠`, and it earns it honestly: the app is wired and has not connected, so
 * there is a command outstanding. A missing daemon is not a defect in the install — the daemon comes
 * up when the agent loads the tools — so it is a notice.
 */
/**
 * Narrow "no app connected" using what the dev servers themselves announced.
 *
 * `confirmAppConnected` can only observe the bridge, so its NO_SESSION covers two situations with
 * OPPOSITE fixes: the dev server is not running Reticle at all, or it is and no page has been
 * opened. An announced entry is proof the plugin is loaded in the process that is actually running
 * — which means the config is right and it has already been restarted.
 *
 * Only the unexplained answer is sharpened. CONNECTED is the finished state and NO_DAEMON is a
 * different fact; neither becomes more true because a dev server is up.
 */
export function sharpenWithDevServers(
  confirmation: InitConfirmation,
  running: readonly DevServerEntry[],
): InitConfirmation {
  if (confirmation !== InitConfirmation.NO_SESSION) return confirmation;
  return 0 === running.length ? InitConfirmation.NO_SESSION : InitConfirmation.NO_PAGE;
}

export function confirmationMessage(
  confirmation: InitConfirmation,
  port: number,
  running: readonly DevServerEntry[] = [],
): string {
  if (confirmation === InitConfirmation.CONNECTED) {
    return (
      '  [✓] an app is connected — that is the install finished, not just written.\n' +
      '      Ask your agent to drive a flow.'
    );
  }
  if (confirmation === InitConfirmation.NO_DAEMON) {
    return (
      `  [ℹ] nothing is listening on port ${String(port)} yet, so no app could have connected and ` +
      'this run did not wait for one.\n' +
      '      The daemon starts on its own when your agent loads the Reticle tools. After that, ' +
      `${PROVE_COMMAND} confirms the app.`
    );
  }
  if (confirmation === InitConfirmation.NO_PAGE) {
    // Deliberately never says "restart". The announcement is proof they already did — telling them
    // again is how a correct instruction reads as the tool not knowing what is going on.
    const where = running.map((s) => `        ${s.url}`).join('\n');
    return (
      '  [⚠] your dev server has Reticle loaded, and no page has connected yet — so the only step ' +
      'left is opening the app.\n' +
      `      Open it in a browser:\n${where}\n` +
      `      ${PROVE_COMMAND} then confirms it.`
    );
  }
  return (
    '  [⚠] no app has connected yet — the files are written, the page half of the install is not ' +
    'done.\n' +
    '      Restart your dev server and load the app in a browser — or ask your agent to, which it is ' +
    'now told to do for you, in the background and with the command from your own scripts.\n' +
    `      ${PROVE_COMMAND} then confirms it, or says exactly why it has not connected.`
  );
}

/**
 * What a non-TTY run says instead of waiting.
 *
 * `init` deliberately does not block when nobody is at the terminal — a 12-second wait in a script
 * is wrong, and an agent driving `init` through a shell is never a TTY. But silence was the wrong
 * other half of that decision: the agent path IS the prescribed path (every skill and every README
 * block tells an agent to run exactly this command), so the one message joining "init finished" to
 * "an app connected" was withheld from most of the people who run it. They were left with files on
 * disk, an exit code of 0, and nothing saying the page half had not happened.
 *
 * It claims nothing it did not check. It did not look for a session, so it does not say whether one
 * exists — a one-shot look would be worse than none, because a daemon is shared across every project
 * on the machine and "a session exists" is satisfied by somebody else's app, which is the false
 * green `confirmAppConnected` refuses by design.
 */
function unwatchedMessage(port: number): string {
  return (
    '  [ℹ] the files are written. An app CONNECTING is what finishes the install, and this run did ' +
    'not wait to see one.\n' +
    '      Start the dev server, load the app in a browser, then ' +
    `${PROVE_COMMAND} — it confirms the app, or says exactly why it has not connected.\n` +
    `      Bridge port ${String(port)}.`
  );
}

const WATCHING = (windowMs: number): string =>
  `  watching for an app to connect (up to ${String(Math.round(windowMs / 1000))}s) — Ctrl-C is safe, ` +
  'everything above is already written.';

/**
 * Finish `init` on evidence rather than on a write.
 *
 * The telemetry report happens HERE rather than inside `runInit`, so the one `init_completed` event
 * carries what was seen. Emitting inside `runInit` and again after the wait would double-count the
 * funnel it exists to measure, and a second event kind for the same command would need joining back
 * to the first before anybody could read either.
 */
export async function confirmInstall(
  result: ConfirmableResult,
  io: PrintIo,
  deps: ConfirmDeps & { interactive: boolean; port: number },
  report: (outcome: InitOutcome) => void = reportInitOutcome,
): Promise<void> {
  const outcome = result.outcome;
  // No outcome means a dry run or an exit that already reported for itself (no package.json). A
  // preview is not an install and must not land in the funnel as either a success or a failure.
  if (outcome === undefined) return;
  if (!deps.interactive) {
    // Still no waiting — see unwatchedMessage for why it speaks anyway.
    io.print('');
    io.print(unwatchedMessage(deps.port));
    report(outcome);
    return;
  }
  io.print('');
  io.print(WATCHING(deps.windowMs ?? CONFIRM_WINDOW_MS));
  const observed = await confirmAppConnected(deps);
  const running = deps.listDevServers?.() ?? [];
  const confirmation = sharpenWithDevServers(observed, running);
  io.print(confirmationMessage(confirmation, deps.port, running));
  report({ ...outcome, confirmation });
}

/** The real deps: the daemon's own status endpoint, and whether a human is watching. */
export function nodeConfirmDeps(port: number = RETICLE_DEFAULT_PORT): ConfirmDeps & {
  interactive: boolean;
  port: number;
} {
  return {
    // Scoped to the project being set up. The registry is machine-wide, so unscoped it reported a
    // sibling app's dev server as this one's — see devServersForProject.
    listDevServers: () =>
      devServersForProject(readDevServers(reticleStateHome()), {
        projectId: readProjectId(process.cwd()),
        root: process.cwd(),
      }),
    listSessionIds: async () => {
      const payload = await fetchStatus(port);
      // `fetchStatus` resolves undefined when nothing answered, which is precisely the "no daemon"
      // case — a zero-session daemon and an absent one need opposite messages.
      if (payload === undefined) return null;
      return summarizeStatus(payload).sessions.map((s) => s.sessionId);
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    interactive: true === process.stdout.isTTY,
    port,
  };
}
