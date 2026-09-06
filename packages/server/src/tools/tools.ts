import { z } from 'zod';
import { NoSessionAction, QueryBy, ReticleCommand, SnapshotMode } from '@reticlehq/core';
import { ReticleTool } from './tool-names.js';
import { withSizeCost } from '../session/output-budget.js';
import { applySnapshotDelta, SnapshotCache } from './snapshot-delta.js';
import { asRecord, asString, asNumber } from './tools-helpers.js';
import { countSchema } from './numeric-bounds.js';
import { normalizeQueryArgs } from './query-shape.js';
import { paginateQueryResult } from './query-paginate.js';

/**
 * The query strategies, derived from the enum in core — never retyped.
 *
 * The description used to hand-list them and had already drifted: it named six and omitted
 * `component`, which is real and works. Deriving both the schema and the prose from one source is
 * the repo's own rule, and here it is also the difference between refusing `by:'css'` and silently
 * answering "0 matches" to it.
 */
const QUERY_BY_VALUES = Object.values(QueryBy);
const QUERY_BY_LIST = QUERY_BY_VALUES.join(' | ');
const queryByEnum = z.enum(QUERY_BY_VALUES as [string, ...string[]]);
import { CONTRACT_TOOLS } from './contract-tools.js';
import { DOMAIN_TOOLS } from '../domain/domain-tools.js';
import { BROWSER_TOOLS } from './browser-tools.js';
import { FLOW_TOOLS } from '../flows/flow-tools.js';
import { INTENT_TOOLS } from '../intent/intent-tools.js';
import { CONTEXT_TOOLS } from '../runs/context-tools.js';
import { PROJECT_TOOLS } from '../project/project-tools.js';
import { MEMORY_TOOLS } from '../memory/memory-tools.js';
import { RUN_TOOLS } from '../runs/run-tools.js';
import { VISUAL_TOOLS } from '../visual/visual-tools.js';
import { AFFECTED_TOOLS } from '../flows/affected-tools.js';
import { buildCoverageTools } from './coverage-tools.js';
import { VERIFY_CHANGE_TOOLS } from '../flows/verify-change-tools.js';
import { CRAWL_TOOLS } from '../crawl/crawl-tools.js';
import { NAV_SMOKE_TOOLS } from '../nav-smoke/nav-smoke-tools.js';
import { SCROLL_TOOLS } from '../input/scroll-tools.js';
import { NETWORK_MOCK_TOOLS } from '../input/network-mock-tools.js';
import { VIEWPORT_TOOLS } from '../input/viewport-tools.js';
import { SESSION_TOOLS } from '../session/session-tools.js';
import { ANNOTATE_TOOLS } from '../flows/annotate-tools.js';
import { LIVE_CONTROL_TOOLS } from '../session/live-control-tools.js';
import { type ToolDef, sessionIdShape, commandOrThrow } from './tool-kit.js';
import { applyMerges, type MergePlan } from './merge-tools.js';
import { ACT_TOOLS } from './act-tools.js';
import { OBSERVE_TOOLS } from './observe-tools.js';
import { RECONCILE_TOOLS } from './reconcile-tools.js';
import { READ_TOOLS } from './read-tools.js';
import { LEASE_TOOLS } from './lease-tools.js';
import { FEEDBACK_TOOLS } from './feedback-tools.js';

// Re-exported so tool modules that import these from './tools.js' keep working after the kit move.
export type { ToolDef, ToolDeps } from './tool-kit.js';

/** Per-server last-snapshot cache backing reticle_snapshot's diff:true delta mode (route-invalidated). */
const SNAPSHOT_CACHE = new SnapshotCache();

/** Every handler, including tools retired from the advertised MCP surface. */
export const RAW_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.SESSIONS,
    description:
      'List connected browser sessions (tab url/title, sessionId, last-seen, health: hidden/focused/throttled, and `realInputAvailable` — true when native CDP/launched real input is driving this tab), plus a `recommendation` naming the in-protocol escape hatch (`reticle_run { tool: "reticle_lease" }`, with `reticle drive` as the human-side equivalent) when a tab is hidden/throttled and may be un-scriptable from here.',
    inputSchema: {},
    outputSchema: {
      sessions: z
        .array(
          // Keep in sync with SessionInfo (session.ts) plus the handler-added realInputAvailable/leased.
          // A strict MCP client validates this against the payload, so an undeclared field is a hard error.
          z.object({
            sessionId: z.string(),
            url: z.string(),
            projectId: z.string().optional(),
            title: z.string().optional(),
            adapters: z.array(z.string()),
            hasCapabilities: z.boolean(),
            runtime: z
              .string()
              .optional()
              .describe(
                "Which shell answered: web, electron or tauri. Absent on an SDK too old to report one — never defaulted, because a browser tab and a desktop window on the same url are otherwise indistinguishable and only one of them has the app's IPC.",
              ),
            versionSkew: z
              .string()
              .optional()
              .describe(
                "Present only when this page's SDK version differs from the daemon's. A skewed pair connects and then disagrees about tool behaviour — usually surfacing as a bare -32000. Fix it before trusting any verdict from this session.",
              ),
            lastSeenMs: z.number(),
            throttled: z.boolean(),
            focused: z.boolean(),
            hidden: z.boolean(),
            realInputAvailable: z.boolean().optional(),
            leased: z.boolean().optional(),
            stale: z.boolean().optional(),
            cleanup_suggestion: z.string().optional(),
            unresponsive: z
              .literal(true)
              .optional()
              .describe(
                'Present only when this tab is attached but has stopped answering commands: every call against it will time out. The other health fields still look fine, which is what makes this state invisible without the flag.',
              ),
            unresponsive_suggestion: z.string().optional(),
            pendingMarks: z.number().optional(),
            review_suggestion: z.string().optional(),
            recommendation: z.string().optional(),
            // Attached by SessionManager.list() (#117): whether this tab ever dropped and came back,
            // how often, and how long the last drop lasted. Undeclared here, a validating client
            // stripped the outage history while the row still looked complete — a verdict over a
            // window with a four-second blind gap read as trustworthy.
            attachment: z
              .object({
                connectedSinceMs: z.number(),
                outages: z.number(),
                lastOutage: z.object({ startedMs: z.number(), durationMs: z.number() }).optional(),
              })
              .optional()
              .describe(
                'Present only when this tab has dropped and reconnected at least once: how long it has been attached in total, how many outages occurred, and when the last one started and how long it lasted. A verdict over this window spans a gap where nothing was observed.',
              ),
          }),
        )
        .describe(
          'Connected browser sessions with health state. `projectId` groups sessions by app (stable across port changes); `leased` marks a pool-managed headless context vs a human tab.',
        ),
      why: z
        .string()
        .optional()
        .describe(
          'Present ONLY when `sessions` is empty: why nothing is connected, and the next action that fixes it. An empty list is never the end of the road — read this before concluding the app cannot be driven.',
        ),
      next_action: z
        .object({
          action: z.nativeEnum(NoSessionAction),
          command: z.string().optional(),
          port: z.number().optional(),
          reason: z.string(),
        })
        .optional()
        .describe(
          "Present ONLY when `sessions` is empty: the same answer as `why`, executable. `command` is the LITERAL command to run, sourced from this project's own package.json scripts and lockfile — it is absent, never guessed, when the project declares no dev script. `action` is one of daemon_split | start_dev_server | run_init | open_app | reopen_app. `daemon_split` outranks the rest and means the app IS running and instrumented, on a DIFFERENT daemon than the one you are attached to — do not start or re-init anything, read `reason`.",
        ),
    },
    handler: async (deps) => {
      const provider = deps.realInput;
      const leasedIds = new Set(deps.pool?.leasedSessionIds() ?? []);
      const sessions = await Promise.all(
        deps.sessions.list().map(async (s) => ({
          ...s,
          realInputAvailable: provider !== undefined ? await provider.isAvailableFor(s.url) : false,
          leased: leasedIds.has(s.sessionId),
        })),
      );
      // An empty list is the most common thing this tool ever returns, and on its own it is a dead
      // end: the agent asked the one question it knows to ask, got a confident-looking answer with
      // no next step, and stopped. The daemon already knows WHY nothing is connected — say it here
      // rather than only when a later tool fails for want of a session.
      if (0 === sessions.length) {
        const why = deps.sessions.noSessionHint();
        // The executable half. `why` is for the human reading the transcript; this is the one the
        // agent acts on, so it never has to parse a paragraph to find a command inside it.
        const next = deps.sessions.noSessionNextAction();
        return {
          sessions,
          ...(why === undefined ? {} : { why }),
          ...(next === undefined ? {} : { next_action: next }),
        };
      }
      return { sessions };
    },
  },
  {
    name: ReticleTool.SNAPSHOT,
    example: { diff: true },
    description:
      'Semantic accessibility snapshot of the page or a subtree — `mode:"interactive"` returns only the controls, ~3x smaller. Refs (`e42`) are stable: the same element keeps its ref across snapshots and only stops resolving once it leaves the DOM — re-snapshot after a navigation or if a ref fails to resolve, not between ordinary actions. mode: full|interactive|status. Use to see what is on screen right now. The result carries cost:{ bytes, tokens } (estimated) — if it is large, re-scope (pass `scope`) or use mode:interactive/status instead of reading the whole tree. Pass diff:true after your first snapshot to get back ONLY what changed since your last look (mode:delta with added/removed, or mode:unchanged) — far fewer tokens and no stale tree to mis-read; a route change resets it to a full snapshot automatically.',
    inputSchema: {
      scope: z
        .string()
        .optional()
        .describe(
          'CSS selector or element ref to restrict the snapshot to a subtree. Omit to snapshot the whole page.',
        ),
      mode: z
        .nativeEnum(SnapshotMode)
        .optional()
        .describe(
          'full = all elements; interactive = only clickable/focusable elements; status = only route + title. Default: full.',
        ),
      diff: z
        .boolean()
        .optional()
        .describe(
          'Return only what changed since your last snapshot of the same scope/mode (mode:delta|unchanged). First call (or after a route change) still returns the full tree.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      tree: z
        .string()
        .optional()
        .describe('Indented ARIA tree of every element on the page (or the scoped subtree).'),
      status: z
        .object({
          route: z.string(),
          title: z.string().optional(),
          visibleDialogs: z.array(z.string()).optional(),
          overlayHidingPage: z.string().optional(),
        })
        .optional(),
      mode: z
        .string()
        .optional()
        .describe('full | delta | unchanged — which kind of diff response this is.'),
      delta: z
        .object({
          added: z.array(z.string()),
          removed: z.array(z.string()),
          addedCount: z.number(),
          removedCount: z.number(),
        })
        .optional()
        .describe('Only present on a diff:true call that found changes.'),
      changed: z
        .array(z.string())
        .optional()
        .describe(
          'Elements whose value changed in place (same ref, different content) — not a structural add/remove.',
        ),
      changedCount: z.number().optional().describe('Number of elements in `changed`.'),
      reason: z
        .string()
        .optional()
        .describe('Why mode is "full": first snapshot for this route, or route changed.'),
      cost: z
        .object({ bytes: z.number(), tokens: z.number() })
        .optional()
        .describe('Estimated size of this result — re-scope if large.'),
      // buildSnapshot has always returned these; leaving them undeclared stripped them from
      // structuredContent, so a schema-aware client saw a tree that ended abruptly with no way to
      // tell a small page from a capped one. Every "that element isn't rendered" conclusion drawn
      // from a capped tree inherits the omission.
      nodes: z.number().optional().describe('How many nodes this tree actually contains.'),
      truncated: z
        .boolean()
        .optional()
        .describe(
          'True when the page exceeded the snapshot cap. The tree is then a document-order PREFIX: an element being absent from it does NOT mean it is absent from the page.',
        ),
      note: z
        .string()
        .optional()
        .describe(
          'Present when a diff was computed over a capped tree — "unchanged" is then partial.',
        ),
      scopeMissing: z
        .boolean()
        .optional()
        .describe(
          'True when a scope was given but resolved to nothing — the tree is EMPTY on purpose, not because the page is empty. Do not read an absent element as absent from the page; re-check the scope.',
        ),
    },
    // async so a synchronous resolve() failure (no session connected) surfaces as a REJECTED promise —
    // the handler contract every caller relies on — not a throw that escapes a direct invocation.
    handler: async (deps, args) => {
      // Resolve ONCE and key the diff cache on the RESOLVED session id. Keying on `sessionId ?? 'default'`
      // meant two different auto-selected sessions (agent omits sessionId) shared the 'default' slot, so
      // diff:true computed a delta against the WRONG session's prior snapshot — a cross-session false
      // change. Pass the resolved id to the command too, so the cache key and the snapshotted session
      // can't drift apart via a second auto-selection.
      const resolved = deps.sessions.resolve(asString(args['sessionId']));
      const mode = asString(args['mode']) ?? SnapshotMode.FULL;
      return commandOrThrow(deps, resolved.id, ReticleCommand.SNAPSHOT, {
        scope: args['scope'],
        mode,
      }).then((raw) =>
        withSizeCost(
          noteHiddenPage(
            noteEmptyLeanTree(
              applySnapshotDelta(
                raw,
                {
                  sessionId: resolved.id,
                  scope: asString(args['scope']) ?? '',
                  mode,
                  diff: true === args['diff'],
                },
                SNAPSHOT_CACHE,
              ),
              mode,
            ),
            mode,
          ),
        ),
      );
    },
  },
  {
    name: ReticleTool.QUERY,
    example: { by: 'testid', value: 'todo-list' },
    description: `Find elements by Testing-Library semantics, INCLUDING open shadow roots — \`count_only:true\` gives just the count (~30x smaller); \`limit\` caps descriptors. Pass \`by\` (${QUERY_BY_LIST}) and \`value\` (the query string). Returns matching refs + descriptors + visibility. Pass \`attrs:["href"]\` to project attributes (link/image URLs) onto each match. Pass \`limit\` to cap descriptors (broad role queries can be large) or \`count_only:true\` for just the match count — both cut tokens. On zero matches, also returns hint:{ route, presentRegions[], knownEmptyState } so you can distinguish an empty state from a missing element WITHOUT taking a snapshot. ASKING SEVERAL QUESTIONS ABOUT THE PAGE? One reticle_snapshot answers them all at once — a run of queries costs a round trip each and returns what the snapshot already held.`,
    inputSchema: {
      // Constrained to the enum, NOT z.string(). A free string let `by:'css'` through to the
      // browser's `default: return []`, so an unsupported strategy answered "0 matches" — which
      // reads as "the element is not on the page". Measured on a live page: by:'css' value:'body'
      // returned count 0. A false negative is the one answer this product must never invent.
      by: queryByEnum.optional().describe(`Query strategy: ${QUERY_BY_LIST}`),
      value: z
        .string()
        .optional()
        .describe(
          'Query value for the selected strategy (e.g. by=role value=button, or by=testid value=submit-btn). Or use the predicate spelling directly: { testid: "submit" }, { text: "Deploy" }.',
        ),
      name: z
        .string()
        .optional()
        .describe(
          'Accessible name filter — narrows results when `by` is role and the page has many elements of that role.',
        ),
      scope: z
        .string()
        .optional()
        .describe('CSS selector or element ref to restrict the search to a subtree.'),
      self: z
        .boolean()
        .optional()
        .describe(
          'Return the `scope` element ITSELF instead of searching inside it. Use when the target is a plain layout container with no role, name, testid or text of its own — which is routinely the element that carries the handler, and is otherwise unreachable because every query excludes its own scope root. Requires `scope`.',
        ),
      attrs: z
        .array(z.string())
        .optional()
        .describe(
          "Attribute names to return per match, e.g. ['href'] to inventory links or ['src'] for images. Absent attributes are omitted; credential-bearing names are redacted.",
        ),
      limit: countSchema
        .optional()
        .describe(
          'Cap the returned descriptors to the first N (cuts tokens on broad queries). If more matched, the result carries total + truncated:true so the trim is never silent — narrow with name/scope.',
        ),
      count_only: z
        .boolean()
        .optional()
        .describe(
          'Return just { count } (no element descriptors) — use when you only need "how many match?" and not their refs.',
        ),
      // The predicate's spelling, accepted as an alias for by/value so the shape an agent learns from
      // act_and_wait/assert also works here. See query-shape.ts.
      testid: z.string().optional().describe('Alias for by="testid" value=… (predicate spelling).'),
      text: z.string().optional().describe('Alias for by="text" value=… (predicate spelling).'),
      role: z.string().optional().describe('Alias for by="role" value=… (predicate spelling).'),
      label: z.string().optional().describe('Alias for by="label" value=… (predicate spelling).'),
      placeholder: z.string().optional().describe('Alias for by="placeholder" value=… .'),
      alt: z.string().optional().describe('Alias for by="alt" value=… (predicate spelling).'),
      ...sessionIdShape,
    },
    outputSchema: {
      elements: z
        .array(
          z.object({
            ref: z.string(),
            role: z.string(),
            name: z.string(),
            value: z.string().optional(),
            states: z.array(z.string()),
            visible: z.boolean(),
            attrs: z
              .record(z.string())
              .optional()
              .describe(
                'Present only for attributes requested via `attrs` and found on the element.',
              ),
            source: z
              .string()
              .optional()
              .describe(
                'Where this element is written, as `file:line` — open this to change it. Present when the app is built with the Reticle plugin in dev; absent in production builds.',
              ),
            chart: z
              .array(
                z.object({
                  kind: z.string(),
                  tag: z.string(),
                  attr: z.string(),
                  sample: z.string(),
                }),
              )
              .optional()
              .describe(
                'Chart geometry faults, present ONLY when the element is a broken chart. kind is non-finite-coordinates | empty-geometry | degenerate-geometry. A healthy chart omits this. Declared here so structuredContent carries it on validating profiles rather than dropping it.',
              ),
          }),
        )
        .optional(),
      count: z
        .number()
        .optional()
        .describe(
          'How many elements MATCHED — always exact, even when the returned list was capped. Never derive a count from elements.length.',
        ),
      total: z
        .number()
        .optional()
        .describe('Total matches before `limit` truncation — present only when truncated.'),
      truncated: z.boolean().optional().describe('True when `limit` dropped some matches.'),
      hint: z
        .object({
          route: z.string(),
          // The browser emits presentRegions and it was NOT declared here, so zod stripped it from
          // structuredContent on every zero-match result — the successor field was invisible while its
          // deprecated predecessor was the only thing an agent could see. An undeclared field is a
          // silent data loss, which is exactly what this schema exists to prevent.
          presentRegions: z
            .array(
              z.object({
                role: z.string(),
                name: z.string().optional(),
                childCount: z.number(),
                // `sample` is the orientation payload an agent actually reads ("there is a list with
                // 847 rows, first three are …"). It was omitted from the first version of this
                // declaration, which repeated the original sin one level down.
                sample: z.array(z.string()),
              }),
            )
            .optional()
            .describe('Structural clusters on the page — what IS here, to diagnose the miss.'),
          presentTestids: z.array(z.string()).optional(),
          knownEmptyState: z.boolean(),
          splitText: z
            .object({
              ref: z.string().optional(),
              role: z.string().optional(),
              name: z.string().optional(),
            })
            .passthrough()
            .optional()
            .describe(
              "Present when a TEXT search missed but the string IS on the page, split across this container's children. Retry as { scope: <ref>, self: true } — no text query can match a string no single element owns.",
            ),
        })
        .optional()
        .describe(
          'Present only on zero matches — tells you what IS on the page so you can diagnose the miss.',
        ),
      cost: z
        .object({ bytes: z.number(), tokens: z.number() })
        .optional()
        .describe('Estimated size of this result — narrow with `name`/`scope`/`limit` if large.'),
      scopeMissing: z
        .boolean()
        .optional()
        .describe(
          'True when a `scope` was given but resolved to nothing — zero matches then means the scope is gone, NOT that the element is absent. The search did not widen to the whole page. Re-check the scope before concluding anything.',
        ),
    },
    handler: (deps, rawArgs) => {
      // Accept the predicate's named-field spelling too — see query-shape.ts.
      const args = normalizeQueryArgs(rawArgs);
      return commandOrThrow(deps, asString(args['sessionId']), ReticleCommand.QUERY, {
        by: args['by'],
        value: args['value'],
        name: args['name'],
        scope: args['scope'],
        // The handler forwards an explicit allowlist, so a new input is silently dropped unless it is
        // added here — the browser saw no `attrs` and returned undefined while the unit tests, which
        // call matchQuery directly, passed. Schema plus implementation is not the whole wire.
        //
        // It happened again with `self`, in the same session that wrote this comment: declared on the
        // tool, implemented in the browser, verified by unit tests that call `runQuery` directly, and
        // dropped here — so the live call returned zero matches with no error. `query-forwarding.test.ts`
        // now asserts the payload, because a comment is not a guard.
        attrs: args['attrs'],
        self: args['self'],
      }).then((result) =>
        withSizeCost(
          paginateQueryResult(result, asNumber(args['limit']), true === args['count_only']),
        ),
      );
    },
  },
  {
    name: ReticleTool.INSPECT,
    example: { ref: 'e42' },
    description:
      'Deep info on one element by ref: full a11y props, visibility, box, and (with @reticlehq/react) component stack + source file.',
    inputSchema: {
      ref: z
        .string()
        .describe(
          `Element ref (e.g. 'e42') from reticle_snapshot/reticle_query — stable until the element leaves the DOM, so no re-snapshot between actions.`,
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      ref: z.string(),
      role: z.string(),
      name: z.string(),
      value: z.string().optional(),
      states: z.array(z.string()),
      visible: z.boolean(),
      box: z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .optional(),
      // True when another element covers this one's center (z-index/overlay bug — unclickable).
      occluded: z.boolean().optional(),
      // Computed style the a11y tree omits: cursor/display/visibility/color so a "present but
      // unusable" UI bug (dead cursor, invisible, recolored) is observable in one inspect.
      styles: z
        .object({
          color: z.string(),
          backgroundColor: z.string(),
          opacity: z.string(),
          cursor: z.string(),
          display: z.string(),
          visibility: z.string(),
        })
        .partial()
        .optional(),
      scroll: z
        .object({
          scrollTop: z.number(),
          scrollHeight: z.number(),
          clientHeight: z.number(),
          overflowY: z.string(),
        })
        .optional(),
      // Theme compliance vs the app's design tokens: { colorToken, colorTokens, backgroundToken,
      // backgroundTokens, offTheme, tokenCount, themeScope }. The plural fields carry EVERY token
      // matching the resolved colour; the singular ones abstain (null) when several tokens share it,
      // because returning an arbitrary winner was the defect (#313). `themeScope` names the theme
      // that was active at capture, so two inspects minutes apart are comparable at all.
      // Kept as unknown — the structured-content serializer can truncate a large inspect payload's
      // fields to strings, which a strict shape would reject; the full object is always present in
      // the text content the agent reads.
      theme: z.unknown().optional(),
      /**
       * Where this element is written, as `file:line`. Present when the app is built with the
       * Reticle build plugin in dev; absent in production builds.
       */
      source: z.string().optional(),
      /**
       * Why `source` is missing, when it is.
       *
       * Distinguishes "this element has no stamp" from "nothing on this page has one, so the
       * stamping loader is not running" — the second means `file:line` is unavailable for the
       * whole session and the fix is a build-config change, which used to be discoverable only by
       * reading the adapter's own source.
       */
      sourceUnavailable: z.string().optional(),
      /**
       * Component identity from the framework adapter (@reticlehq/react).
       *
       * Declared to match what the handler actually returns. It previously declared
       * `{ name, sourceFile }` while the runtime returned `{ componentStack, source }` — the SDK
       * passes structured content through, so the real shape won and the declaration was simply
       * wrong. An agent reads this schema to decide what to ask for, which makes a wrong schema worse
       * than a missing one.
       */
      component: z
        .object({
          componentStack: z.array(z.string()).optional(),
          source: z
            .object({ file: z.string(), line: z.number(), column: z.number().optional() })
            .optional(),
        })
        .optional(),
    },
    handler: (deps, args) =>
      commandOrThrow(deps, asString(args['sessionId']), ReticleCommand.INSPECT, {
        ref: args['ref'],
      }),
  },
  // reticle_capabilities (live | fromDisk) + reticle_contract_save. See contract-tools.ts.
  ...RECONCILE_TOOLS,
  ...CONTRACT_TOOLS,
  ...INTENT_TOOLS,
  ...CONTEXT_TOOLS,
  ...DOMAIN_TOOLS,
  // reticle_flow_save / reticle_flow_list / reticle_flow_load. See flow-tools.ts.
  ...FLOW_TOOLS,
  // reticle_project (read history + diff-vs-last) / reticle_run_record. See project-tools.ts.
  ...PROJECT_TOOLS,
  ...MEMORY_TOOLS,
  // reticle_run_export — export the verification-run verdict artifact (.reticle/runs/). See run-tools.ts.
  ...RUN_TOOLS,
  // reticle_screenshot / reticle_visual_diff — opt-in, CDP-driven. See visual-tools.ts.
  ...VISUAL_TOOLS,
  ...NETWORK_MOCK_TOOLS,
  ...VIEWPORT_TOOLS,
  // reticle_crawl — autonomous click-everything + anomaly report. See crawl-tools.ts.
  ...CRAWL_TOOLS,
  // reticle_nav_smoke — one-shot primary-nav smoke table. See nav-smoke-tools.ts.
  ...NAV_SMOKE_TOOLS,
  // reticle_scroll_to — reveal a virtualized off-screen row. See scroll-tools.ts.
  ...SCROLL_TOOLS,
  // Session lifecycle: reticle_session — tune the presenter session (idle-end). See session-tools.ts.
  ...SESSION_TOOLS,
  // reticle_annotate (structured annotation → expect/dynamic/success). See annotate-tools.ts.
  ...ANNOTATE_TOOLS,
  // reticle_affected — which saved flows a diff invalidates. Unadvertised (zero per-turn cost),
  // reachable through reticle_run. See affected-tools.ts.
  ...AFFECTED_TOOLS,
  // reticle_coverage — which controls were driven vs never touched. Unadvertised; via reticle_run.
  // The table is passed as a thunk so the coverage tool can report which of it was called without
  // importing it back — see buildCoverageTools. Called from the handler, long after TOOLS exists.
  ...buildCoverageTools(() => TOOLS.map((t) => t.name)),
  // reticle_verify_change — "did my change break anything" in one call. See verify-change-tools.ts.
  ...VERIFY_CHANGE_TOOLS,
  // Live-control: reticle_end_session / reticle_resume / reticle_messages. See live-control-tools.ts.
  ...LIVE_CONTROL_TOOLS,
  // reticle_navigate / reticle_refresh — browser navigation tools. See browser-tools.ts.
  ...BROWSER_TOOLS,
  ...ACT_TOOLS,
  ...OBSERVE_TOOLS,
  ...READ_TOOLS,
  ...LEASE_TOOLS,
  // reticle_feedback — the agent reports that RETICLE failed (not that the app did). See feedback-tools.ts.
  ...FEEDBACK_TOOLS,
];

/**
 * surface consolidation. Tool defs are re-sent EVERY turn, so the advertised count is a per-turn
 * tax multiplied by loop length. Sibling families collapse into one action-dispatched tool; the member
 * handlers stay defined above and are simply no longer advertised separately.
 *
 * Guardrail (from the plan): the 12-tool core hot-set keeps its EXACT names and shapes and is never
 * merged — sessions/navigate/snapshot/query/act/act_and_wait/observe/network/console/wait_for/assert/state.
 */
export const MERGE_PLANS: MergePlan[] = [
  {
    name: ReticleTool.BASELINE,
    description:
      'Semantic-state baselines: { action: "save" } snapshots the current state under a name, "list" returns saved names, "diff" compares the live page against a saved baseline (REMOVED/ADDED elements + console-error count).',
    members: {
      save: ReticleTool.BASELINE_SAVE,
      list: ReticleTool.BASELINE_LIST,
      diff: ReticleTool.DIFF,
    },
  },
  {
    name: ReticleTool.RECORD,
    description:
      'Timeline recording: { action: "start" } begins recording under a name, "stop" ends it and returns the reaction report plus a compiled replayable program.',
    members: { start: ReticleTool.RECORD_START, stop: ReticleTool.RECORD_STOP },
  },
  {
    name: ReticleTool.FLOW,
    description:
      'Saved-flow management: { action: "list" } names every saved flow, "load" reads+validates one by flowName, "delete" removes one. The hot verbs (flow_save, flow_replay, flow_heal) stay separate; whole-suite replay is reticle_verify { action: "flows" }.',
    members: {
      list: ReticleTool.FLOW_LIST,
      load: ReticleTool.FLOW_LOAD,
      delete: ReticleTool.FLOW_DELETE,
    },
  },
  {
    name: ReticleTool.SESSION,
    description:
      'Session lifecycle and the human channel, by action: "tune" adjusts the presenter session (e.g. idle-end window); "yield" hands control back to the human between turns (mode: waiting|ask) and is MANDATORY before you stop driving; "end" terminates the session for good; "resume" clears a human pause; "messages" drains the human→agent inbox; "review" lists/resolves the mistakes a human pinned to elements; "narrate" states your intent on the presenter HUD.',
    members: {
      tune: ReticleTool.SESSION_TUNE,
      yield: ReticleTool.YIELD,
      end: ReticleTool.END_SESSION,
      resume: ReticleTool.RESUME,
      messages: ReticleTool.MESSAGES,
      review: ReticleTool.REVIEW,
      narrate: ReticleTool.NARRATE,
    },
    // The handback the lease block orders on every session — the one call an agent MUST make, so it
    // is the one that must not need a schema lookup first.
    example: { action: 'yield', mode: 'waiting' },
  },
  {
    name: ReticleTool.VERIFY,
    description:
      'What is proved, and what is not — by action. Start from a change: { action: "affected" } names which saved flows must re-verify for the files you edited (pass `files`, and/or `since` for a git ref), and "change" goes further and actually replays them, answering with one `verified` plus `because`. `unknown` there is the honest answer when NO saved flow covers the change: nothing ran, so nothing was proved, and it is never reported as green. Without a change to start from: "flows" replays every saved flow for one consolidated suite verdict (deterministic, no LLM per flow), and "coverage" lists the interactive controls you have and have NOT driven this session — an untouched list still holding the controls your change affects means you are not done. "nav_smoke" walks primary nav links (default: inside `nav`) and returns one table per route with `renderedWithoutConsoleErrors` — that is "no new console errors in the settle window", NOT "the route works". "crawl" is the no-script option: it drives every reachable control itself and reports single-channel faults (console errors, failed requests, dead controls) and CONTRADICTIONS, two channels disagreeing about the same click — the false greens a human cannot see, because a human watches the screen and the screen looks correct. DESTRUCTIVE: crawl and nav_smoke really click, and may navigate or mutate state.',
    members: {
      change: ReticleTool.VERIFY_CHANGE,
      flows: ReticleTool.FLOW_VERIFY,
      affected: ReticleTool.AFFECTED,
      coverage: ReticleTool.COVERAGE,
      crawl: ReticleTool.CRAWL,
      nav_smoke: ReticleTool.NAV_SMOKE,
    },
    // No default action ON PURPOSE. The name implies no single member, and one of them really
    // clicks: a fallthrough that guessed wrong would drive the app rather than read it. Every action
    // is explicit, which for `crawl` is the whole safety story.
    example: { action: 'change', files: ['src/App.tsx'] },
  },
  {
    name: ReticleTool.LEASE,
    description:
      'Isolated headless contexts from the shared pool: { action: "acquire" } leases one and navigates it to the app URL, "release" closes it and frees the slot.',
    members: { acquire: ReticleTool.LEASE_ACQUIRE, release: ReticleTool.LEASE_RELEASE },
  },
];

/**
 * Retired from the MCP surface entirely (capability preserved elsewhere, per the plan):
 * - run_record: auto-recording on flow_replay already persists run outcomes.
 */
export const RETIRED_FROM_SURFACE: string[] = [
  ReticleTool.RUN_RECORD, // auto-recording on flow_replay already persists run outcomes
  ReticleTool.REFRESH, // absorbed into reticle_navigate { reload: true }
  ReticleTool.WAIT_READY, // server-internal: the first live call already blocks for the session
];

/**
 * An empty `interactive` tree is a claim, and it is usually the wrong one.
 *
 * `mode:"interactive"` filters on ARIA role, and a large share of production UI carries none. On
 * MarkText — a shipped Electron editor — it returns NOTHING while `mode:"full"` returns 47 nodes,
 * because its whole block picker is `<div>`s with no role, no testid and no pointer cursor. This
 * tool's own description recommends the lean mode, so an agent takes the cheap look, is handed `""`,
 * and reads it as an empty page. It is the one shape of answer this product must never invent.
 *
 * The browser counts what leanness passed over, so the tool can say which of the two it is.
 */
function noteEmptyLeanTree(result: unknown, mode: string): unknown {
  if (SnapshotMode.INTERACTIVE !== mode) return result;
  const row = asRecord(result);
  if (0 !== asNumber(row['nodes'])) return result;
  const skipped = asNumber(row['leanSkipped']) ?? 0;
  if (0 === skipped) return result;
  return {
    ...row,
    note:
      `no element on this page carries an interactive ARIA role, so this mode found nothing — ` +
      `${String(skipped)} element(s) were passed over for leanness and this is NOT an empty page. ` +
      `Take reticle_snapshot { mode: "full" } instead; the controls here are addressed by text or ` +
      `by testid rather than by role.`,
  };
}

/**
 * An empty tree on a page full of elements is the same claim, from the other cause.
 *
 * `noteEmptyLeanTree` covers leanness and returns early for every other mode, so a `full` snapshot
 * that comes back `{ tree: "", nodes: 0 }` says nothing at all — and that is the shape #672 was
 * reported as: 44 buttons and 12 textboxes on the page, every one computing hidden, both modes
 * empty. The reporter spent about six tool calls and a large console dump establishing the page was
 * fine and the snapshot was wrong, then drove the flow off `reticle_query` refs, which is a
 * workaround no tool description mentions.
 *
 * So the note names the count, says plainly that this is not an empty page, and hands over the path
 * that does work. It does NOT diagnose why the page is hidden: the walk knows what it skipped and
 * cannot know why, and a note that guessed would be the same kind of overconfident answer as the
 * empty tree it replaces.
 */
function noteHiddenPage(result: unknown, mode: string): unknown {
  if (SnapshotMode.STATUS === mode) return result;
  const row = asRecord(result);
  if (0 !== asNumber(row['nodes'])) return result;
  // A note already there is the more specific one (leanness), and two explanations for one empty
  // tree is worse than the better of them alone.
  if (row['note'] !== undefined) return result;
  const skipped = asNumber(row['hiddenSkipped']) ?? 0;
  if (0 === skipped) return result;
  return {
    ...row,
    note:
      `this is NOT an empty page: ${String(skipped)} subtree(s) were skipped because their root ` +
      `computed hidden (aria-hidden, the hidden attribute, or display:none), which is what left the ` +
      `tree empty. If the page is plainly rendered, the visibility computation is the thing that is ` +
      `wrong rather than the app — drive it by reticle_query refs, which do not depend on this walk.`,
  };
}

export const TOOLS: ToolDef[] = applyMerges(RAW_TOOLS, MERGE_PLANS, RETIRED_FROM_SURFACE);
