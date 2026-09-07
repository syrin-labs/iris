import { z } from 'zod';
import {
  ActionType,
  AnchorKind,
  type DriftReason,
  FLOW_FILE_VERSION,
  type HealStatus,
  type ReplayStatus,
} from './constants.js';

/**
 * The MCP tool names that can appear as a recorded flow step's `tool`. These are the ONLY tool names
 * that cross the wire into a persisted flow file — the browser recorder stamps them, the server replays
 * them, and FlowStep types them — so they live in core, the wire contract. The full agent-facing tool
 * surface stays server-side (ReticleTool); ReticleTool references THESE for the flow-persisted three, so
 * there is one source of truth and a rename cannot silently desync the recorder from the replayer (a
 * tool rename once killed four e2e specs — this closes the browser/server half of that drift).
 */
export const FlowStepTool = {
  ACT: 'reticle_act',
  ACT_SEQUENCE: 'reticle_act_sequence',
  ACT_AND_WAIT: 'reticle_act_and_wait',
} as const;
export type FlowStepTool = (typeof FlowStepTool)[keyof typeof FlowStepTool];

/**
 * A semantic anchor: how a step re-finds its element/event at replay
 * time. Never a volatile eXX ref. testid/role+name bind a DOM element; signal binds an event.
 */
export const FlowAnchorSchema = z.discriminatedUnion('kind', [
  // `source` is provenance, not part of how the step re-finds its element — the testid does that.
  // It rides along so a failure can say which file to open; optional, so existing flow files parse
  // unchanged and FLOW_FILE_VERSION does not move.
  z.object({
    kind: z.literal(AnchorKind.TESTID),
    value: z.string().min(1),
    source: z
      .object({ file: z.string(), line: z.number(), column: z.number().optional() })
      .optional(),
  }),
  z.object({
    kind: z.literal(AnchorKind.ROLE),
    role: z.string().min(1),
    name: z.string().optional(),
  }),
  z.object({ kind: z.literal(AnchorKind.SIGNAL), name: z.string().min(1) }),
  // Auto-anchor: re-find an element by component identity / source location when it has no testid.
  // component or source carries the durable signal; role/name are disambiguating extras.
  z.object({
    kind: z.literal(AnchorKind.COMPONENT),
    component: z.string().optional(),
    source: z
      .object({ file: z.string(), line: z.number(), column: z.number().optional() })
      .optional(),
    role: z.string().optional(),
    name: z.string().optional(),
  }),
]);
export type FlowAnchor = z.infer<typeof FlowAnchorSchema>;

/**
 * A post-condition a step asserts (compiled from a structured annotation; optional).
 *
 * Strict, at every nesting level: an unrecognized key (a typo, or a predicate kind this schema
 * doesn't model, e.g. `allOf`, or a typo'd `net`/`console`/`element`/`state` sub-field) must fail
 * to parse instead of being silently dropped. A loose z.object() here would quietly discard the
 * extra key and leave the step with a weaker (or empty) assertion than its author wrote — the
 * flow then replays green against nothing, having proved no real regression.
 */
export const FlowExpectSchema = z
  .object({
    signal: z.string().optional(),
    /**
     * Optional payload shape an `assert-signal` annotation requires the signal
     * to match (the predicate DSL's signal.dataMatches). Additive/optional — a flow file with a
     * bare `signal` still parses, and the on-disk version stays FLOW_FILE_VERSION 1.
     */
    signalData: z.record(z.unknown()).optional(),
    /**
     * Exact number of times the signal must have fired — the signal-side twin of `net.count`, and the
     * only way a saved flow can keep a cardinality the agent actually asserted. Without it a
     * `count: 1` drive would be recorded as bare presence, which is a strictly WEAKER claim than the
     * one made: the replayed flow then goes green on the double-fire it was recorded to catch.
     * Additive/optional — a flow file with a bare `signal` still parses, and FLOW_FILE_VERSION stays 1.
     */
    signalCount: z.number().int().nonnegative().optional(),
    net: z
      .object({
        method: z.string().optional(),
        urlContains: z.string().optional(),
        status: z.number().optional(),
        /**
         * Exact number of matching requests since the action — turns presence into a cardinality
         * assertion. Catches the double-submit / useEffect-double-fire / retry-storm regression class:
         * the request fired (presence passes) but fired the WRONG number of times. Omit = presence (≥1).
         */
        count: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    /**
     * Console golden end-condition: assert the action logged (or, with absent:true, did NOT log) a
     * console message at `level` (default 'error'). `absent:true` is the common case — "the action
     * completed with a clean console" — catching the regression where an action throws a caught error
     * / logs an uncaught rejection while the UI still renders fine (a presence check passes it).
     */
    console: z
      .object({
        level: z.string().optional(),
        absent: z.boolean().optional(),
      })
      .strict()
      .optional(),
    element: z
      .object({
        testid: z.string().optional(),
        role: z.string().optional(),
        name: z.string().optional(),
      })
      .strict()
      .optional(),
    /**
     * Assert a registered store's value — the source of truth no DOM/network read can reach. Compiles
     * to the predicate engine's `state` predicate. Additive/optional — a flow without it still parses
     * and the on-disk version stays FLOW_FILE_VERSION 1. `equals` accepts a literal, omitted = presence,
     * or a `{ $gte | $contains | $length }` operator pattern.
     */
    state: z
      .object({
        store: z.string().optional(),
        path: z.string(),
        equals: z.unknown().optional(),
        /**
         * Treat this as an INVARIANT that must still hold AFTER the action settles, rather than a
         * condition to wait for. Set it for a blast-radius check ("this unrelated path must NOT have
         * moved") — without it a wait-until-true read passes before an over-reaching side-effect lands.
         */
        hold: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type FlowExpect = z.infer<typeof FlowExpectSchema>;

/** One step of a flow: an anchored action (+ optional expectation). */
export interface FlowStep {
  /** FlowStepTool.ACT | FlowStepTool.ACT_SEQUENCE (core, shared with ReticleTool). */
  tool: string;
  anchor: FlowAnchor;
  action?: ActionType;
  args?: Record<string, unknown>;
  expect?: FlowExpect;
  /** true when the anchor is best-effort (no testid was resolvable at record time). NOT dropped. */
  degraded?: boolean;
  /** sub-steps for an act_sequence, each independently anchored. */
  steps?: FlowStep[];
}

const baseFlowStep = z.object({
  tool: z.string(),
  anchor: FlowAnchorSchema,
  action: z.nativeEnum(ActionType).optional(),
  args: z.record(z.unknown()).optional(),
  expect: FlowExpectSchema.optional(),
  degraded: z.boolean().optional(),
});

export const FlowStepSchema: z.ZodType<FlowStep> = baseFlowStep.extend({
  steps: z.lazy(() => z.array(FlowStepSchema).optional()),
}) as z.ZodType<FlowStep>;

/**
 * A legible-drift record returned when an anchor misses at replay.
 * The "whose fault is it" payload: what was expected, why it's gone, and the closest surviving
 * anchor (a concrete fix suggestion). Never a bare "command failed".
 */
export interface Drift {
  /** Named reason kind (testid not found / signal not observed). */
  reasonKind: DriftReason;
  /** Human sentence, e.g. `testid "chat-send" not found`. */
  reason: string;
  /** The missed anchor value (the testid string, or the signal name). */
  anchor: string;
  /** Closest present testid via the live near-miss; null only when the page has no testids (or signal drift). */
  nearest: string | null;
  /**
   * True when two or more present testids tie at the minimum edit distance, so `nearest` is an
   * arbitrary pick. An ambiguous drift is NEVER auto-healed (a wrong rebind ships a bug green) —
   * it is surfaced for a human/agent to choose. Absent ⇒ unambiguous.
   */
  ambiguous?: boolean;
}

/** The per-step result of re-resolving + running one anchored step. */
export interface FlowStepResult {
  /** 0-based index of this step in the flow. */
  step: number;
  /** The tool the step runs — FlowStepTool.ACT | ACT_SEQUENCE (core). */
  tool: string;
  /** The testid/signal value the step is bound to (the re-resolved anchor). */
  anchor: string;
  /**
   * The route (pathname) the page was on when this step ran — the "which page" of the journey.
   * Additive/optional: present when a route is observable, absent in route-less contexts (e.g. a
   * fake session with no route events). Lets a replay result read as a page-by-page journey.
   */
  page?: string;
  /**
   * A compact summary of the observable CONSEQUENCE in the window right after this step ran — the
   * "what happened" of the journey: a route change, a domain signal (e.g. a modal opening), a
   * network call, or console errors. Additive/optional and intentionally terse (token-cheap). It
   * captures what had landed by the time the action settled, so a very-late async effect may not
   * appear; the asserted consequence (expect/success) is the authoritative pass/fail signal.
   */
  consequence?: string;
  /**
   * Wall-clock ms this step took (dispatch → post-settle), from the session's injected elapsed clock.
   * Additive/optional: absent in contexts with no advancing clock. Feeds per-step run-to-run perf diffs.
   */
  durationMs?: number;
  ok: boolean;
  error?: string;
  note?: string;
  /** Present iff this step stopped on an anchor miss. */
  drift?: Drift;
  /**
   * A confidence-scored nearest-match rebind for this drifted step (additive,
   * optional). Set only for a confident testid drift.
   */
  proposal?: HealProposal;
}

/**
 * The autonomy decision envelope — the feedback a human used to give, made machine-actionable. From
 * a replay result it states the verdict, what changed, WHERE in the source to look (file:line, from a
 * component anchor), a suggested fix, and the single next action — so a coding agent decides its next
 * move without a human in the loop. Terse by design (token-cheap).
 */
export interface ReplayDecision {
  /** pass = intent held; drift = a locator/anchor missed; fail = an action or the success oracle failed. */
  verdict: 'pass' | 'drift' | 'fail';
  /** One-line human/agent summary of the outcome. */
  summary: string;
  /** What regressed (the drift reason or failure), when not a pass. */
  whatChanged?: string;
  /** Where to look — `file:line` from the failing step's source anchor, or the page route. */
  whereInSource?: string;
  /** A concrete fix hint (e.g. rebind to the nearest surviving anchor). */
  suggestedFix?: string;
  /** The single next action the agent should take. */
  nextAction: string;
}

/**
 * One flow's line in a suite verdict — pass counts as a name; a failure carries the actionable
 * decision fields so the agent can fix it without re-querying.
 */
export interface SuiteFlowResult {
  flow: string;
  /**
   * The flow never ran: its file failed to load, or its leased context never came up. Nothing was
   * learned about the app, so this row is not a regression — it is Reticle reporting its own failure
   * in the same array as the app's. Measured: one sweep emitted 8 `flow-regression` bug_found events
   * off rows like these, from a suite where no flow ever executed.
   */
  couldNotRun?: boolean;
  verdict: 'pass' | 'drift' | 'fail';
  whatChanged?: string;
  whereInSource?: string;
  nextAction?: string;
}

/**
 * The consolidated verdict of replaying EVERY known flow — the autonomous loop's "did I break
 * anything, and what do I fix" answer in one deterministic call. Passing flows are counted; only
 * failures carry detail (token-cheap). `status` is fail if any flow drifted or errored.
 */
export interface SuiteVerdict {
  /**
   * `unverifiable` means the suite contained flows that CANNOT FAIL, so "pass" would be a lie.
   *
   * A recorded flow with no steps, or one that asserts no observable consequence, replays green no
   * matter what the app does. Reporting `pass` for it is a false green in the exact feature sold as
   * the regression suite — measured: a flow saved as `{steps: [], intent: "..."}`, which `flow_save`
   * had ALREADY graded assertion-free with a warning, came back "all 1 flow pass".
   */
  status: 'pass' | 'fail' | 'unverifiable';
  total: number;
  passed: number;
  failed: number;
  summary: string;
  /** Only the failing flows, with their decision (verdict, what changed, where, next action). */
  failures: SuiteFlowResult[];
  /**
   * Flows that replayed without error but assert nothing, so their green means nothing. Counted
   * apart from `passed` — a number that includes them is not a count of anything verified.
   */
  unverifiable?: { flow: string; reason: string }[];
  /**
   * Flows that have both passed AND failed on UNCHANGED code — intermittent, not regressions.
   *
   * A flake and a regression demand opposite responses: one is chased, the other is quarantined. The
   * ledger that answers this already existed and was written only by the CLI, so an agent replaying a
   * suite a hundred times could never learn which of its failures were noise. Omitted entirely when
   * the ledger has not seen enough runs to say.
   */
  flaky?: string[];
}

/** The reticle_flow_replay envelope. */
export interface FlowReplayResult {
  name: string;
  status: ReplayStatus;
  steps: FlowStepResult[];
  /** The machine-actionable decision derived from this replay (autonomy layer). */
  decision?: ReplayDecision;
  /** Set when status === 'error' (load failure or resolved action failure). */
  error?: { code: string; message: string };
  /**
   * Set on an `ok` replay whose flow cannot fail: it asserts no observable consequence, or has no
   * steps at all. The replay genuinely completed, so the status stays `ok` — but a bare `ok` read
   * as proof the feature works is exactly the false confidence `flow-risk.ts` argues against, and
   * `reticle_flow_verify` already refuses to count these as passes. This carries the same reason,
   * from the same function, to the single-flow caller who would otherwise never see it.
   */
  unverifiable?: { reason: string };
  /**
   * The confident rebind proposals aggregated across drifted steps (additive,
   * optional — present only when at least one drifted step has a confident nearest match).
   */
  proposals?: HealProposal[];
  /**
   * The push-default deviation report over this replay's route segments (ranked deviations vs the learned
   * envelope, or a fall-back note below N=3 runs). Additive; present when segments were observed.
   */
  deviation?: unknown;
  /**
   * What the project already knows about this flow, fetched from shared memory on the agent's
   * behalf.
   *
   * Present only when the project is linked, memory sync is on, and the team has actually captured
   * something about this flow. Consulting shared memory used to be a separate act an agent had to
   * remember to perform — measured across a real corpus, every subject showed zero reads, not
   * because the knowledge was useless but because nothing ever asked for it. A verification that
   * asks on the agent's behalf is the difference between memory the platform stores and memory the
   * platform uses.
   *
   * Deliberately additive and deliberately small: a verdict whose own result has been pushed below
   * a wall of statements is a worse verdict.
   */
  knows?: { statement: string; status: string }[];
}

/**
 * The on-disk flow file: diffable, git-tracked, anchor-resolved.
 * The optional `dynamic` field (both `dynamic` + `success` are optional, so a
 * file with neither still parses — back-compat is locked by a test).
 */
export const FlowFileSchema = z.object({
  version: z.literal(FLOW_FILE_VERSION),
  name: z.string(),
  /**
   * The business goal this flow exists to verify, one line (e.g. "ship a deploy to production").
   * Optional + back-compat (a flow without it still parses). Set via an `intent` annotation. The
   * point of "intent + outcome oracle": a flow that declares an intent should also assert an
   * observable business OUTCOME (a consequence success-state), or it claims to verify a goal it
   * cannot actually check — flow-classify flags that gap.
   */
  intent: z.string().optional(),
  /**
   * The intent-ledger row this flow discharges — the id in `.reticle/intent.json`.
   *
   * `intent` above is the prose a recorder captured; this is the LINK to the ledger that already
   * models declared → bound → proved and records which verdict discharged what. Without it there
   * would be two ways to say what a change is for, which is the defect this codebase keeps paying
   * for: a flow's goal and an intent's statement would drift apart with nothing to reconcile them.
   *
   * Set at save time from the flow's own prose, or written by hand to point a flow at an intent
   * declared earlier via `reticle_intent` — a flow can prove something somebody else declared.
   * Optional + back-compat: a flow without it replays exactly as before, and the on-disk version
   * stays FLOW_FILE_VERSION 1.
   */
  intentId: z.string().optional(),
  /**
   * The project the flow was recorded against (the connecting session's HELLO `projectId`), stamped at
   * save time. Scopes a flow to its app so a shared daemon's HUD lists only the current project's flows
   * instead of every project that ever saved to that daemon. Optional + back-compat: a flow with no
   * projectId is treated as global (visible everywhere), so pre-existing files parse and still show.
   */
  projectId: z.string().optional(),
  /**
   * The route (pathname) the journey started on, captured at record time. Replay navigates here
   * before step 1 so a flow whose first anchor lives on another page doesn't drift on step 1 ("a
   * step no longer matches") just because replay began on the wrong page. Optional + back-compat: a
   * flow without it (or recorded before this shipped) replays from the current page as before, and
   * the on-disk version stays FLOW_FILE_VERSION 1.
   */
  startPath: z.string().optional(),
  // FUTURE: fixtures/preconditions — schema slot reserved, unpopulated this cut. The recorder
  // never writes it and no fixture runner exists.
  fixture: z.string().optional(),
  /** From the injected clock (ms) — deterministic in tests, byte-stable on disk. */
  createdAt: z.number(),
  steps: z.array(FlowStepSchema),
  success: FlowExpectSchema.optional(),
  /**
   * Anchors whose CONTENT must not be asserted (e.g. LLM output). Replay asserts
   * presence, not words. Compiled from a `mark-dynamic` annotation.
   */
  dynamic: z.array(FlowAnchorSchema).optional(),
});
export type FlowFile = z.infer<typeof FlowFileSchema>;

/**
 * The in-page → wire payload for a finished human recording. The browser
 * compiles captured interactions into a FlowFile-shaped object (resolving semantic anchors at
 * capture time) and emits it as ONE EventType.FLOW_RECORDED event; the server persists it.
 */
export const RecordedFlowSchema = z.object({
  name: z.string(),
  flow: FlowFileSchema,
});

/** A concrete, confidence-scored rebind proposed for one drifted step. */
export interface HealProposal {
  /** 0-based step index in the flow. */
  step: number;
  /** Old (missing) testid anchor value. */
  from: string;
  /** Proposed nearest present testid. */
  to: string;
  /** Normalized (0,1]; >= HEAL_CONFIDENCE_MIN to be applicable. */
  confidence: number;
}

/** One applied rebind (a HealProposal that was written to disk). */
export interface HealChange {
  step: number;
  from: string;
  to: string;
}

/** The reticle_flow_heal envelope. */
export interface FlowHealResult {
  name: string;
  status: HealStatus;
  /** Whether the file was rewritten (true only when status === 'healed'). */
  applied: boolean;
  /** Confident, applicable rebinds. With apply:false these are the dry-run diff. */
  proposals: HealProposal[];
  /** Anchors actually written (empty unless applied). */
  changed: HealChange[];
  /** Human one-liner for the agent (e.g. "nothing to heal", floor explanation). */
  message: string;
  error?: { code: string; message: string };
}

export type RecordedFlow = z.infer<typeof RecordedFlowSchema>;

/**
 * One replayable-flow chip on the in-page HUD.
 *
 * Crosses the bridge: the daemon builds these from the flows on disk and pushes them with
 * `ReticleCommand.FLOWS`; the presenter panel renders one ▶ button per chip. It lived as two
 * identical `interface FlowChip` declarations — one in the server, one in the browser — which is the
 * shape that drifts silently, because nothing links the two and no test crosses the boundary.
 *
 * A TYPE and not a zod schema on purpose: the browser SDK ships into the user's app and carries no
 * zod, so the receiving side narrows the raw wire value by hand. The type is what both ends agree on.
 */
export interface FlowChip {
  name: string;
  /** The testid the flow's first step anchors to, when it has one — the panel hides chips that cannot start on the current page. */
  start?: string;
}
