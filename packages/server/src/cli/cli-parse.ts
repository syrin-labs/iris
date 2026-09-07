/**
 * Pure CLI argument parsing — the command/flag grammar, the CliResult union, and parseCliArgs.
 * Split out of cli.ts (which keeps the side-effecting handlers + dispatch) to stay under the
 * file-size cap and keep the parser pure + unit-testable. Re-exported from cli.ts so existing
 * imports are unchanged.
 */
import { parseFeedbackArgs, type ParsedFeedback } from './cli-parse-feedback.js';
import { FORCE_FLAG } from './cli-kill.js';

// Re-exported so every existing importer of these flags is unaffected by the file split.
export {
  AGENT_FLAG,
  BUG_FLAG,
  FEEDBACK_KINDS,
  KIND_FLAG,
  RATING_FLAG,
} from './cli-parse-feedback.js';

/**
 * The lines below say `reticle <command>`, which is the bin this package installs and is correct
 * once it is on PATH. Copied into `npx`, it is not: `npx reticle` resolves the PACKAGE named
 * `reticle`, which belongs to somebody else, and npx will happily fetch and run it. The docs were
 * telling readers to do exactly that on 110 lines before it was caught, so the invocation now leads
 * the usage block rather than being a footnote somewhere else.
 */
export const CLI_USAGE = `usage:  npx @reticlehq/server <command>   (or \`reticle <command>\` once the bin is on your PATH)

  reticle init  [--dry-run] [--port N] [--no-mcp] [--no-install] [--app <dir>]
                [--flow "<what to drive>"] [--env KEY=VALUE]... [--files-only]  (wire Reticle into the project in this directory)
                --app picks WHICH app in a monorepo, when several are found
                --flow names the journey worth proving, in your own words. Only you know
                which one matters, and naming it is the difference between a drive that
                finishes and one that spends its budget looking for something to do
                --env is what the app needs to reach a usable state: the key from
                .env.example, the mock backend, the variable that skips an auth wall.
                Repeatable, and a value may contain spaces and equals signs
                --files-only writes the files and stops, which is what init did before it
                learned to boot the app and prove the install works
                --license writes the key to .env and keeps .env out of git
                --json puts the result on stdout, so an agent reads one object
                --no-drive / --no-open / --no-agents / --url / --timeout / --drive-model
                are the runtime dials: CI, a headless box, or an app you already run
                --no-mcp skips MORE than the server registration: also the agent rule files
                (CLAUDE.md / AGENTS.md / .cursor) and the /reticle command, because all three
                only make sense once the tools are reachable.
  reticle serve [--port N] [--drive <url>] [--headless] [--http] [--http-port N] [--http-token T]
  reticle stop  [--port N] [--quiet]                    (stop the daemon we started, by its recorded pid)
  reticle kill  [--port N] [--force]                   (free the port by its LISTENER, never the agent's mcp proxy)
  reticle restart [--port N] [--force]                 (kill, then start a daemon and wait for a real bind)
  reticle status [--port N]
  reticle doctor [--port N]                            (one command to diagnose setup: Chromium, daemon, port)
  reticle open  [url] [--port N]                        (show the app: reuse the connected tab, else open one)
  reticle verify <url> [--port N] [--headed] [--timeout N] [--storage-state <file>] [--session-id <id>]  (one-shot: drive the URL, verify saved flows, exit 0=pass)
  reticle affected [--since <ref>] [file...]           (which saved flows must re-verify for the changed files)
  reticle gate [--since <ref>] [file...]               (exit non-zero unless passing artifacts cover the affected flows)
  reticle watch [url]                                  (on save, report which saved flows must re-verify)
  reticle drive <url> [--headless]                     (foreground mode, for debugging)
  reticle mcp   [--port N] [--drive <url>] [--headless] (MCP stdio proxy; auto-starts daemon if needed)
  reticle update                                       (install the latest server version and restart)
  reticle rollback                                     (restore the previous server version and restart)
  reticle license                                      (show enterprise license status: active | eval | missing)
  reticle telemetry [status|enable|disable]            (anonymous usage metrics; status shows what's sent + the policy)
  reticle feedback [--rating 1-5] [--bug] "message"    (tell us what worked and what didn't; prints exactly what it sends)
  reticle feedback --agent --kind <bug|gap|ambiguity|feature_request|improvement|experience> "message"
                                                       (agents: file from anywhere, including a setup that never finished)
  reticle identify --context company|side_project|open_source|learning [--company N] [--email E] [--forget]
                                                       (OPT-IN: tell us who you are, e.g. for support or an enterprise trial)

Cloud (link this project to Reticle; runs/flows recorded on the dashboard):
  reticle login [--url <u>] [--email <e>] [--code <c>] [--org <n>]
                                                       (browser device flow by default; --email mails a code)
  reticle logout [--url <u>]                           (sign out of ONE host; others stay signed in)
  reticle link  [--project <name|id>]                  (bind this repo: mints a scoped key, writes .reticle/cloud.json)
  reticle whoami                                        (who am I signed in as, and is this repo attached?)
  reticle project <ls|create <name>>                   (list or create cloud projects)
  reticle config [--runs on|off] [--memory on|off] [--flows on|off] [--verify local|server]
  reticle push | sync [--watch]                        (one sync cycle: send the difference, collect decisions)
  reticle runs | regression | share <runId>            (read cloud state; regression exits 3 if any flow broke)

'drive' shows the browser; everything else is hidden (serve/mcp own the pool behind leases, replay
and the spec runner: batch work). --headed opts any of them in, --headless hides drive, CI hides it.`;

const INIT_COMMAND = 'init';
const SERVE_COMMAND = 'serve';
const STOP_COMMAND = 'stop';
const KILL_COMMAND = 'kill';
const RESTART_COMMAND = 'restart';
const STATUS_COMMAND = 'status';
const OPEN_COMMAND = 'open';
const DRIVE_COMMAND = 'drive';
const VERIFY_COMMAND = 'verify';
const AFFECTED_COMMAND = 'affected';
const HUNT_COMMAND = 'hunt';
const CAPSULES_COMMAND = 'capsules';
const GATE_COMMAND = 'gate';
/** Hook mode: prose a human can read, and silence when there was simply nothing to check. */
const HOOK_FLAG = '--hook';
const WATCH_COMMAND = 'watch';
const UPDATE_COMMAND = 'update';
const ROLLBACK_COMMAND = 'rollback';
const MCP_COMMAND = 'mcp';
const LICENSE_COMMAND = 'license';
const VERSION_COMMAND = 'version';
const TELEMETRY_COMMAND = 'telemetry';
const FEEDBACK_COMMAND = 'feedback';
const IDENTIFY_COMMAND = 'identify';
const COMPANY_FLAG = '--company';
const EMAIL_FLAG = '--email';
const CONTEXT_FLAG = '--context';
const FORGET_FLAG = '--forget';
/** The `reticle telemetry` sub-actions. Bare `reticle telemetry` means `status`. */
export const TelemetryAction = {
  STATUS: 'status',
  ENABLE: 'enable',
  DISABLE: 'disable',
} as const;
export type TelemetryAction = (typeof TelemetryAction)[keyof typeof TelemetryAction];
export const DAEMON_INNER_COMMAND = '_daemon';

/**
 * Every subcommand a person can type, as one closed vocabulary. Telemetry reports which one ran, and
 * this is what keeps that property low-cardinality and non-identifying: an argument we do not
 * recognize reports as `unknown` rather than being echoed, so a typo — which may be a path, a URL, or
 * a flow name — can never reach the wire just because someone misspelled `status`.
 *
 * Lives here rather than in the telemetry module because this is where the command names are already
 * defined; a second list somewhere else would drift the first time a command is added.
 */
export const UNKNOWN_COMMAND = 'unknown';
const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
  INIT_COMMAND,
  SERVE_COMMAND,
  STOP_COMMAND,
  KILL_COMMAND,
  RESTART_COMMAND,
  STATUS_COMMAND,
  OPEN_COMMAND,
  DRIVE_COMMAND,
  VERIFY_COMMAND,
  AFFECTED_COMMAND,
  HUNT_COMMAND,
  CAPSULES_COMMAND,
  GATE_COMMAND,
  WATCH_COMMAND,
  UPDATE_COMMAND,
  ROLLBACK_COMMAND,
  MCP_COMMAND,
  LICENSE_COMMAND,
  VERSION_COMMAND,
  TELEMETRY_COMMAND,
  FEEDBACK_COMMAND,
  IDENTIFY_COMMAND,
  DAEMON_INNER_COMMAND,
  // Cloud subcommands dispatch before the local parser but are still commands a human ran.
  'login',
  'logout',
  'whoami',
  'link',
  'project',
  'config',
  'push',
  'runs',
  'issues',
  'memory',
  'regression',
  'share',
  'doctor',
  'help',
]);

/** The subcommand name if we recognize it, else `unknown`. Bare `reticle` reports `help`. */
export function knownCommand(arg: string | undefined): string {
  if (arg === undefined || '' === arg) return 'help';
  return KNOWN_COMMANDS.has(arg) ? arg : UNKNOWN_COMMAND;
}

export const HEADED_FLAG = '--headed';
/**
 * Force a hidden browser. The default is now HEADED: a run nobody can see is a run nobody trusts,
 * and every "did it actually do anything?" question cost a round-trip. CI passes this (or just sets
 * CI, which flips the default) because there is no display there to be headed on.
 */
const HEADLESS_FLAG = '--headless';
export const PORT_FLAG = '--port';
export const DRIVE_FLAG = '--drive';
const QUIET_FLAG = '--quiet';
const DRY_RUN_FLAG = '--dry-run';
const YES_FLAG = '--yes';
const NO_MCP_FLAG = '--no-mcp';
const APP_FLAG = '--app';
/**
 * What only the caller can know, and what it may switch off.
 *
 * `--flow`, `--env` and `--app` are an AGENT's answers: which journey proves the thing the user
 * cares about, what the app needs to reach a usable state, and which app in a monorepo. None is
 * inferable from the repository alone, and a run without them either guesses or stops.
 *
 * `--files-only` is the escape hatch for a caller that wants what init used to do and nothing more.
 */
const FLOW_FLAG = '--flow';
const ENV_FLAG = '--env';
const FILES_ONLY_FLAG = '--files-only';
/**
 * Write `captureNetworkBodies: true` into the app's config. OFF unless asked (#705).
 *
 * Body capture is what makes a 2xx write's OUTCOME readable rather than just its transport, so it
 * is worth having — but a body is the one part of a request that routinely carries personal data,
 * and `init` runs unattended. Whoever passes this has decided; nothing decides it for them.
 */
const CAPTURE_BODIES_FLAG = '--capture-bodies';
/**
 * The rest of the runtime surface.
 *
 * `--json` is not a convenience: SKILL.md tells an agent to read the result and act on `agentTodo`,
 * and reading one object is one turn where interpreting a report is several. The three opt-outs are
 * what a machine without a browser, or a caller already running their app, actually needs.
 */
const JSON_FLAG = '--json';
const NO_DRIVE_FLAG = '--no-drive';
const NO_OPEN_FLAG = '--no-open';
const NO_AGENTS_FLAG = '--no-agents';
/**
 * Restart the calling client so IT gets the tools.
 *
 * The flag was accepted by the prototype and not by `init`, so passing it printed the whole usage
 * text. `init` decides what a restart should do — including refusing an id with no transcript, which
 * is the case that looks exactly like success — and prints it; performing the restart is the
 * caller's, because opening a terminal is not something a one-shot command should do behind a flag.
 */
const RELAUNCH_FLAG = '--relaunch';
const URL_FLAG = '--url';
const TIMEOUT_FLAG_INIT = '--timeout';
const DRIVE_MODEL_FLAG = '--drive-model';
/**
 * The key, written to .env by the command rather than by hand.
 *
 * The instructions used to ask an agent for three steps: append to .env, check .gitignore, confirm.
 * All three are deterministic, and the second is the one that costs something when skipped, because
 * a key committed to git is leaked and stays leaked after the file is removed.
 */
const LICENSE_FLAG = '--license';
const NO_INSTALL_FLAG = '--no-install';
export const HTTP_FLAG = '--http';
export const HTTP_PORT_FLAG = '--http-port';
export const HTTP_TOKEN_FLAG = '--http-token';
const TIMEOUT_FLAG = '--timeout';
const STORAGE_STATE_FLAG = '--storage-state';
const SESSION_ID_FLAG = '--session-id';

export type CliResult =
  | {
      kind: 'init';
      port: number | undefined;
      mcp: boolean;
      dryRun: boolean;
      install: boolean;
      app: string | undefined;
      flow: string | undefined;
      env: string[];
      filesOnly: boolean;
      captureBodies: boolean;
      json: boolean;
      drive: boolean;
      relaunch: boolean;
      open: boolean;
      agents: boolean;
      url: string | undefined;
      timeoutSeconds: number | undefined;
      driveModel: string | undefined;
      licenseKey: string | undefined;
    }
  | {
      kind: 'serve';
      port: number;
      driveUrl?: string;
      headless: boolean;
      http: boolean;
      httpPort?: number;
      httpToken?: string;
    }
  | { kind: 'stop'; port: number; quiet: boolean }
  | { kind: 'kill'; port: number; force: boolean }
  | { kind: 'restart'; port: number; force: boolean }
  | { kind: 'status'; port: number }
  | { kind: 'license' }
  | { kind: 'telemetry'; action: TelemetryAction }
  | Extract<ParsedFeedback, { kind: 'feedback' }>
  | { kind: 'identify'; context?: string; company?: string; email?: string; forget: boolean }
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'doctor'; port: number }
  | { kind: 'open'; port: number; url?: string }
  | {
      kind: '_daemon';
      port: number;
      driveUrl?: string;
      headless: boolean;
      http: boolean;
      httpPort?: number;
      httpToken?: string;
    }
  | { kind: 'drive'; port: number; driveUrl: string; headless: boolean }
  | {
      kind: 'verify';
      url: string;
      headless: boolean;
      port: number;
      timeoutMs?: number;
      storageState?: string;
      sessionId?: string;
    }
  | { kind: 'affected'; files: string[]; since?: string }
  | { kind: 'hunt'; dir: string }
  | { kind: 'capsules' }
  | { kind: 'gate'; files: string[]; since?: string; hook?: boolean }
  | { kind: 'watch'; url?: string }
  | { kind: 'update' }
  | { kind: 'rollback' }
  | {
      kind: 'mcp';
      port: number;
      driveUrl?: string;
      headless: boolean;
      http: boolean;
      httpPort?: number;
      httpToken?: string;
    }
  | { kind: 'error'; message: string };

type ServeFlags =
  | {
      kind: 'ok';
      port: number;
      driveUrl?: string;
      headless: boolean;
      http: boolean;
      httpPort?: number;
      httpToken?: string;
    }
  | { kind: 'error'; message: string };

/**
 * `serve` / `mcp` / `_daemon` own the browser POOL, which backs automated work — leased contexts for
 * parallel agents, flow replay, the spec runner. Those are batch: nobody is watching, and launching
 * them headed changed timing enough to break four e2e specs. The headed default belongs to the
 * INTERACTIVE command (`drive`), where a human asked to see the run. `--headed` still opts in here.
 */
/**
 * A usage error names the thing that was wrong.
 *
 * These used to return CLI_USAGE as the MESSAGE, so every mistake — a typo'd flag, a flag missing
 * its value, an unknown command — produced the same 600-character help block, JSON-escaped onto one
 * stderr line by `log()`, with no mention of what the parser actually rejected. The install gate
 * reported it verbatim as "init crashed: <the entire help text>", which is unreadable in a report
 * and undiagnosable from a CI log; a human who typed one wrong flag got the same wall.
 *
 * The help text is still shown — cli.ts renders it as readable text underneath. It is just not the
 * message any more.
 */
type ParseError = { kind: 'error'; message: string };

const unknownArgument = (arg: string): ParseError => ({
  kind: 'error',
  message: `unknown argument '${arg}'`,
});
const missingValue = (flag: string): ParseError => ({
  kind: 'error',
  message: `${flag} needs a value`,
});
const notANumber = (flag: string, value: string): ParseError => ({
  kind: 'error',
  message: `${flag} expects a number, got '${value}'`,
});
const missingOperand = (command: string, what: string): ParseError => ({
  kind: 'error',
  message: `${command} needs ${what}`,
});
const requiresHttp = (flag: string): ParseError => ({
  kind: 'error',
  message: `${flag} requires ${HTTP_FLAG} — it configures the verify endpoint ${HTTP_FLAG} starts`,
});
const unknownCommand = (command: string): ParseError => ({
  kind: 'error',
  message: `unknown command '${command}'`,
});

function parseServeFlags(
  args: string[],
  defaultPort: number,
  _defaultHeadless: boolean,
): ServeFlags {
  let port = defaultPort;
  let driveUrl: string | undefined;
  let headless = true;
  let http = false;
  let httpPort: number | undefined;
  let httpToken: string | undefined;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    // `i < args.length` already guarantees this, but the index signature does not say so and the
    // unknown-argument error needs a real string to name.
    if (arg === undefined) break;
    if (arg === PORT_FLAG) {
      i++;
      const n = args[i];
      if (n === undefined) return missingValue(PORT_FLAG);
      const parsed = parseInt(n, 10);
      if (isNaN(parsed)) return notANumber(PORT_FLAG, n);
      port = parsed;
    } else if (arg === DRIVE_FLAG) {
      i++;
      driveUrl = args[i];
      if (driveUrl === undefined) return missingValue(DRIVE_FLAG);
    } else if (arg === HEADED_FLAG) {
      headless = false;
    } else if (arg === HEADLESS_FLAG) {
      headless = true;
    } else if (arg === HTTP_FLAG) {
      http = true;
    } else if (arg === HTTP_PORT_FLAG) {
      i++;
      const n = args[i];
      if (n === undefined) return missingValue(HTTP_PORT_FLAG);
      const parsed = parseInt(n, 10);
      if (isNaN(parsed)) return notANumber(HTTP_PORT_FLAG, n);
      httpPort = parsed;
    } else if (arg === HTTP_TOKEN_FLAG) {
      i++;
      httpToken = args[i];
      if (httpToken === undefined) return missingValue(HTTP_TOKEN_FLAG);
    } else {
      return unknownArgument(arg);
    }
    i++;
  }
  // Without `--http` these flags configure an endpoint nothing starts, and they were accepted and
  // silently ignored — worse than being rejected, because the whole reason to pass them is to be
  // honoured (#687).
  if (!http && httpPort !== undefined) return requiresHttp(HTTP_PORT_FLAG);
  if (!http && httpToken !== undefined) return requiresHttp(HTTP_TOKEN_FLAG);
  return {
    kind: 'ok',
    port,
    headless,
    http,
    ...(driveUrl !== undefined ? { driveUrl } : {}),
    ...(httpPort !== undefined ? { httpPort } : {}),
    ...(httpToken !== undefined ? { httpToken } : {}),
  };
}

function parsePortFlag(args: string[], defaultPort: number): number {
  const idx = args.indexOf(PORT_FLAG);
  if (-1 === idx) return defaultPort;
  const n = args[idx + 1];
  if (n === undefined) return defaultPort;
  const parsed = parseInt(n, 10);
  return isNaN(parsed) ? defaultPort : parsed;
}

type DriveSuffix =
  | { kind: 'ok'; port: number; driveUrl: string; headless: boolean }
  | { kind: 'error'; message: string };

function parseDriveSuffix(args: string[], port: number, defaultHeadless: boolean): DriveSuffix {
  let headless = defaultHeadless;
  let driveUrl: string | undefined;
  for (const arg of args) {
    if (arg === HEADED_FLAG) {
      headless = false;
    } else if (arg === HEADLESS_FLAG) {
      headless = true;
    } else if (arg.startsWith('--')) {
      return unknownArgument(arg);
    } else if (driveUrl === undefined) {
      driveUrl = arg;
    } else {
      return unknownArgument(arg);
    }
  }
  if (driveUrl === undefined) return missingOperand(DRIVE_COMMAND, 'a url');
  return { kind: 'ok', port, driveUrl, headless };
}

type VerifySuffix =
  | {
      kind: 'ok';
      url: string;
      headless: boolean;
      port: number;
      timeoutMs?: number;
      storageState?: string;
      sessionId?: string;
    }
  | { kind: 'error'; message: string };

/**
 * Parse `verify <url> [--port N] [--headed] [--timeout N] [--storage-state <file>]
 * [--session-id <id>]`. The first non-flag token is the preview URL. `defaultPort` is already
 * env + `.reticle.json` + 4400.
 */
function parseVerifySuffix(args: string[], defaultPort: number): VerifySuffix {
  let headless = true;
  let url: string | undefined;
  let timeoutMs: number | undefined;
  let storageState: string | undefined;
  let sessionId: string | undefined;
  let port = defaultPort;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) break;
    if (arg === HEADED_FLAG) {
      headless = false;
    } else if (arg === PORT_FLAG) {
      i++;
      const n = args[i];
      if (n === undefined) return missingValue(PORT_FLAG);
      const parsed = parseInt(n, 10);
      if (isNaN(parsed)) return notANumber(PORT_FLAG, n);
      port = parsed;
    } else if (arg === TIMEOUT_FLAG) {
      i++;
      const n = args[i];
      if (n === undefined) return missingValue(TIMEOUT_FLAG);
      const parsed = parseInt(n, 10);
      if (isNaN(parsed)) return notANumber(TIMEOUT_FLAG, n);
      timeoutMs = parsed;
    } else if (arg === STORAGE_STATE_FLAG) {
      i++;
      const v = args[i];
      if (v === undefined) return missingValue(STORAGE_STATE_FLAG);
      storageState = v;
    } else if (arg === SESSION_ID_FLAG) {
      i++;
      const v = args[i];
      if (v === undefined) return missingValue(SESSION_ID_FLAG);
      sessionId = v;
    } else if (arg.startsWith('--')) {
      return unknownArgument(arg);
    } else if (url === undefined) {
      url = arg;
    } else {
      return unknownArgument(arg);
    }
    i++;
  }
  if (url === undefined) return missingOperand(VERIFY_COMMAND, 'a url');
  return {
    kind: 'ok',
    url,
    headless,
    port,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(storageState !== undefined ? { storageState } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

type InitFlags =
  | {
      kind: 'ok';
      port: number | undefined;
      mcp: boolean;
      dryRun: boolean;
      install: boolean;
      app: string | undefined;
      flow: string | undefined;
      env: string[];
      filesOnly: boolean;
      captureBodies: boolean;
      json: boolean;
      drive: boolean;
      relaunch: boolean;
      open: boolean;
      agents: boolean;
      url: string | undefined;
      timeoutSeconds: number | undefined;
      driveModel: string | undefined;
      licenseKey: string | undefined;
    }
  | { kind: 'error'; message: string };

function parseInitFlags(args: string[]): InitFlags {
  let port: number | undefined;
  let mcp = true;
  let dryRun = false;
  let install = true;
  let app: string | undefined;
  let flow: string | undefined;
  // Repeatable: one variable per flag, so a value containing spaces or `=` needs no quoting rules.
  const env: string[] = [];
  let filesOnly = false;
  let captureBodies = false;
  let json = false;
  let drive = true;
  let open = true;
  let relaunch = false;
  let agents = true;
  let url: string | undefined;
  let timeoutSeconds: number | undefined;
  let driveModel: string | undefined;
  let licenseKey: string | undefined;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    // `i < args.length` already guarantees this, but the index signature does not say so and the
    // unknown-argument error needs a real string to name.
    if (arg === undefined) break;
    if (arg === PORT_FLAG) {
      i++;
      const n = args[i];
      if (n === undefined) return missingValue(PORT_FLAG);
      const parsed = parseInt(n, 10);
      if (isNaN(parsed)) return notANumber(PORT_FLAG, n);
      port = parsed;
    } else if (arg === APP_FLAG) {
      i++;
      const value = args[i];
      if (value === undefined) return missingValue(APP_FLAG);
      app = value;
    } else if (arg === FLOW_FLAG) {
      i++;
      const value = args[i];
      if (value === undefined) return missingValue(FLOW_FLAG);
      flow = value;
    } else if (arg === ENV_FLAG) {
      i++;
      const value = args[i];
      if (value === undefined) return missingValue(ENV_FLAG);
      env.push(value);
    } else if (arg === FILES_ONLY_FLAG) {
      filesOnly = true;
    } else if (arg === CAPTURE_BODIES_FLAG) {
      captureBodies = true;
    } else if (arg === JSON_FLAG) {
      json = true;
    } else if (arg === NO_DRIVE_FLAG) {
      drive = false;
    } else if (arg === NO_OPEN_FLAG) {
      open = false;
    } else if (arg === RELAUNCH_FLAG) {
      relaunch = true;
    } else if (arg === NO_AGENTS_FLAG) {
      agents = false;
    } else if (arg === URL_FLAG) {
      i++;
      const value = args[i];
      if (value === undefined) return missingValue(URL_FLAG);
      url = value;
    } else if (arg === LICENSE_FLAG) {
      i++;
      const value = args[i];
      if (value === undefined) return missingValue(LICENSE_FLAG);
      licenseKey = value;
    } else if (arg === DRIVE_MODEL_FLAG) {
      i++;
      const value = args[i];
      if (value === undefined) return missingValue(DRIVE_MODEL_FLAG);
      driveModel = value;
    } else if (arg === TIMEOUT_FLAG_INIT) {
      i++;
      const value = args[i];
      if (value === undefined) return missingValue(TIMEOUT_FLAG_INIT);
      const seconds = parseInt(value, 10);
      if (isNaN(seconds)) return notANumber(TIMEOUT_FLAG_INIT, value);
      timeoutSeconds = seconds;
    } else if (arg === NO_MCP_FLAG) {
      mcp = false;
    } else if (arg === NO_INSTALL_FLAG) {
      install = false;
    } else if (arg === DRY_RUN_FLAG) {
      dryRun = true;
    } else if (arg === YES_FLAG) {
      // Accepted for scripting/CI; init has no interactive prompts today.
    } else {
      return unknownArgument(arg);
    }
    i++;
  }
  return {
    kind: 'ok',
    port,
    mcp,
    dryRun,
    install,
    app,
    flow,
    env,
    filesOnly,
    captureBodies,
    json,
    drive,
    open,
    relaunch,
    agents,
    url,
    timeoutSeconds,
    driveModel,
    licenseKey,
  };
}

/** Pure CLI arg parser — exported for unit tests. argv = process.argv.slice(2). */
const SINCE_FLAG = '--since';

/** Parse `[--since <ref>] [file...]` shared by `affected` and `gate`. */
/**
 * What `reticle gate` / `reticle affected` mean with NOTHING after them: the working tree.
 *
 * They used to mean a usage error — while the rule `reticle init` writes into the agent's own
 * instruction file says, in as many words, "run `reticle gate`". An instruction the tool rejects is
 * worse than no instruction: the agent spends a turn on it and concludes Reticle is broken.
 *
 * HEAD is the ref that answers the question being asked. Explicit files or an explicit --since still
 * win; this only fills the empty case.
 */
const WORKING_TREE_REF = 'HEAD';

function implicitSince(files: readonly string[]): string | undefined {
  return 0 === files.length ? WORKING_TREE_REF : undefined;
}

function parseTargetArgs(rest: string[]): { files: string[]; since?: string } {
  const files: string[] = [];
  let since: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === SINCE_FLAG) {
      since = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg !== undefined && !arg.startsWith('-')) files.push(arg);
  }
  return since === undefined ? { files } : { files, since };
}

/**
 * @param defaultHeadless Whether a browser Reticle launches should be hidden when no flag says
 *   otherwise. Injected rather than read from the environment here, because this module is pure —
 *   `cli.ts` decides it from `CI`. The product default is FALSE: showing the run is what makes it
 *   trustworthy, and asking people to opt into seeing their own app was backwards.
 */
export function parseCliArgs(
  argv: string[],
  defaultPort: number,
  defaultHeadless = false,
): CliResult {
  // Bare `reticle` is `serve` — a pool-owning command, so headless like the rest of that family.
  if (0 === argv.length) return { kind: 'serve', port: defaultPort, headless: true, http: false };

  const [cmd, ...rest] = argv;
  // Guaranteed by the bare-argv check above; restated so the unknown-command error can name it.
  if (cmd === undefined) return { kind: 'error', message: CLI_USAGE };

  // `version` (or the conventional -v/--version flags) prints the running version — the diagnostic the
  // troubleshooting docs lean on to confirm which npx-resolved build is actually executing.
  if (cmd === VERSION_COMMAND || '--version' === cmd || '-v' === cmd) return { kind: 'version' };

  // `help` (and the conventional -h/--help) print usage to stdout and exit 0 — the universal first move
  // for a new user, which otherwise fell through to a JSON error with exit 1.
  if ('help' === cmd || '--help' === cmd || '-h' === cmd) return { kind: 'help' };

  switch (cmd) {
    case INIT_COMMAND: {
      const r = parseInitFlags(rest);
      if ('error' === r.kind) return r;
      return {
        kind: 'init',
        port: r.port,
        mcp: r.mcp,
        dryRun: r.dryRun,
        install: r.install,
        app: r.app,
        flow: r.flow,
        env: r.env,
        filesOnly: r.filesOnly,
        captureBodies: r.captureBodies,
        json: r.json,
        drive: r.drive,
        open: r.open,
        relaunch: r.relaunch,
        agents: r.agents,
        url: r.url,
        timeoutSeconds: r.timeoutSeconds,
        driveModel: r.driveModel,
        licenseKey: r.licenseKey,
      };
    }
    case SERVE_COMMAND: {
      const r = parseServeFlags(rest, defaultPort, defaultHeadless);
      if ('error' === r.kind) return r;
      return {
        kind: 'serve',
        port: r.port,
        headless: r.headless,
        http: r.http,
        ...(r.driveUrl !== undefined ? { driveUrl: r.driveUrl } : {}),
        ...(r.httpPort !== undefined ? { httpPort: r.httpPort } : {}),
        ...(r.httpToken !== undefined ? { httpToken: r.httpToken } : {}),
      };
    }
    case STOP_COMMAND: {
      const port = parsePortFlag(rest, defaultPort);
      const quiet = rest.includes(QUIET_FLAG);
      return { kind: 'stop', port, quiet };
    }
    case KILL_COMMAND: {
      const port = parsePortFlag(rest, defaultPort);
      return { kind: 'kill', port, force: rest.includes(FORCE_FLAG) };
    }
    case RESTART_COMMAND: {
      const port = parsePortFlag(rest, defaultPort);
      return { kind: 'restart', port, force: rest.includes(FORCE_FLAG) };
    }
    case STATUS_COMMAND: {
      const port = parsePortFlag(rest, defaultPort);
      return { kind: 'status', port };
    }
    case 'doctor': {
      const port = parsePortFlag(rest, defaultPort);
      return { kind: 'doctor', port };
    }
    case LICENSE_COMMAND:
      return { kind: 'license' };
    case TELEMETRY_COMMAND: {
      const action = rest[0] ?? TelemetryAction.STATUS;
      if (
        action !== TelemetryAction.STATUS &&
        action !== TelemetryAction.ENABLE &&
        action !== TelemetryAction.DISABLE
      ) {
        return { kind: 'error', message: `unknown telemetry action: ${action}` };
      }
      return { kind: 'telemetry', action };
    }
    case IDENTIFY_COMMAND: {
      const flag = (name: string): string | undefined => {
        const at = rest.indexOf(name);
        return -1 === at ? undefined : rest[at + 1];
      };
      const context = flag(CONTEXT_FLAG);
      const company = flag(COMPANY_FLAG);
      const email = flag(EMAIL_FLAG);
      return {
        kind: 'identify',
        ...(context !== undefined ? { context } : {}),
        ...(company !== undefined ? { company } : {}),
        ...(email !== undefined ? { email } : {}),
        forget: rest.includes(FORGET_FLAG),
      };
    }
    case FEEDBACK_COMMAND:
      return parseFeedbackArgs(rest);
    case OPEN_COMMAND: {
      const port = parsePortFlag(rest, defaultPort);
      // The first non-flag arg is the url (optional — omitting reuses a connected tab).
      const url = rest.find((a) => !a.startsWith('--') && a !== String(port));
      return url !== undefined ? { kind: 'open', port, url } : { kind: 'open', port };
    }
    case DRIVE_COMMAND: {
      const r = parseDriveSuffix(rest, defaultPort, defaultHeadless);
      if ('error' === r.kind) return r;
      return { kind: 'drive', port: r.port, driveUrl: r.driveUrl, headless: r.headless };
    }
    case DAEMON_INNER_COMMAND: {
      const r = parseServeFlags(rest, defaultPort, defaultHeadless);
      if ('error' === r.kind) return r;
      return {
        kind: '_daemon',
        port: r.port,
        headless: r.headless,
        http: r.http,
        ...(r.driveUrl !== undefined ? { driveUrl: r.driveUrl } : {}),
        ...(r.httpPort !== undefined ? { httpPort: r.httpPort } : {}),
        ...(r.httpToken !== undefined ? { httpToken: r.httpToken } : {}),
      };
    }
    case VERIFY_COMMAND: {
      const r = parseVerifySuffix(rest, defaultPort);
      if ('error' === r.kind) return r;
      return {
        kind: 'verify',
        url: r.url,
        headless: r.headless,
        port: r.port,
        ...(r.timeoutMs !== undefined ? { timeoutMs: r.timeoutMs } : {}),
        ...(r.storageState !== undefined ? { storageState: r.storageState } : {}),
        ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
      };
    }
    case CAPSULES_COMMAND:
      return { kind: 'capsules' };
    case HUNT_COMMAND: {
      const dir = rest.find((a) => !a.startsWith('-'));
      return dir === undefined
        ? { kind: 'error', message: 'usage: reticle hunt <dir-of-crawl-reports>' }
        : { kind: 'hunt', dir };
    }
    case AFFECTED_COMMAND: {
      const t = parseTargetArgs(rest);
      const since = t.since ?? implicitSince(t.files);
      return { kind: 'affected', files: t.files, ...(since === undefined ? {} : { since }) };
    }
    case GATE_COMMAND: {
      // `--hook` is stripped before target parsing, which would reject it as an unknown flag.
      const hook = rest.includes(HOOK_FLAG);
      const t = parseTargetArgs(rest.filter((a) => a !== HOOK_FLAG));
      const since = t.since ?? implicitSince(t.files);
      return {
        kind: 'gate',
        files: t.files,
        ...(since === undefined ? {} : { since }),
        ...(hook ? { hook: true } : {}),
      };
    }
    case WATCH_COMMAND: {
      // `reticle watch [url]` — on file save, report which saved flows must re-verify.
      const url = rest.find((arg) => !arg.startsWith('-'));
      return url === undefined ? { kind: 'watch' } : { kind: 'watch', url };
    }
    case UPDATE_COMMAND:
      return { kind: 'update' };
    case ROLLBACK_COMMAND:
      return { kind: 'rollback' };
    case MCP_COMMAND: {
      const r = parseServeFlags(rest, defaultPort, defaultHeadless);
      if ('error' === r.kind) return r;
      return {
        kind: 'mcp',
        port: r.port,
        headless: r.headless,
        http: r.http,
        ...(r.driveUrl !== undefined ? { driveUrl: r.driveUrl } : {}),
        ...(r.httpPort !== undefined ? { httpPort: r.httpPort } : {}),
        ...(r.httpToken !== undefined ? { httpToken: r.httpToken } : {}),
      };
    }
    default:
      // A bare `reticle` never lands here — it defaults to `serve` above — so `cmd` is always a real
      // word somebody typed, and naming it is strictly more useful than reprinting the whole help.
      return unknownCommand(cmd);
  }
}
