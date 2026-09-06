// E2E orchestrator: run each committed spec sequentially against already-running servers
// (api:8787, demo:4310, next-smoke:3100). Each spec boots its own Reticle bridge on :4400, so we
// free that port between specs. Exits non-zero if any spec fails — the CI regression gate.
//
// Two batteries, one runner. `--desktop` runs the Electron/Tauri specs instead of the web ones,
// because those two need things the web battery's boot script does not provision — an Electron
// install, a compiled Tauri binary, and on Linux a display — while needing none of its three HTTP
// servers. They are a separate JOB, never a silent omission: a spec on disk that belongs to neither
// list still fails the classification check below.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { freePortSafely, sweepBatteryOrphans } from './gate-harness.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const specsDir = path.join(dir, 'specs');

// Order: next-smoke-backed specs first, real-world (demo+api) last.
const ORDER = [
  // Needs no browser and none of the three servers — real dist modules against a real capture
  // endpoint. Runs first because it is the fastest way to learn the build is sane.
  'telemetry-events-test',
  // Also needs no browser and no servers: a fake MCP peer and a hand-rolled HELLO, both LYING about
  // their contract. Runs early for the same reason — it is a cheap check that the three pieces agree.
  'version-skew-test',
  // Also serverless and browserless: it drives five tool calls and then reads the call tree the
  // daemon emitted while doing it. The trace is produced on every RETICLE_TRACE=1 run and was
  // discarded; it carries the hang signature (a completed child span with no completed parent),
  // which nothing else here can see.
  'trace-shape-test',
  // Serverless too: it holds the bridge port with a plain socket and checks that serve, status and
  // doctor all say so. They used to report a spawn, `running:false`, and "not running" — three
  // surfaces disagreeing, none of them naming the port, and the truth only in the daemon's own log.
  'daemon-port-honesty-test',
  // Serverless as well: it starts a real daemon with a fast heartbeat, SIGKILLs it, and reads the
  // daemon's own log back. A killed daemon used to leave NOTHING (installExitTrace hooks 'exit',
  // which SIGKILL never fires) while a tidy one logged code:0 — so the two were indistinguishable in
  // the one file users are told to open.
  'daemon-heartbeat-test',
  // Serverless as well: a fault proxy sits between the MCP proxy and a real daemon and breaks the
  // link in NAMED ways — reset, blackhole, truncate, latency — instead of SIGKILLing a process. It
  // separates the two unanswered-call populations by their timing: a queued call is answered by the
  // 20s queue timer, a call broken IN FLIGHT by the stream-loss path in well under a second.
  'transport-faults-test',
  'next-smoke-test',
  'next-blur-clock-test',
  'status-honesty-test',
  'drive-launch-test',
  // The other half of drive: what it does when it CANNOT have the port. A daemon on :4400 is the
  // normal state once an agent has connected, and drive used to die there on a raw EADDRINUSE —
  // reported twice from the field, both times against the command Reticle itself recommends.
  'drive-attach-test',
  'spa-nav-realinput-test',
  'visual-test',
  'crawl-test',
  // The other one-shot explorer: crawl drives every control; this walks primary nav only. next-smoke
  // has a `<nav>` of App Router links, which is the shape the tool is for — unit tests inject a fake
  // session and never prove the query+click+settle path against a real document.
  'nav-smoke-test',
  // The release motive, end to end. The unit tests pin the RULE; only a real app in a real browser
  // proves the wiring — that the facts reach the rule, that the field survives the outputSchema, and
  // that a gap raised on one call is still open on the next AND closes when the app stops being
  // unobservable. Carries its own negative control, because a surface that always reports a finding
  // is worth exactly nothing.
  'instrumentation-gap-test',
  'scroll-find-test',
  'flow-record-replay-test',
  'flow-self-heal-test',
  'project-history-test',
  'spec-runner-test',
  // Needs no servers and no browser — it watches the daemon's own life cycle, which nothing else
  // here can see (every other spec drives a daemon immediately, never leaving one idle).
  'daemon-lifecycle-test',
  // The other half of the transport story. daemon-lifecycle covers the daemon exiting on its OWN
  // terms; this one SIGKILLs it under a live client and asserts the stdio MCP server survives —
  // the failure a user experiences as "my tools vanished, open /mcp and reconnect". Also needs no
  // servers and no browser.
  'mcp-survives-test',
  // Brute force against the same transport: repeated kills, kills mid-call, concurrent bursts,
  // garbage on stdin, and a foreign process stealing the port. Survival is only half the bar — the
  // other half is that every request gets an ANSWER, because a hung call is a hung agent.
  'mcp-stress-test',
  // The wire under both of those: SDK <-> daemon. Session cap, oversized frames, malformed frames,
  // a message flood, and sockets killed mid-handshake. Owns its own daemon on its own port.
  'bridge-stress-test',
  // The other channel: daemon <-> page. Tabs closed mid-command, two tabs at once, a backgrounded
  // page, and a reload under a live ref. Needs the bench-app the dashboard specs use.
  'browser-stress-test',
  // Every shipped tool, called WRONG: empty, nulls, wrong types, junk keys, a 100KB argument.
  // The surface sweep proves the tools work; this proves they refuse safely — bounded, actionable,
  // and never blaming the caller's typo on Reticle. Needs the same bench-app.
  'tool-fuzz-test',
  'live-control-test',
  'real-world-tests',
  'response-ignored-test',
  'multi-agent-lease-test',
  'atlas-hard-fixture-test',
  // Drives a real session and then checks that the EVENTS describe it — a different question from
  // telemetry-events-test, which only proves each kind can be sent. Owns a browser and writes a flow,
  // so it sits beside the sweep at the end.
  'telemetry-stitch-test',
  // Feedback is the only qualitative channel the product has. This proves a report survives a dead
  // network (outbox), that a delivered one drains, and that filing from a Reticle checkout works.
  'feedback-durability-test',
  // Last: it drives every tool over real MCP, including navigate/crawl/clock, and owns a browser of
  // its own. Running it earlier would leave the shared bench-app in a state later specs assume fresh.
  'tool-surface-sweep-test',
  // Beside the sweep, and deliberately NOT folded into it: the sweep advertises every tool and calls
  // each one directly, which is right for sweeping a surface and wrong for learning what an ordinary
  // agent can reach. This one runs at the DEFAULT profile and makes the calls SKILL.md prints, through
  // the `reticle_run` envelope the skill has to teach because those tools are not advertised. The
  // sweep can be entirely green while every instruction in the skill is unreachable.
  'skill-one-call-paths-test',
  // Last: drive the demo app the way a user's agent does, including a false assertion that MUST be
  // refused. Everything above proves the pieces; this proves the product.
  'release-smoke-test',
];
// The desktop battery — `pnpm e2e:desktop`. Each of these starts its OWN runtime (an Electron main
// process, a packaged Tauri binary) and waits for it to dial the bridge, so they need no server from
// run-ci.sh and would only fail inside it for want of a display.
const DESKTOP = ['electron-desktop-test', 'tauri-desktop-test'];
// Specs intentionally excluded from BOTH batteries (add here WITH a reason, never by omission).
const present = new Set(
  readdirSync(specsDir)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.replace(/\.mjs$/, '')),
);
// ORDER only SEQUENCES; a spec present on disk but in no list is silently un-run rot (this is how
// new-features-test.mjs rotted). Fail loud so every new spec must be classified.
const unclassified = [...present].filter(
  (n) => !ORDER.includes(n) && !DESKTOP.includes(n),
);
if (unclassified.length > 0) {
  console.error(
    `\ne2e: spec(s) present but not in ORDER or DESKTOP: ${unclassified.join(', ')}\n` +
      'Add each to ORDER (web battery) or DESKTOP (Electron/Tauri battery).',
  );
  process.exit(1);
}
// A named list that resolves to nothing means the battery quietly passed having run zero specs —
// the same rot in a new shape. Only reachable by deleting a file without updating the list.
const desktop = process.argv.includes('--desktop');
const specs = (desktop ? DESKTOP : ORDER).filter((n) => present.has(n));
if (specs.length === 0) {
  console.error(`\ne2e: the ${desktop ? 'desktop' : 'web'} battery resolved to zero specs`);
  process.exit(1);
}

const sh = (cmd) =>
  new Promise((res) => {
    let out = '';
    const child = spawn('bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('close', () => res(out.trim()));
  });

/** The bridge port every spec binds. One holder left behind fails every spec after it. */
const BRIDGE_PORT = 4400;

/**
 * Free the bridge port, escalating until it actually IS free.
 *
 * A spec that fails can leave a process holding this port, and the previous version — a single
 * SIGTERM to LISTEN sockets followed by `sleep 1` — did not reliably shift it: a hung process may
 * ignore SIGTERM, and a socket mid-teardown is not in LISTEN state so it was not even looked at.
 * Every subsequent spec then died with EADDRINUSE, so ONE real failure was reported as fifteen and
 * the actual cause sat buried under fourteen spurious ones. Measured: that turned a single broken
 * spec into a dozen turns of misdiagnosis.
 *
 * Escalates TERM → KILL and polls until the port is genuinely released, then says so plainly if it
 * cannot be — a diagnosis is worth more than a cascade.
 */
async function freePort() {
  // Listeners first, then — only if the port is still held — everything else, named before it is
  // touched. The previous version killed every holder on the first pass, which on 4400 includes any
  // `reticle mcp` proxy attached to the daemon: a developer running the battery with their own agent
  // connected lost that agent's transport, silently, with no log (the process that writes the proxy
  // log is the one that dies). See apps/e2e/harness-rules.md.
  const { freed, survivors } = await freePortSafely(BRIDGE_PORT, {
    onNote: (note) => process.stdout.write(`\n[e2e] ${note}\n`),
  });
  if (!freed) {
    process.stdout.write(
      `\n[e2e] port ${String(BRIDGE_PORT)} is STILL held by ` +
        `${survivors.map((h) => `pid ${h.pid} (${h.command})`).join(', ')} — ` +
        `every spec below will fail with EADDRINUSE for that reason and not their own.\n`,
    );
  }
}

/**
 * Warn when something that is NOT ours will join the bridge.
 *
 * The battery runs on 4400 — Reticle's default, and therefore the port every developer's own app
 * dials. A single fixture tab left open in a normal browser joins every daemon the battery starts,
 * and any spec that assumes it owns the session fails with "multiple sessions connected".
 *
 * That cost most of an afternoon: three different specs failed across three runs, each of them
 * correct, all of them poisoned by two Chrome tabs on :4310 and :7699. Every hypothesis about the
 * code was wrong, because the fault was not in the code.
 *
 * It has to BAIT them rather than just look: before the battery starts nothing is listening, so
 * there is nothing for a stray tab to be connected TO. The tabs reconnect to whatever appears on
 * 4400, so this stands a daemon up for a few seconds and sees who turns up. The first version of
 * this check polled an empty port, found nothing, and would have reported all-clear every time.
 *
 * Moving the battery to a private port is the real fix and is a bigger job: bench-app, next-smoke
 * and atlas each hardcode how they dial, and half of them silently stopped connecting when the port
 * moved. Until that is done, this names the cause in one line at the top of the run instead of
 * letting a different innocent spec fail each time.
 */
async function warnAboutForeignSessions() {
  // Before anything: clear what a KILLED previous battery left running. Its trap never ran, so a
  // driven browser and an MCP proxy may still be up, competing for this port and for memory. A run
  // that inherits those reports interleaved failures and SIGKILLs that read exactly like a product
  // regression — measured once at 17 of 31 specs, none of it real. See apps/e2e/harness-rules.md.
  // Processes only — no ports. run-ci.sh boots api:8787, bench-app:4310 and next-smoke:3100 BEFORE
  // this runs, so anything holding those is almost certainly this run's own fixture. Passing them
  // here once killed all three and failed 19 specs. The bridge port is freed by freePort() below,
  // which owns that decision.
  await sweepBatteryOrphans([], {
    onNote: (note) => process.stdout.write(`[e2e] ${note}\n`),
  });
  await freePort();
  const daemon = spawn('node', ['packages/server/dist/cli.js', 'serve', '--port', String(BRIDGE_PORT)], {
    stdio: 'ignore',
    detached: true,
  });
  let sessions = [];
  try {
    // 12s, not 4: an SDK reconnects with backoff, so a stray tab whose last attempt just failed
    // can take longer than a short probe to reappear. A run where the bait window closed too early
    // reported all-clear and then lost a spec to the very tab it had missed.
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const raw = await sh(
        `curl -s --max-time 2 http://localhost:${String(BRIDGE_PORT)}/status 2>/dev/null`,
      );
      if (raw === '') continue;
      try {
        sessions = JSON.parse(raw).sessions ?? [];
      } catch {
        /* daemon still coming up */
      }
      if (0 < sessions.length) break;
    }
  } finally {
    try {
      process.kill(-daemon.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    await freePort();
  }
  if (0 === sessions.length) return;
  process.stdout.write(
    `\n[e2e] WARNING: ${String(sessions.length)} FOREIGN session(s) joined :${String(BRIDGE_PORT)} before the battery started:\n` +
      sessions.map((session) => `        ${session.sessionId}  ${session.url}`).join('\n') +
      `\n        These are not ours — most likely app tabs open in your normal browser. They will join\n` +
      `        every daemon this battery starts, and any spec that assumes it owns the session will fail\n` +
      `        with "multiple sessions connected". The spec will look broken and will not be.\n` +
      `        Close those tabs before trusting a failure below.\n`,
  );
}

await warnAboutForeignSessions();

let failed = 0;
/** Names of the specs that failed, so the SUMMARY can name them — see below. */
const failures = [];
for (const name of specs) {
  await freePort();
  process.stdout.write(`\n──────── ${name} ────────\n`);
  // `detached` puts the spec in its OWN process group, so anything it spawned — a browser, a server,
  // a daemon — can be cleaned up as a unit when it exits.
  //
  // The port sweep above only frees the BRIDGE port, which is the shape of the failure I happened to
  // hit rather than the shape of the failure itself: a spec binding any other port leaves the same
  // cascade behind. Measured: a spec holding :9960 failed every later run of itself the same way
  // :4400 did. Killing the group is port-agnostic and needs no list of ports to keep up to date.
  const child = spawn('node', [path.join(specsDir, `${name}.mjs`)], {
    stdio: 'inherit',
    detached: true,
  });
  // Capture the SIGNAL too. `close` reports (code, signal), and a spec killed by a signal arrives
  // with code === null — which the failure line then printed as "exit null", a message that says
  // only "something went wrong somewhere" and sent me to re-run the spec by hand to learn anything.
  const { code, signal } = await new Promise((res) =>
    child.on('close', (c, sig) => res({ code: c, signal: sig })),
  );
  try {
    // Negative pid targets the group. ESRCH just means everything already exited, which is the norm.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* group already gone */
  }
  if (0 !== code) {
    const how = signal === null || signal === undefined ? `exit ${code}` : `killed by ${signal}`;
    failed += 1;
    failures.push(`${name} (${how})`);
    process.stdout.write(`\n[e2e] ✗ ${name} FAILED (${how})\n`);
  }
}

await freePort();
process.stdout.write(
  `\n================ e2e ${desktop ? 'desktop ' : ''}battery: ${specs.length - failed}/${specs.length} specs passed ================\n`,
);
// Name them HERE too, not only where they happened. The per-spec line is thousands of lines up by
// the time the battery ends, so "21/22" was in practice an unnamed failure: two intermittent ones
// were investigated from scratch because the summary — the part anyone actually reads, and all that
// survives in a CI tail — did not say which spec it was.
if (failures.length > 0) {
  process.stdout.write(`   failed: ${failures.join(', ')}\n`);
}
process.exit(failed === 0 ? 0 : 1);
