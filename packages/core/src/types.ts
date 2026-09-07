import type { Ref } from './brand.js';
import { z } from 'zod';
import {
  AnnotationKind,
  type AnnotationErrorCode,
  type AnnotationTarget,
  CONTRACT_FILE_VERSION,
  ElementState,
  QueryBy,
  RunKind,
  RunStatus,
} from './constants.js';
import { PROJECT_FILE_VERSION } from './flow-constants.js';
import { RiskSurface } from './verification-run.js';
import type { FlowExpect } from './flow-types.js';

/**
 * A query describing which element(s) to find, Testing-Library style.
 *
 * Strict, for the same reason the predicate union that wraps it is: a key nobody spells is a schema
 * error naming the key, never a stripped field. Reported from the field —
 * `{ kind: 'element', query: { css: "a[href='…']" } }` parsed, `css` was dropped, the empty query
 * that survived matched nothing, and the verdict read "no element matched {}" about an element that
 * was on the page. A stripped locator here is a false RED, and an agent that believes it goes and
 * "fixes" correct code.
 */
export const ElementQuerySchema = z
  .object({
    by: z.nativeEnum(QueryBy).optional(),
    value: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    testid: z.string().optional(),
    alt: z.string().optional(),
    /** Component display name (auto-anchor resolution). The nearest enclosing component of the target. */
    component: z.string().optional(),
    /**
     * Attribute names to project onto each match (e.g. `['href']` to inventory links, `['src']` for
     * images). Without this the descriptor carries only semantics, so URLs are unreachable.
     */
    attrs: z.array(z.string()).optional(),
    /** Source location of the target element (auto-anchor resolution) — the precise, granular match. */
    source: z
      .object({ file: z.string(), line: z.number(), column: z.number().optional() })
      .strict()
      .optional(),
    /** CSS selector or ref to scope the search. */
    scope: z.string().optional(),
    /**
     * Return the `scope` element ITSELF rather than searching inside it. When `text` is also given,
     * the scope root must contain that text across its full subtree.
     *
     * Every other path excludes the scope root by construction, so a layout container with no role,
     * name, testid or text of its own was unreachable — and that is routinely the element carrying the
     * handler. Reported from the field: "click the empty region of this row" is an ordinary user
     * action (dismiss, deselect, close, marquee-select) that could not be expressed at all, and the
     * verification was handed back to the human. Requires `scope`.
     */
    self: z.boolean().optional(),
  })
  .strict();
export type ElementQuery = z.infer<typeof ElementQuerySchema>;

/** Compact semantic descriptor of one element surfaced to the agent. */
export interface ElementDescriptor {
  /** Branded: minted by the browser's ref registry, so it cannot be confused with another id kind. */
  ref: Ref;
  role: string;
  name: string;
  value?: string;
  states: ElementState[];
  visible: boolean;
  text?: string;
  /**
   * Attributes explicitly requested via `ElementQuery.attrs`. Absent attributes are omitted (so
   * "missing" and "present but blank" stay distinguishable) and credential-bearing names are redacted.
   */
  attrs?: Record<string, string>;
  /**
   * Where this element is written, as `file:line` — the nearest `data-reticle-source` stamped by the
   * build plugin in dev. Absent in production builds and in apps that do not use the plugin, so an
   * agent must treat it as a shortcut rather than a guarantee.
   *
   * A compact string rather than `{file, line}` because a descriptor can repeat hundreds of times in
   * one response and every consumer either opens an editor or prints it.
   */
  source?: string;
  /**
   * Chart geometry faults found inside this element — PRESENT ONLY WHEN SOMETHING IS WRONG.
   *
   * A chart is the one dashboard surface where the store and the screen diverge invisibly: every
   * other widget renders text a comparison can read, while a chart renders coordinates that a correct
   * `series` can still turn into a blank or NaN-filled path. Reported on the descriptor rather than
   * behind a new tool so it costs nothing to ask for — the agent already queries the chart element,
   * and a healthy chart adds zero bytes because the field is omitted.
   */
  chart?: ChartFault[];
}

/** One chart geometry fault. `kind` is what an agent branches on; `sample` is bounded for the wire. */
export interface ChartFault {
  kind: 'non-finite-coordinates' | 'empty-geometry' | 'degenerate-geometry';
  tag: string;
  attr: string;
  sample: string;
}

export interface MatchResult {
  matched: boolean;
  count: number;
  elements: ElementDescriptor[];
  /**
   * True when a `scope` was given but resolved to nothing (the container was unmounted or the selector
   * matched no element). The search returns zero matches WITHOUT falling back to the whole page, and
   * this flag says why — so "element absent" and "scope vanished" stay distinguishable. Without it, a
   * scoped assertion silently widened to the body (a phantom positive) or read a gone scope as a
   * confirmed absence (a false negative); both are the false-green shape this tool exists to prevent.
   */
  scopeMissing?: boolean;
  /**
   * Zero-match diagnosis, present only on a miss: what IS on the page. `reticle_query` has always
   * returned this; MATCH (the command every PREDICATE uses) did not, so a failed assertion was a
   * dead end while the same failure through query was one step from fixed.
   */
  hint?: QueryEmptyHint;
}

/**
 * A semantic cluster of interactive elements in the DOM — the replacement for the raw testid list
 * in zero-match hints. Tells the agent "there is a list with 847 rows" rather than 12 opaque IDs.
 */
export interface PresentRegion {
  /** ARIA role of the container element. */
  role: string;
  /** Accessible name of the container, if present. */
  name?: string;
  /** Number of direct role-bearing children in the container. */
  childCount: number;
  /** Up to 3 `role[name]` strings sampled from the first children (for orientation). */
  sample: string[];
}

/** Diagnostic hint attached to a zero-match reticle_query result. */
export interface QueryEmptyHint {
  /** location.pathname + location.search at query time. */
  route: string;
  /** Semantic clusters of the page's interactive regions — the successor to presentTestids. */
  presentRegions: PresentRegion[];
  /** @deprecated Use presentRegions. Kept for one major cycle; removed next major. */
  presentTestids: string[];
  /** True if a capability-registered testid is present in the scope. */
  knownEmptyState: boolean;
  /**
   * Present only when a TEXT search missed and the string is nonetheless on the page, split across
   * this element's children — so no single element's own text carries it and no `by: text` query can
   * ever match it.
   *
   * The descriptor is the tightest container that holds the whole string; its `ref` is a locator, so
   * the recovery is `{ scope: <ref>, self: true }` rather than another guess at the text.
   */
  splitText?: ElementDescriptor;
}

/** Result of the QUERY command / reticle_query tool. `hint` present ONLY on zero matches. */
export interface QueryResult {
  elements: ElementDescriptor[];
  /**
   * How many elements MATCHED, which is not the same as how many are in `elements`.
   *
   * Descriptors are expensive to build and the transport caps collections, so beyond a point matches
   * are counted but not described. Reporting the count separately is what keeps "how many are there?"
   * an exact answer instead of a description of the cap.
   */
  count: number;
  hint?: QueryEmptyHint;
  /** See MatchResult.scopeMissing — a provided scope resolved to nothing; the search did not widen. */
  scopeMissing?: boolean;
}

/** One named flow advertised by the app (mirrors the browser CapabilityFlow). */
export const CapabilityFlowSchema = z.object({
  name: z.string(),
  steps: z.array(z.string()),
});

/**
 * A declared risk zone — the app naming a surface (auth/payment/db/…) and the paths it covers, so a
 * host can gate on it. Shares RiskSurface with the verification-run verdict so a declaration and a
 * detection speak the same vocabulary. ENFORCED LATER — parsed + surfaced now.
 */
export const RiskZoneSchema = z.object({
  surface: z.nativeEnum(RiskSurface),
  paths: z.array(z.string()).optional(),
  note: z.string().optional(),
});

/**
 * Optional governance metadata an app may declare about its testable surface: who owns it, safety
 * invariants, allowed scopes, store paths/selectors to redact, and declared risk zones. All optional
 * and additive — a manifest without any of it stays valid (back-compat). Parsed + surfaced now;
 * enforcement (policy gates, redaction-by-declaration) comes later.
 */
export const ManifestGovernanceSchema = z.object({
  owner: z.string().optional(),
  safety: z.array(z.string()).optional(),
  scope: z.array(z.string()).optional(),
  redact: z.array(z.string()).optional(),
  risk: z.array(RiskZoneSchema).optional(),
});
export type ManifestGovernance = z.infer<typeof ManifestGovernanceSchema>;

/** The app's testable surface — persisted form of the browser Capabilities. */
export const CapabilitiesSchema = z.object({
  testids: z.array(z.string()),
  signals: z.array(z.string()),
  stores: z.array(z.string()),
  flows: z.array(CapabilityFlowSchema),
  /** Optional declared governance (owner/safety/scope/redact/risk). Additive — back-compat safe. */
  governance: ManifestGovernanceSchema.optional(),
});
export type CapabilitiesContract = z.infer<typeof CapabilitiesSchema>;

/** The on-disk contract.json envelope: versioned + timestamped capabilities. */
export const ContractFileSchema = z.object({
  version: z.literal(CONTRACT_FILE_VERSION),
  generatedAt: z.number(),
  capabilities: CapabilitiesSchema,
});

/**
 * Evidence counts captured with a run so the agent can compare runs over time
 * ("console errors went 0→3 since last run"). All optional: a run records only what it observed.
 */
export const RunEvidenceSchema = z.object({
  consoleErrors: z.number().optional(),
  networkErrors: z.number().optional(),
  driftSteps: z.number().optional(),
});

/** One persisted run outcome in .reticle/project.json. */
export const RunRecordSchema = z.object({
  kind: z.nativeEnum(RunKind),
  name: z.string(),
  status: z.nativeEnum(RunStatus),
  at: z.number(),
  summary: z.string().optional(),
  evidence: RunEvidenceSchema.optional(),
  durationMs: z.number().optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** The optional learned map of the app (known flow/route names). */
export const ProjectLearnedSchema = z.object({
  flows: z.array(z.string()).optional(),
  routes: z.array(z.string()).optional(),
  /**
   * The highest observability this project has ever reached — of the controls a session drove, the
   * share Reticle could fully observe.
   *
   * Kept so a LATER run can be told it fell. A coverage figure with no floor under it is one that
   * gets gamed, and the cheapest way to stop a gap firing is to stop asserting the thing that
   * revealed it — so the number and its guard ship together or neither is worth having. Same
   * reasoning as the assertion-tier ledger, which records what a flow asserted the last time it
   * PASSED for exactly this reason.
   *
   * Optional and additive: absent means "no best yet", which is the honest state of every project
   * that predates this field, and is why the file version does not move.
   */
  bestObservability: z.object({ percent: z.number(), at: z.number() }).optional(),
});
export type ProjectLearned = z.infer<typeof ProjectLearnedSchema>;

/** The on-disk project.json envelope: versioned learned-map + chronological runs. */
export const ProjectFileSchema = z.object({
  version: z.literal(PROJECT_FILE_VERSION),
  learned: ProjectLearnedSchema.optional(),
  runs: z.array(RunRecordSchema),
});
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

/**
 * The structured annotation REQUEST a human/agent attaches to the live
 * recording (the server-side `reticle_annotate` tool). A discriminated union over the four shipped
 * AnnotationKind values. Each variant carries exactly the fields its compilation needs.
 *
 * FIRST CUT boundary (do NOT remove): only this structured union is accepted. A free
 * NATURAL-LANGUAGE annotation (e.g. the string "the diff should appear") is REJECTED by this
 * schema — never guessed/compiled into a predicate. Free NL → predicate compilation is explicitly
 * FUTURE; a `safeParse` of a bare string returns success:false, which the tool maps
 * to AnnotationErrorCode.UNKNOWN_KIND. No NL parser exists or is faked here.
 */
export const AnnotationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal(AnnotationKind.ASSERT_SIGNAL),
    name: z.string().min(1),
    dataMatches: z.record(z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal(AnnotationKind.ASSERT_VISIBLE),
    testid: z.string().min(1),
  }),
  z.object({
    kind: z.literal(AnnotationKind.ASSERT_STATE),
    statePath: z.string().min(1),
    store: z.string().min(1).optional(),
    equals: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal(AnnotationKind.ASSERT_NET),
    // Same shape SUCCESS_STATE already accepts, so one vocabulary describes a network consequence
    // whether it gates a step or ends the flow. `count` is the point of it: presence says the
    // request fired, cardinality catches the double-submit that fired it twice.
    net: z.object({
      method: z.string().min(1).optional(),
      urlContains: z.string().min(1).optional(),
      status: z.number().optional(),
      count: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({
    kind: z.literal(AnnotationKind.MARK_DYNAMIC),
    testid: z.string().min(1),
  }),
  z.object({
    kind: z.literal(AnnotationKind.SUCCESS_STATE),
    signal: z.string().min(1).optional(),
    testid: z.string().min(1).optional(),
    // A store-truth golden end-condition: the flow succeeds when this store path holds (e.g. the
    // created deployment actually reached status 'live' in the store, not just on screen).
    statePath: z.string().min(1).optional(),
    store: z.string().min(1).optional(),
    equals: z.unknown().optional(),
    // Treat the statePath as an INVARIANT that must hold AFTER settle (a blast-radius "this unrelated
    // path must not have moved" check), not a condition to wait for.
    hold: z.boolean().optional(),
    // A network-cardinality golden end-condition: the flow succeeds only when EXACTLY `count` matching
    // requests fired (omit count = presence). Catches the double-submit / retry-storm regression class.
    net: z
      .object({
        method: z.string().min(1).optional(),
        urlContains: z.string().min(1).optional(),
        status: z.number().optional(),
        count: z.number().int().nonnegative().optional(),
      })
      .optional(),
    // A console golden end-condition: with absent:true, "the action completed with a clean console"
    // (no message at `level`, default 'error') — catches an action that logs a caught error / rejection
    // while the UI still renders fine.
    console: z
      .object({
        level: z.string().min(1).optional(),
        absent: z.boolean().optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal(AnnotationKind.INTENT),
    text: z.string().min(1),
  }),
]);
export type Annotation = z.infer<typeof AnnotationSchema>;

/**
 * The reticle_annotate result envelope (discriminated on `ok`, never a free
 * string). On success it names the target (step|flow) + the human compiled-predicate text the
 * recorder confirmation strip shows ("will assert signal diff:shown").
 */
export type AnnotateResult =
  | {
      ok: true;
      target: AnnotationTarget;
      compiled: string;
      /**
       * Set when the compiled annotation is NOT something a replay evaluates, so `compiled` on its
       * own would overstate it. `assert-signal` writes a STEP expect, and replay checks exactly two
       * things per step — element presence and state — so a step signal is recorded and then never
       * checked. Saying "will assert signal X" and passing regardless is a false green in the
       * feature whose whole job is to catch them.
       */
      note?: string;
    }
  /**
   * A failure carries its own way out. `code` alone told the caller WHAT was wrong and never what to
   * do, and the recovery hints elsewhere only attach to THROWN messages — a structured `{ ok: false }`
   * got none. So an agent hitting `annotate_no_recording` had no way to learn that a recording has to
   * be started first, and simply stopped annotating.
   */
  | { ok: false; code: AnnotationErrorCode; recovery?: string };

/**
 * The patch a compiled annotation produces. The caller applies it to the
 * AnnotationStore: a step.expect (assert-*), a flow.dynamic[] entry (mark-dynamic), or flow.success
 * (success-state). All optional; exactly the fields the compiled kind needs are set.
 */
export interface AnnotatePatch {
  /** index of the step whose.expect is set (assert-signal / assert-visible). */
  stepIndex?: number;
  stepExpect?: FlowExpect;
  /** the testid pushed into flow.dynamic[] (mark-dynamic). */
  dynamicAdd?: string;
  /** flow.success (success-state). */
  success?: FlowExpect;
  /** flow.intent (intent) — the business goal this flow exists to verify. */
  intent?: string;
}

/** Pure compiler output: the result envelope + (on ok) the patch to apply. */
export interface AnnotateOutcome {
  result: AnnotateResult;
  patch?: AnnotatePatch;
}

export type ContractFile = z.infer<typeof ContractFileSchema>;
export type RunEvidence = z.infer<typeof RunEvidenceSchema>;
export type CapabilityFlow = z.infer<typeof CapabilityFlowSchema>;
export type RiskZone = z.infer<typeof RiskZoneSchema>;
