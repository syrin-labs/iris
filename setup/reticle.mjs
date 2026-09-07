#!/usr/bin/env node
/**
 * reticle setup — the whole of SKILL.md's SETUP in one call, on any machine.
 *
 * Measured against an agent doing SKILL.md by hand: that arm spends 26-80 model turns and stops,
 * twice out of three, to ask a human to restart their client — having produced no verdict. Almost
 * none of its time is compute. It is serialised turns plus one human round trip.
 *
 * So the split is: the agent decides WHAT to prove; this script does everything else. Every phase
 * below is a thing no model needs to be in the loop for.
 *
 * Node, not a shell script, for one reason that outranks the filename: Windows is most of Reticle's
 * users, `bash` there means Git Bash or WSL, and a setup.sh + setup.ps1 pair drifts the first time
 * somebody fixes a bug in one of them. Node is the runtime every user of a JS SDK provably has.
 *
 *   node setup.mjs [flags]      or, shipped:  npx @reticlehq/server@latest setup
 *
 * Flags:
 *   --app <dir>        monorepo: the app to wire (init refuses to guess between several)
 *   --flow "<what>"    the flow to drive, in the caller's own words
 *   --init-arg <arg>   forward a raw flag to `reticle init` (repeatable)
 *   --url <url>        the app is already served here; do not start a dev server
 *   --dev-cmd <cmd>    exact dev command, when it is not `<pm> run dev`
 *   --port <n>         bridge port (default 4400). NOT the dev server's port.
 *   --license <key>    write RETICLE_LICENSE_KEY into .env, and .env into .gitignore
 *   --no-restart-dev   do not restart a dev server that predates init
 *   --no-open          do not open a browser tab; something else will connect (CI, an existing tab)
 *   --no-agents        do not register the MCP with other coding agents on this machine
 *   --no-drive         stop after a session connects; leave the verdict to the caller
 *   --json             machine-readable result on stdout, human progress on stderr
 *   --relaunch         restart the calling client (Claude Code or codex) so IT gets the tools
 *   --timeout <s>      per-phase budget (default 120)
 *   --drive-budget <n> dollars the drive may spend before it is stopped (default 3)
 *   --no-escalate      accept a weak saved flow instead of re-recording it with a stronger model
 *   --drive-model <m>  model for the drive. It is 90% of the wall clock, so this is the only
 *                      lever that materially changes how long setup takes — and the one that can
 *                      buy speed with a worse verdict, so it is measured, not assumed.
 */

// Before anything else, and using nothing newer than the version being rejected. Node 16 has no
// global `fetch`, so without this the run dies on `fetch is not defined` at the CONNECT phase —
// several minutes in, with the user's build config already edited. A dependency that is too old is
// the same class of problem as one that is missing, and it deserves the same answer: up front.
const NODE_MIN_MAJOR = 18;
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < NODE_MIN_MAJOR) {
  process.stderr.write(
    `reticle setup needs Node ${NODE_MIN_MAJOR} or newer; this is Node ${process.versions.node}. ` +
      'Node 16 and older have no global fetch, so setup would edit your build config and then die ' +
      'halfway through. Upgrade Node, or run setup from a shell where a newer one is on PATH.\n',
  );
  process.exit(1);
}

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  accessSync,
  constants,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';

import { pickSession } from './pick-session.mjs';
import { codexSession } from './codex-session.mjs';
import { planAgents, applyAgents, applySkills } from './agents.mjs';
import {
  parseLsofListeners,
  parseNetstatListeners,
  descendants,
  parseWmicProcesses,
} from './platform-probe.mjs';

const WIN = platform() === 'win32';
const BRIDGE_DEFAULT_PORT = 4400;
const DEFAULT_PHASE_TIMEOUT_S = 120;
/**
 * A dev server that has gone QUIET for this long is hung, not building. Anything shorter mistakes a
 * slow webpack pass for a hang; anything longer makes a genuinely dead server feel like one.
 */
const DEV_SERVER_QUIET_MS = 45_000;
/** The point at which even a talkative dev server has had enough rope. */
const DEV_SERVER_CEILING_MS = 25 * 60_000;

/** The drive is a model choosing and driving a flow, so it gets its own, much larger budget. */
const DRIVE_TIMEOUT_MS = 10 * 60_000;
/**
 * And a cost ceiling, which is the better bound of the two. A wall clock says nothing about what
 * the run is doing; measured, one app burned the full ten minutes and produced no output at all,
 * because `--output-format json` emits nothing until the run completes — so a drive killed on time
 * leaves NO evidence of where it went. A budget stops the same runaway sooner and for a reason you
 * can put in a sentence.
 */
const DRIVE_BUDGET_USD = 3;
const DEV_SCRIPT_NAMES = ['dev', 'start', 'serve'];
const URL_IN_LOG = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+/;
/** Ports a dev server that predates `init` is most likely sitting on. */
const COMMON_DEV_PORTS = [3000, 3001, 4200, 4321, 5173, 5174, 8080];

// ---------------------------------------------------------------------------- flags

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : argv[i + 1];
};
const has = (n) => argv.includes(n);
const opts = {
  app: flag('--app'),
  url: flag('--url'),
  devCmd: flag('--dev-cmd'),
  port: Number(flag('--port', BRIDGE_DEFAULT_PORT)),
  license: flag('--license'),
  restartDev: !has('--no-restart-dev'),
  open: !has('--no-open'),
  agents: !has('--no-agents'),
  // What the CALLING agent knows and init cannot work out: which flow actually matters to the user.
  // Without it the drive picks something plausible and demonstrates the wrong thing at the one
  // moment the user is watching.
  flow: flag('--flow'),
  // Repeatable escape hatch: `--init-arg --yes --init-arg --no-install`. init grows flags faster
  // than this script can learn them, and a caller that knows one should not have to wait for us.
  initArgs: argv.reduce(
    (acc, a, i) => (a === '--init-arg' && argv[i + 1] !== undefined ? [...acc, argv[i + 1]] : acc),
    [],
  ),
  drive: !has('--no-drive'),
  json: has('--json'),
  relaunch: has('--relaunch'),
  timeoutMs: Number(flag('--timeout', DEFAULT_PHASE_TIMEOUT_S)) * 1000,
  driveBudget: Number(flag('--drive-budget', DRIVE_BUDGET_USD)),
  driveModel: flag('--drive-model'),
  escalate: !has('--no-escalate'),
};

// ---------------------------------------------------------------------------- reporting
//
// Progress goes to STDERR and the result object to STDOUT, so `--json` is pipeable while a human
// watching the terminal still sees what happened. The caller is an agent: `agentTodo` is the whole
// point of the format — one array it can act on, instead of a report it has to interpret.

const result = { ok: false, phases: {}, agentTodo: [], app: {}, verdict: null };
const t0 = Date.now();
let last = t0;
const say = (s) => process.stderr.write(`${s}\n`);
const todo = (s) => {
  result.agentTodo.push(s);
  say(`AGENT: ${s}`);
};
const phase = (name) => {
  const now = Date.now();
  result.phases[name] = now - last;
  last = now;
};
/**
 * What is left to do by hand, from wherever this stopped.
 *
 * Setup can misbehave — it has, twice today, and both times it named the cause and left the caller
 * to work out what that meant for the install. Naming a cause is not the same as being recoverable.
 * An agent that knows init already ran, the dev server is up and only the drive failed should not
 * re-read the whole procedure and redo the parts that worked; it should pick up at the step that
 * did not.
 *
 * Ordered, phase-aware, and only ever the REMAINING steps. Everything it needs to act — the url,
 * the dev command, the session id — is already in this same object.
 */
function remainingSteps() {
  const done = result.phases;
  const steps = [];
  if (done.init === undefined) {
    steps.push(
      'Run `npx @reticlehq/server@latest init` in this directory and fix every ⚠ it reports.',
    );
  }
  if (done.devServer === undefined && opts.url === undefined) {
    steps.push(
      `Start the dev server yourself: ${result.app?.devCmd ?? 'the dev script in package.json'} — then open the app in a browser.`,
    );
  }
  if (result.session === undefined) {
    steps.push(
      `Confirm a session appears: \`reticle_sessions\`. If the list is empty, read its \`next_action\` — the usual cause is a dev server that was already running when init edited the build config, so restart it and hard-reload${result.app?.url === undefined ? '' : ` ${result.app.url}`}.`,
    );
  }
  if (result.flowSaved !== true) {
    steps.push(
      'Drive one flow and produce a verdict: `reticle_snapshot({mode:"interactive"})` once, `reticle_act_sequence` for the setup steps, then ONE `reticle_act_and_wait({ref,action,until})`. Wrap it in `reticle_record` start/stop and `reticle_flow_save`, and check the grade it returns is `asserted`.',
    );
  }
  steps.push('The whole procedure, if you need it: `curl https://docs.reticle.sh/llms.txt`.');
  return steps;
}

function finish(code) {
  result.ok = code === 0;
  result.totalMs = Date.now() - t0;
  // A failed run is only useful if the caller can carry on from it.
  if (code !== 0) result.fallback = remainingSteps();
  if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    if (code !== 0) {
      say('');
      say('  To finish by hand from here:');
      for (const [i, step] of (result.fallback ?? []).entries()) say(`   ${i + 1}. ${step}`);
    }
    say('');
    for (const [k, v] of Object.entries(result.phases)) say(`  ${k}: ${(v / 1000).toFixed(1)}s`);
    say(`  total: ${(result.totalMs / 1000).toFixed(1)}s`);
  }
  process.exit(code);
}
/**
 * The dev server this script started, and the promise not to leave it behind.
 *
 * Setup starts a dev server DETACHED and deliberately leaves it running on success — it is the
 * deliverable, an instrumented app the user can watch. On any other ending it is a leak: a server
 * nobody started, holding a port nobody can account for, surviving the terminal that spawned it.
 * Measured: Ctrl-C during setup left one listening indefinitely.
 */
let devServer;
function stopDevServer() {
  if (devServer?.pid === undefined) return;
  if (WIN) run('taskkill', ['/PID', String(devServer.pid), '/T', '/F']);
  else {
    try {
      process.kill(-devServer.pid, 'SIGTERM');
    } catch {
      try {
        devServer.kill();
      } catch {
        /* gone */
      }
    }
  }
  devServer = undefined;
}
const die = (why) => {
  stopDevServer();
  result.error = why;
  todo(why);
  finish(1);
};

/**
 * Nothing this script does may end as a stack trace in front of a user.
 *
 * Every scenario in the break matrix asserts that, because a raw `TypeError` is not a message: it
 * names a line in our code rather than the thing they have to fix, and it leaves the dev server we
 * started running behind it. A bug of ours is still our bug — but it should arrive as one sentence,
 * with the machine left tidy, and with the JSON the caller is parsing still well-formed.
 */
for (const fatal of ['uncaughtException', 'unhandledRejection']) {
  process.on(fatal, (err) => {
    const message = String(err?.message ?? err)
      .split('\n')[0]
      .slice(0, 300);
    stopDevServer();
    result.error = `setup crashed (${fatal}): ${message}`;
    // The trace goes to a FILE, never to stdout or stderr. "No stack trace reaches the user" is an
    // invariant every scenario in the matrix checks, and it stops being checkable the moment we
    // make an exception for our own crashes — which are exactly when it matters most.
    const crashLog = join(cwd, '.reticle-setup-crash.log');
    try {
      writeFileSync(crashLog, String(err?.stack ?? err));
    } catch {
      /* an unwritable directory is not worth a second crash */
    }
    todo(
      `setup hit a bug of its own and stopped: ${message}. The install may be partly done and re-running is safe. Please report it — the trace is in ${crashLog}.`,
    );
    finish(1);
  });
}

// A signal is the most likely way this ends early, and the one place a leak is invisible: the
// terminal comes back, the port stays taken, and the next run blames the port holder.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopDevServer();
    process.stderr.write(`\nsetup interrupted (${sig}) — the dev server it started was stopped.\n`);
    process.exit(130);
  });
}

// ---------------------------------------------------------------------------- platform bits
//
// The three places a shell script would have used lsof/kill/osascript and been wrong on Windows.

const run = (file, args, o = {}) =>
  spawnSync(file, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...o });

/** PIDs LISTENING on a port. `-sTCP:LISTEN` is load-bearing: without it lsof also returns CLIENT
 *  sockets — including this process's own — and the caller kills itself. */
function listenersOn(port) {
  if (WIN) {
    return parseNetstatListeners(run('netstat', ['-ano']).stdout ?? '')
      .filter((r) => r.port === port)
      .map((r) => String(r.pid));
  }
  const out = run('sh', ['-c', `lsof -ti:${port} -sTCP:LISTEN || true`]).stdout ?? '';
  return out.split('\n').filter(Boolean);
}

/** A listener's working directory, or null where the OS will not tell us cheaply. Windows has no
 *  cheap equivalent, so ownership is UNKNOWN there and we refuse to kill rather than guess. */
function cwdOfPid(pid) {
  if (WIN) return null;
  const out =
    run('sh', ['-c', `lsof -a -p ${pid} -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1`])
      .stdout ?? '';
  return out.trim() || null;
}

function killPid(pid) {
  if (WIN) run('taskkill', ['/PID', String(pid), '/T', '/F']);
  else {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

/** Kill a spawned dev server AND the children it started; killing the wrapper leaves the port held. */
function killTree(child) {
  if (child?.pid === undefined) return;
  if (WIN) run('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill();
      } catch {
        /* gone */
      }
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ports that the dev server WE started is listening on.
 *
 * Log scraping alone is not enough: react-scripts prints its "Local: http://localhost:3200" block
 * only in some environments, so a CRA app compiled successfully, served happily, and setup timed
 * out after 180s insisting no URL was printed. It had been serving the whole time.
 *
 * This is not "guessing a port", which the rules rightly forbid — it is OBSERVING which port our
 * own process group bound. The evidence is the process we spawned, not a convention.
 */
function listeningPortsOfGroup(pgid) {
  if (pgid === undefined) return [];
  if (WIN) {
    // Windows has no process groups to ask, so walk the tree instead: every LISTENING socket whose
    // owning pid is our dev server or one of its descendants. Returning [] here — which is what
    // this did — meant a dev server that prints no URL was undiscoverable on Windows, and CRA
    // prints no URL. That is a 100% failure on the majority platform, on a path no test could see.
    const tree = descendants(
      parseWmicProcesses(run('wmic', ['process', 'get', 'ParentProcessId,ProcessId']).stdout ?? ''),
      pgid,
    );
    const mine = new Set(tree);
    return [
      ...new Set(
        parseNetstatListeners(run('netstat', ['-ano']).stdout ?? '')
          .filter((r) => mine.has(r.pid))
          .map((r) => r.port),
      ),
    ];
  }
  const pids = (run('sh', ['-c', `ps -o pid= -g ${pgid} 2>/dev/null | tr -d ' '`]).stdout ?? '')
    .split('\n')
    .filter(Boolean);
  if (pids.length === 0) return [];
  return parseLsofListeners(
    run('sh', [
      '-c',
      `lsof -a -p ${pids.join(',')} -iTCP -sTCP:LISTEN -P -n 2>/dev/null | awk 'NR>1{print $9}'`,
    ]).stdout ?? '',
  );
}

async function until(fn, budgetMs, everyMs = 500) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------- phase 1: detect
//
// The prefetch is the one genuinely parallel wait in the whole flow: npx resolving and downloading
// the CLI, while we read package.json. Everything after this depends on init, and init depends on
// the CLI, so nothing else here is overlappable however it is arranged.

const cwd = process.cwd();
// `appDir` is deliberately NOT final here. In a monorepo the app is chosen from init's own report
// (below), and resolving the dev script before that ran the gate against the ROOT package.json —
// which has no dev script by design, so every monorepo died at the first check with the message
// meant for a broken single app. The dev script is resolved once the app is known, and not before.
let appDir = opts.app === undefined ? cwd : resolve(cwd, opts.app);
const pkgPath = join(cwd, 'package.json');
if (!existsSync(pkgPath)) die(`no package.json at ${pkgPath} — nothing to instrument.`);

// Resolve the CLI ONCE, here, while package.json is being read. Setup shells out to it four times
// — serve, init, open, verify — and every bare `npx` re-resolves the package before doing anything
// useful. `npx -p <pkg> -c 'command -v reticle'` runs inside the environment npx just prepared and
// prints the binary's real path, so the other three calls skip that work. Anything unexpected and
// `cli()` falls back to plain npx, losing only the seconds this was meant to save.
const prefetch = spawn(
  WIN ? 'npx.cmd' : 'npx',
  ['--yes', '-p', '@reticlehq/server@latest', '-c', WIN ? 'where reticle' : 'command -v reticle'],
  { stdio: ['ignore', 'pipe', 'ignore'], shell: WIN },
);
let resolvedCli = '';
prefetch.stdout.on('data', (c) => (resolvedCli += c));

// Setup writes: .reticle.json, the build config, a capabilities file, its own logs. A checkout
// the user cannot write to (root-owned, a read-only mount, a container bind) fails on every one of
// them, and EACCES arriving as a stack trace at phase four is the worst version of that.
try {
  accessSync(cwd, constants.W_OK);
} catch {
  die(
    `${cwd} is not writable, and setup has to write into it (.reticle.json, the build config, a capabilities file). Fix the permissions, or run setup from a checkout you own.`,
  );
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
} catch (err) {
  // A trailing comma is a five-second fix and a baffling stack trace. Say which file, and what.
  die(
    `${pkgPath} is not valid JSON (${String(err.message).split('\n')[0]}). Fix it and re-run: setup reads the dev script and package manager from it.`,
  );
}
const pm = existsSync(join(cwd, 'pnpm-lock.yaml'))
  ? 'pnpm'
  : existsSync(join(cwd, 'yarn.lock'))
    ? 'yarn'
    : existsSync(join(cwd, 'bun.lockb'))
      ? 'bun'
      : 'npm';
// The lockfile says which package manager this project uses; it does not say the machine HAS it.
// `pnpm-lock.yaml` in a repo cloned onto a machine with only npm is an ordinary Monday, and the
// failure without this check is `spawn pnpm ENOENT` surfacing as "dev server exited" — which sends
// the reader into their dev script looking for a bug that is not there.
if (!which(pm)) {
  die(
    `this project uses ${pm} (its lockfile says so) and ${pm} is not installed on this machine. Install it (npm i -g ${pm}, or corepack enable), or pass --dev-cmd with a command that works here.`,
  );
}

/**
 * Where a dev command RUNS is not automatically where the app lives.
 *
 * A command we DISCOVERED in a package.json belongs to that package.json's directory. A command the
 * caller SUPPLIED belongs where they invoked setup — which for a monorepo is the root, because that
 * is where the workspace tooling lives. Running a supplied command inside the app directory broke a
 * real turbo monorepo: `./node_modules/.bin/turbo run develop --filter=web` resolved against
 * `apps/web/` and died with "No such file or directory", which reads as a broken dev script.
 */
let devCwd = cwd;

/** The dev command for whichever directory turned out to hold the app. */
function resolveDev(dir) {
  if (opts.devCmd !== undefined) {
    devCwd = cwd;
    return opts.devCmd;
  }
  try {
    const scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {};
    const name = DEV_SCRIPT_NAMES.find((k) => scripts[k] !== undefined);
    if (name === undefined) return null;
    devCwd = dir;
    return `${pm} run ${name}`;
  } catch {
    return null;
  }
}
result.app = { dir: appDir, packageManager: pm };

await new Promise((r) => prefetch.on('exit', r));
resolvedCli = resolvedCli.trim().split('\n').filter(Boolean).pop() ?? '';
if (resolvedCli !== '' && existsSync(resolvedCli)) result.cli = resolvedCli;
phase('detect');

// ---------------------------------------------------------------------------- phase 2: init

const statusUrl = `http://127.0.0.1:${opts.port}/status`;
const CLI = [WIN ? 'npx.cmd' : 'npx', ['--yes', '@reticlehq/server@latest']];
const cli = (args, o = {}) =>
  result.cli === undefined
    ? run(CLI[0], [...CLI[1], ...args], { shell: WIN, ...o })
    : run(result.cli, args, { shell: WIN, ...o });

// RETICLE_INSTALL_SOURCE is how an install is attributed. SKILL.md's hand path sets `skill_file`;
// without a value here every install through this script lands as nothing at all, and telemetry
// fails SILENTLY — nothing throws, no test reddens, the data is just permanently gone.
const initEnv = { ...process.env, RETICLE_INSTALL_SOURCE: 'setup_script' };
/**
 * Boot the daemon WHILE init runs, rather than paying for it inside the connect gate.
 *
 * The bridge daemon is started lazily by the first `open`/status call, so its boot lands in the
 * middle of the phase that is already the user's most anxious wait — measured at up to 15s. It is
 * shared, idempotent and idles itself out, so starting it early costs nothing and is exactly what
 * would have happened seconds later anyway. Detached and ignored: an existing daemon makes this
 * exit at once, and a daemon that cannot start is reported by the connect gate with far better
 * context than a race here could give.
 */
const serveCmd =
  result.cli === undefined ? [CLI[0], [...CLI[1], 'serve']] : [result.cli, ['serve']];
spawn(serveCmd[0], serveCmd[1], { cwd, shell: WIN, detached: !WIN, stdio: 'ignore' }).unref?.();

// `--port` is the BRIDGE port, and init writes it into .reticle.json. Not forwarding it meant a
// non-default port polled a bridge the project had never been told about: the SDK dialled 4400
// while this script watched 4500, and the failure read as "the SDK is not loading in the page".
const initFlags = [
  ...(opts.app === undefined ? [] : ['--app', opts.app]),
  ...(opts.port === BRIDGE_DEFAULT_PORT ? [] : ['--port', String(opts.port)]),
  ...opts.initArgs,
];
let init = cli(['init', ...initFlags], { cwd, env: initEnv });
let initOut = `${init.stdout ?? ''}${init.stderr ?? ''}`;

if (!existsSync(join(cwd, '.reticle.json'))) {
  // `init` not running at all is usually not about the project. npx has to REACH the registry
  // first, and offline / proxied / authenticated registries all fail here — telling the user
  // something about their app instead sends them to look in the wrong place entirely.
  const registryBroken =
    /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ERR_SOCKET_TIMEOUT|network|401 Unauthorized|403 Forbidden|E401|E403|registry/i.test(
      initOut,
    );
  die(
    registryBroken
      ? `could not fetch the Reticle CLI from the npm registry (${(process.env.npm_config_registry ?? 'https://registry.npmjs.org').replace(/\/$/, '')}). Setup never reached your project. If you are offline, behind a proxy, or on a private registry, fix npm's registry/proxy config and re-run — see .reticle-setup-init.log`
      : `init exited ${init.status} and wrote no .reticle.json — see .reticle-setup-init.log`,
  );
}
phase('init');

/**
 * Who owns the bridge port. Checked HERE — after init, before a dev server is booted — because a
 * stranger on it makes every later phase impossible, and finding out at the connect gate blames the
 * app's wiring for something that has nothing to do with the app.
 *
 *   free       nothing there; the daemon will bind it when it is needed
 *   daemon     ours, answering /status
 *   stranger   something is listening and it is not us
 */
async function bridgeOwner() {
  try {
    const res = await fetch(statusUrl, { signal: AbortSignal.timeout(2000) });
    const body = await res.json();
    if (typeof body?.running === 'boolean') return 'daemon';
  } catch {
    /* fall through to the listener check */
  }
  return listenersOn(opts.port).length > 0 ? 'stranger' : 'free';
}

if ((await bridgeOwner()) === 'stranger') {
  die(
    `port ${opts.port} is held by something that is not a Reticle daemon. That is the bridge — the ` +
      'channel between the daemon and the SDK in your page — so no session can ever appear while it ' +
      'is occupied, however correct the wiring is. Free it, or re-run with --port <n> and set the ' +
      'same port in .reticle.json.',
  );
}

/**
 * The workspaces this repo declares, filtered to the ones that can actually be served.
 *
 * A monorepo ROOT has no dev script by design. init will happily wire that root — it did, in the
 * scenario that found this — leaving a project that is instrumented in a directory nothing serves,
 * and a `⚠` that reads like a framework-detection problem. The app somebody is working in is the
 * one with a dev script, and it is discoverable without asking anybody.
 */
function workspaceApps(root) {
  const globs = [];
  try {
    globs.push(...(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces ?? []));
  } catch {
    /* none */
  }
  try {
    for (const m of readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').matchAll(
      /^\s*-\s*['"]?([^'"\n]+)/gm,
    ))
      globs.push(m[1].trim());
  } catch {
    /* not pnpm */
  }
  // Conventional layouts, for a repo that declares no workspaces but is plainly one.
  if (globs.length === 0) globs.push('apps/*', 'packages/*');
  const dirs = new Set();
  for (const g of globs) {
    const base = g.replace(/\/\*+$/, '');
    try {
      for (const e of readdirSync(join(root, base), { withFileTypes: true }))
        if (e.isDirectory()) dirs.add(`${base}/${e.name}`);
    } catch {
      /* that glob matches nothing here */
    }
  }
  return [...dirs].filter((d) => resolveDev(join(root, d)) !== null);
}

/**
 * The managed block, which is the part that outlives this run.
 *
 * `init` writes a marked block into CLAUDE.md and AGENTS.md — that block is what makes the NEXT
 * agent verify its own work instead of guessing, so a missing one is a silent loss of the whole
 * point, months later, with nothing to trace it to. The markers are also how a re-run stays
 * idempotent: a hand-written copy without them will never be updated again, which is why this
 * REPORTS a missing block rather than writing one itself.
 */
for (const f of ['CLAUDE.md', 'AGENTS.md']) {
  const path = join(cwd, f);
  if (!existsSync(path)) {
    todo(
      `init did not write ${f}. Re-run \`npx @reticlehq/server@latest init\` — do not hand-write it: without the reticle:begin/end markers a re-run can never update it.`,
    );
    continue;
  }
  if (!readFileSync(path, 'utf8').includes('reticle:begin')) {
    todo(
      `${f} exists but has no <!-- reticle:begin --> block, so the next agent will not be told to verify its work. Re-run init rather than pasting one in: the markers are what keep it updatable.`,
    );
  }
}

/**
 * Register with the coding agents `init` does not reach.
 *
 * `init` covers eight clients and only where it finds them installed. That leaves a real hole: VS
 * Code's USER-scope mcp.json exists on machines today and init only ever writes the project-scope
 * one, so a VS Code user gets no tools outside the repo they ran init in. Zed, Warp, Kiro, Amp,
 * Copilot CLI, Amazon Q, Factory Droid, Cline and Roo are not covered at all.
 *
 * The rules live in agents.mjs and are tested against a pretend filesystem for all three platforms.
 * The one worth repeating here: a documented path is written even for an absent agent, so a later
 * install is already wired — but a path we cannot evidence is refused, because a config file at a
 * guessed location is one nobody reads, which looks exactly like success.
 */
if (opts.agents) {
  const io = {
    exists: (f) => existsSync(f),
    readFile: (f) => readFileSync(f, 'utf8'),
    writeFile: (f, c) => writeFileSync(f, c),
    mkdir: (d) => mkdirSync(d, { recursive: true }),
  };
  const rows = applyAgents(planAgents({ exists: io.exists, readFile: io.readFile }), io);
  const wrote = rows.filter((r) => r.action === 'created' || r.action === 'merged');
  const manual = rows.filter((r) => r.action === 'manual');
  result.agents = rows.map((r) => ({ id: r.id, action: r.action, file: r.file }));
  if (wrote.length > 0)
    say(
      `registered the MCP server with ${wrote.length} more agent(s): ${wrote.map((r) => r.name).join(', ')}`,
    );
  for (const r of manual) todo(`${r.name}: ${r.why} — add the reticle entry to ${r.file} by hand.`);
  const skills = applySkills(io);
  result.skills = skills;
  if (skills.length > 0) say(`wrote the /reticle skill for ${skills.length} agent(s)`);
}

// Now the app is known — from --app, or it was the root all along.
appDir = opts.app === undefined ? cwd : resolve(cwd, opts.app);
let devCmd = resolveDev(appDir);

// Nothing to serve where we are pointed. Before giving up, look where an app could be: SKILL.md is
// explicit that the agent PICKS and re-runs, because asking which app they meant is the single most
// likely place an install stops, and the answer is nearly always already in the repo.
if (devCmd === null && opts.url === undefined && opts.app === undefined) {
  const candidates = workspaceApps(cwd);
  const pick = candidates[0];
  if (pick !== undefined) {
    say(
      `no dev script at the root, but ${candidates.length} workspace app${candidates.length === 1 ? '' : 's'} can be served — wiring ${pick}${candidates.length > 1 ? ` (first of ${candidates.join(', ')})` : ''}`,
    );
    result.pickedApp = pick;
    result.workspaceApps = candidates;
    opts.app = pick;
    appDir = resolve(cwd, pick);
    devCmd = resolveDev(appDir);
    const reinit = cli(['init', '--app', pick, ...opts.initArgs], { cwd, env: initEnv });
    initOut += `\n--- re-run with --app ${pick} ---\n${reinit.stdout ?? ''}${reinit.stderr ?? ''}`;
    for (const line of `${reinit.stdout ?? ''}${reinit.stderr ?? ''}`.split('\n')) {
      if (/^\s*[⚠ℹ]/.test(line)) todo(`init --app ${pick}: ${line.trim()}`);
    }
    if (candidates.length > 1)
      todo(
        `this repo has several runnable apps (${candidates.join(', ')}) and setup wired ${pick}. If the user meant another, re-run: reticle.sh --app <dir>`,
      );
  }
}

if (devCmd === null && opts.url === undefined) {
  die(
    `no ${DEV_SCRIPT_NAMES.join('/')} script in ${join(appDir, 'package.json')}, and no workspace app that has one, and no --url. SKILL.md says stop here rather than invent one.`,
  );
}
result.app = { ...result.app, dir: appDir, devCmd };

// A license key is a credential: into .env, never into git, never echoed back.
if (opts.license !== undefined) {
  const env = join(cwd, '.env');
  appendFileSync(env, `${existsSync(env) ? '\n' : ''}RETICLE_LICENSE_KEY=${opts.license}\n`);
  const ignore = join(cwd, '.gitignore');
  const ignored = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  if (!ignored.split('\n').some((l) => l.trim() === '.env')) appendFileSync(ignore, '\n.env\n');
  say('license key written to .env (and .env is gitignored)');
}

// ---------------------------------------------------------------------------- phase 3: dev server
//
// A dev server that was already running read the build config BEFORE init edited it. It keeps
// serving the old bundle, no session ever appears, and every symptom points at the wiring that is
// in fact correct. This is a 100% failure, not an intermittent one.

let url = opts.url;
let dev;
if (url === undefined) {
  if (opts.restartDev) {
    for (const p of COMMON_DEV_PORTS) {
      for (const pid of listenersOn(p)) {
        const owner = cwdOfPid(pid);
        if (owner === null) {
          todo(
            `something is listening on port ${p} and this platform will not say whose it is. If it is this project's dev server, restart it: it is serving a bundle from before init edited the build config.`,
          );
        } else if (owner.startsWith(cwd)) {
          say(`restarting stale dev server (pid ${pid}, port ${p}) — its bundle predates init`);
          killPid(pid);
        }
      }
    }
  }
  const log = join(cwd, '.reticle-setup-dev.log');
  writeFileSync(log, '');
  say(`starting: ${devCmd}`);
  say(`starting in ${devCwd === cwd ? 'the repo root' : devCwd}`);
  dev = spawn(devCmd, {
    cwd: devCwd,
    shell: true,
    detached: !WIN,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  devServer = dev;
  let buf = '';
  /**
   * When the dev server last said anything.
   *
   * A fixed budget is the wrong instrument for "is this hung?". The heaviest real monorepo in the
   * fixture set builds two shared packages before its app serves, and was measured taking twenty
   * minutes to come up — while a genuinely wedged server, which writes nothing at all, gets exactly
   * the same budget as the busy one. Output IS progress, so it buys more time; silence does not.
   */
  let lastOutputAt = Date.now();
  const collect = (c) => {
    buf += c;
    lastOutputAt = Date.now();
    appendFileSync(log, c);
  };
  dev.stdout.on('data', collect);
  dev.stderr.on('data', collect);
  // The dev tool prints its own URL. Never compose one: the port is its business, and a composed
  // guess is how a run waits on 5173 while vite has quietly moved to 5174.
  /**
   * Wait for a dev server, by any of the three things that actually prove one is up.
   *
   * 1. it printed a url            — the fast path, and what most tools do
   * 2. our process group bound a port — CRA prints nothing parseable in a non-tty; it was serving
   *                                  the whole time while setup timed out saying otherwise
   * 3. the launcher EXITED but a url it announced is answering — `astro dev` daemonizes: it forks
   *                                  the real server, prints the url, and the foreground process
   *                                  exits. Treating that exit as death failed Astro 100% of the
   *                                  time against a server that was running perfectly.
   */
  let daemonized = false;
  const found = await until(
    async () => {
      const announced = URL_IN_LOG.exec(buf)?.[0];
      if (dev.exitCode !== null) {
        // The launcher is gone. That is only fatal if nothing it started is answering.
        if (announced !== undefined && (await diagnose(announced)).served) {
          daemonized = true;
          return announced;
        }
        const port = listeningPortsOfGroup(dev.pid)[0];
        if (port !== undefined) {
          daemonized = true;
          return `http://localhost:${port}`;
        }
        die(
          `dev server exited without serving anything — see ${log}\n${buf.trim().split('\n').slice(-10).join('\n')}`,
        );
      }
      if (announced !== undefined) return announced;
      const port = listeningPortsOfGroup(dev.pid)[0];
      return port === undefined ? null : `http://localhost:${port}`;
    },
    opts.timeoutMs,
    500,
  );

  if (found === null) {
    die(
      `the dev server neither printed a URL nor bound a port in ${opts.timeoutMs / 1000}s — see ${log}\n${buf.trim().split('\n').slice(-10).join('\n')}`,
    );
  }
  url = found;
  if (daemonized) {
    // It escaped our process group, so nothing here can stop it later. Say so rather than pretend.
    result.daemonizedDevServer = true;
    say(
      `the dev server daemonized (its launcher exited while ${url} kept serving) — it is outside this process's control, so stop it with its own command when you are done`,
    );
  }

  // A URL in a log is an ANNOUNCEMENT, not readiness. Next prints `- Local: http://localhost:3100`
  // before it can serve anything, and treating that as up meant opening a browser tab at a url that
  // 404s, then waiting out the whole connect budget and blaming the SDK for a server that had not
  // finished starting.
  say(`waiting for ${url} to serve`);
  const ceiling = Date.now() + DEV_SERVER_CEILING_MS;
  let deadline = Date.now() + opts.timeoutMs;
  let serving = false;
  while (Date.now() < Math.min(deadline, ceiling)) {
    if (dev.exitCode !== null && !daemonized) {
      die(
        `dev server exited after announcing ${url} — see ${log}\n${buf.trim().split('\n').slice(-8).join('\n')}`,
      );
    }
    const d = await diagnose(url);
    // A TLS refusal means the server ANSWERED and we would not validate its certificate — it is up.
    if (d.served || d.tlsRefused === true) {
      serving = true;
      break;
    }
    // Still talking means still building. Push the deadline out rather than failing a working build.
    if (Date.now() - lastOutputAt < DEV_SERVER_QUIET_MS) deadline = lastOutputAt + opts.timeoutMs;
    await sleep(200);
  }
  if (!serving) {
    die(
      `${url} was announced by the dev server but never served a response, and it stopped producing output. The server is running and not answering — see ${log}:\n${buf.trim().split('\n').slice(-8).join('\n')}`,
    );
  }
}
result.app.url = url;
say(`app: ${url}`);
phase('devServer');

// ---------------------------------------------------------------------------- phase 4: connect
//
// The gate. Nothing below this line means anything without a session, and no report of a finished
// setup is honest without one.

async function allSessions() {
  try {
    const res = await fetch(statusUrl, { signal: AbortSignal.timeout(2000) });
    return (await res.json()).sessions ?? [];
  } catch {
    return [];
  }
}

let sessionsBeforeOpen = new Set();
async function sessionOn(target) {
  return pickSession(await allSessions(), target, sessionsBeforeOpen) ?? null;
}

/**
 * What the page itself says, when no session appeared. Three causes look identical from the
 * outside and need completely different answers, and an agent told only "no session" re-runs
 * `init` — the one action that cannot help.
 *
 *   not served          the dev server died or never bound; nothing to diagnose yet
 *   served, no SDK      the bundle predates init's edit to the build config. REPAIRABLE.
 *   served, SDK present it loaded and did not dial: a production guard, a localhost guard, or a
 *                       bridge port that differs on the two sides
 */
async function diagnose(target) {
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(5000) });
    const body = await res.text();
    return { served: true, sdkInPage: /@reticlehq|@reticle-connect|reticle-dev/.test(body) };
  } catch (err) {
    // A self-signed dev certificate REFUSES us while serving the browser perfectly well. Reporting
    // that as "nothing is listening" is a confident wrong cause, and the user goes to restart a dev
    // server that was never down.
    const tls = /certificate|SELF_SIGNED|DEPTH_ZERO|ERR_TLS|unable to verify/i.test(
      String(err?.cause?.message ?? err?.message ?? ''),
    );
    return { served: false, sdkInPage: false, tlsRefused: tls };
  }
}

/**
 * Open the app, and NOTICE when that fails.
 *
 * Discarding this status made every browserless machine — CI, a container, an SSH session, WSL
 * without a host browser, a box with no Chromium — look exactly like a broken SDK: setup waited out
 * the whole connect budget and then blamed the wiring. They need completely different answers, and
 * only one of them is about the app.
 */
function openApp(target) {
  // Not every caller wants a tab. CI has no browser to give one, a headless box has nowhere to put
  // it, and a user who already has the app open does not want a second. The connect gate below is
  // unchanged either way: something still has to dial in, or setup still fails.
  if (!opts.open) {
    say('not opening a browser (--no-open): something else has to connect to this url');
    return true;
  }
  const r = cli(['open', target], { cwd });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status === 0) return true;
  const noBrowser =
    /chromium|chrome|browser|playwright|executable doesn'?t exist|ENOENT|DISPLAY/i.test(out);
  const headless =
    process.env.CI !== undefined ||
    (process.platform === 'linux' && process.env.DISPLAY === undefined);
  todo(
    noBrowser || headless
      ? `no browser could be opened on this machine${headless ? ' (headless: CI, a container, or no DISPLAY)' : ''}, so nothing will ever dial in from a tab. Take a tab Reticle owns instead: reticle_run({ tool: "reticle_lease", args: { action: "acquire", url: "${target}" } }) — or open ${target} yourself in a browser that can reach this host.`
      : `\`reticle open ${target}\` failed: ${out.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`,
  );
  return false;
}

// Anything already on this url belongs to an earlier run or an old tab. Recording them first is
// what lets the picker above tell "ours" from "someone's leftovers".
sessionsBeforeOpen = new Set((await allSessions()).map((s) => s.sessionId));
if (sessionsBeforeOpen.size > 0)
  say(
    `${sessionsBeforeOpen.size} session(s) already on this daemon — preferring whichever tab this run opens`,
  );
openApp(url);
let session = await until(() => sessionOn(url), opts.timeoutMs, 250);

if (session === null) {
  // One repair, for the cause that outweighs every other by a wide margin: a dev server that read
  // the build config BEFORE init edited it. It keeps serving the old bundle, so the wiring is
  // correct and nothing connects. The agent arm spends turns rediscovering this every time.
  const before = await diagnose(url);
  result.diagnosis = before;
  if (before.served && !before.sdkInPage) {
    let restarted = false;
    if (dev !== undefined) {
      say(
        'the page is served without the SDK in it — restarting the dev server we started, whose bundle predates init',
      );
      killTree(dev);
      say(`starting in ${devCwd === cwd ? 'the repo root' : devCwd}`);
      dev = spawn(devCmd, {
        cwd: devCwd,
        shell: true,
        detached: !WIN,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      devServer = dev;
      dev.stdout.resume();
      dev.stderr.resume();
      restarted = (await until(() => diagnose(url).then((d) => d.served), opts.timeoutMs)) !== null;
    } else {
      // Somebody else's server on --url. Ownership decides whether restarting it is ours to do;
      // SKILL.md is explicit that we never kill what we did not start.
      const owner = listenersOn(new URL(url).port)
        .map(cwdOfPid)
        .find((c) => c?.startsWith(cwd));
      if (owner !== undefined) {
        say(
          "the page is served without the SDK in it — restarting this project's dev server, whose bundle predates init",
        );
        for (const pid of listenersOn(new URL(url).port))
          if (cwdOfPid(pid)?.startsWith(cwd)) killPid(pid);
        todo(
          `restarted the dev server on ${url}; if it does not come back up, start it yourself with: ${devCmd ?? 'your dev script'}`,
        );
      } else {
        todo(
          `${url} is served WITHOUT the SDK in the page, and the server is not ours to restart. It read the build config before init edited it: restart it and hard-reload the tab.`,
        );
      }
    }
    if (restarted || dev === undefined) {
      openApp(url);
      session = await until(() => sessionOn(url), opts.timeoutMs, 250);
    }
  }
}

if (session === null) {
  const after = result.diagnosis ?? (await diagnose(url));
  die(
    !after.served
      ? after.tlsRefused === true
        ? `${url} is served over HTTPS with a certificate this process will not accept, so setup cannot read the page to diagnose it. The app itself may be fine. Re-run with NODE_TLS_REJECT_UNAUTHORIZED=0 if you trust this dev certificate, or point setup at the http origin.`
        : `nothing is serving ${url} — the dev server is not up, so the SDK was never given the chance to load. Start it: ${devCmd ?? 'your dev script'}`
      : after.sdkInPage
        ? `the SDK is IN the page at ${url} and never dialled the bridge. It loaded and returned early. In order: is the connect guarded on hostname === 'localhost' (false on every non-localhost dev host, and window does not exist during SSR), is it behind a production-only check, and is the bridge port ${opts.port} the same number on both sides. curl https://docs.reticle.sh/troubleshooting.md`
        : `${url} is served but the SDK is NOT in the page, and restarting the dev server did not change that. The build config edit did not take: check the plugin is in the plugins array (Vite) or withReticle wraps the export and the dev component is mounted in the root layout (Next). curl https://docs.reticle.sh/install-manual.md`,
  );
}
/**
 * A connected session is not yet the thing the user came for.
 *
 * The point of this whole script is that somebody WATCHES their own app being driven — the HUD, the
 * glow, the cursor moving through their flow. That only happens in a visible, foreground tab. The
 * daemon knows the difference and says so: a hidden or throttled tab has its timers and rAF clamped,
 * so an action can land on a page that never advances, and the run then produces a verdict of
 * `unknown` for a reason that has nothing to do with the app.
 *
 * So a background tab is worth one focus attempt and, failing that, a loud line — not silence.
 */
if (session.hidden === true || session.throttled === true) {
  say(
    'the connected tab is in the background — bringing it to the front, because watching it drive IS the demo',
  );
  openApp(url);
  const refocused = await until(
    async () => {
      const s = await sessionOn(url);
      return s !== null && s.hidden !== true && s.throttled !== true ? s : null;
    },
    10_000,
    1000,
  );
  if (refocused !== null) session = refocused;
}
result.session = {
  id: session.sessionId,
  url: session.url,
  hasCapabilities: session.hasCapabilities,
  visible: session.hidden !== true && session.throttled !== true,
};
if (!result.session.visible) {
  todo(
    `the app is connected but its tab is hidden or throttled, so timers and rAF are clamped and an action can land on a page that never advances. Bring ${url} to the front before driving — and tell the user to keep it visible: watching Reticle drive their own app is the point.`,
  );
}
say(
  `connected: ${session.sessionId}${result.session.visible ? ' (tab is visible)' : ' (TAB IS HIDDEN)'}`,
);
phase('connect');

// ---------------------------------------------------------------------------- phase 5: verdict
//
// The restart bottleneck, deleted. The calling client read its MCP server list at ITS startup and
// cannot reload it — that is why SKILL.md has to ask for a restart. But the drive does not need the
// CALLER to have the tools; it needs A PROCESS that has them, and a child `claude -p` reads the
// list init just wrote. No human round trip, no resume, no lost context.

/**
 * Who can drive, in preference order.
 *
 * The drive is what turns an install into the thing the user came for, and it needs ONE process
 * that holds the reticle_* tools — not this one, and not necessarily Claude. Restricting it to
 * `claude` meant a Cursor or Codex user got a connected app and no verdict at all: the whole point,
 * withheld because of which CLI they happen to use.
 *
 * Every entry is PROBED before it is trusted. A CLI can be on PATH and not run — this machine has a
 * codex whose vendor binary is missing, which exits non-zero on every invocation — and restarting
 * into one of those produces an empty session that looks exactly like success.
 *
 * The prompt always goes on STDIN. Passing it positionally is what made the claude call swallow it
 * as an extra value of the variadic --allowedTools, and no flag ordering is safe across four CLIs.
 */
const DRIVERS = [
  {
    id: 'claude',
    bin: 'claude',
    probe: ['--version'],
    argv: (tools) => [
      '-p',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      tools,
      ...(opts.driveModel === undefined ? [] : ['--model', opts.driveModel]),
      '--max-budget-usd',
      String(opts.driveBudget),
      // stream-json, not json: `json` emits NOTHING until the run completes, so a drive killed at
      // the timeout left no trace of where it got stuck — measured four times on the same app,
      // every one reporting "the drive produced no output ... nothing on stderr either". spawnSync
      // returns the stdout collected before it kills, so streaming turns that into evidence.
      '--output-format',
      'stream-json',
      '--verbose',
    ],
    parse: (out) => {
      // NDJSON. The last line carrying a cost is the result; if there is none, the run was killed
      // mid-flight and the most recent assistant text is the best account of where it had got to.
      const events = String(out)
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return undefined;
          }
        })
        .filter(Boolean);
      const done = [...events].reverse().find((e) => e?.total_cost_usd !== undefined);
      if (done !== undefined) {
        return { text: done.result ?? '', turns: done.num_turns, cost: done.total_cost_usd };
      }
      const lastSaid = [...events]
        .reverse()
        .flatMap((e) => (e?.type === 'assistant' ? (e.message?.content ?? []) : []))
        .find((c) => c?.type === 'text' || c?.type === 'tool_use');
      const where =
        lastSaid?.type === 'tool_use'
          ? `it was calling \`${lastSaid.name}\``
          : lastSaid?.text !== undefined
            ? `the last thing it said was: ${String(lastSaid.text).slice(0, 300)}`
            : 'it produced no events at all';
      return {
        text: '',
        turns: events.filter((e) => e?.type === 'assistant').length,
        incomplete: where,
      };
    },
  },
  // Verified flags, unverified end-to-end: neither has been watched driving a real app here, so
  // they are tried only when claude is absent, and a silent failure falls through to the next.
  {
    id: 'opencode',
    bin: 'opencode',
    probe: ['--version'],
    argv: () => ['run'],
    parse: (out) => ({ text: out }),
  },
  {
    id: 'cursor-agent',
    bin: 'cursor-agent',
    probe: ['--version'],
    argv: () => ['-p', '--output-format', 'text'],
    parse: (out) => ({ text: out }),
  },
  // Gemini takes its prompt as the value of -p, not on stdin, and gates MCP servers by name.
  {
    id: 'gemini',
    bin: 'gemini',
    probe: ['--version'],
    promptAs: 'arg',
    argv: (_tools, prompt) => [
      '-p',
      prompt,
      '--allowed-mcp-server-names',
      'reticle',
      '--output-format',
      'text',
    ],
    parse: (out) => ({ text: out }),
  },
];

/**
 * Saved flows, wherever this project keeps them.
 *
 * `.reticle/` lives at the PROJECT root, and in a monorepo that is the app directory rather than
 * where setup was invoked. Looking only in the cwd reported "no verdict" for a run whose drive had
 * saved a flow and said so — a false NEGATIVE, which is the mirror of the failure this script
 * exists to prevent and just as misleading: it exits non-zero and tells the user a successful
 * install failed.
 */
function savedFlowsIn() {
  const seen = new Set();
  for (const root of [cwd, appDir]) {
    try {
      for (const f of readdirSync(join(root, '.reticle', 'flows'))) seen.add(f);
    } catch {
      /* no flows kept there */
    }
  }
  return [...seen];
}

/** The grade `reticle_flow_save` reported, read out of the child's own prose. */
function readGrade(text) {
  return (
    /assertions?\.?grade\W+`?([a-z-]+)/i.exec(text ?? '')?.[1] ??
    /grade\W+`?([a-z-]+)/i.exec(text ?? '')?.[1]
  );
}

/** On PATH AND actually runnable. The second half is the one that has bitten. */
function usableDriver() {
  for (const d of DRIVERS) {
    if (!which(d.bin)) continue;
    const probe = run(d.bin, d.probe, { timeout: 20_000 });
    if (probe.status === 0) return d;
    say(
      `${d.bin} is on PATH but does not run (${`${probe.stderr ?? ''}`.trim().split('\n')[0].slice(0, 120)}) — skipping it`,
    );
  }
  return null;
}

/**
 * A saved flow makes the second run free.
 *
 * SKILL.md's very first instruction branches on this and setup ignored it: `.reticle.json` exists
 * means VERIFY, not SETUP. The first drive of a journey is expensive — a model choosing what to
 * prove, which is ~70% of this script's wall clock. Every drive after it should not be. `verify`
 * replays what was recorded, deterministically, with no model in the loop at all.
 *
 * So a re-run reaches a verdict in seconds instead of minutes, and costs nothing.
 */
const savedFlows = (() => {
  try {
    return savedFlowsIn();
  } catch {
    return [];
  }
})();

// Probed once, before either branch: a replay needs no driver, but knowing whether one exists is
// what makes the "nobody drove this" message below true rather than a guess.
const driver = opts.drive && savedFlows.length === 0 ? usableDriver() : null;

if (opts.drive && savedFlows.length > 0) {
  say(
    `${savedFlows.length} saved flow(s) — replaying instead of driving: deterministic, and no model in the loop`,
  );
  const replay = cli(['verify', url], { cwd, timeout: DRIVE_TIMEOUT_MS });
  const out = `${replay.stdout ?? ''}${replay.stderr ?? ''}`.trim();
  result.verdict = out.slice(-2000);
  result.replayed = true;
  result.flowSaved = true;
  say(out.split('\n').slice(-12).join('\n'));
  // Exit code is the verdict: 0 pass, non-zero anything else. A replay that fails is a REGRESSION
  // in the app, not a setup failure — saying otherwise sends the user to reinstall over a real bug.
  if (replay.status !== 0) {
    todo(
      `the saved flow(s) did not pass on replay (exit ${replay.status}). Setup is fine — this is the app failing a journey it used to pass. Read the report above before changing anything about the install.`,
    );
  }
  phase('replay');
} else if (opts.drive && driver !== null) {
  // Everything the child would otherwise spend a turn discovering, handed over up front.
  const capsFile = ['reticle-dev.tsx', 'reticle-dev.ts', 'reticle-dev.jsx', 'reticle-dev.js']
    .map((f) => join(appDir, 'src', f))
    .find(existsSync);
  const caps =
    capsFile === undefined
      ? ''
      : `\n\nIts capabilities file (${capsFile}):\n${readFileSync(capsFile, 'utf8').slice(0, 4000)}`;
  /**
   * The capabilities file, and why the child is allowed to EDIT.
   *
   * `init` scaffolds src/reticle-dev.* from the data-testid values it found and leaves the rest —
   * that is the `ℹ AGENT: finish the capabilities file` line people skim past. Unfinished, the app
   * registers no store, `reticle_state` returns nothing, and every verdict rests on the DOM alone.
   * SKILL.md is explicit: finish it BEFORE you drive, and never report a clean install over an
   * empty state read.
   *
   * The previous flags made that impossible. `--allowedTools mcp__reticle` permits the Reticle
   * tools and NOTHING else, so the one repair the instructions demand was denied by the same call
   * that asked for it — and the run reported success anyway. Edit/Write/Read are granted only when
   * the session says the capabilities are missing, so a healthy install still drives with the
   * Reticle surface alone.
   */
  const needsCapabilities = session.hasCapabilities === false;
  const capsTask =
    needsCapabilities && capsFile !== undefined
      ? `\n\nFIRST, before you drive: this session reports hasCapabilities:false, so ${capsFile} was scaffolded and never finished. Open it, register the app's store if it has one, and list the testids the flow you are about to drive actually touches. A few lines.\n\nEDIT ONLY ${capsFile}. You have write access for that one file and nothing else: this is somebody's repository, not a scratch copy, and setup silently changing their application source is not a trade they agreed to. If the app is broken in a way that blocks the drive — a build error, a missing asset, an auth wall — SAY SO and stop. That is a finding worth having, and it is theirs to fix.`
      : '';
  const throttleWarning = result.session.visible
    ? ''
    : '\n\nNOTE: this tab is hidden or throttled, so timers and rAF are clamped. If an action seems to land on a page that never advances, that is why — say so rather than reporting `unknown` as if the app were at fault.';
  // The TASK LEADS. Measured: with the situation first and a capabilities dump in the middle, a
  // model answered "I don't see an actual task or request from you yet" and drove nothing — one
  // turn, no verdict, and setup called it a success. Context after the ask, never before it.
  const prompt =
    `TASK: drive ${opts.flow === undefined ? 'one user flow' : `THIS flow — ${opts.flow}`} in this ` +
    'running app and produce a verdict. Do it now; do not ask questions, there is nobody to answer.\n\n' +
    `The app is at ${url} and Reticle session ${session.sessionId} is connected to it.${caps}${capsTask}${throttleWarning}\n\n` +
    'Drive the single most important user flow, in as few calls as you can: ONE ' +
    "reticle_snapshot({mode:'interactive'}) for the whole flow, reticle_act_sequence for every fill " +
    'and intermediate click in one call, then ONE reticle_act_and_wait({ref,action,until}) — that is ' +
    'the call that produces the verdict, and `until` names the expected consequence BEFORE the action ' +
    'fires. Then reticle_state() once. Wrap it in reticle_record start/stop and reticle_flow_save.\n\n' +
    'Then CHECK the grade `reticle_flow_save` returns. If it is not `asserted`, the flow only ACTS: ' +
    'it will pass even when the feature is broken, and this setup replays that flow on every later ' +
    'run — so an unasserted flow becomes a permanent green that proves nothing. If the grade is not ' +
    '`asserted`, record it again with an `until` that names a consequence the action CHANGES (the ' +
    'text that appears, the request that fires, the route that moves), and keep going until it is.\n\n' +
    'Report: the flow name, the verdict, and assertions.grade. A verdict of "unknown" or "no-fault" ' +
    'is NOT a pass — say so plainly rather than weakening the check until it passes.';
  // Comma-separated, and the prompt goes on STDIN. `--allowedTools` is variadic: with the prompt
  // passed positionally after it, the flag swallowed the prompt as another tool name and claude
  // exited with "Input must be provided" — in 2 seconds, with everything on stderr, which this
  // script discarded. The drive silently never happened and setup reported the install fine.
  const tools = needsCapabilities ? 'mcp__reticle,Read,Edit,Write' : 'mcp__reticle';
  say('');
  say(`  ▸ WATCH ${url} NOW — the HUD is on, and you are about to see Reticle drive your app.`);
  say('');
  say(
    `driving one flow in a fresh ${driver.bin} process (it has the reticle_* tools; the caller does not yet)${needsCapabilities ? ' — and finishing the capabilities file first' : ''}`,
  );
  // A budget, like every other phase. Without one a wedged `claude -p` wedges setup itself, and the
  // user watches a terminal that will never come back.
  const child =
    driver.promptAs === 'arg'
      ? run(driver.bin, driver.argv(tools, prompt), { cwd, timeout: DRIVE_TIMEOUT_MS })
      : run(driver.bin, driver.argv(tools, prompt), {
          cwd,
          timeout: DRIVE_TIMEOUT_MS,
          input: prompt,
        });

  if (child.error?.code === 'ETIMEDOUT' || child.signal !== null) {
    todo(
      `the drive did not finish within ${DRIVE_TIMEOUT_MS / 60_000} minutes (budget $${opts.driveBudget}) and was stopped. The app IS installed and connected at ${url}; drive it yourself: snapshot once, act_sequence for the setup, ONE act_and_wait for the verdict.`,
    );
  }
  const parsed = driver.parse(`${child.stdout ?? ''}`);
  result.verdict = (parsed.text ?? '').trim().slice(-2000);
  result.driver = driver.id;
  result.driveTurns = parsed.turns;
  result.driveCostUsd = parsed.cost;
  // A drive that produced nothing is a FAILED drive, and it used to leave no trace at all: stderr
  // was discarded, so the one thing that could explain it was the one thing thrown away.
  if (parsed.incomplete !== undefined) {
    todo(
      `the drive did not finish, and ${parsed.incomplete}. That is where to look — the app IS installed and connected at ${url}.`,
    );
  }
  if (result.verdict === '') {
    todo(
      `the drive produced no output (exit ${child.status}): ${`${child.stderr ?? ''}`.trim().split('\n').slice(-3).join(' ').slice(0, 400) || 'nothing on stderr either'}`,
    );
  }
  say(result.verdict);
  result.flowSaved = savedFlowsIn().length > 0;

  /**
   * A saved flow is only worth replaying if it ASSERTS something.
   *
   * `reticle_flow_save` grades what it recorded, and anything other than `asserted` means the flow
   * merely acts: it will pass even when the feature is broken. That matters more here than in a
   * hand-driven session, because this script makes replay the fast path for every later run — so an
   * assertion-free flow turns each of those into a green that proves nothing, cheaply and forever.
   *
   * Measured, and this is why it is checked rather than trusted: a faster drive model produced
   * `verified: "yes"` with an `assertion-free` saved flow in two runs out of three. The verdict was
   * real; the artifact it left behind was not.
   */
  let grade = readGrade(result.verdict);

  /**
   * A weak artifact is escalated, not accepted.
   *
   * Measured: a faster drive model reaches the same `verified: "yes"` three times faster and leaves
   * an `assertion-free` or `presence-only` flow — one that only ACTS, so it passes even when the
   * feature is broken. Since setup replays saved flows on every later run, that is a permanent
   * green. Presenting this as a trade the user must choose between is worse than resolving it: run
   * the fast model, and when the artifact comes back weak, re-record ONCE with the stronger one.
   * The common case keeps the speed; the bad case costs a second drive and yields a real flow.
   */
  if (
    opts.escalate &&
    opts.driveModel !== undefined &&
    result.flowSaved &&
    grade !== undefined &&
    grade !== 'asserted'
  ) {
    say(
      `the saved flow graded \`${grade}\`, not \`asserted\` — re-recording once with the default model so the flow is worth replaying`,
    );
    const strong = run(
      driver.bin,
      driver
        .argv(tools, prompt)
        .filter((a2, i, arr) => a2 !== '--model' && arr[i - 1] !== '--model'),
      {
        cwd,
        timeout: DRIVE_TIMEOUT_MS,
        input: prompt,
      },
    );
    const reparsed = driver.parse(`${strong.stdout ?? ''}`);
    const regrade = readGrade(reparsed.text);
    result.escalated = { from: grade, to: regrade ?? 'unknown' };
    if (regrade === 'asserted') {
      result.verdict = (reparsed.text ?? '').trim().slice(-2000);
      grade = regrade;
      say('re-record produced an `asserted` flow');
    } else {
      say(
        `re-record still graded \`${regrade ?? 'unknown'}\` — reporting the weakness rather than hiding it`,
      );
    }
  }

  result.assertionsGrade = grade;
  if (result.flowSaved && grade !== undefined && grade !== 'asserted') {
    todo(
      `the saved flow graded \`${grade}\`, not \`asserted\` — it only ACTS, so it will pass even when the feature is broken. Re-running setup will replay it and report a green that proves nothing. Re-record it with an \`until\` that names a consequence the action CHANGES.`,
    );
  }
  if (!result.flowSaved)
    todo(
      'the drive saved no flow — step 5 is unfinished, and setup is not complete without a verdict.',
    );
  phase('drive');
} else if (opts.drive) {
  todo(
    `no usable agent CLI found (tried ${DRIVERS.map((d) => d.bin).join(', ')}), so nobody drove the app. It IS installed and connected at ${url} — drive it yourself: snapshot once, act_sequence for the setup, ONE act_and_wait for the verdict.`,
  );
  if (session.hasCapabilities === false) {
    todo(
      'this session reports hasCapabilities:false — finish src/reticle-dev.* (register the store, list the testids your flow touches) BEFORE driving, or reticle_state returns nothing and the verdict rests on the DOM alone.',
    );
  }
}

function which(bin) {
  return run(WIN ? 'where' : 'which', [bin]).status === 0;
}

// ---------------------------------------------------------------------------- relaunch
//
// Restart the caller so it picks up the MCP server, without a human doing it.
//
// A client reads its MCP list ONCE, at startup. Nothing inside the process can reload it, so the
// only way is a restart — and only whatever LAUNCHED the process can perform one. Three routes,
// strongest first, each refused rather than faked when its precondition is missing:
//
//   1. a supervisor is waiting (CL_RUN)  write the handoff, end this process, and it relaunches
//                                        with --resume in the SAME terminal, context intact
//   2. a terminal we can drive           open a new window running `claude --resume <id>`
//   3. neither                           print the one command, rather than guess
//
// The session id is load-bearing: `--resume` on an id with no transcript opens an EMPTY
// conversation under that id, with no error anywhere. An id we cannot verify is not used.

const RESUME_PROMPT = 'continue - verify using reticle';

/** A transcript for this session must exist, or resuming lands in an empty conversation. */
function transcriptExists(sessionId) {
  for (const base of [
    join(homedir(), '.claude-shared', 'projects'),
    join(homedir(), '.claude', 'projects'),
  ]) {
    try {
      for (const proj of readdirSync(base)) {
        if (existsSync(join(base, proj, `${sessionId}.jsonl`))) return true;
      }
    } catch {
      /* that history directory does not exist on this machine */
    }
  }
  return false;
}

/** Open a new terminal window running `cmd`. False where we cannot drive one — a headless box. */
function openTerminalRunning(cmd) {
  if (WIN) {
    if (run('where', ['wt.exe']).status === 0)
      return run('wt.exe', ['cmd', '/k', cmd]).status === 0;
    return run('cmd', ['/c', 'start', '', 'cmd', '/k', cmd]).status === 0;
  }
  if (process.platform === 'darwin') {
    const app = process.env.TERM_PROGRAM === 'iTerm.app' ? 'iTerm' : 'Terminal';
    return (
      run('osascript', ['-e', `tell application "${app}" to do script ${JSON.stringify(cmd)}`])
        .status === 0
    );
  }
  for (const [bin, args] of [
    ['x-terminal-emulator', ['-e']],
    ['gnome-terminal', ['--']],
    ['konsole', ['-e']],
    ['xterm', ['-e']],
  ]) {
    if (which(bin)) return run(bin, [...args, 'sh', '-c', `${cmd}; exec $SHELL`]).status === 0;
  }
  return false;
}

if (opts.relaunch) {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  const claudePid = process.env.CLAUDE_PID;
  const resumeCmd = `cd ${JSON.stringify(cwd)} && claude --resume ${sessionId} ${JSON.stringify(RESUME_PROMPT)}`;

  // Codex, when the caller is not Claude Code. Kept as a separate branch rather than folded into a
  // table of two, because the two clients are identified by opposite means and only one of them can
  // hand back to a supervisor: Claude Code names its own session in the environment, codex does not
  // and has to be recognised from the transcript it is writing. See codexSession.
  //
  // UNVERIFIED END-TO-END, and said plainly for the same reason the driver table says it: the codex
  // on this machine has no vendor binary, so `codex resume` has never been watched reopening a real
  // conversation from here. The identification half IS verified — it reads real rollout files.
  const codexId = sessionId === undefined ? codexSession(cwd) : undefined;
  if (sessionId === undefined && codexId !== undefined) {
    const cmd = `cd ${JSON.stringify(cwd)} && codex resume ${codexId} ${JSON.stringify(RESUME_PROMPT)}`;
    if (openTerminalRunning(cmd)) {
      result.relaunch = 'new-window';
      say(
        'reopened this codex conversation in a new terminal window with the tools loaded — this one can be closed.',
      );
    } else {
      result.relaunch = 'manual';
      todo(`could not open a terminal here, so the restart is yours: ${cmd}`);
    }
  } else if (sessionId === undefined) {
    // Gemini exports GEMINI_CLI=1 and nothing else; most clients tell a child nothing at all.
    todo(
      'this client does not tell a child process which conversation it is, so nothing here can resume it. Restart it once and the reticle_* tools will be there.',
    );
  } else if (!transcriptExists(sessionId)) {
    todo(
      `refusing to restart: no transcript exists yet for ${sessionId}, and \`--resume\` on an id with no transcript opens an EMPTY conversation that looks exactly like it worked. Say something in this session first, then re-run with --relaunch.`,
    );
  } else if (process.env.CL_RUN !== undefined && claudePid !== undefined) {
    const dir = process.env.CL_HANDOFF_DIR ?? join(homedir(), '.claude-shared', 'cl-handoff');
    mkdirSync(dir, { recursive: true });
    const account =
      (process.env.CLAUDE_CONFIG_DIR ?? '.claude')
        .split(/[\\/]/)
        .pop()
        .replace(/^\.claude-?/, '') || 'default';
    writeFileSync(join(dir, process.env.CL_RUN), `${account}\t${sessionId}\n`);
    result.relaunch = 'supervisor';
    say(
      'handing back to the supervisor: this conversation restarts with the reticle tools loaded.',
    );
    setTimeout(() => {
      try {
        process.kill(Number(claudePid), 'SIGTERM');
      } catch {
        /* already gone */
      }
    }, 1000).unref();
  } else if (openTerminalRunning(resumeCmd)) {
    result.relaunch = 'new-window';
    say(
      'reopened this conversation in a new terminal window with the tools loaded — this one can be closed.',
    );
  } else {
    result.relaunch = 'manual';
    todo(`could not open a terminal here, so the restart is yours: ${resumeCmd}`);
  }
}

/**
 * A setup that never produced a verdict did not succeed, and must not exit 0.
 *
 * SKILL.md is explicit — do not report Reticle as set up until a verdict exists — and the exit code
 * is the one place a caller reads that without parsing anything. Measured: a drive returned in a
 * single turn having done nothing ("I don't see an actual task or request from you yet") and setup
 * exited 0 with flowSaved:false. Anything scripting this would have shipped on it.
 *
 * `--no-drive` is the deliberate opt-out and stays a success: the caller took ownership of step 5.
 */
const verdictMissing = opts.drive && result.flowSaved !== true;
if (verdictMissing) {
  todo(
    'setup did NOT produce a verdict, so it is not complete. The app is installed and connected — drive one flow yourself, or re-run. Exiting non-zero because an exit code of 0 here would be a false green.',
  );
}

// The dev server stays UP. It is the whole deliverable: an instrumented app the user can watch.
// Ownership passes to the user here, so the interrupt teardown must not fire on the way out.
devServer = undefined;
dev?.unref();
dev?.stdout?.destroy();
dev?.stderr?.destroy();
finish(verdictMissing ? 1 : 0);
