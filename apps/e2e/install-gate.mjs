// Tier 1: install Reticle into apps that have never seen it, and check a session actually appears
// AND can answer a state question (`hasCapabilities`). Connected is not verifiable.
//
// Every gate in this repo is blind to the install. `apps/bench-app`, `apps/next-smoke` and the rest
// are ALREADY instrumented, so re-running `init` over one reports `·` (already wired) for every step
// and proves nothing — which is exactly how a Next.js install shipped connecting 0% of the time
// through three independent defects, none of which any check short of opening a browser could see.
//
// The pristine surface is SCAFFOLDED rather than vendored. `npm create vite` and `create-next-app`
// produce apps that have never seen Reticle, in seconds, with nothing to store or maintain. That
// catches install REGRESSIONS. It does not catch install COMPLEXITY — a 70-dependency app with ten
// Vite plugins is a different question, and it belongs in the reticle-fixtures gate (Tier 2), which
// is slower and cannot block a PR. Conflating the two gives a gate too slow to block and too shallow
// to trust.
//
// Four scaffolds, because `init` has four genuinely different paths into an app. The third matters
// most for framework reasons: a Pages Router app has no `app/` root layout to patch, so connect has
// to mount through `pages/_app` — and that is the path that once did nothing at all, silently.
//
// The fourth is a different axis entirely: the first three are all the same SHAPE — a single-app root
// with `init` run inside it — and that sameness is what made this gate blind to four init defects one
// user hit in eight minutes. `monorepo-subdir` is the shape those live in.
//
//   pnpm gate:install                 # all scaffolds
//   node apps/e2e/install-gate.mjs --only next-pages-router [--keep]
//   pnpm gate:install:self-test       # negative control: every scaffold must go RED
import { execFileSync, spawn } from 'node:child_process';

// ── Never phone home from the gate ───────────────────────────────────────────────────────────────
//
// Set BEFORE anything spawns, and on this process rather than per-call, so every child inherits it —
// the `reticle init` runs, the dev servers, and the daemon whichever of them starts it. Per-spawn
// env is how the next site added here quietly leaks.
//
// This is the ONE harness the source-checkout guard does not cover. That guard walks up from `cwd`
// looking for the monorepo's package.json, and this gate deliberately scaffolds PRISTINE apps into
// the OS temp directory and installs Reticle into them from a local Verdaccio — which is the entire
// point of it, and which means those daemons are, correctly, not in a source checkout.
//
// So it emitted real events. Measured in one day of production data: 308 CI rows from 19 distinct
// anonymous ids — every runner a brand-new "user" — carrying 144 of the 169 `init_completed` events
// and 19 `reticle_installed`. The gate was the majority of our own install funnel, and on a release
// branch it reports that branch's version, so unreleased versions appear in production dashboards.
//
// `RETICLE_TELEMETRY=0` and not `RETICLE_TELEMETRY_FILE`: the gate asserts on `init`'s printed plan,
// never on emitted events, so there is nothing here worth recording.
process.env.RETICLE_TELEMETRY = '0';

// ── And say what we are, whoever is running us ──────────────────────────────────────────────────
//
// `CI` is how every event decides whether it came from a pipeline, and it is only ever set by the
// runner. A gate driven from a laptop or from a cloud agent sandbox therefore reports itself as a
// human at a machine — which is how our own gate traffic became indistinguishable from a user's in
// the one dataset that decides what gets built. Set here rather than relied on from the environment,
// so the claim is true regardless of who invoked this.
//
// The telemetry line above already silences the events; this is belt and braces for anything that
// re-enables them (a debug run recording to a local sink) and for the CLI's own CI-shaped defaults.
process.env.CI = process.env.CI ?? 'true';
// Corepack, silenced before it can ask a question nobody is there to answer.
//
// If any scaffold's manifest carries a `packageManager` field — `create-next-app` has shipped one
// in the past and may again — corepack intercepts every `npm`/`pnpm` call and, for a version it
// does not have cached, prints a y/N download prompt and WAITS. Nothing is attached to that stdin,
// so the gate does not fail: it hangs until the job's timeout, and a timeout says "the install
// takes too long on Windows" rather than "a prompt is waiting". Two variables turn a hang into
// either a normal install or a named error.
process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
process.env.COREPACK_ENABLE_STRICT = process.env.COREPACK_ENABLE_STRICT ?? '0';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  freePortSafely,
  killTree,
  startOwnedDaemon,
  watchTransport,
  attributeOutcome,
  Attribution,
  sweepBatteryOrphans,
} from './gate-harness.mjs';

const WIN = 'win32' === process.platform;

/**
 * `npm`, `npx` and `pnpm` are `.cmd` shims on Windows, and Node will not run one for you.
 *
 * Two separate obstacles, and clearing only the first is what made the first Windows run of this
 * gate die on `spawn EINVAL` at the very first command:
 *
 *  1. CreateProcess does not consult PATHEXT, so `spawn('npm', …)` is ENOENT even though npm plainly
 *     works in that shell. The file wanted is `npm.cmd`.
 *  2. Node then REFUSES to spawn a `.cmd` or `.bat` without `shell: true` — the fix for
 *     CVE-2024-27980, where batch files re-parse their own arguments. That refusal is `EINVAL`,
 *     which names neither the file nor the reason.
 *
 * So the shell is not optional here, and the argument-reinterpretation worry that argued against it
 * does not apply to the shell we actually get: `cmd.exe` does not glob, so the `*` in an import
 * alias survives, and `@` and `--` are ordinary characters to it. What cmd.exe DOES need is quoting
 * around whitespace, because Node joins the arguments into one string before handing them over —
 * and a temp directory with a space in it is the normal case on a real user's machine, as opposed
 * to the 8.3 short path a CI runner happens to hand out.
 */
const PACKAGE_MANAGERS = new Set(['npm', 'npx', 'pnpm', 'yarn']);
const quoteForCmd = (arg) =>
  /[\s"]/.test(arg) ? `"${String(arg).split('"').join('\\"')}"` : String(arg);

/** A command and the options it must be spawned with, on either kind of machine. */
function pm(cmd, args = []) {
  if (!WIN || !PACKAGE_MANAGERS.has(cmd)) return { cmd, args, shellOpts: {} };
  return { cmd: `${cmd}.cmd`, args: args.map(quoteForCmd), shellOpts: { shell: true } };
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages/server/dist/cli.js');
/** Private ports, so this never fights the battery or a developer's own daemon. */
/**
 * Separate port ranges for the self-test, which runs FIRST in CI and in the same job.
 *
 * The self-test deliberately points each scaffold's init one port off its daemon, so its own init
 * daemons land on exactly the ports the real run is about to use. On Windows, where a process's
 * teardown outlives the kill, the real run's monorepo init then found its port taken, moved up one,
 * and registered this run's projectId on a port the harness was not watching. Discovery did the
 * right thing with the wrong daemon and the gate reported "no session ever appeared".
 *
 * Ranges that cannot overlap are cheaper than reasoning about how long a Windows handle lives.
 */
const SELF_TEST_PORT_OFFSET = 60;
const BRIDGE_PORT_BASE =
  Number(process.env.INSTALL_GATE_PORT ?? '4788') +
  (process.argv.includes('--self-test') ? SELF_TEST_PORT_OFFSET : 0);
const APP_PORT_BASE =
  Number(process.env.INSTALL_GATE_APP_PORT ?? '4820') +
  (process.argv.includes('--self-test') ? SELF_TEST_PORT_OFFSET : 0);
/** Generous: a cold Next build is slow, and a timeout here reads as an install failure. */
const BOOT_TIMEOUT_MS = 180_000;
const CONNECT_TIMEOUT_MS = 45_000;
/** After a session appears, how long to wait for `hasCapabilities` to flip true on reannounce. */
const CAPABILITIES_WAIT_MS = 10_000;
const KEEP = process.argv.includes('--keep');
/**
 * A `data-testid` the gate plants in every scaffold so `init` has something to register.
 *
 * Empty create-vite / create-next-app apps have none, so `init` writes
 * `registerCapabilities({ testids: [], signals: [], stores: [] })` and `hasCapabilities` stays
 * false. Requiring verifiability without this stamp would paint every scaffold red for a reason
 * that is true of an empty app and uninformative. With it, a regression that writes empty arrays
 * again fails the session check below.
 */
const INSTALL_PROBE_TESTID = 'reticle-install-probe';
const INSTALL_PROBE_FILE = 'reticle-install-probe.ts';
/**
 * Negative control: wire the app to a port the daemon is NOT on, so no session can appear, and
 * require the gate to FAIL.
 *
 * `check-boundaries.mjs --self-test` and `check-lossy-transforms.mjs --self-test` already run this
 * way in CI, for the reason this repo keeps rediscovering: a guard that has never failed is not a
 * guard. The session check (connected AND verifiable) is the assertion that proves the install
 * WORKS, so it is the one that most needs to be shown capable of going red.
 */
const SELF_TEST = process.argv.includes('--self-test');
/** Re-record the baseline instead of asserting against it. The diff is then reviewed in the PR. */
const UPDATE_BASELINE = process.argv.includes('--update-baseline');
/**
 * What `init` planned, last time somebody looked and agreed with it.
 *
 * Committed, so a change to the shape of an install shows up as a reviewable diff rather than as
 * nothing at all. Kept beside the gate rather than in a scratch directory for the same reason.
 */
const BASELINE_PATH = join(ROOT, 'apps/e2e/install-baseline.json');
const BASELINE = (() => {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return {};
  }
})();
const nextBaseline = {};
const ONLY = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : undefined;

/**
 * A LOCAL REGISTRY, not `file:` wiring.
 *
 * Three approaches were tried and two are dead ends, which is worth writing down because both look
 * reasonable:
 *
 *   - tarballs: the fixtures repo's rule against them stands — repeated `npm i --no-save *.tgz`
 *     pruned transitive deps and mixed a published core with a local plugin.
 *   - `file:` deps: npm SYMLINKS them, which Vite resolves and Next does not (`Can't resolve
 *     '@reticlehq/react'` from pages/_app). `--install-links` copies instead, and then npm cannot
 *     resolve `workspace:*` at all — EUNSUPPORTEDPROTOCOL.
 *
 * Verdaccio is the documented answer (docs/local-registry.md) and the only one that produces a REAL
 * install: `pnpm publish` resolves `workspace:*` to concrete versions, and the app then runs the same
 * `npm i @reticlehq/...` a user runs. It also lets `init` do its OWN dependency install, which is a
 * step the gate previously had to skip and then excuse.
 */
const REGISTRY_PORT = Number(process.env.INSTALL_GATE_REGISTRY_PORT ?? '4873');
const REGISTRY = `http://localhost:${String(REGISTRY_PORT)}`;

async function startLocalRegistry() {
  await freePortSafely(REGISTRY_PORT);
  // The paths scripts/verdaccio.yaml actually uses. Resetting BOTH matters: leave the htpasswd file
  // behind and the second run's user-create returns no token (the user already exists), which
  // presents as "no token from verdaccio" and looks like a registry fault rather than stale state.
  const storage = join(tmpdir(), 'reticle-verdaccio-storage');
  const htpasswd = join(tmpdir(), 'reticle-verdaccio-htpasswd');
  // `force` swallows ENOENT and nothing else. Windows raises EPERM/EBUSY while any handle on the
  // tree is still open — a verdaccio from a previous run being torn down is exactly that — and an
  // unretried delete there fails the gate before it has started, with an errno instead of a reason.
  const winSafe = { recursive: true, force: true, maxRetries: 8, retryDelay: 250 };
  rmSync(storage, winSafe);
  rmSync(htpasswd, winSafe);
  // The checked-in config names POSIX paths, and `/tmp` on Windows resolves to whatever the current
  // drive happens to be. Rather than keep a second Windows copy that drifts from the first, the one
  // config is read and its two paths repointed at this machine's real temp directory.
  const config = join(mkdtempSync(join(tmpdir(), 'reticle-gate-verdaccio-')), 'verdaccio.yaml');
  writeFileSync(
    config,
    readFileSync(join(ROOT, 'scripts/verdaccio.yaml'), 'utf8')
      .replace('/tmp/reticle-verdaccio-storage', storage.split('\\').join('/'))
      .replace('/tmp/reticle-verdaccio-htpasswd', htpasswd.split('\\').join('/')),
  );
  const verdaccio = pm('npx', ['--yes', 'verdaccio@latest', '--config', config]);
  const proc = spawn(verdaccio.cmd, verdaccio.args, {
    cwd: ROOT,
    detached: !WIN,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...verdaccio.shellOpts,
  });
  const log = [];
  proc.stdout.on('data', (d) => log.push(String(d)));
  proc.stderr.on('data', (d) => log.push(String(d)));
  // A dead registry and a slow one produced the SAME message — "did not start", 90 seconds later,
  // with an empty log — because nothing watched the process itself. That happened on Windows and cost
  // a whole run's coverage to a cause nobody could name. `error` catches a spawn that never began
  // (a .cmd resolved wrong, a missing binary); `exit` catches one that began and died.
  let spawnError;
  let exited;
  proc.on('error', (err) => {
    spawnError = err;
  });
  proc.on('exit', (code, signal) => {
    exited = `exit ${String(code)}${signal === null ? '' : ` (${signal})`}`;
  });

  // `npx --yes verdaccio@latest` resolves and can cold-download the package before it serves
  // anything, and Windows runners are markedly slower at that file IO. 90s is generous for a healthy
  // start and tight for a cold install, which is the shape of the failure seen here. Raised on
  // Windows only, so a genuine hang on the other platforms still surfaces at the same speed.
  const deadline = Date.now() + (WIN ? 240_000 : 90_000);
  let up = false;
  // Stop the moment the process is gone: waiting out 90 seconds for something that already died
  // buys nothing and hides why.
  while (Date.now() < deadline && spawnError === undefined && exited === undefined) {
    if (await reachable(`${REGISTRY}/-/ping`)) {
      up = true;
      break;
    }
    await sleep(500);
  }
  if (!up) {
    killTree(proc.pid);
    const cause =
      spawnError !== undefined
        ? `spawn failed: ${spawnError.message}`
        : exited !== undefined
          ? `the process ${exited} before the registry answered`
          : `timed out after ${String(WIN ? 240 : 90)}s with the process still alive`;
    const tail = log.join('').trim();
    throw new Error(
      `verdaccio did not start on ${REGISTRY} — ${cause}. ` +
        `command: ${verdaccio.cmd} ${verdaccio.args.join(' ')}. ` +
        `output: ${0 === tail.length ? '(nothing on stdout or stderr)' : tail.slice(-400)}`,
    );
  }

  // From here on the registry is RUNNING, and every remaining step can throw. Left unguarded, one
  // of them did: a prepack that failed on Windows aborted the publish, this function threw, and the
  // verdaccio it had started outlived the process. The next run then found port 4873 already held
  // by a registry carrying the previous run's htpasswd, so the user create returned nothing and the
  // gate reported "no token from verdaccio" — a second, unrelated-looking failure that hid the
  // first. A registry this function started is this function's to stop on the way out.
  try {
    return await publishInto(proc);
  } catch (err) {
    killTree(proc.pid);
    throw err;
  }
}

/** Everything that needs the registry to be up. Split out only so the caller above can guard it. */
async function publishInto(proc) {
  const res = await fetch(`${REGISTRY}/-/user/org.couchdb.user:reticle`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      _id: 'org.couchdb.user:reticle',
      name: 'reticle',
      password: 'reticle',
      type: 'user',
      roles: [],
      date: '2026-01-01T00:00:00.000Z',
    }),
  });
  const token = (await res.json())?.token;
  if (typeof token !== 'string' || token === '') throw new Error('no token from verdaccio');

  // Auth through an ISOLATED npmrc, pointed at by npm_config_userconfig.
  //
  // The env-var form (`npm_config_//localhost:PORT/:_authToken`) worked on my machine and failed in
  // CI, which is the whole reason this gate needed to run there: locally a developer's own ~/.npmrc
  // can be carrying credentials that make the publish succeed for a reason the gate is not testing.
  // A temp userconfig is unambiguous and still never touches the developer's global npmrc — which
  // scripts/local-registry.sh does append to, and which a killed run would leave a token in.
  const npmrc = join(mkdtempSync(join(tmpdir(), 'reticle-gate-npmrc-')), '.npmrc');
  writeFileSync(
    npmrc,
    `registry=${REGISTRY}\n//localhost:${String(REGISTRY_PORT)}/:_authToken=${token}\n`,
  );
  const auth = { npm_config_userconfig: npmrc, NPM_CONFIG_USERCONFIG: npmrc };
  run('pnpm', ['-r', 'publish', '--registry', REGISTRY, '--no-git-checks'], ROOT, auth);
  return { proc, auth, stop: () => killTree(proc.pid) };
}

/** Where a scaffold's create command puts the app, relative to the workdir. */
const DEFAULT_APP_DIR = 'app';
/** A lockfile only has to EXIST to pick a package manager — nothing here parses it. */
const PNPM_LOCK = 'pnpm-lock.yaml';
const PNPM_LOCK_STUB = "lockfileVersion: '9.0'\n";

/**
 * One per DISTINCT init path. Not one per framework anyone can name — a scaffold that exercises a
 * path another scaffold already covers costs two minutes a run and proves nothing new.
 *
 * Optional fields, all defaulting to the single-app shape the first three use:
 *   - `appDir`   — where the create command puts the app (default `app/`)
 *   - `initFrom` — the directory `init` is invoked from (default: the app's)
 *   - `seed`     — extra files written into the WORKDIR after scaffolding, before install
 *   - `hidePnpm` — make `pnpm` unusable for the `init` call only
 *   - `dropLocalLockfile` — delete the app's own lockfile after install, so package-manager
 *     detection has to walk UP for one instead of short-circuiting on it
 */
const SCAFFOLDS = [
  {
    id: 'vite-react',
    what: 'Vite + React — the vite-plugin path (config patch + injected connect)',
    create: ['npm', ['create', 'vite@latest', 'app', '--yes', '--', '--template', 'react-ts']],
    dev: (port) => ['npm', ['run', 'dev', '--', '--port', String(port), '--strictPort']],
  },
  {
    // The NON-REACT path, and the reason it is here is not hypothetical. 2.8.0 nearly shipped an
    // installer that left a Vue app connecting 0% of the time: `init` correctly gives a Vue codebase
    // the framework-neutral `@reticlehq/browser`, and three separate generators still emitted
    // `import('@reticlehq/react')` — the vite-plugin's injected connect among them. Every file init
    // wrote was correct, every gate was green, and nothing dialled the daemon.
    //
    // That is the same shape as the Next.js install this gate was built for, on a different stack:
    // the failure is silent, and only opening a browser can see it. Vue rather than Svelte because
    // it is the larger population; both take the identical code path through the plugin.
    id: 'vite-vue',
    what: 'Vite + Vue — the non-React path (sensor instead of the React kit)',
    create: ['npm', ['create', 'vite@latest', 'app', '--yes', '--', '--template', 'vue']],
    dev: (port) => ['npm', ['run', 'dev', '--', '--port', String(port), '--strictPort']],
  },
  {
    id: 'next-app-router',
    what: 'Next App Router — withReticle plus the app/ root layout',
    create: [
      'npx',
      [
        'create-next-app@latest',
        'app',
        '--ts',
        '--app',
        '--no-src-dir',
        '--no-tailwind',
        '--no-eslint',
        '--import-alias',
        '@/*',
        '--use-npm',
        '--yes',
      ],
    ],
    dev: (port) => ['npm', ['run', 'dev', '--', '-p', String(port)]],
  },
  {
    id: 'next-pages-router',
    // The one that matters. No `app/` directory exists, so the root layout init patches is not there
    // and connect has to mount through `pages/_app` — a different code path, and the one that
    // silently did nothing.
    what: 'Next Pages Router — no app/ at all, so connect must mount via pages/_app',
    create: [
      'npx',
      [
        'create-next-app@latest',
        'app',
        '--ts',
        '--no-app',
        '--no-src-dir',
        '--no-tailwind',
        '--no-eslint',
        '--import-alias',
        '@/*',
        '--use-npm',
        '--yes',
      ],
    ],
    dev: (port) => ['npm', ['run', 'dev', '--', '-p', String(port)]],
  },
  {
    id: 'monorepo-subdir',
    // Not a fourth flavour of the same shape — the first genuinely different one. The other three are
    // single-app roots with `init` run inside the app, and that shape is why this gate was blind to
    // all FOUR init defects one user hit in eight minutes on 2026-08-10: the app was in `frontend/`,
    // the repo root had no package.json, and the root carried a pnpm lockfile the app did not use.
    //
    // Four things are only reachable here:
    //   1. discovery — `init` from a root with no manifest has to FIND `frontend/` (it used to bail
    //      with "No package.json found" before discovery ever ran).
    //   2. the same bail made `--app frontend` unreachable too, i.e. the documented workaround for
    //      (1) failed the same way (one run can only take one of these two paths; discovery is the
    //      one a user hits without reading anything, so it is the one wired up).
    //   3. package-manager precedence: an ancestor `pnpm-lock.yaml` must NOT beat the npm-installed
    //      tree sitting in `frontend/`. With pnpm unusable, a regression here is not a cosmetic
    //      mis-detection — `pnpm add -D` simply cannot run, and the install step goes ⚠. This one
    //      only becomes reachable together with `dropLocalLockfile`: with the app's own lockfile
    //      present, detection short-circuits on it and the ancestor is never read at all.
    //   4. and a failed install must not silently skip the downstream wiring, which the baseline
    //      diff catches: the steps after it would vanish from the plan.
    what: 'monorepo root, app in frontend/, inherited pnpm lockfile, no pnpm on PATH',
    appDir: 'frontend',
    initFrom: '.',
    seed: { [PNPM_LOCK]: PNPM_LOCK_STUB },
    hidePnpm: true,
    dropLocalLockfile: true,
    create: [
      'npx',
      [
        'create-next-app@latest',
        'frontend',
        '--ts',
        '--app',
        '--no-src-dir',
        '--no-tailwind',
        '--no-eslint',
        '--import-alias',
        '@/*',
        '--use-npm',
        '--yes',
      ],
    ],
    dev: (port) => ['npm', ['run', 'dev', '--', '-p', String(port)]],
  },
];

/**
 * A PATH on which `pnpm` cannot run.
 *
 * SHADOWED, not stripped. Dropping the PATH entry that holds pnpm is the obvious move and it is a
 * trap: on plenty of machines (the maintainer's included) `pnpm`, `npm` and `npx` share one bin
 * directory, so removing it takes the package manager the scaffold actually needs with it and the
 * scaffold fails for a reason that has nothing to do with the thing under test. A stub that exits
 * 127 the way an absent binary does is indistinguishable to `init`, which never probes for pnpm — it
 * just runs it — and leaves everything else on PATH alone.
 */
function pathWithoutPnpm(workdir) {
  const binDir = join(workdir, '.gate-no-pnpm');
  mkdirSync(binDir, { recursive: true });
  // A shebang script is not executable on Windows; the shim a Windows shell would find is `pnpm.cmd`
  // earlier on PATH. Both exit 127, which is what `init` reads as "pnpm is not on this machine".
  if (WIN) writeFileSync(join(binDir, 'pnpm.cmd'), '@echo pnpm: command not found 1>&2\r\n@exit /b 127\r\n');
  else
    writeFileSync(join(binDir, 'pnpm'), '#!/bin/sh\necho "pnpm: command not found" >&2\nexit 127\n', {
      mode: 0o755,
    });
  return `${binDir}${delimiter}${process.env.PATH ?? ''}`;
}


/**
 * Everything that can say WHY a session never appeared, printed where the failure is.
 *
 * Two independent witnesses, because they fail differently: the page knows whether it tried, and
 * the daemon knows whether it refused. `origin_rejected` in the daemon log is the difference
 * between "the app never dialled" and "the app dialled and the gate said no" — opposite bugs with
 * opposite fixes, indistinguishable from the browser side alone.
 */
function dumpEvidence(consoleLines, bridgePort, failedResponses = [], wsAttempts = []) {
  const say = (label, body) => {
    const text = String(body).trim();
    if (0 === text.length) return;
    console.log(`      ── ${label} ──`);
    for (const line of text.split('\n').slice(-40)) console.log(`      ${line.slice(0, 300)}`);
  };
  say('page console', consoleLines.join('\n'));
  say('non-2xx responses', failedResponses.join('\n'));
  say('websocket attempts', wsAttempts.join('\n'));
  // Which daemon claims which project. Discovery is registry-first, so when a page dials a port the
  // harness is not watching, this is the file that says why it chose that one.
  const stateHome = join(homedir(), '.reticle');
  try {
    const claims = readdirSync(stateHome)
      .filter((f) => f.startsWith('connected-'))
      .map((f) => `${f}: ${readFileSync(join(stateHome, f), 'utf8').slice(0, 200)}`);
    say('daemon registry', claims.join('\n'));
  } catch {
    say('daemon registry', `not readable in ${stateHome}`);
  }
  const daemonLog = join(homedir(), '.reticle', `daemon-${String(bridgePort)}.log`);
  try {
    say(`daemon log (${daemonLog})`, readFileSync(daemonLog, 'utf8'));
  } catch {
    say('daemon log', `not readable at ${daemonLog}`);
  }
}

const run = (cmd, args, cwd, extraEnv = {}) => {
  const it = pm(cmd, args);
  return execFileSync(it.cmd, it.args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
    timeout: 600_000,
    ...it.shellOpts,
  });
};

async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function sessionsOn(port) {
  try {
    const res = await fetch(`http://localhost:${String(port)}/status`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.sessions) ? body.sessions : [];
  } catch {
    return [];
  }
}

/**
 * Plant a `data-testid` `init` will scan, so the generated capabilities file registers something.
 *
 * Written where the scan looks (under `src/` when that exists, otherwise the app root). Not imported
 * by the app — the scanner reads source text, and `hasCapabilities` rides on `registerCapabilities`,
 * not on the DOM.
 */
function stampInstallProbe(app) {
  const dir = existsSync(join(app, 'src')) ? join(app, 'src') : app;
  writeFileSync(
    join(dir, INSTALL_PROBE_FILE),
    `export const RETICLE_INSTALL_PROBE = 'data-testid="${INSTALL_PROBE_TESTID}"';\n`,
  );
}

/**
 * The steps `init` reported, as `mark → title`.
 *
 * "Zero ⚠" is an absolute and it is not enough on its own. A step that silently changes mark — ✓ to
 * ℹ, or ✓ to · — still passes that assertion while meaning something different happened, and a step
 * that DISAPPEARS from the plan entirely passes it most comfortably of all, because the thing that
 * would have warned you is the thing that is gone.
 *
 * So the shape of the plan is recorded and diffed. That is the difference between a threshold and a
 * baseline: a threshold answers "is this bad", a baseline answers "is this DIFFERENT", and silent
 * regressions are almost always the second question.
 */
/**
 * Every localhost port init said it was using, so the harness can stop what init handed over.
 *
 * Read out of init's own output rather than assumed from the framework: a scaffold that relocates
 * (5173 taken, vite moves to 5174) would otherwise leave the moved one behind.
 *
 * Two shapes, because init reports two kinds of thing. Dev servers arrive as URLs. The DAEMON
 * arrives as a JSON event — `{"event":"reticle_setup_daemon_started","port":4797}` — and matching
 * only URLs meant it was never swept. That daemon then outlived init holding a registry entry for
 * this scaffold's projectId, and daemon discovery is registry-FIRST by design: the app correctly
 * preferred the live daemon serving its project over the port written into its config at install
 * time. So the page dialled 4797 while the harness watched 4796 and reported "no session ever
 * appeared" about an app that had connected perfectly well to the wrong witness. Harness rule 2 is
 * "own the daemon before the app can dial it", and a daemon left running by init breaks it.
 */
function portsMentionedIn(text) {
  const found = new Set();
  for (const m of String(text).matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/g)) {
    found.add(Number(m[1]));
  }
  for (const m of String(text).matchAll(/"event":"reticle_setup_daemon_started"[^}]*"port":(\d{2,5})/g)) {
    found.add(Number(m[1]));
  }
  return [...found];
}

function stepsOf(report) {
  return report
    .split('\n')
    .map((line) => /^\s*\[(.)\]\s+(.+?)\s+→\s+(.+)$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ mark: m[1], title: m[2].trim(), target: m[3].trim() }));
}

/**
 * One line per step, stable and diffable: mark, title, and TARGET.
 *
 * The first version left the target out, on the assumption it carried absolute paths. It does not —
 * every target is a repo-relative path or a descriptive string — and leaving it out threw away the
 * single most load-bearing fact in the file. `Mount ReticleDev → app/layout.tsx` versus
 * `→ pages/_app.tsx` IS the difference between the two Next paths, so without the target the
 * app-router and pages-router baselines were byte-identical and a regression that mounted the
 * pages-router app into the wrong file would have diffed clean.
 */
const fingerprint = (steps) => steps.map((s) => `${s.mark} ${s.title} → ${s.target}`);

/** Drive one scaffold end to end. Returns its own tally, so one bad scaffold cannot mask another. */
async function driveScaffold(scaffold, index) {
  let pass = 0;
  let fail = 0;
  const chk = (label, ok, detail = '') => {
    console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
    ok ? (pass += 1) : (fail += 1);
  };
  const note = (line) => console.log(`   · ${line}`);

  // A port pair per scaffold. Sequential runs would be fine sharing one, but a scaffold that leaves
  // a dev server behind must not be able to make the NEXT scaffold look broken.
  const bridgePort = BRIDGE_PORT_BASE + index * 2;
  const appPort = APP_PORT_BASE + index * 2;

  console.log(`\n──────── ${scaffold.id} ────────`);
  note(scaffold.what);
  await freePortSafely(bridgePort);
  await freePortSafely(appPort);

  // `realpathSync.native`, because on Windows `tmpdir()` hands back the 8.3 SHORT form —
  // `C:\Users\RUNNER~1\AppData\Local\Temp`, which is literally what the gate's own log prints.
  // Two paths for one directory is a containment check waiting to fail, and Vite's file server does
  // exactly that: `server.fs.allow` compares a request's resolved path against the workspace root,
  // and a short-form root against a long-form request answers 403 Forbidden. Whether or not that is
  // what bit here, no real user's project lives behind an 8.3 alias, so a gate that tests one is
  // testing a path shape its users do not have. On POSIX this only resolves symlinks — macOS's
  // /var -> /private/var among them, which is the same class of two-names-one-directory problem.
  const workdir = realpathSync.native(
    mkdtempSync(join(tmpdir(), `reticle-install-${scaffold.id}-`)),
  );
  const app = join(workdir, scaffold.appDir ?? DEFAULT_APP_DIR);
  // Where `init` is invoked. Defaults to the app, which is the only shape that used to exist here.
  const initFrom = scaffold.initFrom === undefined ? app : join(workdir, scaffold.initFrom);
  let daemon;
  let dev;
  /**
   * Ports init said it was using, captured where `report` is in scope.
   *
   * The cleanup that needs them runs in the outer `finally`, which cannot see the try-scoped
   * `report` — reading it there threw a ReferenceError and took the whole gate down after the
   * first scaffold had already passed every assertion.
   */
  let handedOverPorts = [];

  try {
    // ── 1. a surface that has never seen Reticle ──────────────────────────────────────────────
    note('scaffolding…');
    run(scaffold.create[0], scaffold.create[1], workdir);
    stampInstallProbe(app);
    // Seeded AFTER the create command, never before: `create-next-app` reads the surrounding
    // directory to pick a package manager, and a lockfile planted first would change what it builds.
    for (const [rel, content] of Object.entries(scaffold.seed ?? {})) {
      writeFileSync(join(workdir, rel), content);
    }
    const pkgPath = join(app, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    chk(
      'the scaffold is a real app',
      typeof pkg.name === 'string' && pkg.scripts?.dev !== undefined,
    );
    chk(
      '  and it has never seen Reticle',
      !JSON.stringify(pkg).includes('@reticlehq'),
      'no @reticlehq in the fresh package.json',
    );

    // ── 2. point the app's @reticlehq scope at the local registry ─────────────────────────────
    // The scope must be spelled EXACTLY. `@reticle:registry=` — which this repo's own docs carried
    // until a moment ago — matches nothing, so npm silently falls through to the public registry and
    // the gate would measure the published SDK while reporting on local changes.
    writeFileSync(join(app, '.npmrc'), `@reticlehq:registry=${REGISTRY}\n`);
    run('npm', ['install', '--no-audit', '--no-fund'], app);
    // The lockfile npm just wrote is the reason the inherited-lockfile trap was unreachable here.
    // `resolveLockfiles` returns the moment it sees a LOCAL lockfile — "local is authoritative" — so
    // an ancestor `pnpm-lock.yaml` is never consulted and a scaffold that seeds one passes whether
    // precedence is right, wrong, or the ancestor file is absent entirely. Deleting it leaves exactly
    // the state the user was in: no local lockfile, an npm-installed `node_modules` (whose
    // `.package-lock.json` marker is what detection reads), and a pnpm lockfile one directory up.
    // init writes its own package-lock.json back when it installs, so the registry check below still
    // has one to read.
    if (true === scaffold.dropLocalLockfile) rmSync(join(app, 'package-lock.json'), { force: true });

    // ── 3. the thing under test ────────────────────────────────────────────────────────────────
    // `--no-mcp` for the reason the fixtures gate uses it: registering the MCP server edits global
    // machine state (~/.cursor/mcp.json, the developer's own CLAUDE.md). The gate measures the SDK
    // install, not what it does to whoever runs it.
    //
    // init DOES its own dependency install here, from the local registry. That is the whole point of
    // the registry: the previous `file:`-wired version had to pass `--no-install` and then excuse the
    // ⚠ it produced, which meant the one step most likely to regress was the one step not tested.
    let report = '';
    let initExit = 0;
    try {
      report = run(
        'node',
        [CLI, 'init', '--port', String(SELF_TEST ? bridgePort + 1 : bridgePort), '--no-mcp'],
        initFrom,
        {
          npm_config_registry: REGISTRY,
          ...(true === scaffold.hidePnpm ? { PATH: pathWithoutPnpm(workdir) } : {}),
        },
      );
    } catch (err) {
      initExit = err.status ?? 1;
      report = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    console.log(
      report
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => `      ${l}`)
        .join('\n'),
    );

    handedOverPorts = portsMentionedIn(report);
    chk('init exits 0', initExit === 0, `exit ${String(initExit)}`);

    // The load-bearing assertion, and now an absolute one. A ⚠ is a step nothing performed, so the
    // app never dials the bridge and every tool answers "no browser session connected" — a
    // green-looking install that cannot work. The earlier version of this gate tolerated one ⚠ and
    // had to argue for it; running against a real registry removes the argument.
    const manualLines = report.split('\n').filter((l) => l.includes('[⚠]'));
    chk(
      'init leaves ZERO manual steps',
      manualLines.length === 0,
      manualLines.length === 0 ? 'no ⚠' : manualLines.join(' | ').trim(),
    );
    const noticeLines = report.split('\n').filter((l) => l.includes('[ℹ]'));
    note(
      0 === noticeLines.length
        ? 'no ℹ notices'
        : `${String(noticeLines.length)} ℹ notice(s) — not a ⚠, but the app may still be unobservable`,
    );

    // The baseline diff. See stepsOf() for why "zero ⚠" cannot carry this on its own.
    //
    // The scaffold's own temp directory is folded to `<root>` first. Most targets are repo-relative,
    // but the ones written where the AGENT stands — the `.reticle.json` a redirect leaves at the
    // repo root, and the rule/command files — are absolute by necessity, and an absolute path under
    // `mkdtemp` is different on every run: recording it would make this baseline diff RED forever,
    // for a reason that has nothing to do with init.
    // Both spellings of it: `mkdtemp` hands back `/var/folders/…` on macOS while the `init` process
    // reports its cwd as the resolved `/private/var/folders/…`, and only one of those two ever
    // appears in a given line.
    //
    // LONGEST FIRST, and that is the whole subtlety. One spelling is a suffix of the other, so
    // folding the short one first eats the tail of the long one and leaves `/private<root>` behind
    // — a baseline diff that fails while reporting a path that never existed.
    //
    // The separator is folded too, and only here. `init` prints `<root>\.reticle.json` on Windows
    // and `<root>/.reticle.json` everywhere else, and BOTH are right — that is what a path looks
    // like on each platform. One recorded baseline has to be readable on both, and the thing it
    // exists to catch is a step changing its mark or vanishing from the plan, never which slash the
    // host uses. Without this the monorepo scaffold failed the diff on Windows over one character.
    const foldRoot = (text) =>
      [workdir, realpathSync(workdir)]
        .sort((a, b) => b.length - a.length)
        .reduce((acc, dir) => acc.split(dir).join('<root>'), text)
        .split('<root>\\')
        .join('<root>/');
    const steps = fingerprint(stepsOf(foldRoot(report)));
    const expected = BASELINE[scaffold.id];
    if (UPDATE_BASELINE) {
      nextBaseline[scaffold.id] = steps;
      note(`baseline recorded: ${String(steps.length)} step(s)`);
    } else if (expected === undefined) {
      chk(
        'this scaffold has a recorded baseline',
        false,
        `no baseline for '${scaffold.id}' — run with --update-baseline and commit the diff`,
      );
    } else {
      const same = expected.length === steps.length && expected.every((e, i) => e === steps[i]);
      chk(
        "init's plan matches the recorded baseline",
        same,
        same
          ? `${String(steps.length)} step(s) unchanged`
          : `expected:\n        ${expected.join('\n        ')}\n      got:\n        ${steps.join('\n        ')}`,
      );
    }

    // The SDK must have come from the registry we published to, not from public npm.
    const lock = (() => {
      try {
        return readFileSync(join(app, 'package-lock.json'), 'utf8');
      } catch {
        return '';
      }
    })();
    chk(
      '  and it came from the LOCAL registry, not public npm',
      lock.includes(`localhost:${String(REGISTRY_PORT)}`),
      lock.includes(`localhost:${String(REGISTRY_PORT)}`)
        ? 'resolved against the local registry'
        : 'package-lock does not reference the local registry — this measured PUBLISHED code',
    );

    chk(
      '  and init applied something — a run of all `·` would mean it found nothing to do',
      (report.match(/\[✓\]/g) ?? []).length > 0,
      `${String((report.match(/\[✓\]/g) ?? []).length)} ✓ mark(s)`,
    );

    // ── 4. stop what init handed over, BEFORE booting our own ──────────────────────────────────
    //
    // init leaves the app running on purpose: the user gets an instrumented app they can watch.
    // The gate then boots its own on a different port, and for Vite two servers are harmless. For
    // Next they are not — both write the same `.next` directory, and the second one finds it being
    // rewritten underneath itself and never binds. That reported as "the app boots ❌" with Next's
    // telemetry banner as the detail, which is not about booting at all.
    //
    // Doing it here rather than in the finally also stops one scaffold's leftovers reaching the
    // next one, which is what degraded a whole run down the list.
    for (const port of handedOverPorts) {
      if (port !== appPort) await freePortSafely(port);
    }
    handedOverPorts = [];

    // Killing the process does not undo a half-written `.next`. That is the other half of the same
    // problem and the reason the mitigation above was not enough: init's dev server is stopped
    // mid-compile, leaving a build directory that describes a build nobody finished, and the gate's
    // own server then reads it, finds it inconsistent and exits without ever binding. Reported as
    // "the app boots ❌" with Next's telemetry banner as the detail, on all three Next scaffolds,
    // on Linux only — where Next gets far enough to have written something before it is killed.
    //
    // Next rebuilds this from source, so deleting it costs a cold compile and nothing else.
    //
    // Best-effort, like every other cleanup here. On Windows the dev server still holds files under
    // `.next\dev` when this runs, so the delete raises ENOTEMPTY — and Windows does not need this
    // in the first place: it passed 5/5 before the removal existed, because Next there does not get
    // far enough to leave an inconsistent build behind. Throwing turned a Linux fix into a Windows
    // failure on the one scaffold whose dev server was slowest to let go.
    const nextBuildDir = join(app, '.next');
    if (existsSync(nextBuildDir)) {
      try {
        rmSync(nextBuildDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
        note('removed a .next left behind by the dev server init handed over');
      } catch (err) {
        note(`left .next in place (${String(err).slice(0, 100)}) — the boot below may still be cold`);
      }
    }

    // ── 5. own the daemon before the app can dial it (harness rule 2) ───────────────────────────
    daemon = await startOwnedDaemon(bridgePort, { cliPath: CLI, cwd: ROOT });
    const transport = watchTransport(bridgePort);

    // ── 6. boot, and open it in a real browser ──────────────────────────────────────────────────
    const [devCmd, devArgs] = scaffold.dev(appPort);
    const devSpawn = pm(devCmd, devArgs);
    dev = spawn(devSpawn.cmd, devSpawn.args, {
      cwd: app,
      detached: !WIN,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none' },
      ...devSpawn.shellOpts,
    });
    const devLog = [];
    dev.stdout.on('data', (d) => devLog.push(String(d)));
    dev.stderr.on('data', (d) => devLog.push(String(d)));

    const bootDeadline = Date.now() + BOOT_TIMEOUT_MS;
    let booted = false;
    while (Date.now() < bootDeadline) {
      if (await reachable(`http://localhost:${String(appPort)}/`)) {
        booted = true;
        break;
      }
      await sleep(500);
    }
    // The LAST 300 characters of a dev server's log is its banner, not its error — Next prints a
    // telemetry notice on the way out, so every boot failure here was reported as
    // "…completely anonymous telemetry regarding usage." and the actual cause was never shown.
    // Lines that look like a failure first, then the tail as context.
    const devText = devLog.join('');
    const devErrors = devText
      .split('\n')
      .filter((l) => /error|failed|EADDRINUSE|cannot|ENOENT|exit/i.test(l))
      .slice(-6)
      .join(' | ');
    chk(
      'the app boots',
      booted,
      booted ? `:${String(appPort)}` : `${devErrors || '(no error lines)'} ⟨tail⟩ ${devText.slice(-300)}`,
    );

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const consoleLines = [];
    page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
    // WHAT was refused, not just that something was. A console line reading "Failed to load
    // resource: 403 (Forbidden)" cost a full CI round trip on Windows because it names a status and
    // no url — and the two candidates need opposite fixes: a 403 on `ws://…/reticle` is the bridge
    // refusing an origin, a 403 on an `http://…/@fs/…` is Vite refusing to serve a file outside its
    // allow-list. Both are plausible from the console text alone, which is the problem.
    const failedResponses = [];
    const wsAttempts = [];
    page.on('response', (r) => {
      if (r.status() >= 400) failedResponses.push(`${String(r.status())} ${r.url()}`);
    });
    // A websocket that never opens produces no `response` event at all, so it is watched separately.
    page.on('websocket', (ws) => {
      wsAttempts.push(`opened ${ws.url()}`);
      ws.on('socketerror', (e) => wsAttempts.push(`FAILED ${ws.url()} — ${String(e)}`));
    });
    try {
      await page.goto(`http://localhost:${String(appPort)}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
    } catch (err) {
      consoleLines.push(`goto failed: ${String(err).slice(0, 120)}`);
    }

    // POLL. Steps 6 and 7 of the connection sequence race, and a gate that samples once sits outside
    // the product's own protection against it — see docs/system-map.md.
    //
    // Connected is not verifiable. `hasCapabilities` is announced in HELLO at connect() and
    // re-announced when `registerCapabilities` runs after, so the first snapshot can be false even
    // on a file that registers a testid. Wait for a session, then keep polling for capabilities.
    const connectDeadline = Date.now() + CONNECT_TIMEOUT_MS;
    let sessions = [];
    while (Date.now() < connectDeadline) {
      sessions = await sessionsOn(bridgePort);
      if (sessions.length > 0) break;
      await sleep(500);
    }
    const capDeadline = Math.min(connectDeadline, Date.now() + CAPABILITIES_WAIT_MS);
    while (Date.now() < capDeadline && !sessions.some((s) => true === s.hasCapabilities)) {
      sessions = await sessionsOn(bridgePort);
      await sleep(500);
    }

    // ── 6. attribute honestly (harness rule 4) ─────────────────────────────────────────────────
    const { aliveThroughout } = transport.stop();
    const verifiable = sessions.some((s) => true === s.hasCapabilities);
    const verdict = attributeOutcome({
      connected: sessions.length > 0,
      hasCapabilities: verifiable,
      transportAliveThroughout: aliveThroughout,
    });
    if (verdict.outcome === Attribution.INCONCLUSIVE) {
      // Neither a pass nor a clean fail. A scaffold that never had a bridge was never tested, and
      // reporting that as an install failure is how a correct SvelteKit install became a bug report.
      console.log(`   ⚠️  INCONCLUSIVE — ${verdict.because}`);
      fail += 1;
    } else {
      const passed = verdict.outcome === Attribution.PASS;
      chk(
        'a session appears and can answer a state question',
        passed,
        passed
          ? (sessions[0]?.url ?? '')
          : `${verdict.because}; console: ${consoleLines.slice(-3).join(' | ').slice(0, 220)}`,
      );
      // The one-line summary above is a headline, not evidence. A real failure here — the page
      // never dialled, or dialled and was refused — is diagnosed from what the PAGE said and what
      // the DAEMON said, and 220 characters of the last three console lines is enough to know
      // something went wrong and not enough to know what. A `403 (Forbidden)` on Windows cost a
      // whole CI round trip for exactly this reason: it named a status and not an origin.
      if (!passed) dumpEvidence(consoleLines, bridgePort, failedResponses, wsAttempts);
    }

    await browser.close();
  } catch (err) {
    chk('the scaffold ran to completion', false, String(err).slice(0, 300));
  } finally {
    if (dev !== undefined) killTree(dev.pid);
    if (daemon !== undefined) await daemon.stop();
    await freePortSafely(appPort);
    // The dev server INIT started and handed over, which is not the one above.
    //
    // Handing it over is the product behaviour: init leaves the user with a running instrumented
    // app. A harness has to clean up after that, and this one did not — so every scaffold left a
    // vite squatting the port the NEXT scaffold's init would ask for, and the run degraded down the
    // list while the first scaffold looked fine. Three "the app boots" failures, none of them about
    // booting.
    for (const port of handedOverPorts) {
      if (port !== appPort) await freePortSafely(port);
    }
    if (KEEP) note(`kept: ${workdir}`);
    // A dev server that has just been signalled is still flushing `.next` into this directory, so
    // the first rmdir loses a race it does not have to lose.
    //
    // And it must never decide the run. On Windows a handle survives the process that held it, so
    // this raised `EBUSY: resource busy or locked, rmdir …\app` AFTER a scaffold had passed all
    // nine of its checks — and because the throw escaped a `finally`, it reached the top level and
    // was reported as "the gate could not start", aborting every scaffold behind it. A whole run's
    // worth of Windows coverage lost to a directory that would not delete. A leaked temp directory
    // is a leak; it is not an install failure, and this gate answers exactly one question.
    else {
      try {
        rmSync(workdir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
      } catch (err) {
        note(`could not remove ${workdir} (${String(err).slice(0, 120)}) — leaving it behind`);
      }
    }
  }

  console.log(`   ${fail === 0 ? '✓' : '✗'} ${scaffold.id}: ${pass} passed, ${fail} failed`);
  return { id: scaffold.id, pass, fail };
}

console.log('\n=== INSTALL GATE: pristine apps, installed into, opened, and asked to connect ===');
if (SELF_TEST) console.log('   (self-test: every scaffold is mis-wired and MUST fail)');
await sweepBatteryOrphans([], { onNote: (n) => console.log(`   · ${n}`) });

const chosen = SCAFFOLDS.filter((s) => ONLY === undefined || s.id === ONLY);
if (chosen.length === 0) {
  console.error(`\nno scaffold named '${String(ONLY)}' — have: ${SCAFFOLDS.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

let registry;
const results = [];
try {
  console.log('   · publishing @reticlehq/* to a local registry…');
  registry = await startLocalRegistry();
  for (const [index, scaffold] of chosen.entries()) {
    // Isolated, for the same reason the CI matrix sets `fail-fast: false`: which scaffolds install
    // and which do not is the entire output of this gate, and one of them throwing used to take the
    // answer for every scaffold behind it. Measured on Windows — vite-react passed all nine checks,
    // then an EBUSY on a temp directory ended the run and four scaffolds were never attempted.
    // A crash is that scaffold's failure to report, not a reason to stop asking the question.
    try {
      results.push(await driveScaffold(scaffold, index));
    } catch (err) {
      console.log(`   ✗ ${scaffold.id} crashed: ${String(err).slice(0, 300)}`);
      results.push({ id: scaffold.id, pass: 0, fail: 1 });
    }
  }
} catch (err) {
  // The reason, not the banner. execFileSync's message begins with the command and then its STDOUT,
  // so a truncation of it shows npm's package listing and never the error — which is precisely how
  // this failure arrived from CI unreadable.
  const detail = [err?.stderr, err?.stdout, String(err)]
    .filter((part) => 'string' === typeof part && part.trim() !== '')
    .map((part) => part.trim().split('\n').slice(-12).join('\n'))
    .join('\n---\n');
  console.log(`   ❌ the gate could not start:\n${detail.slice(0, 2000)}`);
  results.push({ id: 'setup', pass: 0, fail: 1 });
} finally {
  if (registry !== undefined) registry.stop();
  await freePortSafely(REGISTRY_PORT);
}

if (UPDATE_BASELINE) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ ...BASELINE, ...nextBaseline }, null, 2)}\n`);
  console.log(`\n   · baseline written to ${BASELINE_PATH} — review the diff before committing`);
}

console.log('\n──────── summary ────────');
for (const r of results) {
  console.log(`   ${r.fail === 0 ? '✅' : '❌'} ${r.id.padEnd(20)} ${r.pass} passed, ${r.fail} failed`);
}

if (SELF_TEST) {
  // Inverted, and per scaffold. A green here would mean the session check passes regardless of
  // reality, which is the only way this whole script could be worthless while looking fine.
  const undetected = results.filter((r) => r.fail === 0).map((r) => r.id);
  const ok = undetected.length === 0;
  console.log(
    `\n${ok ? '✅ SELF-TEST PASSED' : '❌ SELF-TEST FAILED'} — ` +
      (ok
        ? 'every mis-wired install was correctly reported as a failure'
        : `these went UNDETECTED and so prove nothing: ${undetected.join(', ')}`),
  );
  process.exit(ok ? 0 : 1);
}

const failed = results.filter((r) => r.fail > 0);
console.log(
  `\n${failed.length === 0 ? '✅ INSTALL GATE PASSED' : '❌ INSTALL GATE FAILED'} ` +
    `(${String(results.length - failed.length)}/${String(results.length)} scaffolds)`,
);
process.exit(failed.length === 0 ? 0 : 1);
