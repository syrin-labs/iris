/**
 * Wire-level constants. No free strings anywhere in Reticle reference these directly —
 * every string/number that crosses the browser <-> bridge <-> agent boundary is named here.
 */

export const RETICLE_DEFAULT_PORT = 4400;
export const RETICLE_WS_PATH = '/reticle';
/** Agent↔server MCP wire paths — served by the daemon HTTP plane, forwarded by the stdio proxy. */
export const MCP_SSE_PATH = '/mcp/sse';
export const MCP_MESSAGE_PATH = '/mcp/message';
/**
 * The name this MCP server answers to — in its own `serverInfo` handshake, and in the registration
 * an installer writes into an agent's config. Those must be the same string or the agent registers
 * one server and talks to another.
 *
 * It lives here because it is an identity that crosses the wire, not an installer detail. It used to
 * live in `init/`, which made the MCP handshake — squarely on the library path — reach into the
 * install-time surface for a single string, and dragged that whole subtree along behind it for any
 * consumer embedding the engine as a library.
 */
export const MCP_SERVER_NAME = 'reticle';
/**
 * SSE event name the daemon writes to every open MCP stream immediately before it shuts itself down.
 *
 * A stream that simply ends looks identical from the proxy whether the daemon retired on schedule or
 * died under it, so every planned shutdown was counted as an outage the agent suffered. The proxy
 * cannot infer the difference — the daemon is the only thing that knows, and this is it saying so.
 * A custom event name rather than a `message`: the proxy forwards `message` frames to the client
 * verbatim, and this is addressed to the proxy, not to the agent.
 */
export const MCP_SHUTDOWN_EVENT = 'reticle-shutdown';
/** Local-only daemon introspection — `reticle status` GETs this for sessions + health at a glance. */
export const STATUS_PATH = '/status';
/**
 * Local-only drive request — `reticle drive <url>` POSTs `{url}` here when a daemon already owns the
 * bridge port, and gets back the pooled session that daemon opened. The CLI asks instead of binding,
 * so the two never fight over the port. Same trust tier as STATUS_PATH.
 */
export const DRIVE_PATH = '/drive';
export const RETICLE_PROTOCOL_VERSION = 1;

/**
 * The host a CLIENT names when it dials the bridge, as opposed to the address the bridge BINDS.
 *
 * They are deliberately different values and both are correct. The daemon binds `127.0.0.1` so it can
 * never be reached off-host; a client says `localhost`, which is the readable name every doc, log
 * line and error message uses. The gap between them is covered by the IPv6 loopback alias
 * (`loopback-alias.ts`), which serves `[::1]` too, so `localhost` reaches the daemon whichever family
 * a platform resolves first.
 *
 * Named rather than inlined because it was inlined, and three generators then wrote their own: CRA
 * emitted `127.0.0.1`, the Astro helper and the Next plugin each spelled out `localhost`. A default
 * argument is not a single source of truth if it can be bypassed by typing the value.
 */
export const RETICLE_CLIENT_HOST = 'localhost';

/**
 * The one place the bridge WebSocket URL is built. The SDK connect default, the vite/next snippet
 * generators, and the CLI's inject-connect all call this instead of hand-writing `ws://…${path}` —
 * so the wire string can never drift across the four call sites. Host defaults to `localhost` (the
 * dev app connects from the browser); pass it only for a non-default bind.
 */
export function bridgeWsUrl(
  port: number = RETICLE_DEFAULT_PORT,
  host: string = RETICLE_CLIENT_HOST,
): string {
  return `ws://${host}:${String(port)}${RETICLE_WS_PATH}`;
}

/**
 * Namespaced URL params a pooled/headless launcher appends to the app URL so the app's own SDK adopts
 * the lease's identity (session + project) on connect — no app code changes. Wire contract shared by
 * the server (BrowserPool/lease tools) and the browser SDK; namespaced to avoid clashing with the
 * app's own query params.
 */
export const RETICLE_URL_PARAM = {
  SESSION: '__reticle_session',
  PROJECT: '__reticle_project',
} as const;

/** The loopback bind address. The daemon/bridge bind here by default — never expose Reticle off-host. */
export const LOOPBACK_HOST = '127.0.0.1';

/**
 * Every environment variable Reticle reads, named once. A misspelled inline env string silently
 * disables the control it gates (e.g. a typo'd `RETICLE_TOKEN` would disable auth) — so the names live
 * here and nowhere else. The values are the literal process.env keys.
 */
export const ReticleEnv = {
  /** Shared-secret the browser SDK must present in HELLO; absent ⇒ loopback-trust only. */
  TOKEN: 'RETICLE_TOKEN',
  /** Bridge bind host. Defaults to loopback; setting anything else is opt-in remote exposure. */
  HOST: 'RETICLE_HOST',
  /** Comma-separated WS Origin allow-list for the bridge. */
  ALLOWED_ORIGINS: 'RETICLE_ALLOWED_ORIGINS',
  /** Bridge/daemon WS port override. */
  PORT: 'RETICLE_PORT',
  /** Daemon state — pidfiles, discovery registry, logs. Defaults to `~/.reticle`. Overridable
   * because a read-only $HOME (sandboxed agent, locked-down Windows profile, container) otherwise
   * makes the daemon unstartable with a raw EACCES naming nothing. Reported by a Windows user. */
  STATE_DIR: 'RETICLE_STATE_DIR',
  /** Attach to an already-running browser over CDP instead of launching one. */
  CDP_URL: 'RETICLE_CDP_URL',
  /** Max simultaneous leased headless contexts in the browser pool (resource cap). */
  MAX_CONTEXTS: 'RETICLE_MAX_CONTEXTS',
  /**
   * Inbound events per second before the bridge starts SAMPLING (never disconnecting).
   *
   * Raise it for a legitimately busy app — a streaming dashboard, a live grid — rather than accept
   * partial coverage. Free and local: the daemon runs on the same machine, so a higher ceiling costs
   * nothing to anyone.
   */
  MAX_MESSAGES_PER_SECOND: 'RETICLE_MAX_MESSAGES_PER_SECOND',
  /** Bearer token required by the optional `reticle serve --http` verify endpoint. */
  VERIFY_TOKEN: 'RETICLE_VERIFY_TOKEN',
  /** Ms of continuous idleness (no agent, no browser session, no lease) before the daemon self-exits;
   * `0` disables. Keeps Reticle from lingering on a user's machine after the editor closes. */
  IDLE_SHUTDOWN: 'RETICLE_IDLE_SHUTDOWN_MS',
  /** Idle re-check cadence (default 30s). Overridable so daemon-lifecycle-test can watch a full
   * exit/wake cycle in seconds rather than minutes. */
  IDLE_CHECK: 'RETICLE_IDLE_CHECK_MS',
  /**
   * Grace for a daemon with an agent ATTACHED. Longer than the base on purpose: quiet with a client
   * present means a slow install or a thinking human, not an unwanted daemon — a flat 5 minutes was
   * killing live runs mid-install. Derived from the base when unset.
   */
  IDLE_ATTACHED: 'RETICLE_IDLE_ATTACHED_MS',
  /**
   * How often the daemon writes `reticle_daemon_alive`, so a GAP in its log is evidence it died.
   *
   * Overridable for the same reason the idle windows are: a spec that has to prove "a killed daemon
   * is distinguishable from a tidy one" cannot wait 30 seconds per beat, and a spec that instead
   * re-implements the cadence is insensitive to the thing it claims to guard.
   */
  HEARTBEAT: 'RETICLE_HEARTBEAT_MS',
  /** Directory holding the auto-provisioned pairing token. Defaults to ~/.reticle; relocatable for CI. */
  PAIRING_TOKEN_DIR: 'RETICLE_PAIRING_TOKEN_DIR',
  /** Force the durable causal journal off (`0`/`false`/`off`) or on (`1`/`true`/`on`); default on. */
  JOURNAL: 'RETICLE_JOURNAL',
  /**
   * Verbose internal flow tracing for people working ON Reticle (`1`/`true`/`on`); default off.
   *
   * Distinct from the journal, which records what the AGENT did to the app. This records what
   * RETICLE did to answer it: one line per internal stage, with its duration and nesting, so a
   * developer can see which code a tool call actually went through and where the time went.
   * Off by default and free when off — a trace on every tool call is a cost on the hot path.
   */
  TRACE: 'RETICLE_TRACE',
  /**
   * How many consecutive reconnects the MCP proxy attempts before it stops retrying and goes
   * dormant. Overridable for the same reason the idle windows are: the real budget takes MINUTES to
   * exhaust, so the one spec that proves the proxy SURVIVES exhaustion could not run at all without
   * shortening it. A budget nobody can reach in a test is a budget nobody tests.
   */
  RECONNECT_ATTEMPTS: 'RETICLE_RECONNECT_ATTEMPTS',
} as const;

/** Hard transport bounds shared by the browser and bridge. */
export const TRANSPORT_LIMITS = {
  MAX_MESSAGE_BYTES: 1024 * 1024,
  /**
   * Inbound events per second before the bridge SAMPLES rather than records everything.
   *
   * This was 1000, and an ordinary React app with an active query cache blew through it: the
   * reporter's FIRST `act_and_wait` of the session came back `unknown` with `unclean_capture` and a
   * four-figure drop count, and setting the env override to twenty times the default fixed it (#316).
   * Reticle was right to refuse the verdict — a sampled window cannot support one, and the guard that
   * catches false greens is blindest exactly there — but landing that on the first drive after an
   * install, recoverable only by knowing an environment variable exists and inventing a number for
   * it, is the worst possible place to spend the honesty.
   *
   * 20000 is the value that was measured to work on the page that reported it. The cap exists to stop
   * a PATHOLOGICAL page (an animation loop firing DOM mutations every frame), not to throttle a busy
   * one, and the ceiling it has to defend is cheap: the daemon is on the same machine and a typical
   * event is a few hundred bytes, so this is single-digit MB/s over loopback.
   *
   * Raising it does not raise what a runaway page can make the bridge HOLD, and that separation is
   * what makes the change safe. Memory is bounded independently by the ring buffer, which evicts on
   * `RING_BUFFER_DEFAULTS.MAX_BYTES` (this same constant, reached through that alias) as well as on
   * a count and an age. Grep for `MAX_BUFFER_BYTES` alone and it looks like a constant nobody reads,
   * which is exactly the wrong conclusion to draw before touching this number: the rate cap defends
   * parse cost, the ring buffer defends memory, and they are not substitutes.
   */
  MAX_MESSAGES_PER_SECOND: 20000,
  MAX_SESSIONS: 32,
  MAX_PENDING_CONNECTIONS: 16,
  HELLO_TIMEOUT_MS: 5000,
  MAX_BUFFER_BYTES: 8 * 1024 * 1024,
  MAX_SESSION_ID_LENGTH: 128,
  MAX_URL_LENGTH: 4096,
  MAX_TITLE_LENGTH: 512,
  MAX_ADAPTERS: 32,
  MAX_ADAPTER_NAME_LENGTH: 128,
  MAX_TOKEN_LENGTH: 512,
  MAX_COMMAND_ID_LENGTH: 128,
  MAX_COMMAND_NAME_LENGTH: 128,
  MAX_REF_LENGTH: 128,
  MAX_ERROR_LENGTH: 4096,
  /** Cap on a captured stack trace before it crosses the wire — the console observer and both React
   *  error hooks (error-boundary, hydration-error) all truncate to this, so it is one fact. */
  MAX_STACK_LENGTH: 4000,
  MAX_SERIALIZE_DEPTH: 8,
  MAX_COLLECTION_ITEMS: 200,
  MAX_OBJECT_KEYS: 200,
  MAX_STRING_LENGTH: 64 * 1024,
  /** Human review marks: the note the human types when flagging a mistake on the page. */
  MAX_MARK_NOTE_LENGTH: 2000,
  /** Human review marks: the legible element label that pins the mark (e.g. "Submit button"). */
  MAX_MARK_LABEL_LENGTH: 256,
} as const;

/** Replacement used when sensitive data is removed before crossing the bridge. */
export const REDACTED_VALUE = '[REDACTED]';

/** Explicit opt-in argument required for potentially destructive actions. */
export const DANGEROUS_ACTION_CONFIRM_ARG = 'confirmDangerous';

/**
 * Opt-in argument for a TRUSTED native click, for the handlers a synthetic one cannot satisfy —
 * file pickers, clipboard, anything gated on `isTrusted`. Only `reticle_act` can honour it: the
 * native driver is a pointer gesture at coordinates, and the act-then-wait tool drives the page
 * through the SDK instead.
 */
export const NATIVE_INPUT_ARG = 'native';

/** Schema version stamped onto compiled replay programs. */
export const REPLAY_PROGRAM_VERSION = 1;

/** The git-checked Reticle workspace directory + its layout. No free strings. */
export const ReticleDir = {
  ROOT: '.reticle',
  CONTRACT_FILE: 'contract.json',
  FLOWS_SUBDIR: 'flows',
  BASELINES_SUBDIR: 'baselines',
  /** cross-run memory — outcomes of past runs (the "did it behave like last time?" file). */
  PROJECT_FILE: 'project.json',
  /**
   * the user's own record of what Reticle has done for them — .reticle/impact.json.
   *
   * Local only, never uploaded, and deliberately NOT part of telemetry: telemetry answers our
   * questions about the product; this answers the user's question about their own work.
   */
  IMPACT_FILE: 'impact.json',
  /** what changes were SUPPOSED to make true —.reticle/intent.json (git-checked, reviewed) */
  INTENT_FILE: 'intent.json',
  /** opt-in pixel baselines —.reticle/visual/<name>.png + <name>.diff.png. */
  VISUAL_SUBDIR: 'visual',
  /** verification-run artifacts —.reticle/runs/<runId>.json (the OEM/CI-consumable verdict). */
  RUNS_SUBDIR: 'runs',
  /** fail-to-pass bug capsules —.reticle/capsules/<id>.json (a minimal failing flow + its evidence). */
  CAPSULES_SUBDIR: 'capsules',
  /** durable causal journal —.reticle/sessions/<id>/{events,actions}.jsonl (the substrate). */
  SESSIONS_SUBDIR: 'sessions',
  /** append-only event ledger inside a session dir (one ReticleEvent per line). */
  JOURNAL_EVENTS_FILE: 'events.jsonl',
  /** append-only action ledger inside a session dir (one JournalAction per line). */
  JOURNAL_ACTIONS_FILE: 'actions.jsonl',
  /** learned expected-envelopes per route, accumulated across runs (the deviation-report baseline). */
  ENVELOPES_FILE: 'envelopes.json',
  /** learned ambient (action-less churn) region map — excluded from settle/summaries/envelopes. */
  AMBIENT_FILE: 'ambient.json',
  /** per-flow flake ledger — replay outcomes that decide intermittent-failure quarantine. */
  FLAKE_FILE: 'flake.json',
  /**
   * the project's cloud binding — .reticle/cloud.json, written by `reticle link`. Git-checked and
   * non-secret: the project id, the API origin, and where its dashboard lives. The KEY lives in
   * ~/.reticle/credentials.json instead, because that one must never reach a repository.
   */
  CLOUD_LINK_FILE: 'cloud.json',
  /**
   * local sync bookkeeping — .reticle/cloud-state.json. The pull cursor, when each half last ran,
   * and the last error. NOT git-checked: it describes this machine's conversation with the server,
   * and committing one machine's cursor would make every other machine skip what it had not seen.
   */
  CLOUD_STATE_FILE: 'cloud-state.json',
  /**
   * triage decisions pulled BACK from the dashboard — .reticle/issues.json. What a human said about
   * a defect ("resolved", "not a bug"), so the HUD stops showing it and the next run does not
   * re-report it as though nobody had looked.
   */
  ISSUES_FILE: 'issues.json',
  /** Per-flow assertion tiers recorded on each PASSING replay — the gate's anti-downgrade baseline. */
  TIERS_FILE: 'assertion-tiers.json',
  /**
   * Auto-provisioned bridge pairing token, stored at ~/.reticle/pairing-token (mode 0600). Written by
   * the daemon, read Node-side by the build plugins to inject into connect. A browser sandbox cannot
   * read it, so a rogue localhost app can't present it — that's what stops cross-app session hijack.
   */
  PAIRING_TOKEN_FILE: 'pairing-token',
} as const;

/**
 * Structured reasons a screenshot/visual-diff could not produce a verdict (never
 * thrown as free strings). The visual layer is OPT-IN and CDP/Playwright-driven — it is NEVER
 * bundled into the always-on browser SDK — so NO_PROVIDER is the common "you must `reticle drive`" case.
 */
export const VisualReason = {
  NO_PROVIDER: 'no-visual-provider', // no CDP/launched browser → cannot capture pixels
  CAPTURE_FAILED: 'capture-failed', // the page could not be screenshotted
  BASELINE_MISSING: 'baseline-missing', // reticle_visual_diff with no saved baseline of that name
  DIMENSION_MISMATCH: 'dimension-mismatch', // current vs baseline differ in size — can't pixel-diff
  // { fullPage } asked of a shell that can only photograph the viewport. Reported rather than
  // quietly downgraded: a caller who asked for the whole scroll height and silently got the visible
  // part would bank a baseline that says nothing about the content below the fold.
  FULL_PAGE_UNSUPPORTED: 'full-page-unsupported',
  // The shell answered, and the window had no composited frame to photograph yet. Distinct from
  // CAPTURE_FAILED on purpose: the capture ran and the window was empty, which is a timing fact
  // about the window rather than a failure of the capture path. Electron's `capturePage()` returns
  // an empty image rather than an error in that state, so without a name of its own it arrived as
  // an unexplained no-image and read identically to a dead window and to a thrown error.
  NOT_COMPOSITED: 'window-not-composited',
} as const;
export type VisualReason = (typeof VisualReason)[keyof typeof VisualReason];

/** Actionable companion to NO_PROVIDER — the visual layer needs a driven browser. */
export const VISUAL_NO_PROVIDER_RECOMMENDATION =
  'visual capture needs a driven browser — start with `reticle drive <url>` or set RETICLE_CDP_URL; the always-on SDK does not ship a screenshotter';

/** Default per-pixel color-distance threshold (pixelmatch 0..1; higher = more lenient). */
export const VISUAL_PIXEL_THRESHOLD = 0.1;

/**
 * Autonomous "smart monkey" anomaly classes reticle_crawl reports after clicking a
 * reachable control. Named so the agent (and tests) branch on cause, never on message text.
 */
/**
 * Bounds for reticle_scroll_to — how many viewport scrolls to try before giving up on
 * a virtualized/windowed list (which only renders visible rows, so a plain reticle_query misses
 * off-screen items). Each scroll advances ~one viewport; the loop also stops early at the list end.
 */
export const SCROLL_FIND_DEFAULTS = {
  MAX_SCROLLS: 20,
} as const;

/** Bounds so a crawl always terminates and each click has time to settle. */
export const CRAWL_DEFAULTS = {
  /** Max controls clicked in one crawl (then `truncated:true`). */
  MAX_STEPS: 25,
  /** ms to wait for a click's reaction to land in the buffer before classifying. */
  SETTLE_MS: 300,
  /** HTTP status at/above which a response counts as a failed request. */
  FAILED_STATUS: 400,
} as const;

/** Default max wait for reticle_assert / reticle_wait_for / reticle_act_and_wait when the caller gives
 *  no `timeout_ms`. One fact, shared by the server tools and the @reticlehq/test matchers so the test
 *  package's assumption can't silently diverge from the server default. */
export const DEFAULT_ASSERT_TIMEOUT_MS = 4000;

/** How long to wait between npm registry update checks (24 h). */
export const UpdateCheckIntervalMs = 24 * 60 * 60 * 1000;

/** Schema version stamped into contract.json so a reader can reject/upgrade old files. */
export const CONTRACT_FILE_VERSION = 1;

/** Arg key on reticle_capabilities selecting the on-disk contract over the live session. */
export const FROM_DISK_ARG = 'fromDisk';

/** Structured outcome when reading contract.json fails (never thrown to the agent). */
export const ContractReadError = {
  MISSING: 'contract-missing', // no .reticle/contract.json on disk
  MALFORMED: 'contract-malformed', // present but not valid JSON / fails schema
} as const;
export type ContractReadError = (typeof ContractReadError)[keyof typeof ContractReadError];

/** On-disk artifact constants (project/flow/replay/recorder/heal/annotation) live here. */
export * from './flow-constants.js';

/** Bounds for the per-session ring buffer (see plan/02-architecture.md). */
export const RING_BUFFER_DEFAULTS = {
  MAX_EVENTS: 2000,
  MAX_AGE_MS: 60_000,
  MAX_BYTES: TRANSPORT_LIMITS.MAX_BUFFER_BYTES,
} as const;

/** Normalized event types pushed into the ring buffer. */
export const EventType = {
  DOM_ADDED: 'dom.added',
  DOM_REMOVED: 'dom.removed',
  DOM_ATTR: 'dom.attr',
  DOM_TEXT: 'dom.text',
  NET_REQUEST: 'net.request',
  NET_PENDING: 'net.pending',
  /** An SSE (EventSource) or WebSocket frame — a message on a long-lived streaming connection. */
  NET_STREAM: 'net.stream',
  /** A web-perf metric a screenshot can't verify: LCP, cumulative layout shift, or a long task. */
  PERF: 'perf',
  ROUTE_CHANGE: 'route.change',
  CONSOLE_LOG: 'console.log',
  CONSOLE_WARN: 'console.warn',
  CONSOLE_ERROR: 'console.error',
  CONSOLE_INFO: 'console.info',
  CONSOLE_DEBUG: 'console.debug',
  ERROR_UNCAUGHT: 'error.uncaught',
  VISIBLE_SHOWN: 'visible.shown',
  ANIM_START: 'anim.start',
  ANIM_END: 'anim.end',
  SCROLL_POSITION: 'scroll.position',
  REVEAL_SHOWN: 'reveal.shown',
  SIGNAL: 'signal',
  STATE_CHANGE: 'state.change',
  /** a write to localStorage/sessionStorage/cookies — `data: { area, key, old?, new? }` (values redacted). */
  STORAGE_CHANGE: 'storage.change',
  /** page-level visibility/focus health (distinct from element-level VISIBLE_*). */
  PAGE_HEALTH: 'page.health',
  /**
   * synthetic: the page called window.open, so the consequence of what was just clicked may live in
   * another browsing context this one cannot observe (an OAuth popup is the archetype).
   * `data: { href }` — the URL the page asked to open, when it named one.
   */
  CONTEXT_OPENED: 'context.opened',
  /** aggregated React commits over a throttle window (dev builds) — `data: { commits }`. Commit storms /
   * wasted re-renders show up here without a per-render flood. */
  RENDER_COMMIT: 'render.commit',
  /** element focus moved — `data: { to, from, toBody }`. Focus dropping to body after an act is a regression. */
  FOCUS_CHANGE: 'focus.change',
  /** browser → bridge: a human recording compiled in-page. */
  FLOW_RECORDED: 'flow.recorded',
  /** synthetic: browser transport queue overflowed; events were dropped. `data: { dropped: number }`. */
  TRANSPORT_OVERFLOW: 'transport.overflow',
  /**
   * synthetic: a per-channel cap truncated a batch (e.g. a DOM mutation flood). `data: { channel, dropped }`.
   * Marks downstream rollups/envelopes as built on incomplete data — a ledger that lies at scale is worse
   * than no ledger, so truncation is never silent.
   */
  TRUNCATED: 'truncated',
  /**
   * synthetic: the SDK detected a region it CANNOT observe (a cross-origin iframe, a closed shadow root).
   * `data: { kind: BlindSpotKind, count }`. Surfaced on results as `coverage: partial` so a green never
   * implies it saw everything.
   */
  BLIND_SPOT: 'blind-spot',
  /** synthetic: the SDK ITSELF failed (an observer threw). `data: { site, message, errorType }`.
   *  Rides the existing bridge — no outbound request. See browser/observers/sdk-failure.ts. */
  SDK_FAILED: 'sdk.failed',
  /**
   * synthetic (driven only): CDP/Playwright-authoritative network detail for a response the in-page
   * fetch/XHR wrapper also saw — full response headers + authoritative status/mimeType the page-side
   * wrapper can't reach. `data: { url, method?, status, headers, resourceType? }`. Merged onto the
   * matching in-page NET_REQUEST so the driven view never loses fidelity to an outside-in tool.
   */
  NET_DETAIL: 'net.detail',
  /**
   * Live-control: browser → bridge. A human acted on the presenter panel.
   * `data: { kind: HumanControlKind; text?: string }`. Rides the existing EventMessage.
   */
  HUMAN_CONTROL: 'human.control',
  /**
   * Human review: browser → bridge. A human pinned a mistake to an element on the running page
   * (the "annotate the bug where you see it" loop). `data` narrows to HumanMarkDataSchema — a note
   * plus a re-resolvable element anchor (and its source file:line when the framework stamped one) so
   * the agent that drains the mark knows exactly which element and which source to fix.
   */
  HUMAN_MARK: 'human.mark',
  /**
   * The app produced a FILE — a Blob handed to `URL.createObjectURL`, usually saved by clicking an
   * anchor with `download`. `data: { filename?, mimeType, bytes, lines?, preview? }`. The one artifact
   * class no outside-the-browser tool can inspect: it never crosses the network, so there is no
   * request to intercept. See `observers/download.ts` for the defect that motivated it.
   */
  DOWNLOAD: 'download',
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

/**
 * Named phenomena the perception layer detects deterministically over the journal — capsules and
 * deviation reports lead with these names, not raw events. The library grows in later releases; the
 * mechanism (versioned matchers + evidence templates) lands now.
 */
export const PhenomenonType = {
  /** An act dispatched but the app did nothing — no DOM/net/route/signal in its window. */
  DEAD_CLICK: 'dead-click',
  /** A click landed before hydration attached handlers — a silent no-op. */
  PRE_HYDRATION_CLICK: 'pre-hydration-click',
  /** A 5xx response that occurred while the page was hidden — looks fine, isn't. */
  HIDDEN_500: 'hidden-500',
  /** A request started and never completed within the window — a hung/in-flight request. */
  HUNG_REQUEST: 'hung-request',
  /** A React error boundary caught and swallowed — a fine-looking fallback over a broken feature. */
  SWALLOWED_ERROR: 'swallowed-error',
} as const;
export type PhenomenonType = (typeof PhenomenonType)[keyof typeof PhenomenonType];

/** Signal the React adapter fires once hydration commits (handlers attached). Shared browser↔server. */
export const RETICLE_HYDRATION_SIGNAL = 'reticle:hydration-complete';

/**
 * The registered-store name the React adapter uses for render stats, read via reticle_state. It crosses
 * the wire as a store id AND the browser SDK special-cases it as reticle-owned (so it isn't flagged as
 * an unregistered store), so the name is one fact in core — a rename in the adapter must not silently
 * stop the SDK's owned-store matching.
 */
export const RETICLE_RENDERS_STORE = '__reticle_renders';

/** Global the render pre-hook parks its commit buffer on (see the vite plugin's RENDER_PREHOOK_SOURCE). */
export const RETICLE_RENDER_PREHOOK = '__reticleRenderPreHook';

/**
 * Signal the React adapter fires when an error boundary catches (dev-only). Carried on the signal channel
 * (the SDK's public emit surface) so the server sees a boundary that swallowed — the purest "looks fine,
 * isn't", invisible to every other channel. `data: { message, stack?, componentStack? }`.
 */
export const RETICLE_ERROR_BOUNDARY_SIGNAL = 'reticle:error-boundary';

/**
 * Signal the React adapter fires on a hydration mismatch — server-rendered markup that disagrees with the
 * client's first render. React reports these as *recoverable* errors (`hydrateRoot(el, App,
 * { onRecoverableError })`); a mismatch silently discards the SSR DOM and re-renders on the client, so the
 * page "looks fine" while event handlers, form state, or scroll position were lost — invisible to DOM/
 * network/console. `data: { message, stack?, componentStack? }`.
 */
export const RETICLE_HYDRATION_ERROR_SIGNAL = 'reticle:hydration-error';

/** The observation channel a TRUNCATED event names, so downstream knows WHICH data is incomplete. */
export const TruncationChannel = {
  DOM: 'dom',
} as const;
export type TruncationChannel = (typeof TruncationChannel)[keyof typeof TruncationChannel];

/**
 * How an event was linked to the action it is attributed to. `window` means the SDK stamped the
 * currently-active action's id onto every event observed between that action's dispatch and its
 * settle — a time-window heuristic, not proven dataflow. It is the only tier available until
 * commit-stream linking upgrades it; the label stays on so a chain is never presented as dataflow
 * truth (see plan risk register).
 */
export const EventAttribution = {
  WINDOW: 'window',
} as const;
export type EventAttribution = (typeof EventAttribution)[keyof typeof EventAttribution];

/** The web-perf metrics carried in an EventType.PERF event's `metric` field. */
export const PerfMetric = {
  /** Largest Contentful Paint (ms). */
  LCP: 'lcp',
  /** Cumulative Layout Shift (unitless, running sum). */
  CLS: 'cls',
  /** A long task blocking the main thread (ms). */
  LONGTASK: 'longtask',
} as const;
export type PerfMetric = (typeof PerfMetric)[keyof typeof PerfMetric];

/** Which input path executed an action — native (CDP/Playwright) vs synthetic dispatchEvent. */
export const InputMode = {
  REAL: 'real',
  SYNTHETIC: 'synthetic',
} as const;
export type InputMode = (typeof InputMode)[keyof typeof InputMode];

/**
 * Why a pointer action ran SYNTHETIC even though a real-input provider is configured. Attached as
 * `inputModeReason` so a real→synthetic fallback is never silent (field bug #2) — the agent can
 * tell "I couldn't locate the element" from "the page isn't correlated to a CDP target".
 */
export const InputModeReason = {
  NOT_POINTER: 'not-a-pointer-action', // fill/type never use native input
  // Clicks default to the occlusion-honest synthetic path ("don't click, run the code") even with a
  // provider configured; pass action arg native:true to force a trusted native click when needed.
  SYNTHETIC_CLICK_PREFERRED: 'synthetic-click-preferred',
  PAGE_NOT_CORRELATED: 'page-not-correlated-to-a-cdp-target', // no CDP page matches session.url
  ELEMENT_NOT_LOCATABLE: 'element-not-locatable', // INSPECT returned no box (off-screen/stale ref)
  DRAG_TARGET_UNRESOLVED: 'drag-target-unresolved', // drag toRef missing or not locatable
  PROVIDER_DECLINED: 'provider-declined', // provider chose not to perform
  PROVIDER_ERROR: 'provider-error', // provider threw → fell back to synthetic
  /**
   * No real-input provider is configured at all, and the caller explicitly asked for one with
   * `native:true`. Only emitted on that explicit ask: without a provider EVERY action is synthetic,
   * so annotating all of them would put a reason on the most-used tool in the product for no gain.
   * An agent that asked for a trusted click, though, has an expectation to correct — and this is
   * permanent for the session, not a transient downgrade, so it should stop asking.
   */
  NOT_CONFIGURED: 'real-input-not-configured-for-this-session',
} as const;
export type InputModeReason = (typeof InputModeReason)[keyof typeof InputModeReason];

/** Best-effort caveats attached to action results so the agent can interpret a no-op. */
export const ActionWarning = {
  HOVER_NATIVE_ENTER_LEAVE:
    'target has enter/leave handlers; synthetic hover may not trigger them — expect no state change',
  /** real-input provider was available but failed; the action fell back to synthetic dispatch. */
  REAL_INPUT_FELL_BACK:
    'real-input provider was available but failed; fell back to synthetic dispatch',
  /**
   * The click point was covered by another element. Synthetic dispatch still delivered the event to
   * your target, but a real user could NOT click it — treat the target as visually blocked, not
   * actionable. Scroll it into a clear area or dismiss the overlay on top.
   */
  CLICK_OCCLUDED:
    'target is visually occluded by another element; a real user could not click it (synthetic dispatch still delivered the event) — dismiss the overlay or scroll the target clear',
} as const;
export type ActionWarning = (typeof ActionWarning)[keyof typeof ActionWarning];

/** Failure modes when Reticle launches/drives its own browser (`reticle drive`). */
export const DriveErrorCode = {
  PLAYWRIGHT_MISSING: 'playwright_missing',
  LAUNCH_FAILED: 'launch_failed',
  NAVIGATE_FAILED: 'navigate_failed',
} as const;
export type DriveErrorCode = (typeof DriveErrorCode)[keyof typeof DriveErrorCode];

/** Human-facing message when the optional playwright dep is absent. */
export const DRIVE_PLAYWRIGHT_MISSING_MSG =
  "reticle drive needs the optional 'playwright' package — install it: pnpm add -D playwright && npx playwright install chromium";

/** Actions the executor can perform against a ref (plan/03 + plan/05). */
/**
 * The console levels an agent can filter by, DERIVED from the console EventTypes rather than
 * retyped. `reticle_console { level }` matches by building `console.${level}`, so any list written
 * out by hand is one rename away from filtering everything into an empty result — which reads as
 * "no errors on this page".
 */
export const CONSOLE_LEVEL_PREFIX = 'console.';
export const CONSOLE_LEVELS = [
  EventType.CONSOLE_LOG,
  EventType.CONSOLE_WARN,
  EventType.CONSOLE_ERROR,
  EventType.CONSOLE_INFO,
].map((type) => type.slice(CONSOLE_LEVEL_PREFIX.length));

export const ActionType = {
  CLICK: 'click',
  DBLCLICK: 'dblclick',
  HOVER: 'hover',
  FOCUS: 'focus',
  BLUR: 'blur',
  FILL: 'fill',
  TYPE: 'type',
  CLEAR: 'clear',
  SELECT: 'select',
  CHECK: 'check',
  UNCHECK: 'uncheck',
  SUBMIT: 'submit',
  PRESS: 'press',
  UPLOAD: 'upload',
  SCROLL_INTO_VIEW: 'scrollIntoView',
  DRAG: 'drag',
  WEBMCP: 'webmcp',
} as const;
export type ActionType = (typeof ActionType)[keyof typeof ActionType];

/** Why an action's settle wait ended without a real animation frame. */
export const SettleReason = {
  TIMEOUT: 'timeout',
  THROTTLED: 'throttled',
} as const;
export type SettleReason = (typeof SettleReason)[keyof typeof SettleReason];

/** Outcome reasons for a bounded component-state read. Store reads never use these. */
export const ComponentStateReason = {
  UNAVAILABLE: 'component-state-unavailable',
} as const;
export type ComponentStateReason = (typeof ComponentStateReason)[keyof typeof ComponentStateReason];

/**
 * Result of a component-state read attempt, discriminated on `ok`. Crosses
 * browser -> bridge -> agent as `result.component`, so the contract lives in protocol.
 * Always JSON-serializable: hook values are sanitized (no functions/DOM nodes/cycles).
 */
export interface ComponentStateResult {
  ok: boolean;
  reason?: ComponentStateReason;
  /** Component display name, when known. */
  component?: string;
  /** Positional, JSON-safe hook states. */
  hooks?: unknown[];
  /**
   * Present ONLY when `hooks` is a PROJECTION — effect entries were removed. A trim is never silent:
   * without this, a hook list short by three entries reads as the component's complete hook list.
   */
  truncation?: { droppedItems: number; note: string };
}

/** Element states the assertion engine can check (plan/06). */
export const ElementState = {
  VISIBLE: 'visible',
  HIDDEN: 'hidden',
  ENABLED: 'enabled',
  DISABLED: 'disabled',
  CHECKED: 'checked',
  EXPANDED: 'expanded',
  FOCUSED: 'focused',
  PRESENT: 'present',
  /**
   * Inside the viewport right now (getBoundingClientRect intersects the window). Distinct from
   * `visible`, which folds only aria-hidden/[hidden]/display/visibility/opacity and so is already
   * true for content below the fold of a scrolling container. Without this, `scrollIntoView` is
   * ungradeable: the target satisfied `visible`/`present` before the scroll, so act_and_wait
   * returns already_true. (#398)
   */
  IN_VIEWPORT: 'inViewport',
} as const;
export type ElementState = (typeof ElementState)[keyof typeof ElementState];

/** Query strategies, aligned with Testing Library semantics (plan/04). */
export const QueryBy = {
  ROLE: 'role',
  TEXT: 'text',
  LABEL: 'label',
  PLACEHOLDER: 'placeholder',
  TESTID: 'testid',
  ALT: 'alt',
  /** Resolve by component identity / source location (auto-anchors — addresses any element with
   * no hand-added testid). Pair with ElementQuery.component and/or.source. */
  COMPONENT: 'component',
} as const;
export type QueryBy = (typeof QueryBy)[keyof typeof QueryBy];

/** Commands the bridge sends to the browser SDK (the `name` field of a CommandMessage). */
export const ReticleCommand = {
  SNAPSHOT: 'snapshot',
  QUERY: 'query',
  MATCH: 'match',
  INSPECT: 'inspect',
  ACT: 'act',
  ACT_SEQUENCE: 'act_sequence',
  ANIMATIONS: 'animations',
  NARRATE: 'narrate',
  CLOCK: 'clock',
  CAPABILITIES: 'capabilities',
  STATE_READ: 'state_read',
  /** Read localStorage / sessionStorage / readable cookies (sensitive keys redacted). */
  STORAGE_READ: 'storage_read',
  /** scroll a ref's nearest scrollable container by ~a viewport (virtualized lists). */
  SCROLL: 'scroll',
  /** Session lifecycle: agent tunes the presenter session (e.g. idle-end timeout) for the app's needs. */
  SESSION_CONFIG: 'session_config',
  /**
   * Live-control: bridge → browser. Pushes the current session state to the panel so an
   * AGENT-driven pause/end keeps the presenter in sync. `args: { state, text? }`.
   */
  PRESENTER: 'presenter',
  /**
   * Bridge -> browser: the user's own impact record, so the HUD can show what Reticle has done for
   * them without the page asking for it. `args: { snapshot: ImpactSnapshot }`. Local data on a
   * local socket - it is the same file the report is stored in, not a fetch to us.
   */
  IMPACT: 'impact',
  /**
   * Ask the DESKTOP shell to photograph its own window and return `{ png: <base64> }`.
   *
   * A desktop webview has no CDP endpoint, so pixels must come from the runtime itself. Electron's
   * `webContents.capturePage()` reads the window's backing store, which is why this beats capturing
   * a screen region: it is correct even when the window is behind the editor, and needs no
   * screen-recording permission. Answered only when the app installed the capture helper.
   */
  CAPTURE: 'capture',
  /** Navigate the page to a new URL. `args: { url: string }`. */
  NAVIGATE: 'navigate',
  /** Reload the page. `args: { hard?: boolean }` — hard clears the cache via location replace trick. */
  REFRESH: 'refresh',
  /**
   * Bridge → browser: the saved flows the human can replay from the panel.
   * `args: { flows: [{ name, start? }] }` — `start` is the first step's testid anchor, a page hint the
   * HUD uses to show a flow only where it can begin. Absent when the first step isn't testid-anchored.
   */
  FLOWS: 'flows',
} as const;
export type ReticleCommand = (typeof ReticleCommand)[keyof typeof ReticleCommand];

/** Presenter intent shown to the human watcher: is the agent reading or acting? */
export const PresenterMode = {
  IDLE: 'idle',
  READING: 'reading',
  ACTING: 'acting',
} as const;
export type PresenterMode = (typeof PresenterMode)[keyof typeof PresenterMode];

/** Snapshot rendering modes (plan/04). */
export const SnapshotMode = {
  FULL: 'full',
  INTERACTIVE: 'interactive',
  STATUS: 'status',
} as const;
export type SnapshotMode = (typeof SnapshotMode)[keyof typeof SnapshotMode];

/** Top-level envelope discriminator for messages on the WS channel. */
export const MessageKind = {
  HELLO: 'hello',
  COMMAND: 'command',
  COMMAND_RESULT: 'command_result',
  EVENT: 'event',
} as const;
export type MessageKind = (typeof MessageKind)[keyof typeof MessageKind];
