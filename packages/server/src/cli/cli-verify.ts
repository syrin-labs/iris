/**
 * `reticle verify <url>` — one-shot, non-MCP verification. It boots the engine in drive mode (Reticle owns
 * a browser pointed at the preview URL), waits for the in-page SDK to dial back, replays every saved
 * flow, renders the verdict, and exits 0 on pass / 1 otherwise. The same ReticleRunner + verdict the MCP
 * and HTTP paths use — so a platform/CI agent that can only run a shell command (Lovable, Emergent,
 * GitHub Actions) gets a byte-identical artifact without speaking MCP.
 *
 * The orchestration (runVerify) is split from the live wiring (openLiveConnection) behind VerifyPorts,
 * so the decision logic — including the two honesty guards (no session, no flows ⇒ never a green pass)
 * — is unit-tested without launching a real browser.
 */

import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  RETICLE_DEFAULT_PORT,
  ReticleEnv,
  bridgeWsUrl,
  isLoopbackHostname,
  ReticleDir,
  RunAgentKind,
  RunFramework,
  RunProfile,
  RunTrigger,
  VerdictStatus,
  VerifyPhase,
  type ReticleVerificationRun,
} from '@reticlehq/core';
import { start, type RunningServer } from '../index.js';
import { probePresence, PortPresence } from '../daemon/port-presence.js';
import { probeDaemon } from '../mcp/mcp-proxy.js';
import { fetchStatus } from './cli-launch.js';
import {
  cloudFetch,
  createProgressReporter,
  resolveCloudConfig,
  syncProgressToCloud,
  syncRunToCloud,
  SyncOutcome,
} from '../cloud/cloud-sync.js';
import { ReticleRunner, type VerifyProgressListener } from '../runs/reticle-runner.js';
import { createRunnerPort } from '../runs/runner-port.js';
import { RunStore } from '../runs/run-store.js';
import { renderRunReport } from '../runs/render-report.js';
import { BaselineStore } from '../project/baselines.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import type { SessionManager } from '../session/session-manager.js';
import type { ToolDeps } from '../tools/tools.js';

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const DEFAULT_SESSION_TIMEOUT_MS = 15_000;
const SESSION_POLL_MS = 250;
const DEFAULT_PROJECT_NAME = 'app';
const VERIFY_AGENT_ID = 'reticle-cli';

const MSG_NO_SESSION =
  'No app connected: Reticle drove the URL but no @reticlehq/browser session dialed back.\n' +
  '  Make sure the SDK is in the build and reticle.connect() runs on the preview page' +
  ' (for a non-localhost preview: allowNonLocalhost + a pairing token).';
const MSG_NO_FLOWS =
  'No saved flows to verify (.reticle/flows is empty), so refusing to report a pass for verifying nothing.\n' +
  '  Flows are recorded interactively by an agent (reticle_record{action:"start"} → act → reticle_flow_save via the\n' +
  '  MCP tools), then committed to .reticle/flows/. In CI, check those files in and re-run `reticle verify`.';
const MSG_VERIFY_PREFIX = 'verify failed: ';

/** The live capabilities runVerify needs — faked in tests so the logic runs without a browser. */
export interface VerifyConnection {
  /** Resolve true once a browser session has connected, or false at timeout. */
  sessionReady(timeoutMs: number): Promise<boolean>;
  listFlows(): Promise<string[]>;
  /**
   * `onProgress` is narration for a run in flight — see `verify-progress.ts` in core. Optional at
   * every layer: a connection that ignores it behaves exactly as it did before.
   */
  verify(onProgress?: VerifyProgressListener): Promise<ReticleVerificationRun>;
  close(): Promise<void>;
}

export interface VerifyPorts {
  connect: () => Promise<VerifyConnection>;
  out: (line: string) => void;
  fail: (line: string) => void;
  exit: (code: number) => void;
}

interface VerifyArgs {
  url: string;
  timeoutMs: number;
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openConnection(ports: VerifyPorts): Promise<VerifyConnection | undefined> {
  try {
    return await ports.connect();
  } catch (error) {
    ports.fail(MSG_VERIFY_PREFIX + errMessage(error));
    ports.exit(EXIT_FAIL);
    return undefined;
  }
}

/** Orchestration: boot → wait for a session → replay flows → verdict → exit code. Browser-free. */
export async function runVerify(args: VerifyArgs, ports: VerifyPorts): Promise<void> {
  const conn = await openConnection(ports);
  if (conn === undefined) return;
  try {
    const ready = await conn.sessionReady(args.timeoutMs);
    if (!ready) {
      ports.fail(MSG_NO_SESSION);
      ports.exit(EXIT_FAIL);
      return;
    }
    const names = await conn.listFlows();
    if (0 === names.length) {
      ports.fail(MSG_NO_FLOWS);
      ports.exit(EXIT_FAIL);
      return;
    }
    /*
     * Narrate the run while it happens.
     *
     * Everything else the CLI reports is a finished artifact, which is the right shape for evidence
     * and the wrong shape for the minutes a verification actually takes. Without this the dashboard
     * has nothing to show between "linked" and "done", and a run that is working looks exactly like
     * one that has died — the ambiguity somebody spent fifteen minutes inside.
     *
     * Opt-in and best-effort: no cloud credentials means nothing is buffered and nothing is sent.
     */
    /*
     * A correlation id for the STREAM, minted before the run exists.
     *
     * The artifact's own `runId` is only assigned once verification finishes, and these events have
     * to be attributable from the first one — so the stream gets its own id, and the dashboard keys
     * live progress by it until the finished run replaces the whole picture.
     */
    const streamId = randomUUID();
    const cloud = resolveCloudConfig(process.env);
    const progress = createProgressReporter(streamId, cloud, cloudFetch);
    let run: ReticleVerificationRun;
    try {
      run = await conn.verify(progress.onProgress);
    } finally {
      // Stopped before the last flush so the timer cannot fire mid-send, and flushed after it so the
      // events from the final flow are not thrown away with the interval that would have sent them.
      progress.stop();
      await progress.flush().catch(() => undefined);
    }
    await pushRunToCloud(run, ports); // best-effort; opt-in; never changes the verdict or exit code
    /*
     * The last event anybody watching is waiting for, sent after the artifact has actually landed —
     * so "pushed" on a dashboard means the run is really there, not that we were about to try.
     */
    await syncProgressToCloud(
      streamId,
      // The run's OWN injected timestamp — no wall clock is read in this path (rule 7).
      [{ phase: VerifyPhase.PUSHED, at: run.createdAt }],
      cloud,
      cloudFetch,
    ).catch(() => undefined);
    ports.out(renderRunReport(run));
    ports.exit(run.verdict.status === VerdictStatus.PASS ? EXIT_PASS : EXIT_FAIL);
  } catch (error) {
    ports.fail(MSG_VERIFY_PREFIX + errMessage(error));
    ports.exit(EXIT_FAIL);
  } finally {
    await conn.close().catch(() => undefined);
  }
}

/**
 * Best-effort push of a finished run to the cloud dashboard. Opt-in: only fires when the user has set
 * RETICLE_CLOUD_URL + RETICLE_CLOUD_KEY (the "shifted to server" step). Absent → no-op, nothing leaves the
 * machine (the no-phone-home default). A push failure NEVER changes the verdict or exit code — the run is
 * already reported locally; the cloud copy is an enhancement.
 */
async function pushRunToCloud(run: ReticleVerificationRun, ports: VerifyPorts): Promise<void> {
  const config = resolveCloudConfig(process.env);
  if (null === config) return;
  const result = await syncRunToCloud(run, config, cloudFetch);
  if (result.outcome === SyncOutcome.SYNCED) {
    ports.out(`↑ run ${run.runId} recorded on the Reticle dashboard`);
  } else {
    ports.fail(
      `cloud run sync failed (${result.status ?? result.error ?? 'error'}); run kept locally`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSession(
  sessions: SessionManager,
  timeoutMs: number,
  now: () => number,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (sessions.count() > 0) return true;
    await delay(SESSION_POLL_MS);
  }
  return sessions.count() > 0;
}

/** Reconstruct the disk-backed ToolDeps over the live bridge + driven browser the daemon owns. */
function buildVerifyDeps(running: RunningServer, reticleRoot: string, now: () => number): ToolDeps {
  const fs = createNodeFileSystem();
  const deps: ToolDeps = {
    sessions: running.bridge.sessions,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(fs, reticleRoot, { now }),
    annotations: new AnnotationStore(),
    project: new ProjectStore(fs, reticleRoot, { now }),
    fs,
    reticleRoot,
    now,
  };
  if (running.realInput !== undefined) deps.realInput = running.realInput;
  return deps;
}

interface LiveOpts {
  url: string;
  headless: boolean;
  reticleRoot: string;
  projectName: string;
  now: () => number;
  /** Bridge port the driven browser's SDK must dial — must match the app's configured port
   *  (--port / RETICLE_PORT / .reticle.json), or a custom-port app never connects. */
  port: number;
  storageState?: string;
  /** Which connected tab to verify, when the app has more than one open on this port. */
  sessionId?: string;
}

/** Split a drive URL into its origin + whether it's loopback — decides token/injection pairing. */
export function urlParts(url: string): { origin?: string; loopback: boolean } {
  try {
    const u = new URL(url);
    return { origin: u.origin, loopback: isLoopbackHostname(u.hostname) };
  } catch {
    return { loopback: false };
  }
}

async function openLiveConnection(opts: LiveOpts): Promise<VerifyConnection> {
  // A localhost preview connects natively (the app's own reticle.connect is allowed on loopback), so the
  // bridge stays token-free. A HOSTED (non-localhost) preview is blocked by the SDK's connection policy
  // and rejected as a foreign origin — so there we pair via a one-shot token both the bridge and the
  // injected reticle.connect share, plus the preview's origin on the allow-list. That split is what makes
  // both "verify my dev server" and "verify a live Lovable URL" work from the same command.
  // `reticle verify` boots its OWN daemon. Hardcoding the default port meant it crashed with EADDRINUSE
  // on any machine already running a daemon — i.e. every developer machine — so honour RETICLE_PORT.
  const envPort = Number(process.env[ReticleEnv.PORT]);
  const port = Number.isFinite(envPort) && envPort > 0 ? envPort : opts.port;
  const { origin, loopback } = urlParts(opts.url);
  const pairing = loopback
    ? {}
    : (() => {
        const token = randomUUID();
        const bridgeUrl = bridgeWsUrl(port);
        return {
          token,
          injectConnect: { token, url: bridgeUrl },
          ...(origin !== undefined ? { allowedOrigins: [origin] } : {}),
        };
      })();
  const running = await start({
    port,
    driveUrl: opts.url,
    headless: opts.headless,
    mcp: false,
    reticleRoot: opts.reticleRoot,
    now: opts.now,
    ...pairing,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  });
  const deps = buildVerifyDeps(running, opts.reticleRoot, opts.now);
  const runner = new ReticleRunner(createRunnerPort(deps, opts.sessionId));
  return {
    sessionReady: (timeoutMs) => waitForSession(deps.sessions, timeoutMs, opts.now),
    listFlows: () => deps.flows.list(),
    verify: async (onProgress) => {
      const run = await runner.verify({
        project: { name: opts.projectName, framework: RunFramework.OTHER, previewUrl: opts.url },
        agent: { id: VERIFY_AGENT_ID, kind: RunAgentKind.OEM_PIPELINE },
        trigger: { kind: RunTrigger.OEM },
        profile: RunProfile.PROD_PREVIEW,
        ...(onProgress === undefined ? {} : { onProgress }),
      });
      // Persist the artifact. `reticle gate` decides from RunStore.latest, so without this the
      // documented CI loop is broken end to end: `reticle verify` could pass and the gate would still
      // block, because it never sees a passing run. (Only the optional `serve --http` endpoint used to
      // persist.) Best-effort — a disk failure must not turn a passing verification into a failure.
      try {
        await new RunStore(deps.fs, opts.reticleRoot).write(run);
      } catch {
        // artifact persistence is not the verdict
      }
      return run;
    },
    close: () => running.close(),
  };
}

/** CLI entry — wires the live ports and runs the one-shot verification. Exits the process itself. */
/**
 * What a user reads when the bridge port is already taken by a daemon.
 *
 * `verify` boots its OWN daemon, and it has to do so on the port the APP dials — a loopback page
 * connects natively to the port baked into its config, so verify cannot simply pick a free one and
 * still be found. On any machine with Reticle set up, that port already belongs to a running daemon.
 *
 * It used to die there. The listen failure surfaces asynchronously on the server object, after
 * `start` has resolved, so nothing caught it and the process printed a raw `node:net` stack — the
 * worst answer available, and reached most often by the people with the fewest other options, since
 * the skill offers this command as the way to a verdict with no MCP at all.
 *
 * The message says every way out rather than picking one, and it says FIRST that a busy port is the
 * normal state rather than a fault — an install that worked leaves a daemon on it, so a reader who
 * arrives here has done nothing wrong and should not go looking for what they broke (#689).
 *
 * `reticle drive` leads, because it is the only option that works in the state most people are in
 * when they reach this message: the client exposes no `reticle_*` tools (Codex, Cursor Cloud,
 * Antigravity, a session whose MCP link dropped), which is exactly when the CLI is reached for. It
 * ATTACHES to the running daemon rather than binding — see cli/drive-attach.ts — so there is nothing
 * to stop, nothing to race, and it hands back a sessionId the daemon owns. The advice that used to
 * lead, "ask the daemon through the tools", is the one thing that reader by construction cannot do.
 *
 * Stopping the daemon stays on the list and stays LAST of the working options, with the reason: the
 * MCP proxy respawns one into the gap, so `stop` is a race the caller usually loses, and it kills
 * the agent's own link on the way past.
 *
 * `verify` itself attaching, rather than needing the port at all, is the real fix and is #689's
 * first bullet — not this change.
 */
export function portBusyMessage(port: number): string {
  return (
    `reticle verify needs port ${String(port)} — the port your app dials — and a Reticle daemon is ` +
    'already listening on it. It did not start a second one.\n\n' +
    '  This is the NORMAL state after a working install, not a fault: the daemon your MCP client ' +
    'started owns that port.\n\n' +
    `  • Drive the app through the daemon that is already there — this needs no tools and stops ` +
    `nothing: npx @reticlehq/server drive <url>\n` +
    '  • If your client HAS the Reticle tools, ask that daemon directly: ' +
    'reticle_run { tool: "reticle_verify", args: { action: "change", files: ["..."] } }\n' +
    `  • Or run both on another port, if your app is configured for it: RETICLE_PORT=<port> ` +
    'npx @reticlehq/server verify <url>\n' +
    `  • Stopping the daemon (npx @reticlehq/server stop --port ${String(port)}) works, but it cuts ` +
    "your agent's MCP link and the proxy usually respawns a daemon into the gap before verify can " +
    'bind — prefer one of the above.'
  );
}

export function handleVerify(parsed: {
  url: string;
  headless: boolean;
  timeoutMs?: number;
  storageState?: string;
  sessionId?: string;
  /** Bridge port — parseCliArgs already resolves --port / RETICLE_PORT / .reticle.json into this. */
  port: number;
}): void {
  const now = (): number => Date.now();
  const reticleRoot = join(process.cwd(), ReticleDir.ROOT);
  const projectName = basename(process.cwd()) || DEFAULT_PROJECT_NAME;
  const ports: VerifyPorts = {
    connect: () =>
      openLiveConnection({
        url: parsed.url,
        headless: parsed.headless,
        reticleRoot,
        projectName,
        now,
        port: parsed.port ?? RETICLE_DEFAULT_PORT,
        ...(parsed.storageState !== undefined ? { storageState: parsed.storageState } : {}),
        ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
      }),
    out: (line) => process.stdout.write(`${line}\n`),
    fail: (line) => process.stderr.write(`${line}\n`),
    exit: (code) => process.exit(code),
  };
  // Asked BEFORE anything binds. The listen failure arrives asynchronously on the server object,
  // long after `start` has resolved, so no `.catch` on that promise can ever see it — which is why
  // this used to reach the user as a raw node stack rather than as an answer.
  void (async () => {
    const port = parsed.port ?? RETICLE_DEFAULT_PORT;
    if (
      (await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus })) ===
      PortPresence.DAEMON
    ) {
      ports.fail(portBusyMessage(port));
      ports.exit(1);
      return;
    }
    await runVerify(
      { url: parsed.url, timeoutMs: parsed.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS },
      ports,
    );
  })();
}
