/**
 * Anonymous adoption telemetry — the OSS runtime's ONLY phone-home for product metrics (DAU/WAU/MAU,
 * invocations, sessions, installs, tool usage). It answers the "npm downloads don't count, show me
 * platform usage" question without collecting anything personal:
 *
 *   - identity is a random UUID minted locally at `~/.reticle/telemetry-id` (never derived from you),
 *   - the project is a one-way HASH of the cwd (counts DISTINCT projects, reveals none),
 *   - it is strictly opt-OUT: `RETICLE_TELEMETRY=0` or the `DO_NOT_TRACK` convention disables it,
 *   - it is best-effort and non-blocking: a send failure NEVER changes what the tool does.
 *
 * Events are `@reticlehq/core`'s `TelemetryEventSchema`, mapped at the wire into PostHog's capture
 * format (https://posthog.com/docs/api/capture) — PostHog is the analytics backend until the hosted service
 * grows its own; a project API key is WRITE-ONLY by design, so embedding it in an OSS client is safe.
 * Everything here is wrapped so a telemetry bug can never surface to a user — a broken metric must not
 * break a verification.
 */
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import {
  TelemetryEventKind,
  TELEMETRY_EVENT_VERSION,
  ProjectIdSource,
  type Crash,
  type Feedback,
  type Identity,
  type BugFound,
  isSessionScoped,
  type InitOutcome,
  type InstallSource,
  type McpConnection,
  type McpOutage,
  type ToolRefusal,
  type AppInstrumentation,
  type ProjectProfile,
  type SessionSummary,
  type TelemetryActor,
  type TelemetryEvent,
  type Verification,
  type VersionChange,
} from '@reticlehq/core';
import { SERVER_VERSION } from '../version/server-version.js';

const RETICLE_DIR = join(homedir(), '.reticle');
const ID_FILE = join(RETICLE_DIR, 'telemetry-id');
const NOTICE_FILE = join(RETICLE_DIR, 'telemetry-notice-shown');
/** Presence of this file = a persistent, machine-wide opt-out (`reticle telemetry disable`). */
const OPT_OUT_FILE = join(RETICLE_DIR, 'telemetry-opt-out');
/** Where the full disclosure lives — printed in the first-run notice and `reticle telemetry status`. */
const POLICY_URL = 'https://github.com/reticlehq/reticle/blob/main/docs/telemetry.md';
/** PostHog batch-capture endpoint (US cloud). `RETICLE_TELEMETRY_URL` overrides the host (EU/self-host). */
const DEFAULT_URL = 'https://us.i.posthog.com';
const TELEMETRY_PATH = '/batch/';
/**
 * The write-only PostHog project key (safe to embed: it can only WRITE events, never read anything —
 * PostHog's own docs ship it in client-side JS). `RETICLE_TELEMETRY_KEY` overrides it; empty disables.
 */
const POSTHOG_KEY = 'phc_q4yCxKMXHfWQ43VAz4HxJXZFLqFi4nBbg5v3avemggYo';
/**
 * Skip PostHog person-profile processing: our users are anonymous by construction (never $identify'd),
 * so profiles buy nothing — and personless events are up to 4x cheaper while unique counts/retention
 * still key on distinct_id.
 */
const POSTHOG_PERSONLESS = { $process_person_profile: false } as const;

/**
 * PostHog's group type for a licensed customer. Sent as `$groups` so PostHog can aggregate a whole
 * organisation natively: per-company retention, "which orgs went quiet", one row per customer rather
 * than one per machine.
 *
 * The KEY is the licence id and nothing else. The organisation's NAME is never sent from a customer's
 * machine, here or anywhere; the name reaches PostHog only if we push it ourselves from the issuance
 * ledger, which is the one place that mapping lives. So an event still carries no identity, and the
 * analytics side learns a customer list only when we deliberately upload one.
 */
export const POSTHOG_GROUP_ORGANIZATION = 'organization';
const SEND_TIMEOUT_MS = 2000;

/**
 * Feedback gets its own, much larger budget — and a retry.
 *
 * 2s + drop is right for a usage counter: the metric is worthless if it costs the user latency, and
 * losing one changes nothing. Feedback is the opposite on both counts. It is the only qualitative
 * channel the product has, it carries an agent's entire root-cause analysis, and losing one loses
 * work that cannot be reconstructed.
 *
 * Measured to the collector with a WARM DNS cache: dns 0.003s, connect 0.233s, tls 0.467s, total
 * 0.694s — a third of the old budget gone before any payload moves, on the good path. A fresh
 * short-lived CLI process pays cold DNS and a cold route on top, which is exactly the case that
 * failed in the field and then succeeded on retry from a warmer process.
 */
const FEEDBACK_TIMEOUT_MS = 15_000;
const FEEDBACK_RETRIES = 1;
const FEEDBACK_RETRY_BACKOFF_MS = 750;

/**
 * The sender a `detach: true` emit runs in a disowned child (argv: [url, body]) — an in-process fetch
 * keeps Node's event loop alive until the POST finishes, which taxed every short-lived CLI command
 * (`reticle version`/`gate`) ~800ms. Long-lived daemon events still send in-process: a spawn per tool
 * call would be far heavier than a fetch inside an already-running server.
 */
/**
 * The budget the DISOWNED child gets, and why it is not `SEND_TIMEOUT_MS`.
 *
 * 2s is right for an in-process send: the daemon is waiting on it, so the budget is a latency cost
 * somebody pays. A detached child pays nobody — the parent has already exited — so the only thing a
 * short budget there buys is a lost event.
 *
 * And it loses the worst ones. Every detached send comes from a SHORT-LIVED CLI process, which pays
 * cold DNS and a cold TLS route by definition; measured on the feedback path with a WARM cache it
 * was already 0.694s before any payload moved. `reticle_installed` is the extreme case: it fires
 * once per machine, on the first Reticle command that machine ever runs, which is the single coldest
 * network call it will ever make to the collector — so the top of the funnel is the event most
 * likely to be dropped, and it fails silently like everything else here.
 */
const DETACHED_SEND_TIMEOUT_MS = 15_000;
const DETACHED_SEND_SCRIPT =
  "fetch(process.argv[1],{method:'POST',headers:{'content-type':'application/json'}," +
  `body:process.argv[2],signal:AbortSignal.timeout(${DETACHED_SEND_TIMEOUT_MS})})` +
  '.catch(()=>{}).finally(()=>process.exit(0))';

/** Env var names — mirror cloud-sync's `RETICLE_*` convention. */
import { isReticleSourceCheckout } from './dev-repo.js';
import { projectInstallSource } from './install-source.js';
import { licenseFacts } from './license-activation.js';
import { gitFacts } from './git-facts.js';
import { currentAutomationHint } from './automation-hint.js';

const Env = {
  DISABLE: 'RETICLE_TELEMETRY', // "0" / "false" / "off" → disabled
  DO_NOT_TRACK: 'DO_NOT_TRACK', // the cross-tool opt-out convention (any truthy value)
  URL: 'RETICLE_TELEMETRY_URL', // override the PostHog host (EU cloud / self-hosted)
  FILE: 'RETICLE_TELEMETRY_FILE', // record to a local JSONL file and send NOTHING — see the sink note
  KEY: 'RETICLE_TELEMETRY_KEY', // override the PostHog project key
  CI: 'CI', // presence marks a CI environment
  VITEST: 'VITEST', // set by vitest — unit tests must never phone home
} as const;

const isDisabled = (env: NodeJS.ProcessEnv, cwd: string = process.cwd()): boolean => {
  const off = new Set(['0', 'false', 'off', 'no']);
  if (off.has((env[Env.DISABLE] ?? '').toLowerCase())) return true;
  // Recording to a local file is not "phoning home", and the guards below exist to stop us phoning
  // home. Chief among them is the source-checkout rule — which is exactly where a release sweep is
  // driven from, so a sink that inherited it would record nothing and look like it had worked.
  if ((env[Env.FILE] ?? '') !== '') return false;
  if (env[Env.VITEST] !== undefined) return true; // a test run is not a user
  // Developing Reticle is not using Reticle. The `.env` carrying RETICLE_TELEMETRY=0 is gitignored,
  // so it only exists on the machine that made it — a fresh clone would phone home on a
  // contributor's first `reticle serve`. The repo marker is committed, so this guarantee travels.
  if (isReticleSourceCheckout(cwd)) return true;
  const dnt = env[Env.DO_NOT_TRACK];
  return 'string' === typeof dnt && dnt !== '' && dnt !== '0';
};

/**
 * Would telemetry be on here if we ignored the source-checkout guard alone?
 *
 * That guard exists so a fresh clone does not phone home on a contributor's first `reticle serve` —
 * a rule about PASSIVE collection. Feedback is never passive: somebody typed it. Applying the guard
 * to it means anyone dogfooding from their own checkout files nothing and is told "not sent, unknown
 * reason", which silently loses every report from exactly the people most likely to write good ones.
 * Reported from the field, and the reporter only escaped it by happening to run from another repo.
 *
 * Every explicit opt-out still applies — RETICLE_TELEMETRY=0, DO_NOT_TRACK, the persisted opt-out
 * file, and a test run. This lifts one implicit guard for one user-initiated event kind.
 */
const onlyBlockedBySourceCheckout = (env: NodeJS.ProcessEnv, cwd: string): boolean =>
  isDisabled(env, cwd) && !isDisabled(env, '/');

/** Read (or mint-and-persist) the anonymous machine id. `firstRun` is true the run that created it. */
const resolveIdentity = (): { anonymousId: string; firstRun: boolean } => {
  try {
    if (existsSync(ID_FILE)) {
      const id = readFileSync(ID_FILE, 'utf8').trim();
      if (id.length > 0) return { anonymousId: id, firstRun: false };
    }
    const id = randomUUID();
    mkdirSync(RETICLE_DIR, { recursive: true });
    writeFileSync(ID_FILE, id, 'utf8');
    return { anonymousId: id, firstRun: true };
  } catch {
    // Can't persist (read-only home, sandbox): still report, just as a fresh ephemeral id each time.
    return { anonymousId: randomUUID(), firstRun: false };
  }
};

/**
 * One-way project fingerprint: distinct-count of this = "projects Reticle is used in", reveals nothing.
 *
 * Prefers a hash of the git ORIGIN over a hash of the cwd. The contract in `@reticlehq/core` always
 * said "one-way hash of the git remote (or cwd)", but the implementation only ever hashed the path —
 * which meant the same repo cloned by four teammates, or checked out twice on one machine, counted as
 * four separate projects. That inflates the project count and, worse, makes team adoption look like
 * unrelated individuals. Hashing the origin dedupes a real project down to one id across every clone.
 *
 * Still one-way, still non-reversible, and still exactly what the published policy describes: the
 * remote URL itself never leaves the machine, only its SHA-256. The URL is normalized first (scheme,
 * credentials, `.git` suffix and case removed) so `git@github.com:acme/web.git` and
 * `https://github.com/Acme/web` are recognized as the same project rather than two.
 */
export const projectFingerprint = (cwd: string): { projectId: string; source: ProjectIdSource } => {
  const { origin, root } = gitFacts(cwd);
  // Ordered by stability, not by preference: an origin is comparable across machines, a repo root is
  // stable across every directory inside one machine's checkout, a package.json root is the same for
  // a non-git project — and the raw cwd is stable across nothing, which is why it is last. See
  // `project-identity.test.ts` for what a wrong order costs.
  const { key, source } =
    origin !== undefined
      ? { key: origin, source: ProjectIdSource.GIT_ORIGIN }
      : root !== undefined
        ? { key: root, source: ProjectIdSource.GIT_ROOT }
        : packageRoot(cwd) !== null
          ? { key: packageRoot(cwd) ?? cwd, source: ProjectIdSource.PACKAGE_ROOT }
          : { key: cwd, source: ProjectIdSource.CWD };
  return {
    projectId: createHash('sha256').update(key).digest('hex').slice(0, 32),
    // Reported alongside so the analytics knows whether this id is comparable to another machine's.
    source,
  };
};

/** Nearest ancestor holding a package.json — the project boundary when there is no git. */
const packageRoot = (cwd: string): string | null => {
  let dir = cwd;
  // Same bound as the git walk: deep monorepos are well inside 20, and an unbounded loop on a
  // pathological path would hang the CLI's startup.
  for (let depth = 0; depth < 20; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
};

/** Print the opt-out notice exactly once per machine (honest disclosure, the OSS-trust bar). */
const showNoticeOnce = (): void => {
  try {
    if (existsSync(NOTICE_FILE)) return;
    mkdirSync(RETICLE_DIR, { recursive: true });
    writeFileSync(NOTICE_FILE, '1', 'utf8');
    process.stderr.write(
      'reticle: anonymous usage telemetry helps improve reticle — no code, no PII, ' +
        `and your app's data never leaves your machine (${POLICY_URL}). ` +
        'Opt out any time: reticle telemetry disable\n',
    );
  } catch {
    /* notice is a courtesy; never fail on it */
  }
};

/** The current telemetry state and which control set it — what `reticle telemetry status` prints. */
export const describeTelemetry = (
  env: NodeJS.ProcessEnv = process.env,
  dir: string = RETICLE_DIR,
  cwd: string = process.cwd(),
): { enabled: boolean; reason: string; policyUrl: string } => {
  // Report the reason that ACTUALLY applies. Saying "environment variable" when the real cause is
  // the source-checkout guard would send a contributor hunting for a variable that is not set.
  if (isReticleSourceCheckout(cwd)) {
    return {
      enabled: false,
      reason: 'this is a Reticle source checkout; developing it is not using it',
      policyUrl: POLICY_URL,
    };
  }
  if (isDisabled(env, cwd)) {
    return { enabled: false, reason: 'disabled by environment variable', policyUrl: POLICY_URL };
  }
  if (existsSync(join(dir, 'telemetry-opt-out'))) {
    return {
      enabled: false,
      reason: 'disabled via `reticle telemetry disable`',
      policyUrl: POLICY_URL,
    };
  }
  return {
    enabled: true,
    reason: 'anonymous usage metrics only — no code, no PII',
    policyUrl: POLICY_URL,
  };
};

/** Persist (or lift) the machine-wide opt-out — `reticle telemetry disable` / `enable`. */
export const setTelemetryEnabled = (enabled: boolean, dir: string = RETICLE_DIR): void => {
  const optOutFile = join(dir, 'telemetry-opt-out');
  if (enabled) {
    rmSync(optOutFile, { force: true });
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(optOutFile, '1', 'utf8');
};

/**
 * The per-event extras — one optional block per event kind, so a payload can only ever be attached
 * to the event it belongs to. `feedback` is the only one carrying author-written text, and it only
 * ever arrives from `submitFeedback`, which redacts and validates it first. Nothing else may set it.
 */
export interface TelemetryExtra {
  detach?: boolean;
  actor?: TelemetryActor;
  /** `cli_command_run`: which subcommand a human ran. */
  command?: string;
  /** `cli_command_run`: flag NAMES present on the invocation. Never values. */
  flags?: string[];
  /** `daemon_stopped`: the whole session rolled up. Replaces the old per-tool-call event. */
  session?: SessionSummary;
  /** `project_profiled`: the project's shape and depth-of-use. */
  project?: ProjectProfile;
  /** `verification_completed`: one verdict. */
  verification?: Verification;
  /** `version_changed`: update or rollback. */
  versionChange?: VersionChange;
  /** `runtime_crashed`: a fingerprinted crash. */
  crash?: Crash;
  feedback?: Feedback;
  /** `identified`: a self-declared identity. Opt-in, typed by a human, never inferred. */
  identity?: Identity;
  /** `mcp_client_connected`: a client attached, and whether it had attached before. */
  connection?: McpConnection;
  /** `init_completed`: how `reticle init` went. */
  init?: InitOutcome;
  /** `bug_found`: one defect Reticle found in the app under test. */
  bug?: BugFound;
  /** `tool_refused`: a call Reticle could not serve, and why. */
  refusal?: ToolRefusal;
  /** `mcp_connection_lost`: the agent lost its tools — which stage, and why. */
  outage?: McpOutage;
  /** `app_instrumented`: an app carrying the SDK reached this daemon for the first time. */
  instrumentation?: AppInstrumentation;
  /** `reticle_installed` / `init_completed`: which published route brought this install in. */
  installSource?: InstallSource;
}

export interface Telemetry {
  /**
   * Fire one event, non-blocking. `detach: true` hands the send to a disowned child so a short-lived
   * CLI process can exit immediately instead of waiting out the POST (use it from command entry
   * points; daemon-side events send in-process).
   */
  /**
   * Send one event. Resolves to whether it was DELIVERED.
   *
   * Almost every caller ignores the result and should — a lost metric must never surface to a user.
   * `reticle_feedback` is the exception: it hands a receipt to an agent, and reporting "filed" for a
   * send that failed loses the report and lies about it in the same breath.
   */
  emit(kind: TelemetryEventKind, extra?: TelemetryExtra): Promise<boolean>;
  readonly enabled: boolean;
  /** True the very first run on this machine — the CLI emits INSTALL alongside the first INVOKE. */
  readonly firstRun: boolean;
}

// A disabled emitter delivers nothing, and says so — `false` is the honest answer, not a courtesy.
const NOOP: Telemetry = { emit: () => Promise.resolve(false), enabled: false, firstRun: false };

/**
 * Build the telemetry emitter for this process. Resolves identity + opt-out ONCE; each `emit` builds a
 * fully-validated core event, maps it into PostHog capture shape, and fires a best-effort POST.
 * `version` is the running reticle version (for the `version` dimension); `now`/`fetchImpl` are
 * injected so this is testable without a clock or network.
 */
export const createTelemetry = (opts: {
  version: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  spawnImpl?: (command: string, args: string[]) => void;
}): Telemetry => {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  // A source checkout silences metrics but must not silence FEEDBACK — see onlyBlockedBySourceCheckout.
  const feedbackOnly = onlyBlockedBySourceCheckout(env, cwd);
  if (isDisabled(env, cwd) && !feedbackOnly) return NOOP;
  try {
    if (existsSync(OPT_OUT_FILE)) return NOOP; // the persistent `reticle telemetry disable` opt-out
  } catch {
    /* unreadable home dir — fall through; the env-var opt-outs above still apply */
  }
  const apiKey = env[Env.KEY] ?? POSTHOG_KEY;
  if ('' === apiKey) return NOOP; // no key baked in (dev/test build) — nowhere to send, stay silent

  const now = opts.now ?? (() => Date.now());
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${(env[Env.URL] ?? DEFAULT_URL).replace(/\/+$/, '')}${TELEMETRY_PATH}`;
  const ci = env[Env.CI] !== undefined && env[Env.CI] !== '';
  // Read once per process, next to `ci` and never instead of it: this is a second angle on the same
  // question, and the rule that it can never filter a row lives in automation-hint.ts.
  const automation = currentAutomationHint(env);
  const os = platform();
  // Negated so it reads the way people say it: UTC+2 is +120, not -120.
  const tzOffsetMin = -new Date().getTimezoneOffset();
  const { anonymousId, firstRun } = resolveIdentity();
  /**
   * One id per PROCESS, minted in memory and never persisted — which is exactly right: a daemon run
   * IS the session, and a restarted daemon is genuinely a new one. Ephemeral by construction, so it
   * adds no durable identifier to the machine.
   */
  const sessionId = randomUUID();
  const { projectId, source: projectIdSource } = projectFingerprint(opts.cwd ?? process.cwd());
  // Resolved ONCE, beside projectId, and for the same reason: it is a property of this install, not
  // of any one event. It used to be passed per-call and therefore rode only `reticle_installed` and
  // `init_completed` — two of the rarest events there are — so the channel that brought a user in
  // was unknown for every event that could show whether they got anywhere. Reading it here puts it
  // on all of them, which is the only shape in which the question can be asked.
  const installSource = projectInstallSource(opts.cwd ?? process.cwd());
  showNoticeOnce();

  const spawnDetached =
    opts.spawnImpl ??
    ((command: string, args: string[]): void => {
      spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
    });

  /**
   * Returns whether the event was actually DELIVERED.
   *
   * Every caller but one ignores this and should: a lost metric must never surface to a user. The
   * exception is `reticle_feedback`, which hands a receipt back to an agent — `sent: true` there was
   * unconditional, so a DNS miss or a 4xx both read as "filed", and the only qualitative channel the
   * product has could fail silently while telling the reporter it had worked.
   *
   * A detached send reports false: it is handed to a disowned child precisely so the caller does not
   * wait, so its outcome is genuinely unknown and claiming success would be the same lie.
   */
  const emit = async (kind: TelemetryEventKind, extra?: TelemetryExtra): Promise<boolean> => {
    // In a Reticle source checkout the emitter carries FEEDBACK and nothing else: somebody typed the
    // feedback, and no metric is worth phoning home from a contributor's clone.
    if (feedbackOnly && TelemetryEventKind.FEEDBACK_SUBMITTED !== kind) return false;
    // One clock read for the whole event: `ts` and the licence check must agree, and two calls to
    // now() can straddle an expiry.
    const eventTs = now();
    const event: TelemetryEvent = {
      v: TELEMETRY_EVENT_VERSION,
      anonymousId,
      sessionId,
      projectId,
      event: kind,
      ts: eventTs,
      version: opts.version,
      ci,
      // A SCALAR, so it needs the event build and the wire schema and no `blocks` entry — the same
      // three-place trap `outage` fell into, and `installSource` documents below.
      ...(automation !== undefined ? { automation } : {}),
      os,
      tzOffsetMin,
      projectIdSource,
      ...(extra?.actor !== undefined ? { actor: extra.actor } : {}),
      ...(extra?.command !== undefined ? { command: extra.command } : {}),
      ...(extra?.flags !== undefined ? { flags: extra.flags } : {}),
      ...(extra?.session !== undefined ? { session: extra.session } : {}),
      ...(extra?.project !== undefined ? { project: extra.project } : {}),
      ...(extra?.verification !== undefined ? { verification: extra.verification } : {}),
      ...(extra?.versionChange !== undefined ? { versionChange: extra.versionChange } : {}),
      ...(extra?.crash !== undefined ? { crash: extra.crash } : {}),
      ...(extra?.feedback !== undefined ? { feedback: extra.feedback } : {}),
      ...(extra?.identity !== undefined ? { identity: extra.identity } : {}),
      ...(extra?.connection !== undefined ? { connection: extra.connection } : {}),
      ...(extra?.init !== undefined ? { init: extra.init } : {}),
      ...(extra?.bug !== undefined ? { bug: extra.bug } : {}),
      ...(extra?.refusal !== undefined ? { refusal: extra.refusal } : {}),
      ...(extra?.outage !== undefined ? { outage: extra.outage } : {}),
      ...(extra?.instrumentation !== undefined ? { instrumentation: extra.instrumentation } : {}),
      // A SCALAR, so it needs the event build and the wire schema but no entry in `blocks` below —
      // there is nothing to flatten. It still needs both of those, which is the trap `outage` fell
      // into: a field declared on TelemetryExtra and missing from either one is dropped in silence.
      // Always present now, rather than only when a caller remembered to pass it. A per-call
      // override still wins so a command that genuinely knows better can say so.
      installSource: extra?.installSource ?? installSource,
      // Enterprise activation: three SCALARS, so they need the event build and the wire schema and no
      // `blocks` entry. Resolved per event off the event's own clock rather than once at startup — an
      // eleven-hour session must not report the status it booted with. All three are absent unless a
      // release has an issuer key baked, so an OSS payload is byte-identical to before.
      // The RESOLVED env, not process.env: createTelemetry takes an env for injection, and reading
      // the ambient one here would silently ignore it. Identical in production, wrong everywhere the
      // seam is actually used.
      ...licenseFacts(eventTs, env),
    };
    // Map the core contract onto PostHog's capture shape: id/name/time move up, the rest are properties.
    // The feedback body is FLATTENED into `feedback_*` properties rather than sent as a nested object:
    // PostHog filters and breakdowns operate on top-level properties, so a nested `feedback.stack`
    // would be invisible to the exact "which stacks report the most bugs" question this exists to
    // answer. One prefix keeps them grouped in the UI without a nested path.
    const {
      anonymousId: distinctId,
      event: name,
      ts,
      sessionId: eventSessionId,
      feedback,
      session,
      project,
      verification,
      versionChange,
      crash,
      identity,
      connection,
      init,
      bug,
      refusal,
      outage,
      instrumentation,
      ...rest
    } = event;
    // `$session_id` is PostHog's OWN session property, so sending ours under that name lights up
    // its built-in session views and funnels for free rather than requiring custom HogQL everywhere.
    // `sessionId` rides only on events that happened inside a daemon run. A one-shot CLI command
    // mints a per-process id that joins to nothing and inflates every session count — see
    // isSessionScoped for the measurement.
    const properties: Record<string, unknown> = {
      ...rest,
      ...(isSessionScoped(name) ? { sessionId: eventSessionId, $session_id: eventSessionId } : {}),
    };
    // Each block is flattened under its own prefix rather than nested. PostHog filters, breakdowns and
    // insight builders all operate on TOP-LEVEL properties, so a nested `project.stack` is invisible to
    // the exact "which stacks retain best" question these exist to answer — you would have to drop to
    // raw HogQL for every chart. One prefix per block keeps them grouped in the property list without
    // paying that cost. The two genuine maps (`toolCounts`, `errorKinds`) stay objects: their keys are
    // open-ended, so flattening them would mint an unbounded number of property names, which is the one
    // thing that actually degrades a PostHog project.
    const blocks: Record<string, Record<string, unknown> | undefined> = {
      feedback,
      session,
      project,
      verification,
      version: versionChange,
      crash,
      identity,
      connection,
      init,
      bug,
      refusal,
      outage,
      instrumentation,
    };
    for (const [prefix, block] of Object.entries(blocks)) {
      for (const [key, value] of Object.entries(block ?? {})) {
        properties[`${prefix}_${key}`] = value;
      }
    }
    const capture = {
      event: name,
      distinct_id: distinctId,
      timestamp: new Date(ts).toISOString(),
      properties: {
        ...properties,
        ...POSTHOG_PERSONLESS,
        // Only on a licensed build. An unlicensed event has no organisation to belong to, and an
        // empty group key would mint a phantom "no org" bucket that every OSS install falls into.
        ...(event.licenseId !== undefined
          ? { $groups: { [POSTHOG_GROUP_ORGANIZATION]: event.licenseId } }
          : {}),
      },
    };
    const body = JSON.stringify({ api_key: apiKey, batch: [capture] });
    const filePath = env[Env.FILE];
    if (filePath !== undefined && filePath !== '') {
      // The SAME payload the wire would have carried, built by the same code path and redacted by
      // the same rules — so what a run records is what a user would have sent. One JSON object per
      // line, appended, so a whole sweep lands in one file in order.
      try {
        appendFileSync(filePath, `${JSON.stringify(capture)}\n`, 'utf8');
        return true;
      } catch {
        return false; // a sink that cannot write must not take the daemon down
      }
    }
    try {
      if (true === extra?.detach && opts.fetchImpl === undefined) {
        spawnDetached(process.execPath, ['-e', DETACHED_SEND_SCRIPT, url, body]);
        return false; // handed off, outcome unknowable from here
      }
      // Feedback is slower and retried; everything else keeps the fire-and-forget budget.
      const isFeedback = TelemetryEventKind.FEEDBACK_SUBMITTED === kind;
      const timeoutMs = isFeedback ? FEEDBACK_TIMEOUT_MS : SEND_TIMEOUT_MS;
      const attempts = 1 + (isFeedback ? FEEDBACK_RETRIES : 0);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (0 < attempt) {
          await new Promise((r) => setTimeout(r, FEEDBACK_RETRY_BACKOFF_MS * attempt));
        }
        try {
          const response = await doFetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
          // A 4xx is a rejected payload, not a delivery. It must not read as filed. It is also not
          // worth retrying — the payload will be rejected again — so only a THROW (timeout, DNS,
          // connection reset) goes round again.
          return response.ok !== false;
        } catch (error) {
          if (attempt === attempts - 1) throw error;
        }
      }
      return false;
    } catch {
      /* best-effort: a lost metric must never surface to the user */
      return false;
    }
  };

  return { emit, enabled: true, firstRun };
};

/**
 * The process-wide emitter. One identity resolution + one opt-out check per process; both the CLI
 * lifecycle (install/invoke/session) and the per-tool hook in `runTool` share it.
 */
let singleton: Telemetry | undefined;
export const getTelemetry = (): Telemetry =>
  (singleton ??= createTelemetry({ version: SERVER_VERSION }));

export { TelemetryEventKind };
