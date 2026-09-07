/**
 * On-disk artifact constants: the project history, flow files, replay/drift status, the recorder
 * lifecycle, heal outcomes, and the structured-annotation vocabulary. Split out of constants.ts so
 * each file stays one cohesive unit under the size cap; re-exported from constants.ts (and so from
 * the package index) — every existing `@reticlehq/core` import is unchanged.
 */

/**
 * Schema version stamped into project.json so a reader can reject/upgrade old files.
 */
export const PROJECT_FILE_VERSION = 1;

/**
 * Structured outcome when reading project.json fails (never thrown to the agent).
 * Mirrors ContractReadError. NOTE: recordRun self-heals a MALFORMED file (starts fresh) so a
 * corrupt history never wedges the agent; only the READ path (reticle_project) surfaces MALFORMED.
 */
export const ProjectReadError = {
  MISSING: 'project-missing', // no .reticle/project.json on disk
  MALFORMED: 'project-malformed', // present but not valid JSON / fails schema
} as const;
export type ProjectReadError = (typeof ProjectReadError)[keyof typeof ProjectReadError];

/** How a run record was produced. */
export const RunKind = {
  FLOW_REPLAY: 'flow_replay', // auto-recorded by reticle_flow_replay
  MANUAL: 'manual', // explicitly recorded via reticle_run_record
} as const;
export type RunKind = (typeof RunKind)[keyof typeof RunKind];

/**
 * The persisted outcome of a run. Distinct from ReplayStatus (a wire/replay
 * concept of ok|drift|error): RunStatus is the history concept and adds pass/fail. The replay
 * site maps ReplayStatus.OK→PASS, DRIFT→DRIFT, ERROR→ERROR.
 */
export const RunStatus = {
  PASS: 'pass',
  DRIFT: 'drift',
  ERROR: 'error',
  FAIL: 'fail',
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

/**
 * Bounds on project.json so the file stays small + diffable. recordRun keeps the
 * last PER_NAME runs of any single name, then caps the whole list to TOTAL most-recent overall.
 */
export const PROJECT_RUN_CAP = {
  PER_NAME: 50,
  TOTAL: 200,
} as const;

/** Maximum distinct route identities retained in project.json. */
export const PROJECT_ROUTE_CAP = 200;

/** Schema version stamped onto on-disk flow files (.reticle/flows/<name>.json). */
export const FLOW_FILE_VERSION = 1;

/** How a flow step is anchored to the live DOM at replay time (semantic, never a volatile ref). */
export const AnchorKind = {
  TESTID: 'testid', // { kind:'testid', value }
  ROLE: 'role', // { kind:'role', role, name? } — best-effort fallback
  SIGNAL: 'signal', // { kind:'signal', name } — wait/assert anchors
  COMPONENT: 'component', // { kind:'component', component?, source?, role?, name? } — auto-anchor (no testid)
} as const;
export type AnchorKind = (typeof AnchorKind)[keyof typeof AnchorKind];

/**
 * The role marker for a DEGRADED step — one recorded with no resolvable
 * testid. It is kept (never dropped) but a volatile eXX ref is NEVER persisted in its place;
 * the step carries this placeholder ROLE anchor + degraded:true, a legible "add a data-testid
 * here" marker that a human/self-healing pass re-binds. Satisfies the anchor min(1).
 */
export const DEGRADED_ANCHOR_ROLE = 'unresolved';

/** Structured failure codes for flow disk ops (returned, never thrown as free strings). */
export const FlowErrorCode = {
  INVALID_NAME: 'flow_invalid_name', // path traversal / illegal chars
  NOT_FOUND: 'flow_not_found', // load of a missing flow
  PARSE_FAILED: 'flow_parse_failed', // on-disk JSON failed zod validation
  NO_RECORDING: 'flow_no_recording', // save with no compiled program by that name
} as const;
export type FlowErrorCode = (typeof FlowErrorCode)[keyof typeof FlowErrorCode];

/** A flow name must be a single safe path segment (no '/', '\\', '..', leading dot). */
export const FLOW_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/i;

/**
 * The outcome of replaying an on-disk flow by re-resolving its
 * semantic anchors against the live DOM. `drift` (an anchor missed → contract changed) is
 * cleanly separated from `error` (the flow could not load or an action failed) and `ok`.
 */
export const ReplayStatus = {
  OK: 'ok', // every anchor resolved and every step ran green
  DRIFT: 'drift', // an anchor missed (testid renamed / signal not observed) — legible drift returned
  ERROR: 'error', // the flow could not load or a resolved action failed
} as const;
export type ReplayStatus = (typeof ReplayStatus)[keyof typeof ReplayStatus];

/**
 * Why an anchor failed to resolve at replay time (the "whose fault is
 * it" reason kind). Drives the human `reason` sentence and whether a nearest-match is offered.
 */
export const DriftReason = {
  TESTID_NOT_FOUND: 'testid_not_found', // a testid anchor resolved to zero live elements
  SIGNAL_NOT_OBSERVED: 'signal_not_observed', // a signal anchor never fired within the timeout
  COMPONENT_NOT_FOUND: 'component_not_found', // a component/source auto-anchor resolved to zero live elements
  STATE_MISMATCH: 'state_mismatch', // a step's expect.state assertion did not hold against the store
  /**
   * The step carries DEGRADED_ANCHOR_ROLE — no anchor was ever resolvable, so nothing was queried.
   * Distinct from TESTID_NOT_FOUND deliberately: "your element disappeared" and "this step never had
   * an element bound to it" need different fixes, and reporting the second as the first sent heal
   * hunting for the nearest testid to the literal word "unresolved".
   */
  ANCHOR_DEGRADED: 'anchor_degraded',
  /**
   * The step's anchor resolved and its action ran; the testid its `expect.element` names was absent
   * afterwards. Distinct from TESTID_NOT_FOUND for the same reason ANCHOR_DEGRADED is: "the element
   * you clicked is gone" and "the thing you asserted afterwards never appeared" need different
   * fixes, and reporting the second as the first sends the caller looking for a renamed anchor on a
   * step whose anchor was fine.
   */
  EXPECT_ELEMENT_NOT_FOUND: 'expect_element_not_found',
} as const;
export type DriftReason = (typeof DriftReason)[keyof typeof DriftReason];

/** Default timeout (ms) a signal anchor waits to be observed at replay. */
export const FLOW_SIGNAL_TIMEOUT_MS = 4000;

/**
 * The structured annotation kinds a human can attach while recording.
 * FIRST CUT: only these four structured kinds compile to flow fields (via a toolbar menu +
 * a signal <select> drawn from registered capabilities). Free natural-language annotation →
 * predicate compilation is explicitly OUT this cut (no NL parser). `wait-for` / `ignore-region`
 * from the plan grammar are also future — only the four requested kinds ship here.
 */
export const AnnotationKind = {
  ASSERT_SIGNAL: 'assert-signal', // → step.expect.signal (invariant)
  ASSERT_VISIBLE: 'assert-visible', // → step.expect.element (invariant)
  ASSERT_STATE: 'assert-state', // → step.expect.state (store-truth invariant on the last step)
  // → step.expect.net (the request the action must have caused, with an optional exact count).
  // Documented in agent-cheatsheet.md long before it existed: an agent following that advice got
  // `annotate_unknown_kind`, the annotation was dropped, and the flow stayed presence-only — able
  // to pass while broken, which is the failure this whole product is pointed at.
  ASSERT_NET: 'assert-net',
  MARK_DYNAMIC: 'mark-dynamic', // → flow.dynamic[] (don't assert words/content)
  SUCCESS_STATE: 'success-state', // → flow.success (golden end condition)
  INTENT: 'intent', // → flow.intent (the business goal this flow exists to verify)
} as const;
export type AnnotationKind = (typeof AnnotationKind)[keyof typeof AnnotationKind];

/** Recorder lifecycle phases (drives the toolbar UI + the capture gate). */
export const RecorderPhase = {
  IDLE: 'idle', // listeners inert, no steps captured
  RECORDING: 'recording', // capture-phase listeners live
  ANNOTATING: 'annotating', // recording paused, awaiting an annotation target/kind
} as const;
export type RecorderPhase = (typeof RecorderPhase)[keyof typeof RecorderPhase];

/**
 * Structured codes for the recorded-save server tool (returned, never thrown).
 */
export const RecordedSaveError = {
  NO_RECORDED_FLOW: 'flow_no_recorded', // no FLOW_RECORDED event for the session
  INVALID_NAME: 'flow_invalid_name', // reuses FlowErrorCode.INVALID_NAME semantics
} as const;
export type RecordedSaveError = (typeof RecordedSaveError)[keyof typeof RecordedSaveError];

/**
 * Outcome of reticle_flow_heal (distinct from ReplayStatus — adds heal verbs).
 * Rebinds testid anchors only (role/name/signal re-anchoring is future). A confident nearest-match
 * is required before any disk write — the "never silently rewrite" invariant.
 */
export const HealStatus = {
  HEALED: 'healed', // apply:true and >=1 anchor rewritten on disk
  DRIFT: 'drift', // apply:false: confident proposal(s) returned, file untouched
  UNHEALABLE: 'unhealable', // drift exists but no proposal cleared the confidence floor
  NOTHING_TO_HEAL: 'nothing_to_heal', // replay was green
  CONSEQUENCE_BROKEN: 'consequence_broken', // rebind resolves a locator but the flow's success consequence no longer fires — REFUSED (file untouched)
  ERROR: 'error', // flow missing/malformed/invalid-name, or a resolved action failed
} as const;
export type HealStatus = (typeof HealStatus)[keyof typeof HealStatus];

/**
 * Minimum normalized confidence (0,1] a nearest-match rebind must clear before it is
 * eligible to be APPLIED (or surfaced as a confident proposal). Below this, drift is reported but
 * NEVER auto-rewritten — the "never silently rewrite" invariant has a single numeric home here.
 */
export const HEAL_CONFIDENCE_MIN = 0.5;

/**
 * What a structured annotation binds to. STEP folds onto the LAST captured
 * step's expect (assert-signal / assert-visible); FLOW folds onto the flow header (mark-dynamic →
 * dynamic[], success-state → success).
 */
export const AnnotationTarget = {
  STEP: 'step',
  FLOW: 'flow',
} as const;
export type AnnotationTarget = (typeof AnnotationTarget)[keyof typeof AnnotationTarget];

/**
 * Structured failure codes for the annotate compiler/tool (returned, never
 * thrown / free strings). NO_ACTIVE_RECORDING = annotate with nothing recording; NO_STEP_TO_
 * ANNOTATE = an assert-* with zero captured steps yet; UNKNOWN_KIND = kind ∉ AnnotationKind (or a
 * free natural-language string — see AnnotationSchema's FUTURE note); MISSING_FIELD = e.g. a
 * success-state with neither signal nor testid.
 */
export const AnnotationErrorCode = {
  NO_ACTIVE_RECORDING: 'annotate_no_recording',
  NO_STEP_TO_ANNOTATE: 'annotate_no_step',
  UNKNOWN_KIND: 'annotate_unknown_kind',
  MISSING_FIELD: 'annotate_missing_field',
} as const;
export type AnnotationErrorCode = (typeof AnnotationErrorCode)[keyof typeof AnnotationErrorCode];

/** Leading word of the compiled-predicate confirmation ("will assert …"). */
export const COMPILED_PREDICATE_PREFIX = 'will';
