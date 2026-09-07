// One command to run the benchmark suite (the regression gate's data-collection half).
//
//   node bench/harness/bench-all.mjs            # deterministic REPLAY pass (fast, pure Reticle) — default
//   node bench/harness/bench-all.mjs --full      # + OBSERVATION-COST pass (scripted; slow, boots tool MCPs)
//   node bench/harness/bench-all.mjs --no-boot    # don't start fixtures (use ones you already have up)
//
// The three measurement passes (see bench/SCORECARD.md legend):
//   - OBSERVATION-COST ("Layer A"): drive each tool's MCP directly, measure the tokens it injects per look.
//   - AGENT-LOOP       ("Layer B"): a real LLM drives the tool — costs money + needs a key, NEVER run here.
//   - REPLAY           ("Layer C"): re-run a saved flow with no model — Reticle's deterministic floor.
//
// By default this boots the fixtures the passes drive (the demo app + the api backend), health-checks
// them, runs the EXISTING harness scripts, and tears the fixtures down on exit. Each script writes its
// own bench/raw/*.json; gate.mjs reads those. (Raw JSON keys keep the A/B/C codes for data continuity.)
import { execFileSync, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import * as PORTS from './ports.mjs';
import { verifyAnchors } from './inject.mjs';
import { measurementVerdict } from './pass-artifact.mjs';
const FULL = process.argv.includes('--full');
const NO_BOOT = process.argv.includes('--no-boot');
// Ports live in one module — see the note there on why disagreeing about them silently
// invalidated the benchmark twice.
const { RETICLE_PORT, API_PORT, DEMO_PORT, BENCH_URL } = PORTS;
/**
 * The fixture's own sign-in password, handed to the passes as a replay secret.
 *
 * A recorded flow no longer stores the value typed into a password field — it keeps
 * `<redacted: supply at replay>` and reads the real one from `RETICLE_SECRET_<FIELD>` at replay,
 * so a credential never lands in a git-checked flow. Correct, and it silently broke every
 * replay-based pass here: sign-in filled the placeholder, the app stayed on the login screen, and
 * every anchor after it drifted with `nearest: login-email`. The passes reported "not detected"
 * rather than "could not run", which is the honest wording for a flow that never got past step two.
 *
 * This is a fixture account in a demo app with no data worth reaching. It is written out rather
 * than read from a vault precisely because it is not a secret; the mechanism is what is being
 * exercised.
 */
const REPLAY_SECRETS = { RETICLE_SECRET_LOGIN_PASSWORD: 'password' };

const FIXTURE_READY_MS = Number(process.env.BENCH_FIXTURE_READY_MS ?? '30000');
const PNPM_CMD = 'win32' === process.platform ? 'pnpm.cmd' : 'pnpm';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deterministic, offline, pure-Reticle detection scripts — always run (the gate's hard floor).
const REPLAY_PASS = [
  'bench/harness/replay-bench.mjs', // re-run cost: tokens per regression-run
  'bench/harness/replay-detect.mjs', // selector-removal detection (3/3)
  'bench/harness/replay-detect-consequence.mjs', // green-but-wrong detection (2/2)
  'bench/harness/replay-detect-state.mjs', // store-truth oracle catches a dead handler (state predicate)
  'bench/harness/network-cardinality-bench.mjs', // net.count:1 oracle catches a double-submit (presence passes)
  'bench/harness/forbidden-call-bench.mjs', // net.count:0 oracle catches a must-never-fire call
  'bench/harness/console-clean-bench.mjs', // clean-console oracle catches a silent console.error on an action
  'bench/harness/state-blast-radius-bench.mjs', // state invariant catches an action's unintended store side-effect
  'bench/harness/suite-rre.mjs', // suite-scale re-run cost: reticle_flow_verify read-cost ~constant in K (compounding)
  'bench/harness/replay-determinism.mjs', // flake rate: verdict-deterministic across N replays (0% by construction)
];
// Scripted observation cost + detection accuracy. Slow (~12 min) and boots Playwright/DevTools MCPs.
const OBSERVATION_PASS = ['bench/harness/run-observation.mjs', 'bench/harness/analyze.mjs'];

// The bridge requires the auto-provisioned pairing token (a rogue localhost app can't read the file, so
// it can't drive sessions). bench-app has no build plugin to inject it, so we present it manually: read
// the same per-user secret the daemon reads-or-creates (~/.reticle/pairing-token, RETICLE_PAIRING_TOKEN_DIR
// override), creating it here if absent so bench-app's vite has it at startup. The daemon reads the file
// we wrote rather than overwriting it, so both agree on the token.
function readOrCreatePairingToken() {
  const dir = process.env.RETICLE_PAIRING_TOKEN_DIR || join(homedir(), '.reticle');
  const path = join(dir, 'pairing-token');
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length > 0) return existing;
  } catch {
    /* missing — create below */
  }
  const token = randomBytes(24).toString('hex');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 });
  return token;
}

/** Fixtures booted by this process, torn down on exit. */
const fixtures = [];

/** Spawn a fixture server; track it so teardown() can stop it. stdio ignored to keep bench output clean. */
function spawnFixture(label, command, args, env) {
  // `detached` so the child leads its own PROCESS GROUP. `pnpm --filter … exec vite` is a wrapper
  // around a grandchild, and SIGTERM to the wrapper leaves vite running — the orphan then holds the
  // port, the next run's own vite dies on --strictPort, and waitForHttp sees the ORPHAN answer 200
  // and declares the fixtures ready. The battery then drives a process nobody owns, which later
  // exits and takes every remaining pass with it. That is the whole reason bench-all has been
  // unable to complete: the passes reported "measured NOTHING" and the numbers looked like a
  // verifier regression when the fixture had simply gone away underneath them.
  const isWindows = 'win32' === process.platform;
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: 'ignore',
    detached: !isWindows,
    windowsHide: isWindows,
    shell: isWindows,
  });
  child.on('error', (error) => console.error(`fixture ${label} failed to spawn: ${error.message}`));
  child.label = label;
  fixtures.push(child);
  return child;
}

/** Poll a URL until it responds (any non-5xx) or the deadline passes. */
async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

/** Stop every fixture this process started (idempotent; safe to call from a signal handler). */
function teardownFixtures() {
  while (fixtures.length > 0) {
    const child = fixtures.pop();
    try {
      // Kill the GROUP (negative pid), not just the direct child — see spawnFixture. Killing the
      // wrapper alone is what orphaned a dev server that then outlived the run.
      if ('win32' === process.platform) {
        try {
          execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {
          child.kill('SIGTERM');
        }
      } else {
        process.kill(-child.pid, 'SIGTERM');
      }
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
}

/** Boot the demo app + api backend the passes drive, and wait for both to answer. */
async function bootFixtures() {
  console.log(
    `bench-all: booting fixtures — api:${API_PORT}, demo:${DEMO_PORT} (pass --no-boot to skip)`,
  );
  spawnFixture('api', 'node', ['apps/api/server.mjs'], { API_PORT });
  // The benchmark fixture is @reticlehq/bench-app (login + dashboard: compose/deployments/diagnostics)
  // — the app these flows drive. Its embedded SDK dials RETICLE_PORT, which must match the daemon each
  // script spawns.
  const pairingToken = readOrCreatePairingToken();
  spawnFixture(
    'bench-app',
    PNPM_CMD,
    ['--filter', '@reticlehq/bench-app', 'exec', 'vite', '--port', DEMO_PORT, '--strictPort'],
    { RETICLE_PORT, VITE_RETICLE_TOKEN: pairingToken },
  );
  const [apiUp, demoUp] = await Promise.all([
    waitForHttp(`http://localhost:${API_PORT}/api/health`, FIXTURE_READY_MS),
    waitForHttp(`http://localhost:${DEMO_PORT}/`, FIXTURE_READY_MS),
  ]);
  // An HTTP 200 is not proof OUR fixture is up: an orphan from a previous run answers identically,
  // and `--strictPort` means our own vite exited rather than sharing the port. Assert the children we
  // spawned are still alive, so "ready" means ready-and-ours.
  const dead = fixtures.filter((c) => c.exitCode !== null || c.signalCode !== null);
  if (dead.length > 0) {
    teardownFixtures();
    console.error(
      `bench-all: fixture(s) exited during boot: ${dead.map((c) => c.label).join(', ')} — ` +
        `something else is probably holding the port (try: pkill -f 'vite --port ${DEMO_PORT}')`,
    );
    process.exit(1);
  }
  if (!apiUp || !demoUp) {
    teardownFixtures();
    console.error(
      `\n✗ fixtures did not come up within ${FIXTURE_READY_MS}ms (api:${apiUp}, demo:${demoUp}). ` +
        `Raise BENCH_FIXTURE_READY_MS on a slow machine, or start them yourself and pass --no-boot.`,
    );
    process.exit(1);
  }
  console.log('✓ fixtures ready');
}

/** Free any reticle daemon left on the bench port so the next script starts from a clean session. */
function cleanupDaemon() {
  try {
    execFileSync(
      'node',
      ['packages/server/dist/cli.js', 'stop', '--port', RETICLE_PORT, '--quiet'],
      {
        stdio: 'ignore',
      },
    );
  } catch {
    /* none running — fine */
  }
}

/** Resolve once nothing is listening on `port`, so the next pass can actually bind it. */
async function waitForPortFree(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const busy = await new Promise((resolve) => {
      const socket = connect({ port: Number(port), host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (!busy) return true;
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
}

/**
 * A pass writes `bench/raw/<its own basename>.json`. There are two ways it can exit 0 while having
 * proved nothing, and both used to read as a green ✓:
 *
 *   1. Every flow errored, so the summary is a row of nulls — the run still printed
 *      `detection 0/3 … ~null tok … => nullx` and then `process.exit(0)`.
 *   2. It died before writing, leaving the PREVIOUS run's file behind. gate.mjs then compares
 *      stale numbers against history and reports no regression.
 *
 * Both are the exact failure this project exists to catch, in the harness that measures it. So the
 * exit code is not the verdict — the artifact is. Verify the pass wrote a file DURING this run, and
 * that the file records a measurement.
 *
 * Whether it measured anything lives in `pass-artifact.mjs`, shape-independently and unit-tested.
 * The check used to be inline here and read `data.rows` — which four of the twelve passes write, so
 * the other eight, including the most expensive one in the suite, were guarded by nothing but their
 * exit code.
 */
// Every pass writes bench/raw/<script-name>.json — except the two that predate that convention and
// whose filenames analyze.mjs, the README and the artifacts all already refer to by their old names.
const LEGACY_RAW_NAMES = { 'run-observation': 'observation-results', analyze: 'analysis' };

function verifyPassArtifact(scriptPath, startedAtMs) {
  const stem = basename(scriptPath, '.mjs');
  const raw = join('bench', 'raw', `${LEGACY_RAW_NAMES[stem] ?? stem}.json`);
  let stat;
  try {
    stat = statSync(raw);
  } catch {
    return `wrote no ${raw}`;
  }
  // 1s of slack: some filesystems store mtime at whole-second granularity.
  if (stat.mtimeMs < startedAtMs - 1000) return `left ${raw} stale — this run never wrote it`;
  let data;
  try {
    data = JSON.parse(readFileSync(raw, 'utf8'));
  } catch {
    return `wrote ${raw} but it is not valid JSON`;
  }
  const verdict = measurementVerdict(data);
  return verdict.ok ? null : verdict.reason;
}

function runScript(path) {
  console.log(`\n▶ ${path}`);
  const started = Date.now();
  try {
    execFileSync('node', [path], {
      stdio: 'inherit',
      // A pass spawns its OWN daemon, which has to land on the port the fixture app dials. bench-all
      // set that port only on the fixture, so the passes inherited nothing, fell back to a DIFFERENT
      // default, and no browser session ever connected — every flow failed while the pass still
      // reported ✓. Hand both down explicitly rather than hoping the defaults agree.
      env: { ...process.env, RETICLE_PORT, BENCH_URL, ...REPLAY_SECRETS },
    });
  } catch (error) {
    console.error(`\n✗ ${path} FAILED (${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
  const problem = verifyPassArtifact(path, started);
  if (problem !== null) {
    console.error(`\n✗ ${path} exited 0 but ${problem}`);
    return false;
  }
  console.log(`✓ ${path} (${Math.round((Date.now() - started) / 1000)}s)`);
  return true;
}

// Tear fixtures down however we exit (normal, error, Ctrl-C) so an interrupted run never orphans them.
process.on('SIGINT', () => {
  teardownFixtures();
  process.exit(130);
});
process.on('SIGTERM', () => {
  teardownFixtures();
  process.exit(143);
});
process.on('exit', teardownFixtures);

const scripts = [...(FULL ? OBSERVATION_PASS : []), ...REPLAY_PASS];
console.log(
  `bench-all: ${FULL ? 'observation-cost + replay passes' : 'replay pass only (pass --full for observation-cost)'}`,
);

// A benchmark that cannot inject its bugs is not measuring anything — and it fails FLATTERINGLY.
// The injector throws, the observation harness records NOT MEASURED, the scenario leaves the
// comparison, and the catch-rate is averaged over the survivors, so the headline stays perfect while
// coverage shrinks. `broken-form-validation` disappeared exactly that way: the repo's own `yoda` lint
// rule rewrote the fixture and the anchors were not updated with it. Checked BEFORE the pass, because
// a drifted anchor found afterwards has already produced a number somebody may have quoted.
if (FULL) {
  // verifyAnchors() refuses rather than destroying uncommitted work in the fixture files it
  // rewrites. That refusal is a message to a human, so print the sentence — an unhandled throw at
  // module top level would wrap it in a stack trace, on the `pnpm bench --full` path that most
  // people take. Same treatment as the CLI path in inject.mjs.
  let drifted;
  try {
    drifted = verifyAnchors();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  if (drifted.length > 0) {
    for (const d of drifted) console.error(`✗ DRIFTED ${d.id}: ${d.error.split('\n')[0]}`);
    console.error(
      `\n✗ ${String(drifted.length)} regression(s) no longer apply to the fixture. Those scenarios would ` +
        `be silently dropped and every rate below would be computed over what survived. Fix the ` +
        `anchors (\`node bench/harness/inject.mjs --verify-anchors\`) before trusting a number.`,
    );
    process.exit(1);
  }
  console.log('✓ all regression anchors still apply');
}

if (!NO_BOOT) await bootFixtures();

for (const path of scripts) {
  cleanupDaemon();
  // Not a sleep. `stop` returns before the listener has necessarily released the socket, and the next
  // pass spawns its own daemon on the same port — so a fixed 1s wait is a bet on the machine, and it
  // loses under load: the daemon fails to bind, the MCP child exits 1, and the pass dies with
  // "mcp process exited code=1", which reads as a product failure rather than a harness race.
  if (!(await waitForPortFree(RETICLE_PORT))) {
    teardownFixtures();
    console.error(
      `\n✗ daemon port ${RETICLE_PORT} never freed — the next pass could not have bound it.`,
    );
    process.exit(1);
  }
  if (!runScript(path)) {
    cleanupDaemon();
    teardownFixtures();
    console.error('\nbench-all aborted — a pass failed. Fix it before gating.');
    process.exit(1);
  }
}
cleanupDaemon();
// Manifest of what ran THIS pass, so the gate only checks freshly-measured passes (a stale observation
// analysis.json from a prior run must not be gated on a replay-only pass). Keys keep the A/C codes for
// continuity with gate.mjs and the raw data files.
writeFileSync(
  'bench/raw/bench-run.json',
  JSON.stringify({ ranLayerA: FULL, ranLayerC: true, at: new Date().toISOString() }, null, 2),
);
console.log(
  '\nbench-all complete. Run `node bench/harness/gate.mjs` to compare vs the last baseline.',
);
process.exit(0);
