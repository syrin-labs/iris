import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolveProjectCloud } from './cloud/cloud-config.js';
import { startSyncDaemon } from './cloud/sync-daemon.js';
import {
  PROJECT_REGISTRY_FILE,
  emptyProjectRegistry,
  parseProjectRegistry,
  projectCandidates,
} from '@reticlehq/core';
import { discoverProjectConfigs, type ConfigDiscovery } from './cli/config-discovery.js';
import {
  projectCandidatesFrom,
  resolveArtifactRoot,
  type ArtifactRoot,
} from './project/artifact-root.js';
import type { Server } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  AGENT_STOPPED_NOTICE,
  RETICLE_DEFAULT_PORT,
  ReticleCommand,
  ReticleDir,
  ReticleEnv,
  LOOPBACK_HOST,
  ReplayStatus,
  EventType,
} from '@reticlehq/core';
import type { FlowReplayResult } from '@reticlehq/core';
import { originOf } from './session/session-manager.js';
import { setBrowserMode, BrowserMode } from './telemetry/browser-mode.js';
import type { NetworkDetail } from './input/network-detail.js';
import { replayNamedFlow } from './flows/flow-tools.js';
import { createSharedServer } from './http-server.js';
import { openLoopbackAlias } from './daemon/loopback-alias.js';
import { reportAppInstrumented } from './telemetry/app-instrumented.js';
import { resolveBridgeSecurityWithAutoToken } from './bridge/bridge-security.js';
import { Bridge } from './bridge/bridge.js';
import { sdkFixForDirectory } from './version/sdk-fix.js';
import { SERVER_VERSION } from './version/server-version.js';
import { BaselineStore } from './project/baselines.js';
import { RecordingStore } from './flows/recordings.js';
import { initImpact } from './impact/impact-recorder.js';
import { FlowStore } from './flows/flows.js';
import { buildFlowChips } from './flows/flow-scope.js';
import { ProjectStore } from './project/project-store.js';
import { attachRouteLearning } from './project/learned-routes.js';
import { AnnotationStore } from './flows/annotation-store.js';
import { createNodeFileSystem, type FileSystemPort } from './project/fs-port.js';
import { cleanupCaptureDirectories } from './visual/capture-cleanup.js';
import { ReticleRunner } from './runs/reticle-runner.js';
import { createRunnerPort } from './runs/runner-port.js';
import { RunStore } from './runs/run-store.js';
import { startVerifyServer } from './runs/verify-server.js';
import { createMcpServer } from './mcp/mcp.js';
import { LEASE_ACQUIRE_TOOL } from './tools/lease-tools.js';
import { runTool } from './tools/invoke-tool.js';
import { SessionReaper, endAllSessions, MCP_DISCONNECT_SUMMARY } from './session/session-reaper.js';
import { wireSessionScope } from './session/no-session-watch.js';
import { buildIdlePredicate } from './daemon/daemon-usefulness.js';
import { resolveToolSurface } from './tools/tool-surface.js';
import { statusPayload } from './status-payload.js';
import { CdpRealInputProvider, LaunchedRealInputProvider } from './input/real-input.js';
import { cpus } from 'node:os';
import { BrowserPool } from './pool/browser-pool.js';
import {
  AGENT_ALREADY_DRIVING_ELSEWHERE,
  shouldGreetWithLeaseNotice,
} from './session/lease-visibility.js';
import { playwrightLauncher, resolveMaxContexts } from './pool/playwright-launcher.js';
import { LeaseReaper } from './pool/lease-reaper.js';
import { readJournalEnabled, readProjectId } from './cli/cli-port.js';
import { hasProjectConnectedBefore } from './session/connection-memory.js';
import { reticleStateHome } from './daemon/daemon.js';
import { probeChromium } from './cli/chromium-hint.js';
import { makeJournalAttach } from './journal/attach-journal.js';
import { makeSessionEnd } from './journal/session-end.js';
import { AmbientStore } from './journal/ambient-store.js';
import { ensureWorkspaceGitignore } from './journal/workspace-gitignore.js';
import { pruneSessions } from './journal/retention.js';
import type {
  OwnedRealInputProvider,
  RealInputProvider,
  InjectConnectOptions,
} from './input/real-input.js';
import { log } from './log.js';

/** A human-facing one-liner for a panel replay verdict — ✓ passed / ⚠ drifted / ✗ errored. */
function replayVerdictLine(result: FlowReplayResult): string {
  if (result.status === ReplayStatus.OK) return `✓ "${result.name}" passed`;
  if (result.status === ReplayStatus.DRIFT)
    return `⚠ "${result.name}" drifted — a step no longer matches`;
  return `✗ "${result.name}" failed — ${result.error?.message ?? 'could not replay'}`;
}

export { ReticleTool } from './tools/tool-names.js';
export { RingBuffer } from './events/ring-buffer.js';
export { Bridge } from './bridge/bridge.js';
export { Session, SessionManager } from './session/session.js';
export type { SessionInfo, SessionHealth } from './session/session.js';
export { buildSessionRecommendation } from './session/session-recommendation.js';
export type { RecommendationInputs } from './session/session-recommendation.js';
export { TOOLS } from './tools/tools.js';
export type { ToolDeps, ToolDef } from './tools/tools.js';
export { createToolInvoker, UNKNOWN_TOOL_ERROR } from './tools/tool-invoker.js';
export { runTool, SESSION_BOUND_TOOLS, SESSION_EXEMPT_TOOLS } from './tools/invoke-tool.js';
export type { ToolInvoker } from './tools/tool-invoker.js';
export { BaselineStore, normalizeLines, diffLines } from './project/baselines.js';
export { RecordingStore } from './flows/recordings.js';
export type { RecordedStep, CompiledProgram } from './flows/recordings.js';
export { FlowStore, recordedStepToFlowStep } from './flows/flows.js';
export type { FlowResult, Clock } from './flows/flows.js';
export {
  assertSuccess,
  successToPredicate,
  dynamicTestids,
  successLabel,
} from './flows/flow-success.js';
export { classifyFlowAssertions, FlowAssertionGrade } from './flows/flow-classify.js';
export type { FlowAssertionClassification } from './flows/flow-classify.js';
export { buildDomainModel } from './domain/domain-model.js';
export type { DomainModel, DomainFlowSummary, DomainGaps } from './domain/domain-model.js';
export { ProjectStore } from './project/project-store.js';
export type { ReadProjectResult } from './project/project-store.js';
export { VisualStore } from './visual/visual-store.js';
export { diffPng } from './visual/visual-diff.js';
export type { VisualDiffResult, VisualRect, DiffOptions } from './visual/visual-diff.js';
export { crawl } from './crawl/crawl.js';
/**
 * The contradiction pass, and the seam a consumer adds its own rules through.
 *
 * Exported because a service embedding this engine grades a recording the same way the tools do, and
 * without these it would have to re-implement the fold — a second implementation of the one thing
 * this product is judged on, and the one nobody dogfoods is the one that rots.
 */
export { findContradictions } from './events/contradictions.js';
/**
 * The MCP server factory, so a consumer can serve the tool surface it composed.
 *
 * Without this the composition seam is unreachable from outside the package: a consumer can build the
 * list and has nothing to hand it to.
 */
export { createMcpServer } from './mcp/mcp.js';
export type { Contradiction, ContradictionOptions } from './events/contradictions.js';
export {
  registerContradictionFold,
  registeredContradictionFolds,
} from './events/contradiction-folds.js';
export type { ContradictionFold } from './events/contradiction-folds.js';
export { MCP_SSE_PATH, MCP_MESSAGE_PATH } from '@reticlehq/core';
export { BrowserPool, DEFAULT_LEASE_TTL_MS } from './pool/browser-pool.js';
export type { Lease, Launcher, PooledBrowser } from './pool/browser-pool.js';
export { playwrightLauncher, resolveMaxContexts } from './pool/playwright-launcher.js';
export { appendReticleParams } from './tools/lease-tools.js';
export { writePid, removePid, isRunning, logPath, readPid, isAlive } from './daemon/daemon.js';
// The daemon's own liveness vocabulary, exported so a GATE can read a daemon log back and say how
// that daemon ended. Without this the battery would re-implement the rule, and a guard that
// re-implements what it guards is insensitive to it.
export {
  classifyDaemonLife,
  DaemonEnd,
  DAEMON_HEARTBEAT_EVENT,
  DAEMON_HEARTBEAT_MS,
  type DaemonLife,
} from './daemon/heartbeat.js';
export type { CrawlReport, CrawlAnomaly, CrawlOptions, CrawlSession } from './crawl/crawl.js';
export { scrollToFind } from './input/scroll-find.js';
export type { ScrollFindResult, ScrollFindQuery, ScrollFindSession } from './input/scroll-find.js';
export {
  CORE_TOOL_NAMES,
  TOOL_SURFACE,
  TOOL_PROFILE_ENV,
  filterTools,
  resolveToolSurface,
} from './tools/tool-surface.js';
export type { ToolSurface } from './tools/tool-surface.js';
export { AnnotationStore } from './flows/annotation-store.js';
export { replayFlow, nearestTestid } from './flows/flow-replay.js';
export type { FlowReplaySession, WaitForSignal } from './flows/flow-replay.js';
export {
  ensureReticleDir,
  writeContract,
  readContract,
  reticleDirPaths,
  flowPath,
  baselinePath,
} from './project/reticle-dir.js';
export type { ReticleDirPaths, ReadContractResult } from './project/reticle-dir.js';
export { createNodeFileSystem } from './project/fs-port.js';
export type { FileSystemPort } from './project/fs-port.js';
// Replay/Verify API — the programmatic surface an OEM/CI pipeline drives (see docs/platform-integration.md).
export { ReticleRunner } from './runs/reticle-runner.js';
export type { RunnerPort, VerifyOptions } from './runs/reticle-runner.js';
export { createRunnerPort, defaultRunId } from './runs/runner-port.js';
export { buildVerificationRun, computeVerdict } from './runs/build-verification-run.js';
export type { VerificationRunInput } from './runs/build-verification-run.js';
export { RunStore } from './runs/run-store.js';
export type { ReadRunResult } from './runs/run-store.js';
export { classifyChangedFiles, buildRisks, risksForPath } from './runs/risk-classify.js';
export type { ChangedFileInput, RiskPolicy } from './runs/risk-classify.js';
export { buildRepairPacket, buildRepairPackets } from './runs/repair-prompt.js';
export { redactForProfile, REDACTED } from './runs/profile-redact.js';
export { renderRunReport } from './runs/render-report.js';
export { handleVerifyRequest, tokenOk, VERIFY_PATH } from './runs/verify-http.js';
export type { VerifyHttpRequest, VerifyHttpResponse } from './runs/verify-http.js';
export {
  createVerifyRequestListener,
  startVerifyServer,
  TOKEN_HEADER,
} from './runs/verify-server.js';
export type { VerifyServerOptions } from './runs/verify-server.js';
export { evaluatePredicate, waitForPredicate, PredicateSchema } from './events/predicate.js';
export type { Predicate, EvalResult } from './events/predicate.js';
export { buildReactionReport } from './events/reaction.js';
export {
  CdpRealInputProvider,
  LaunchedRealInputProvider,
  DriveError,
  performGesture,
  boxCenter,
  isPointerAction,
} from './input/real-input.js';
export type {
  RealInputProvider,
  OwnedRealInputProvider,
  LaunchFn,
  LaunchedProviderOptions,
  ElementBox,
  RealInputArgs,
} from './input/real-input.js';

export interface StartOptions {
  port?: number;
  /** Bind address. Non-loopback hosts require a token. Defaults to RETICLE_HOST or localhost. */
  host?: string;
  /** Browser/bridge pairing token. Defaults to RETICLE_TOKEN. */
  token?: string;
  /** Browser origins allowed in addition to localhost. Defaults to RETICLE_ALLOWED_ORIGINS. */
  allowedOrigins?: string[];
  /** When false, skip the MCP stdio transport (used in tests). */
  mcp?: boolean;
  /** CDP endpoint for native real-input mode. Defaults to env RETICLE_CDP_URL. No-op if unset. */
  cdpUrl?: string;
  /** launch+own a Playwright Chromium at this url and route pointer actions through it. */
  driveUrl?: string;
  /** launch headless (default true; CLI `--headed` sets false). */
  headless?: boolean;
  /** injected so tests swap in a fake launched provider instead of real Playwright. */
  realInputFactory?: (opts: { driveUrl: string; headless: boolean }) => OwnedRealInputProvider;
  /** When driving, force the page's SDK to (re)connect to our bridge with this token — verify a hosted preview. */
  injectConnect?: InjectConnectOptions;
  /** Path to a Playwright storageState JSON so the driven browser starts authenticated (past a login wall). */
  storageState?: string;
  /** absolute .reticle root. Defaults to process.cwd()/.reticle. Injectable for tests. */
  reticleRoot?: string;
  /** Directory holding the auto-provisioned pairing token. Defaults to ~/.reticle. Injectable for tests. */
  pairingTokenDir?: string;
  /** injectable clock for contract.json's generatedAt stamp. Defaults to Date.now. */
  now?: () => number;
  /**
   * Retired profile name (`core`/`full`/…). Old values still map. The live switch is
   * RETICLE_ADVERTISE_ALL_TOOLS=1; the default is the lean surface.
   */
  toolProfile?: string;
  /** Start the OEM/CI verify HTTP endpoint alongside the daemon (`reticle serve --http`). */
  httpVerify?: boolean;
  /** Port for the verify endpoint. Defaults to RETICLE_VERIFY_DEFAULT_PORT. */
  httpVerifyPort?: number;
  /** Shared token for the verify endpoint. Defaults to env RETICLE_VERIFY_TOKEN, else open (localhost). */
  httpVerifyToken?: string;
}

/** Default localhost port for the verify HTTP endpoint (see docs/platform-integration.md). */
export const RETICLE_VERIFY_DEFAULT_PORT = 7331;

export interface RunningServer {
  bridge: Bridge;
  /** the active real-input provider (launched/CDP), if any. */
  realInput?: RealInputProvider;
  /** the bound port of the verify HTTP endpoint, when `httpVerify` is enabled. */
  verifyPort?: number;
  /** True when nothing is using the daemon: no agent connected, no browser session, no pool lease.
   * The daemon entry (cli.ts) polls this to self-shut-down when idle so Reticle never lingers. */
  isIdle?: () => boolean;
  /** True while an agent's MCP client is attached — see IdleShutdownOptions.agentAttached. */
  agentAttached?: () => boolean;
  /** The pairing token the bridge is enforcing (explicit, env, or auto-provisioned); undefined if none. */
  token?: string;
  /**
   * Tell every attached MCP proxy this daemon is retiring, before anything closes.
   *
   * Optional because only the daemon entry point serves MCP over SSE — `start()` speaks stdio, where
   * the client owns the process and there is no stream to warn. See SharedServer.announceShutdown.
   */
  announceShutdown?: () => void;
  close: () => Promise<void>;
}

export { resolveBridgeSecurity } from './bridge/bridge-security.js';

/**
 * Build the shared browser pool (one headless Chromium, N capped isolated leased contexts). Lazy —
 * no Chromium launches until the first lease — so creating it is free even when never used.
 */
function createBrowserPool(headless: boolean): BrowserPool {
  const maxContexts = resolveMaxContexts(process.env[ReticleEnv.MAX_CONTEXTS], cpus().length);
  const genSessionId = (): string =>
    `lease-${
      'function' === typeof globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : String(Date.now())
    }`;
  return new BrowserPool(playwrightLauncher({ headless }), { maxContexts, genSessionId });
}

/**
 * Route CDP-authoritative network detail onto the driven session's journal.
 *
 * The page and the SDK session share an origin, so a NET_DETAIL is pushed to the matching connected
 * session. Shared by both entry points: `startDaemon` previously omitted it entirely, so on the path
 * users actually take, CDP network detail was collected and then dropped on the floor.
 */
function makeNetworkDetailRouter(bridge: Bridge, driveUrl: string | undefined) {
  const driveOrigin = originOf(driveUrl ?? '');
  return (detail: NetworkDetail): void => {
    // Route by the DOCUMENT that issued the request, not by the request's own origin.
    //
    // Matching the request's origin only works for same-origin calls. An app on one origin calling an
    // API on another — most API calls — produced a detail matching no session, and it was dropped
    // without a trace. The drive-URL fallback papered over it on the launched path and did nothing on
    // the CDP-attach path, where driveUrl is undefined and the fallback compares against ''.
    const pageOrigin = originOf(detail.pageUrl ?? '');
    const requestOrigin = originOf(detail.url);
    for (const session of bridge.sessions.all()) {
      const origin = originOf(session.url);
      // originOf returns `string | undefined`, NEVER '' — so the old `!== ''` guards were dead, and a
      // bare `origin === requestOrigin` matched `undefined === undefined` when BOTH the session URL and
      // the detail URL were unparseable. That routed a NET_DETAIL (with its response headers, incl.
      // set-cookie) onto an unrelated session. Require a DEFINED origin; undefined operands then simply
      // fail to match any of the three candidates.
      const matches =
        origin !== undefined &&
        (origin === pageOrigin || origin === requestOrigin || origin === driveOrigin);
      if (matches) {
        session.pushEvent({
          t: 0,
          type: EventType.NET_DETAIL,
          sessionId: session.id,
          data: { ...detail },
        });
      }
    }
  };
}

/**
 * Wire journal capture, ambient seeding and the journal-tail flush onto a bridge.
 *
 * Both entry points need all three, and both used to hand-roll them. `startDaemon` only ever wired the
 * first, so on the path every user actually takes (`reticle serve` / `reticle mcp`) the journal tail was
 * dropped at session end and the learned ambient map was never persisted OR seeded — meaning ambient
 * learning could not converge across sessions and the last events of every session were lost. The two
 * call sites had already drifted once before, which is why this is one function rather than a
 * copy-paste both are asked to keep in step.
 */
function attachJournal(
  bridge: Bridge,
  deps: { fs: FileSystemPort; reticleRoot: string; enabled: boolean },
): void {
  const journalAttach = makeJournalAttach(deps);
  const ambientStore = new AmbientStore(deps.fs, deps.reticleRoot);
  // Built once, not per session: the resolver walks config discovery and the user-level registry,
  // and neither changes between two tabs connecting a second apart.
  const resolveArtifactRoot = artifactRootResolver(deps.reticleRoot);
  bridge.attachSessionCreate((session) => {
    // Stamp the project's own `.reticle` before ANY counter fires for this session. Without it every
    // verdict is recorded against wherever the daemon was started, which is how one app's evidence
    // reached a different account's production dashboard.
    session.artifactRoot = resolveArtifactRoot(session.projectId).root;
    journalAttach(session);
    // Seed the learned ambient map so a fresh session starts knowing which regions churn, instead of
    // re-learning from zero. Best-effort + async: a late seed still helps, a failure is silent.
    if (deps.enabled) {
      void ambientStore
        .load()
        .then((counts) => session.seedAmbient(counts))
        .catch(() => undefined);
    }
  });
  // Teardown: flush the journal tail to disk + persist what this session learned.
  bridge.attachSessionEnd(makeSessionEnd(deps));
  if (deps.enabled) {
    void pruneSessions(deps.fs, deps.reticleRoot);
    // Here rather than in `init`, because this is the moment we are actually about to write into
    // somebody's repository — and the paths that reach it without ever running `init` (a plugin
    // install, a hand-added client config) are exactly the ones that would otherwise leave an
    // unexplained pile of untracked files behind. Best-effort and write-once; see the helper.
    void ensureWorkspaceGitignore(deps.fs, deps.reticleRoot);
  }
}

/**
 * Resolve the drive/real-input provider from options — shared by start and startDaemon so the
 * precedence (driveUrl launch+own → CDP attach → none) and the storageState/injectConnect plumbing
 * live in ONE place. `onNavigateError` is the entrypoint's own cleanup (close the bridge/shared server)
 * so a failed launch never leaks a WS port. A past divergence between the two paths let daemon mode
 * run with a different setup — this removes that risk.
 */
async function resolveRealInput(
  options: StartOptions,
  onNavigateError: () => Promise<void>,
  onNetworkDetail?: (detail: NetworkDetail) => void,
): Promise<{ realInput?: RealInputProvider; owned?: { dispose: () => Promise<void> } }> {
  const driveUrl = options.driveUrl;
  if (driveUrl !== undefined && driveUrl.length > 0) {
    const headless = options.headless ?? true;
    // The one place that knows. Everything downstream reads it rather than re-deriving it, and a
    // daemon that launches nothing keeps the default (ATTACHED) rather than guessing.
    setBrowserMode(headless ? BrowserMode.HEADLESS : BrowserMode.HEADED);
    const injectConnect = options.injectConnect;
    const storageState = options.storageState;
    const factory =
      options.realInputFactory ??
      ((opts) =>
        new LaunchedRealInputProvider({
          driveUrl: opts.driveUrl,
          headless: opts.headless,
          ...(injectConnect !== undefined ? { injectConnect } : {}),
          ...(storageState !== undefined ? { storageState } : {}),
          ...(onNetworkDetail !== undefined ? { onNetworkDetail } : {}),
        }));
    const launched = factory({ driveUrl, headless });
    try {
      await launched.navigate();
    } catch (error) {
      await onNavigateError(); // no leaked WS port on a failed start
      throw error;
    }
    return { realInput: launched, owned: launched };
  }
  const cdpUrl = options.cdpUrl ?? process.env[ReticleEnv.CDP_URL];
  if (cdpUrl !== undefined && cdpUrl.length > 0) {
    // Same network sink as the launched path. Whether Reticle opened the browser or attached to one
    // someone else opened has no bearing on whether it can read that browser's network.
    const cdp = new CdpRealInputProvider({
      cdpUrl,
      ...(onNetworkDetail !== undefined ? { onNetworkDetail } : {}),
    });
    return { realInput: cdp, owned: cdp };
  }
  return {};
}

/** Start the Reticle bridge (browser WS endpoint) and, by default, the MCP stdio server. */

/**
 * The SDK-upgrade sentence for THIS project's package.json, evaluated at each HELLO so a
 * just-edited manifest is what we name. Falls back to the framework-neutral sensor when cwd is
 * not an app.
 */
function sdkFixForCwd(): string {
  return sdkFixForDirectory(SERVER_VERSION, process.cwd());
}

/**
 * Resolve a session's artifact root, from everything this machine knows about where projects live.
 *
 * Built once per daemon and closed over by every tool call. The two sources are read lazily and
 * cheaply on each call rather than snapshotted at startup: `init` can run in another terminal while
 * this daemon is up, and a resolution that used a startup snapshot would keep answering with a map
 * from before the project the agent is now driving existed.
 */
/**
 * Every `.reticle` root on this machine that sync should consider, from the same two sources the
 * artifact resolver uses.
 *
 * Read on every call rather than snapshotted, for the same reason: `reticle link` can run in
 * another terminal while this daemon is up, and a startup snapshot would keep that repo silent
 * until somebody restarted a process they have no reason to suspect.
 *
 * Returns directories that MIGHT be linked; the caller resolves each and skips the ones that are
 * not. Deciding that here would mean reading every cloud.json on every tick.
 */
function knownProjectRoots(): string[] {
  const roots = new Set<string>();
  try {
    const path = join(homedir(), ReticleDir.ROOT, PROJECT_REGISTRY_FILE);
    if (existsSync(path)) {
      const registry = parseProjectRegistry(JSON.parse(readFileSync(path, 'utf8')));
      for (const candidate of projectCandidates(registry))
        roots.add(join(candidate.directory, ReticleDir.ROOT));
    }
  } catch {
    // A registry that cannot be read is an empty one — never a reason to stop syncing.
  }
  try {
    for (const config of discoverProjectConfigs(process.cwd()).found)
      roots.add(join(config.directory, ReticleDir.ROOT));
  } catch {
    // Same: a diagnostic walk that throws must not take the sync loop with it.
  }
  return [...roots];
}

function artifactRootResolver(daemonRoot: string): (projectId: string | undefined) => ArtifactRoot {
  return (projectId) => {
    let registry = emptyProjectRegistry();
    try {
      const path = join(homedir(), ReticleDir.ROOT, PROJECT_REGISTRY_FILE);
      registry = existsSync(path)
        ? parseProjectRegistry(JSON.parse(readFileSync(path, 'utf8')))
        : registry;
    } catch {
      // A cache that cannot be read is an empty cache, never an error: the daemon still resolves
      // through discovery, and falls back to its own root exactly as it did before this existed.
    }
    let discovery: ConfigDiscovery = { found: [], searched: [] };
    try {
      discovery = discoverProjectConfigs(process.cwd());
    } catch {
      // Same reasoning: a diagnostic search that throws must not take a tool call with it.
    }
    return resolveArtifactRoot({
      projectId,
      candidates: projectCandidatesFrom(discovery, registry),
      daemonRoot,
    });
  };
}

export async function start(options: StartOptions = {}): Promise<RunningServer> {
  const port = options.port ?? RETICLE_DEFAULT_PORT;
  // Open the user's impact record before anything can connect. Not inside the MCP branch: a daemon
  // serving a browser with no agent attached still has a HUD to answer, and a report that reads
  // "nothing recorded yet" over a month of history on disk is the worst version of this feature.
  initImpact({ reticleRoot: options.reticleRoot ?? join(process.cwd(), ReticleDir.ROOT) });
  const security = await resolveBridgeSecurityWithAutoToken(options);
  const bridge = new Bridge({ port, sdkFix: sdkFixForCwd, ...security });
  // Server-authoritative liveness: a Node-side reaper (immune to browser throttling) ends sessions
  // whose agent has gone idle, so a forgotten/crashed agent never leaves the HUD "running" forever.
  const reaper = new SessionReaper(bridge.sessions);
  reaper.start();
  // Scope auto-selection to the active project (from .reticle.json) so a stray tab from another app is
  // never picked when the agent omits a sessionId. Explicit per-call scope/sessionId still overrides.
  const activeProjectId = readProjectId(process.cwd());
  if (activeProjectId !== undefined) {
    bridge.sessions.setDefaultScope({ projectId: activeProjectId });
  }
  const baselines = new BaselineStore();
  const recordings = new RecordingStore();
  // drive precedence: driveUrl (launch+own a browser) → CDP (attach) → none.
  let pool: BrowserPool | undefined;
  let leaseReaper: LeaseReaper | undefined;
  // Route CDP-authoritative network detail (drive path only) onto the driven session's journal: the
  // page and the SDK session share an origin, so a NET_DETAIL is pushed to the matching connected session.
  const routeNetworkDetail = makeNetworkDetailRouter(bridge, options.driveUrl);
  const { realInput, owned } = await resolveRealInput(
    options,
    () => bridge.close(),
    routeNetworkDetail,
  );

  if (options.mcp !== false) {
    // cwd/Date.now are confined to start — never inside reticle-dir.ts's pure logic (rule 7).
    const fs = createNodeFileSystem();
    const reticleRoot = options.reticleRoot ?? join(process.cwd(), ReticleDir.ROOT);
    const now = options.now ?? ((): number => Date.now());
    const journalEnabled = readJournalEnabled(process.cwd(), process.env[ReticleEnv.JOURNAL]);
    attachJournal(bridge, { fs, reticleRoot, enabled: journalEnabled });
    const flows = new FlowStore(fs, reticleRoot, { now });
    const project = new ProjectStore(fs, reticleRoot, { now });
    attachRouteLearning(bridge, project);
    const annotations = new AnnotationStore();
    pool = createBrowserPool(options.headless ?? true);
    leaseReaper = new LeaseReaper(pool);
    leaseReaper.start();
    /*
     * Tell a tab that ARRIVES during a lease why its HUD is silent.
     *
     * The acquire-time notice only reaches tabs already connected, so opening the app — or merely
     * reloading it — while an agent held a lease landed somebody on a dark HUD with nothing
     * explaining it. That is the more common way to hit it, because a person opens the dashboard
     * precisely when they want to watch. Reported as "dashboard is being watched, but the agent chat
     * shows nothing".
     *
     * Registered separately from the journal hook rather than folded into it: this one needs the
     * pool, which does not exist on the no-drive path, and session-create handlers are additive.
     */
    const leasePool = pool;
    bridge.attachSessionCreate((session) => {
      const leasedIds = leasePool.leasedSessionIds();
      const leasedProjects = leasedIds.map((id) => bridge.sessions.get(id)?.projectId);
      if (shouldGreetWithLeaseNotice(session, leasedIds, leasedProjects))
        session.pushNarration(AGENT_ALREADY_DRIVING_ELSEWHERE);
    });
    const deps = {
      sessions: bridge.sessions,
      pool,
      baselines,
      recordings,
      annotations,
      flows,
      project,
      fs,
      reticleRoot,
      artifactRootFor: artifactRootResolver(reticleRoot),
      now,
      bridgePort: port,
      browserProbe: probeChromium,
      // The daemon's OWN project, so a tool can tell "this session is mine" from "this session
      // belongs to a sibling app under the same daemon". contract_save refuses on the second.
      ...(activeProjectId === undefined ? {} : { projectId: activeProjectId }),
    };
    const profile = resolveToolSurface(options.toolProfile);
    const server = createMcpServer(
      realInput !== undefined ? { ...deps, realInput } : deps,
      profile,
      hasProjectConnectedBefore(reticleStateHome(), port, activeProjectId),
    );
    // When the agent (the MCP client) disconnects cleanly, end every active session at once so the
    // HUD doesn't linger. (If the agent instead KILLS this process, the WS dies and the browser
    // self-ends via SESSION_LIFECYCLE.BRIDGE_LOST_MS — see transport.ts.)
    server.server.onclose = () => {
      endAllSessions(bridge.sessions, MCP_DISCONNECT_SUMMARY);
    };
    await server.connect(new StdioServerTransport());
    log('mcp_connected', { port });
  }

  return {
    bridge,
    ...(realInput !== undefined ? { realInput } : {}),
    ...(security.token !== undefined ? { token: security.token } : {}),
    close: async () => {
      reaper.stop();
      await cleanupCaptureDirectories();
      leaseReaper?.stop();
      await pool?.shutdown();
      await owned?.dispose();
      await bridge.close();
    },
  };
}

/**
 * Start the Reticle bridge in daemon mode: a single HTTP server handles both the WebSocket
 * bridge (browser SDK) and the SSE MCP transport (Claude/agent). Unlike start, the MCP
 * connection is not tied to the process lifetime — Claude reconnects across sessions while
 * browser sessions persist in the daemon.
 */
export async function startDaemon(options: StartOptions = {}): Promise<RunningServer> {
  const port = options.port ?? RETICLE_DEFAULT_PORT;
  // The SAME line as in `start`, because these are two entry points that each wire their own world
  // and the daemon is the one that actually serves people. Wired only in `start`, the impact record
  // was never opened in the process the HUD talks to: tool calls still recorded (the dispatch
  // chokepoint opens it lazily), but a tab that connected before the first tool call was pushed
  // nothing, so the report read "nothing recorded yet" over a file with history in it.
  initImpact({ reticleRoot: options.reticleRoot ?? join(process.cwd(), ReticleDir.ROOT) });

  const security = await resolveBridgeSecurityWithAutoToken(options);
  const shared = createSharedServer(security.token === undefined ? {} : { token: security.token });
  const bridge = new Bridge({ port, server: shared.httpServer, sdkFix: sdkFixForCwd, ...security });
  // The daemon owns listen (below), so the real bind error is reported there; absorb bridge.ready's
  // mirror rejection so a port collision can't surface as an unhandled promise rejection.
  void bridge.ready.catch(() => undefined);
  // Declared before attachStatus so the closure below can report it; assigned further down, before
  // listen — the first status request cannot arrive until after the bind.
  let verifyHttp: { server: Server; port: number } | undefined;
  // `reticle status` GETs this for a live, at-a-glance view of connected tabs + their health.
  // The same diagnosis agents get on an empty `reticle_sessions`, so `reticle status` — the
  // most-run command in the field — stops answering "sessionCount: 0" and nothing else.
  // `verifyPort` rides along so a later `serve --http` can tell whether this daemon already honours
  // the requested `--http-port` instead of silently ignoring the flag (#687).
  shared.attachStatus(() =>
    statusPayload(
      bridge.sessions.count(),
      bridge.sessions.list(),
      bridge.sessions.noSessionHint(),
      verifyHttp?.port,
    ),
  );
  // Agent-independent presence: the daemon outlives any single agent, so when the LAST agent's MCP
  // connection drops (it stopped, or is waiting on the human), end every session and push a clear
  // "go to your terminal" notice to the panel — the human is on the browser and must not lose a typed
  // prompt into a dead session. A returning agent's next tool call revives the auto-ended session.
  // Track agent presence for the idle-shutdown predicate (below): the daemon is "idle" only when no
  // agent is attached AND no browser tab is connected AND no pool lease is active.
  let agentConnected = false;
  shared.attachAgentPresence((connected) => {
    agentConnected = connected;
    if (!connected) endAllSessions(bridge.sessions, AGENT_STOPPED_NOTICE);
  });

  const reaper = new SessionReaper(bridge.sessions);
  reaper.start();
  const { realInput, owned } = await resolveRealInput(
    options,
    () => shared.close(),
    makeNetworkDetailRouter(bridge, options.driveUrl),
  );

  const fs = createNodeFileSystem();
  const reticleRoot = options.reticleRoot ?? join(process.cwd(), ReticleDir.ROOT);
  const now = options.now ?? ((): number => Date.now());
  const journalEnabled = readJournalEnabled(process.cwd(), process.env[ReticleEnv.JOURNAL]);
  attachJournal(bridge, { fs, reticleRoot, enabled: journalEnabled });
  const flows = new FlowStore(fs, reticleRoot, { now });
  const project = new ProjectStore(fs, reticleRoot, { now });
  attachRouteLearning(bridge, project);
  const annotations = new AnnotationStore();
  const pool = createBrowserPool(options.headless ?? true);
  const leaseReaper = new LeaseReaper(pool);
  leaseReaper.start();
  /*
   * Automatic cloud sync, for the session nobody thinks about.
   *
   * The daemon outlives every individual tool call and is already running for the whole session, so
   * it is the only place "keep the dashboard current while work is happening" costs nobody an extra
   * process to remember. Safe for an UNLINKED project: it resolves the link on every tick and does
   * nothing until one exists, so `reticle link` takes effect without a restart.
   */
  const cloudSync = startSyncDaemon({
    reticleRoot,
    cloud: () => resolveProjectCloud(fs, reticleRoot, homedir(), process.env),
    // Every OTHER linked repo on this machine, not just the directory the daemon was started in.
    // One daemon serves many projects, and pushing only its own root left the rest silently
    // reporting nothing — indistinguishable, on the dashboard, from nobody having verified anything.
    otherRoots: () => Promise.resolve(knownProjectRoots()),
    cloudFor: (root) => resolveProjectCloud(fs, root, homedir(), process.env),
  });
  // Scope auto-selection to the active project (from .reticle.json) so a stray tab from another app is
  // never picked when the agent omits a sessionId. Explicit per-call scope/sessionId still overrides.
  // Scope + the no-session diagnosis: "no browser session connected" is the error that ends most
  // sessions, and the agent is told to check two things it cannot see. See no-session-diagnosis.ts.
  // Ordered AFTER the pool: the watch may open a browser itself the moment it finds a listening dev
  // server for a wired project (see no-session-watch.ts), and it opens it through the pool — the same
  // path reticle_lease takes, in this process, binding nothing.
  wireSessionScope(
    bridge.sessions,
    readProjectId(process.cwd()),
    port,
    (sessionId) => pool.wasReapedLease(sessionId),
    (url) => pool.acquire(url),
  );
  const deps = {
    sessions: bridge.sessions,
    pool,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    annotations,
    flows,
    project,
    fs,
    reticleRoot,
    // The long-lived daemon needs this MORE than the standalone MCP process does, not less: it is
    // the one that outlives a single project and serves every app on the machine. Omitting it here
    // silently disabled per-session artifact resolution for every agent that attaches to a running
    // daemon — the common case — so flows were listed, loaded and healed against wherever the
    // daemon happened to be launched. Wired in only one of the two places, a resolver is a resolver
    // that does not run.
    artifactRootFor: artifactRootResolver(reticleRoot),
    now,
    bridgePort: port,
    browserProbe: probeChromium,
    // A finished verification should not sit behind a one-minute timer — see ToolDeps.onRunPersisted.
    onRunPersisted: (): void => cloudSync.nudge(),
  };
  const profile = resolveToolSurface(options.toolProfile);
  const effectiveDeps = realInput !== undefined ? { ...deps, realInput } : deps;
  // Read per attach, not once: a project that gets wired while this daemon is alive should stop
  // being told to wire itself on the next agent that connects.
  shared.attachMcp(() =>
    createMcpServer(
      effectiveDeps,
      profile,
      hasProjectConnectedBefore(reticleStateHome(), port, readProjectId(process.cwd())),
    ),
  );
  // `reticle drive <url>` when this daemon already owns the port: it asks HERE instead of trying to
  // bind a port we are holding, and gets the same pooled context an agent's reticle_lease returns —
  // through runTool, so it is counted and reported like any other call rather than being a second,
  // invisible dispatch path. See cli/drive-attach.ts for why attaching beats refereeing the race.
  shared.attachDrive((url) => runTool(LEASE_ACQUIRE_TOOL, effectiveDeps, { url }));

  // Optional OEM/CI verify endpoint: a host platform POSTs to /verify and gets an ReticleVerificationRun,
  // driving the same flow-replay machinery the agent uses — no MCP stdio, no human. Each verdict is
  // persisted via RunStore. Localhost-bound + token-guarded. Off unless `reticle serve --http`.
  // (`verifyHttp` itself is declared above attachStatus, which reports its port.)
  if (true === options.httpVerify) {
    // Wakes cloud sync when the HTTP verify server persists a run — that path does not push
    // inline the way the MCP one does, so without this its runs waited for the timer.
    const runStore = new RunStore(fs, reticleRoot, { onWrote: () => cloudSync.nudge() });
    const runner = new ReticleRunner(createRunnerPort(effectiveDeps));
    const token = options.httpVerifyToken ?? process.env[ReticleEnv.VERIFY_TOKEN] ?? '';
    verifyHttp = await startVerifyServer(
      { runner, token, persist: (run) => runStore.write(run) },
      options.httpVerifyPort ?? RETICLE_VERIFY_DEFAULT_PORT,
    );
    log('reticle_verify_http_started', { port: verifyHttp.port, tokenRequired: token.length > 0 });
  }

  // Replay-from-panel: the human clicks ▶ on a saved flow; run it with NO agent and narrate the
  // verdict into the same activity log they watch the agent in. The page animates via the normal
  // replay path, so they see it re-drive and the ✓/⚠/✗ land.
  bridge.attachReplay((sessionId, flowName) => {
    const session = bridge.sessions.get(sessionId);
    if (session === undefined) return;
    session.pushNarration(`▶ Replaying "${flowName}"…`);
    replayNamedFlow(effectiveDeps, { flowName, sessionId })
      .then((result) => session.pushNarration(replayVerdictLine(result)))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        session.pushNarration(`✗ Replay "${flowName}" failed — ${message}`);
      });
  });
  // On connect, hand the panel the replayable flows so it can render the ▶ list. Scoped to the
  // connecting session's project (a shared daemon serves many apps; each panel shows only its own
  // flows + legacy untagged ones). Each chip carries a `start` hint (the first step's testid anchor)
  // so the HUD shows a flow only on the page it can begin from — the panel re-scopes per route.
  // The first instrumented app of this daemon run — the funnel step nothing could measure before.
  // Inside the existing session-ready hook rather than beside it: this fires exactly when a page
  // carrying the SDK has completed its handshake, which is the definition of "instrumented", and
  // `reportAppInstrumented` is idempotent so later sessions cost a boolean check.
  bridge.attachSessionReady(() => {
    reportAppInstrumented({
      initialized: readProjectId(process.cwd()) !== undefined,
      agentAttached: agentConnected,
    });
  });

  bridge.attachSessionReady((session) => {
    flows
      .list(session.projectId)
      .then(async (names) => {
        const loaded = await Promise.all(names.map((name) => flows.load(name, session.projectId)));
        const files = loaded.flatMap((r) => (r.ok ? [r.value] : []));
        await session.command(ReticleCommand.FLOWS, {
          flows: buildFlowChips(files, session.projectId),
        });
      })
      .catch(() => undefined);
  });

  // Bind with BOTH a 'listening' and an 'error' handler. Without the error path, a port collision
  // (EADDRINUSE — another daemon already owns this port) emits 'error' with no listener, so the
  // promise never settles and the daemon hangs forever, orphaning the process and its PID file.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      shared.httpServer.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      shared.httpServer.removeListener('error', onError);
      resolve();
    };
    shared.httpServer.once('error', onError);
    shared.httpServer.once('listening', onListening);
    shared.httpServer.listen(port, security.host ?? LOOPBACK_HOST);
  });

  // `localhost` is a name with two answers, and Windows/Chrome tries the IPv6 one first. Only alias
  // when we are on the default loopback bind: an explicit RETICLE_HOST is a deliberate choice about
  // reachability, and quietly adding a second listener to it would be the opposite of deliberate.
  const loopbackAlias =
    security.host === undefined
      ? await openLoopbackAlias(port)
      : { opened: false, close: undefined };

  log('mcp_daemon_started', { port, loopbackAlias: loopbackAlias.opened });

  return {
    bridge,
    ...(realInput !== undefined ? { realInput } : {}),
    ...(verifyHttp !== undefined ? { verifyPort: verifyHttp.port } : {}),
    ...(security.token !== undefined ? { token: security.token } : {}),
    // Nobody is using this daemon — self-shuts-down once it holds for the grace window. See
    // daemon-usefulness.ts for the two ways that can be true.
    isIdle: buildIdlePredicate(() => agentConnected, bridge.sessions, pool),
    // Exposed so the shutdown watcher can give an ATTACHED daemon a longer grace. The predicate above
    // says WHETHER it is idle; this says how long that quiet should be tolerated — see idle-grace.
    agentAttached: () => agentConnected,
    announceShutdown: () => shared.announceShutdown(),
    close: async () => {
      reaper.stop();
      await cleanupCaptureDirectories();
      const vh = verifyHttp;
      if (vh !== undefined) await new Promise<void>((resolve) => vh.server.close(() => resolve()));
      leaseReaper.stop();
      cloudSync.stop();
      await loopbackAlias.close?.();
      await pool.shutdown();
      await owned?.dispose();
      await bridge.close();
      await shared.close();
    },
  };
}
