/**
 * How a SESSION and a PROJECT measured — the two big rollup payloads and the types they are built from.
 *
 * Split out of `telemetry.ts` because they are a different kind of thing from the event contract next
 * door: that file answers "what happened", these answer "how much, how long, and on what". They are
 * also where nearly all the growth is — every new thing worth measuring lands in one of these two
 * shapes — so keeping them here is what stops the event contract itself from drifting past its cap
 * every time a counter is added.
 */
import { z } from 'zod';

/**
 * One distinct error shape seen during a session, with the detail needed to fix it.
 *
 * Replaces a bare `{fingerprint: count}` map, which had the same no-dictionary problem as the crash
 * payload: you could rank the top error and never learn what it was, or which tool produced it.
 */
export const ErrorShapeSchema = z.object({
  /** Stable group key — the same defect from any machine shares it. */
  fingerprint: z.string().min(1).max(64),
  /** How many times it happened this session. */
  count: z.number().int().nonnegative(),
  /** The message with every variable part stripped. The dictionary entry for the fingerprint. */
  message: z.string().max(300),
  /** Which tool produced it — the same message from two tools is usually two different bugs. */
  tool: z.string().max(64).optional(),
});
export type ErrorShape = z.infer<typeof ErrorShapeSchema>;

/**
 * Whether the project has git, and whether anyone has pushed it.
 *
 * The distinction matters for more than curiosity: `projectId` can only identify the SAME project
 * across two machines when it is derived from a shared git origin. A repo nobody has pushed has
 * nothing shared to hash, so its fingerprint falls back to the local directory path.
 */
export const GitState = {
  /** No `.git` anywhere above the project — Reticle is running in a plain directory. */
  NONE: 'none',
  /** `git init` was run, but there is no origin remote. Nobody else can be working on this copy. */
  LOCAL_ONLY: 'local_only',
  /** There is an origin remote — the project is pushed and can be shared. */
  REMOTE: 'remote',
} as const;
export type GitState = (typeof GitState)[keyof typeof GitState];

/**
 * Which forge hosts the repo. Public forges are named; everything else is `self_hosted` WITHOUT its
 * hostname, because an internal git host is usually `git.<company>.com` and reporting it would
 * identify the company outright. The bucket carries the signal that actually matters — self-hosted
 * git is a strong enterprise tell.
 */
export const RepoForge = {
  GITHUB: 'github',
  GITLAB: 'gitlab',
  BITBUCKET: 'bitbucket',
  AZURE: 'azure',
  SOURCEHUT: 'sourcehut',
  CODEBERG: 'codeberg',
  SELF_HOSTED: 'self_hosted',
} as const;
export type RepoForge = (typeof RepoForge)[keyof typeof RepoForge];

/**
 * What the machine looked like at a moment worth remembering — a crash, or the end of a session.
 *
 * Sampled at MOMENTS, never per tool call: `os.loadavg()` and `process.memoryUsage()` are cheap but
 * not free, and taking them 200 times a session to answer "was the machine struggling" would be
 * paying a continuous cost for a question only asked about the bad moments. Absolute numbers in MB
 * rather than percentages, because "2 GB free of 8" and "2 GB free of 64" are different worlds.
 */
export const MachineSnapshotSchema = z.object({
  /** Resident set size of the daemon itself — our footprint, the one we can actually fix. */
  rssMb: z.number().int().nonnegative(),
  heapUsedMb: z.number().int().nonnegative(),
  /** Free and total system memory. A machine at 200 MB free explains a lot of otherwise-weird bugs. */
  freeMemMb: z.number().int().nonnegative(),
  totalMemMb: z.number().int().nonnegative(),
  /** 1-minute load average, ×100 so it stays an integer. Zero on Windows, which does not report it. */
  load1x100: z.number().int().nonnegative(),
  cpuCount: z.number().int().nonnegative(),
});
export type MachineSnapshot = z.infer<typeof MachineSnapshotSchema>;

/** Per-tool wall-clock. `count` lives in `toolCounts`; these are the two numbers it does not carry. */
export const ToolTimingSchema = z.object({
  /** Total ms spent inside this tool. Divided by its count, the average; summed, the time in Reticle. */
  totalMs: z.number().int().nonnegative(),
  /** The single worst call. An average hides the 30-second outlier that made someone give up. */
  maxMs: z.number().int().nonnegative(),
});
export type ToolTiming = z.infer<typeof ToolTimingSchema>;

/**
 * Attempts, successes and failure reasons for one kind of connection.
 *
 * The first version of this counted only successes — and counted them inconsistently, incrementing
 * before the await on one path and after it on another, so the CDP number was attempts and the others
 * were successes and nobody could have told from the data. A connection metric that cannot express
 * FAILURE is close to useless: the whole question is how often people cannot get a browser.
 */
export const ConnectionStatsSchema = z.object({
  attempts: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  /** Failure reasons with counts — our own classified vocabulary, never a raw error string. */
  failures: z.record(z.string(), z.number().int().nonnegative()).optional(),
});
export type ConnectionStats = z.infer<typeof ConnectionStatsSchema>;

/**
 * Why a browser/lease connection failed, classified into causes we can act on.
 *
 * A raw message would be both high-cardinality and unsafe (it can carry a URL or a path). These are
 * the distinct THINGS THAT GO WRONG, each with a different fix: a missing Chromium is a docs problem,
 * a refused CDP url is a configuration problem, a pool timeout is a capacity problem.
 */
export const ConnectFailure = {
  /** Playwright's browser binary was never downloaded — `npx playwright install`. */
  CHROMIUM_MISSING: 'chromium_missing',
  /** `playwright` itself is not installed; the optional dependency was skipped. */
  PLAYWRIGHT_MISSING: 'playwright_missing',
  /** Nothing listening on the CDP endpoint, or it refused us. */
  CDP_UNREACHABLE: 'cdp_unreachable',
  /** The browser launched but died, or was closed underneath us. */
  BROWSER_CRASHED: 'browser_crashed',
  /** Waited for a pool slot and never got one. A capacity signal, not an error. */
  POOL_TIMEOUT: 'pool_timeout',
  /** Classified as nothing we recognize — the bucket to watch, since a big one means a blind spot. */
  OTHER: 'other',
} as const;
export type ConnectFailure = (typeof ConnectFailure)[keyof typeof ConnectFailure];

/**
 * One session, rolled up. This replaces the per-tool-call event entirely — see the volume note on
 * `TelemetryEventKind`. The histogram is the point: `{reticle_act: 40, reticle_assert: 12}` says the
 * session was a real verification loop, where 52 separate rows would have said only that 52 things
 * happened. Counts, never payloads: no arguments, no results, no selectors.
 */
export const SessionSummarySchema = z.object({
  /** How long the daemon was up, ms. */
  durationMs: z.number().int().nonnegative(),
  /** Total MCP tool calls served. */
  toolCalls: z.number().int().nonnegative(),
  /**
   * Calls per tool name — `{ "reticle_act": 40 }`. Tool names are a fixed, low-cardinality set we
   * define ourselves, so this is safe to send whole and is queryable in HogQL with JSONExtract.
   */
  toolCounts: z.record(z.string(), z.number().int().nonnegative()),
  /** Tool calls that ended in an error, and the distinct error shapes behind them. */
  toolErrors: z.number().int().nonnegative(),
  /**
   * The distinct error shapes seen, with counts, messages-with-variables-stripped, and the tool that
   * produced each. Bounded, so a pathological loop cannot grow it without limit.
   */
  errors: z.array(ErrorShapeSchema).max(40).optional(),
  /**
   * Failures reported by the IN-PAGE half of Reticle. Half the product runs in the browser and had no
   * error reporting at all — every SDK catch block swallowed silently, so a broken observer just made
   * the product quieter and nobody found out.
   */
  sdkFailures: z.number().int().nonnegative().optional(),
  /** The distinct SDK failure shapes, with the module that reported each. */
  sdkErrors: z.array(ErrorShapeSchema).max(40).optional(),
  /** Verifications that produced a verdict during the session. */
  verifications: z.number().int().nonnegative(),
  /** Defects found in the app under test — the outcome number, not an activity number. */
  bugsFound: z.number().int().nonnegative().optional(),
  /** Those bugs by kind, so the headline number can always be broken down rather than asserted. */
  bugKinds: z.record(z.string(), z.number().int().nonnegative()).optional(),
  /**
   * Which PARAMETERS agents actually passed, per tool: `{"reticle_act": {"ref": 40, "action:click": 31}}`.
   *
   * Names only, with one narrow exception for parameters whose values are enums we define ourselves
   * (`action:click`). Never a raw value: `reticle_act`'s `args` carries the text being typed into the
   * app, which on a login form is a password. See argument-shape.ts for the allowlist.
   */
  toolParams: z.record(z.string(), z.record(z.string(), z.number().int().nonnegative())).optional(),
  /**
   * Browser/lease connections by kind, with attempts AND failures. Replaces a bare success counter
   * that could not express the only interesting outcome.
   */
  connections: z.record(z.string(), ConnectionStatsSchema).optional(),
  /** Wall-clock per tool. With `toolCounts` this gives average, worst, and total time in Reticle. */
  toolTiming: z.record(z.string(), ToolTimingSchema).optional(),
  /**
   * Total ms spent inside tool calls. The headline answer to "how much time does verification cost",
   * and comparable against `durationMs` to see what fraction of a session Reticle was actually busy.
   */
  busyMs: z.number().int().nonnegative().optional(),
  /**
   * Time spent waiting on the BROWSER, and how many commands that was. Subtracted from `busyMs` this
   * separates Reticle's own overhead from the app's — opposite fixes, previously indistinguishable.
   */
  browserMs: z.number().int().nonnegative().optional(),
  browserCommands: z.number().int().nonnegative().optional(),
  /** The most tool calls in flight at once — parallel agents, or one agent fanning out. */
  peakConcurrentTools: z.number().int().nonnegative().optional(),
  /** Calls for a tool name that does not exist. A non-zero value means our surface is confusing. */
  unknownToolCalls: z.number().int().nonnegative().optional(),
  /**
   * WHICH tools the agent reached for that do not exist, with counts.
   *
   * The count alone said "our surface confused someone" and could never say what they wanted. The
   * name is a feature request in the agent's own vocabulary — and it is a NAME, from our own tool
   * namespace, carrying no app data, so it is safe under the send-names-never-values rule.
   *
   * Bounded and truncated: a guess is a short identifier, and anything longer is not one.
   */
  unknownTools: z.record(z.string().max(64), z.number().int().nonnegative()).optional(),
  /**
   * Tool calls that failed because there was no app to reach — no session connected, no session by
   * that id, or several with none named.
   *
   * The single biggest drop-off in the funnel, and it used to be reachable only by unpacking
   * `errors[]` in HogQL. 74% of daemons never call a tool at all, and of the sessions that made
   * exactly one call, most bounced on precisely this. Absent when it never happened, so the field's
   * PRESENCE is the signal.
   */
  noSessionErrors: z.number().int().nonnegative().optional(),
  /**
   * Connection-level POST failures on the MCP proxy (`ENOBUFS`, `EMFILE`, `EADDRNOTAVAIL`,
   * `ECONNREFUSED` before any bytes were sent).
   *
   * These never produce `tool_refused` (the call never reached a handler) and never produce
   * `mcp_connection_lost` (the SSE stream is fine). Without this count, a keep-alive retry that
   * saves the call is indistinguishable from one that never fired. Absent when none happened.
   */
  postSocketFailures: z.number().int().nonnegative().optional(),
  /**
   * Of those POST failures, how many a bounded retry then delivered.
   *
   * The numerator against `postSocketFailures`: a retry that quietly saves a call is a different
   * fact from a retry that never runs. Absent when none were saved.
   */
  postRetriesSaved: z.number().int().nonnegative().optional(),
  /**
   * Longest back-to-back run per tool name — the shape of a retry loop.
   *
   * `toolCounts` reports five useful calls and five retries of one failing call identically, and
   * those are opposite facts: engagement versus an agent stuck. Only tools actually repeated appear.
   */
  consecutiveRepeats: z.record(z.number().int().positive()).optional(),
  /**
   * Actions driven with no verdict after them — the signature of the loop breaking mid-task.
   *
   * An agent that acts and then verifies is the product working; one that acts and wanders off has
   * either given up or lost the thread, and nothing distinguished the two before.
   */
  abandonedActions: z.number().int().nonnegative().optional(),
  /** The machine at shutdown — was it starved while all this was happening? */
  machine: MachineSnapshotSchema.optional(),
  /** Distinct MCP clients seen (`claude-code`, `cursor`), so multi-agent use is visible. */
  clients: z.array(z.string().max(64)).max(8).optional(),
  /**
   * Client name -> version. The other half of `clients`, and the half that explains regressions.
   *
   * MCP's `clientInfo` carries a name AND a version; we read both at the handshake and kept only
   * the name. A product whose users are agents needs to slice every rate by which agent, on which
   * build — a single global figure hides the finding entirely.
   *
   * NOT the model: `clientInfo` has no concept of one, so the transport genuinely cannot report it.
   * Agents self-report it on feedback, which is the only mechanism there is.
   */
  clientVersions: z.record(z.string().max(64), z.string().max(32)).optional(),
  /**
   * Which tool surface was live. The 18-tool default and the 48-tool full surface are different
   * products from inside an agent's context window, and comparing outcomes across them is how we
   * learn whether the trim helps or hurts.
   */
  surface: z.string().max(32).optional(),
  /**
   * How many times an app's SDK dialled this daemon. **Session-lifetime, never windowed.**
   *
   * Zero here is the single most diagnostic number in the payload: the daemon ran and no app ever
   * connected, which is a BROKEN INSTALL. Non-zero with no tool calls is the opposite problem — the
   * install works and the agent never asked. Before this field those two were the same row, and
   * they have opposite fixes. In the field most users who attached an agent never
   * drove, and we could not say which case any of them was.
   *
   * A counter rather than an event because the SDK reconnects on every page reload — an event per
   * connect would be high volume for a question one number answers.
   */
  appConnects: z.number().int().nonnegative().optional(),
  /**
   * Milliseconds from daemon start to the FIRST app connecting. Absent when none ever did.
   *
   * Separates "the app was already running" from "the human had to go start it", which is the
   * difference between a smooth install and one that needed a second step nobody documented.
   */
  msToFirstApp: z.number().int().nonnegative().optional(),
  /**
   * What state the AGENT's work was in when the session ended. Absent on a periodic flush.
   *
   * Distinct from `exit`, which says why the PROCESS ended. A daemon can exit tidily on idle while
   * the agent's work was abandoned mid-task, and those are different findings.
   *
   * In the field most agents that drove an app produced no verdict, and nothing
   * could say whether that was a product failure or a task that simply ended.
   *
   * Most of this is derivable at query time from `toolCalls` / `verifications` /
   * `abandonedActions`. The part that is NOT derivable is `client_left` — whether the agent
   * detached or simply stopped asking — which is why the daemon records it rather than leaving the
   * whole thing to a query.
   */
  endReason: z.enum(['never_used', 'explored', 'abandoned', 'verified', 'client_left']).optional(),
  /**
   * How often Reticle invited the agent to send feedback.
   *
   * The denominator for `feedback_submitted`. A prompt nobody acts on is decoration, and without
   * this we could never tell the difference between "agents have nothing to report" and "our
   * invitation is invisible". Instrumenting our own nudge is what makes it a designed system
   * rather than a hope.
   */
  feedbackPrompted: z.number().int().nonnegative().optional(),
  /**
   * Tool errors bucketed by WHOSE defect they are: `schema` (our grammar failed to explain itself),
   * `state` (the world moved), `refusal` (we said no on purpose), `other` (a blind spot).
   *
   * `toolErrors` is one number over three failures with three different fixes. Only the `schema`
   * bucket is fixable by writing better descriptions, and it was indistinguishable from the rest.
   */
  errorClasses: z.record(z.string().max(16), z.number().int().nonnegative()).optional(),
  /**
   * Errors after which the agent's NEXT call succeeded — the message worked.
   *
   * The best measure of an error message is what the agent does next, and we had the loop
   * (`consecutiveRepeats`) and the shape (`errors[]`) but never the join. This is the most
   * agent-specific metric in the payload: a human would sigh, a log would show nothing.
   */
  errorsRecovered: z.number().int().nonnegative().optional(),
  /** Errors whose very next call failed again — the message did not land. */
  errorsRepeated: z.number().int().nonnegative().optional(),
  /**
   * Did this session ever produce a verdict? Absent on a periodic flush — nothing has ended yet.
   *
   * This is the release's headline metric and it was the one thing in the payload that had to be
   * COMPUTED rather than read: `verifications > 0` over the lifetime counters, which are windowed on
   * every other event in the stream, so the obvious query over `session_progress` answers a
   * different question and looks like it answers this one. A metric that requires a correct
   * subtraction to read is a metric that gets read wrong, and this one decides what the product is
   * allowed to claim.
   *
   * ALWAYS present on a final summary, including `false`: a session that drove an app and never
   * asked whether it worked is the finding, so absence and `false` must not look alike.
   */
  endedWithVerdict: z.boolean().optional(),
  /**
   * Was the update nudge actually delivered to an agent during this daemon run.
   *
   * The nudge is the entire adoption mechanism for a published fix — it rides the tool-result
   * envelope once per daemon process — and it emitted NOTHING, so the one question it exists to
   * answer could not be asked. `versionChange.nudged` is the other half and only reaches us from
   * machines that DID update; the cohort pinned three releases back never fires `version_changed` at
   * all, which is exactly the cohort worth understanding.
   *
   * Crossed against this same installId's `version` on a later day it separates the two causes,
   * which need opposite fixes: `false` for run after run means the nudge is not firing for them (a
   * cache that never warms, a check that never returns, an offline machine); `true` for run after
   * run with a version that never moves means the agent is receiving it and dropping it out of the
   * envelope, or telling a human who says no.
   *
   * Reads the delivery flag, not a counter: the nudge is one-shot per process by design, so `true`
   * means "an agent was told", never "how often".
   */
  updateNudged: z.boolean().optional(),
  /**
   * The newer version this daemon knew about, when it knew about one.
   *
   * OUR OWN published version number, so it is low-cardinality and carries nothing about the
   * machine. Without it `updateNudged: false` is two facts at once — nothing was available, or
   * something was and the nudge did not fire — and only the second is a defect.
   */
  updateOffered: z.string().max(32).optional(),
  /** Was this a clean shutdown, or a periodic flush of a still-running session? */
  final: z.boolean(),
  /**
   * WHY the daemon exited. Absent on a periodic flush (`final: false`) — nothing exited.
   *
   * Without this, a designed exit and a real failure are the same row. In the field the large
   * majority of `mcp_connection_lost` events were `sse_ended` — the stream the daemon closes on its own
   * scheduled idle shutdown — so the metric meant to say "the agent lost its tools" was mostly
   * counting the daemon going to sleep as designed, and a genuine outage was invisible inside it.
   *
   * The daemon has always known this (`recordExitReason`); it simply never put it on an event. The
   * proxy that emits the outage cannot know it — it only sees a socket end — so the join is made
   * here, on the one event that fires at the same moment and already carries the session.
   */
  exit: z.enum(['idle', 'signal', 'unknown']).optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/**
 * Coarse size buckets. A bucket answers "is this a toy or a real codebase" — which is the actual
 * question — while an exact file count starts to be a fingerprint, especially combined with the
 * stack and the framework version.
 */
export const ProjectSize = {
  TINY: 'tiny', // < 50 source files — a demo or a spike
  SMALL: 'small', // < 250
  MEDIUM: 'medium', // < 1000
  LARGE: 'large', // < 5000
  HUGE: 'huge', // 5000+ — a monorepo or a mature product
} as const;
export type ProjectSize = (typeof ProjectSize)[keyof typeof ProjectSize];

/**
 * Why a profile carries no `stack`, when it carries none.
 *
 * `stack` unknown is one of the largest buckets on the profile, and an empty field is not a cause:
 * it collapses "the daemon was started somewhere that is not a project" with "we read this app's
 * manifest and did not recognise what it uses", which need opposite fixes — the first is a
 * discovery problem, the second is a one-line addition to the dependency table.
 *
 * Derived from the branches of `detectStack` rather than computed beside them. A reason assembled
 * separately from the code that failed drifts from it, and then the dimension is worse than absent
 * because it is confidently wrong.
 */
export const StackUnknownReason = {
  /** No manifest here, and discovery found no app anywhere below. Usually a daemon started outside the project. */
  NO_APP_FOUND: 'no_app_found',
  /** A `package.json` HERE, read fine, naming no dependency in the table. The app is a stack we do not know. */
  MANIFEST_UNRECOGNISED: 'manifest_unrecognised',
  /** Discovery found workspace apps and every one of their manifests was unrecognised. */
  WORKSPACE_APPS_UNRECOGNISED: 'workspace_apps_unrecognised',
  /**
   * The cwd manifest DECLARES workspaces and discovery surfaced no app in any of them.
   *
   * Separated from `NO_APP_FOUND` because it is a different failure with a different fix, and
   * likely the dominant one: `findWorkspaceApps` admits a directory only when it holds a Vite or
   * Next config file, or names `next`/`vite` outright. A workspace app on Angular, Nuxt, SvelteKit
   * or Remix is therefore never surfaced, so its manifest is never read and no addition to the
   * stack table could ever reach it. Folded into `NO_APP_FOUND` this reads as "no project here",
   * which points at discovery scope when the gap is in what discovery will admit.
   */
  WORKSPACE_ROOT_NO_APPS: 'workspace_root_no_apps',
  /** Workspace discovery threw — a permission error, most likely. Distinguished so it cannot masquerade as absence. */
  DISCOVERY_FAILED: 'discovery_failed',
} as const;
export type StackUnknownReason = (typeof StackUnknownReason)[keyof typeof StackUnknownReason];

/**
 * The shape of the project and how much of Reticle it actually uses.
 *
 * `featureDepth` is the one to watch: someone running 40 saved flows with visual baselines and a
 * checked-in contract is a different company from someone who called `reticle_snapshot` twice. Both
 * look identical in a DAU chart, and only one of them is retained.
 */
export const ProjectProfileSchema = z.object({
  /** Framework detected from package.json (`next`, `vite`, `vue`, `astro`, …). */
  stack: z.string().min(1).max(64).optional(),
  /**
   * WHERE the stack was found — and therefore how much to trust the absence of one.
   *
   * `cwd` means the daemon was sitting in the app. `workspace` means it was not, and discovery had
   * to walk down to find it. The split is the diagnostic: it says how often our inference needs
   * help, which is the question that decides whether an agent-correction surface is worth building
   * at all.
   *
   * Before discovery existed here, stack was detected on **none of the projects where Reticle was
   * demonstrably set up**, and none of the large ones either. A detector
   * that reads one directory reports nothing precisely where the real repos are.
   */
  stackSource: z.enum(['cwd', 'workspace']).optional(),
  /**
   * Why there is no `stack`, when there is none. Present ONLY when `stack` is absent.
   *
   * Omitted rather than sent as a "resolved" member, so the field's presence is itself the signal —
   * the same rule the session counters follow. A member meaning "nothing went wrong" would be sent
   * on every successful profile and would have to be filtered out of every query that uses this.
   */
  stackUnknownReason: z.nativeEnum(StackUnknownReason).optional(),
  /** Its MAJOR version only — "breaks on React 19" is a work item, a full semver is a fingerprint. */
  stackMajor: z.number().int().nonnegative().optional(),
  size: z.nativeEnum(ProjectSize).optional(),
  /** True when the repo has workspaces — monorepos exercise very different code paths. */
  monorepo: z.boolean().optional(),
  /** No git / git init but unpushed / pushed to a remote. */
  git: z.nativeEnum(GitState),
  /** Which forge, bucketed. Absent unless `git` is `remote`. Never the hostname of a private host. */
  forge: z.nativeEnum(RepoForge).optional(),
  /**
   * How long this project has existed, in whole WEEKS, from its first commit. Answers "are people
   * adopting Reticle on greenfield spikes or on mature codebases" — the single most useful thing to
   * know about who this is for. Weeks, not a date: a date plus a stack narrows to a specific repo.
   */
  ageWeeks: z.number().int().nonnegative().optional(),
  /** Saved flows on disk — the deterministic-replay suite. 0 means replay was never adopted. */
  flowCount: z.number().int().nonnegative(),
  /** Saved text baselines. */
  baselineCount: z.number().int().nonnegative(),
  /** Saved pixel baselines — visual regression adoption. */
  visualBaselineCount: z.number().int().nonnegative(),
  /** Recorded verification-run artifacts — CI/OEM consumption. */
  runCount: z.number().int().nonnegative(),
  /** A git-checked `.reticle/contract.json` — the team declared a testable surface on purpose. */
  hasContract: z.boolean(),
  /**
   * Has `reticle init` run in this project — a `.reticle.json` is present.
   *
   * The install has two halves and the failure side of the second one is a SET DIFFERENCE:
   * `daemon_started` minus `app_instrumented`, joined on `sessionId`. That difference says a daemon
   * ran with nothing wired and cannot say WHY, so the whole non-instrumented majority arrives as one
   * silence covering four different situations with four different owners.
   *
   * This is the first of the two bits that split it, and it is on `project_profiled` deliberately:
   * that event fires once per daemon start whatever happens afterwards, so it is the only place a
   * fact about a project reaches us for the users who never instrument anything. `app_instrumented`
   * carries the same field and cannot answer this, because it only exists when the answer is moot.
   */
  initialized: z.boolean().optional(),
  /**
   * Has an app for this project EVER connected to Reticle — read from durable state, not from this
   * process.
   *
   * The second bit. `initialized: false` is "never ran init"; `initialized: true` with this `false`
   * is the cohort the funnel loses — the config was written and no page has ever reached the daemon,
   * which is the dev server that was never restarted, a plugin that never loaded, or a handshake
   * refused at the origin gate. `true` here with no `app_instrumented` this run is a working install
   * whose app simply is not up right now, and reading that as a loss is how the drop-off gets
   * over-stated.
   *
   * Scoped to project + port, like every other reader of this state, so it cannot borrow another
   * project's success on a shared daemon. OPTIONAL because an older sender has none; absent means
   * not measured, never `false`.
   */
  appConnectedBefore: z.boolean().optional(),
  /** Fail-to-pass bug capsules — the deepest feature in the product. */
  capsuleCount: z.number().int().nonnegative(),
  /** Which of Reticle's feature FAMILIES this project has ever touched. The activation metric. */
  featuresUsed: z.array(z.string().max(32)).max(24),
  /** 0–1: the fraction of shipped feature families in use. One number for "are they getting value". */
  featureDepth: z.number().min(0).max(1),
});
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;
