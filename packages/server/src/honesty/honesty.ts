/**
 * The honesty block — one machine-readable field composing everything that qualifies a verdict's
 * trustworthiness: the assertion grade, the attribution tier, the envelope maturity, the verified-surface
 * coverage, and the capture integrity. The invariant: a green may never LOOK stronger than its honesty
 * block. Harnesses gate on it (e.g. "grade ≥ net AND integrity clean"). This is pure composition +
 * assessment — all five components already exist individually; wiring it onto results is a later step.
 */

import type { CaptureLoss } from '@reticlehq/core';
import { Verified } from '@reticlehq/core';

/** Assertion grade, strongest first — the tier the verdict actually proved. */
export const HonestyGrade = {
  SIGNAL: 'signal',
  NET: 'net',
  STATE: 'state',
  PRESENCE: 'presence',
  NONE: 'none',
} as const;
export type HonestyGrade = (typeof HonestyGrade)[keyof typeof HonestyGrade];

const GRADE_RANK: Record<HonestyGrade, number> = {
  [HonestyGrade.SIGNAL]: 4,
  [HonestyGrade.NET]: 3,
  [HonestyGrade.STATE]: 2,
  [HonestyGrade.PRESENCE]: 1,
  [HonestyGrade.NONE]: 0,
};

/** Below this envelope sample count a deviation verdict is noise, not judgment. */
const MIN_ENVELOPE_SAMPLES = 3;

/** Coverage when the SDK reported no blind spots during the window — it saw everything it can see. */
const FULL_COVERAGE_PCT = 100;

interface HonestyInputs {
  grade: HonestyGrade;
  /** Present when a causal chain is presented; `window` = time-heuristic, never dataflow truth. */
  attribution?: string;
  envelopeSamples?: number;
  coveragePct?: number;
  coveragePartial?: boolean;
  /**
   * The sentence naming WHAT went unobserved, from `buildCoverageStatement`.
   *
   * Separate from `blindSpots`, which carries only the IMPEACHING notes — the ones that downgrade a
   * verdict. A bounding spot does not impeach anything, so it never entered that list, and the flag
   * that survived (`partial: true`) is unanswerable on its own: the verdict prose tells the reader
   * to see `coverage` for what went unobserved, and there was nothing there to see.
   */
  coverageNote?: string;
  truncated?: boolean;
  blindSpots?: readonly string[];
  /**
   * The machine-readable half of `issues` — WHICH kind of loss, from core's closed `CaptureLoss`.
   *
   * `issues` is prose built for an agent to read, and prose is not something a dashboard can group
   * by: `unclean_capture` became a large share of all field verdicts with no way to ask which of its three
   * causes produced them. Passed by the caller rather than derived here, because only the caller
   * knows whether a blind-spot note came from the browser transport or from a boundary in the page.
   */
  losses?: readonly CaptureLoss[];
  /**
   * Did the page go quiet inside the action's window? Omitted when nothing measured it.
   *
   * Settlement stopped being a veto over a declared consequence that held (see `verified.ts`), and a
   * fact that no longer decides the verdict must not therefore disappear: a page that never goes
   * idle is worth knowing about, and a caller who cares can still gate on it. Reported here rather
   * than beside `verified`, where the answer belongs to the rule and not to its inputs.
   */
  settled?: boolean;
}

export interface HonestyBlock {
  grade: HonestyGrade;
  attribution?: string;
  /** Present only when an envelope was actually sampled — never a fabricated zero. */
  envelope?: { samples: number; sufficient: boolean };
  /** `pct` is present only when it was measured (or provably full); `partial` is always known. */
  coverage: { pct?: number; partial: boolean; note?: string };
  integrity: { clean: boolean; issues: string[]; losses?: CaptureLoss[] };
  /** Whether the page went quiet in this window — present only when it was measured. */
  settled?: boolean;
}

export function buildHonestyBlock(inputs: HonestyInputs): HonestyBlock {
  const issues: string[] = [];
  if (true === inputs.truncated) issues.push('capture truncated');
  for (const spot of inputs.blindSpots ?? []) issues.push(`blind spot: ${spot}`);

  // Report only what was measured. `envelope` used to be emitted unconditionally with samples=0, so
  // every act carried `sufficient: false` — and the tool description tells the agent to gate on this
  // block, meaning an agent that obeyed rejected 100% of green verdicts on a value that never changed.
  // A field that always reads "insufficient" is worse than an absent one: it looks like a finding.
  const samples = inputs.envelopeSamples;
  const partial = inputs.coveragePartial ?? false;
  // Nothing blind reported ⇒ the SDK saw everything it is able to see. When coverage IS partial we know
  // that much but not the fraction, so the percentage is omitted rather than invented.
  const pct = inputs.coveragePct ?? (partial ? undefined : FULL_COVERAGE_PCT);

  return {
    grade: inputs.grade,
    ...(inputs.attribution === undefined ? {} : { attribution: inputs.attribution }),
    ...(samples === undefined
      ? {}
      : { envelope: { samples, sufficient: samples >= MIN_ENVELOPE_SAMPLES } }),
    coverage: {
      ...(pct === undefined ? {} : { pct }),
      partial,
      ...(partial && inputs.coverageNote !== undefined ? { note: inputs.coverageNote } : {}),
    },
    ...(inputs.settled === undefined ? {} : { settled: inputs.settled }),
    integrity: {
      clean: 0 === issues.length,
      issues,
      // Only when something was actually lost. An empty array beside `clean: true` would be a field
      // that is always present and always says nothing, which is how a signal gets tuned out.
      ...(0 === issues.length || undefined === inputs.losses || 0 === inputs.losses.length
        ? {}
        : { losses: [...new Set(inputs.losses)] }),
    },
  };
}

interface HonestyBar {
  /** The minimum grade a green must carry to be trusted (default: any). */
  minGrade?: HonestyGrade;
  /** Require capture integrity to be clean (no truncation / blind spots). */
  requireIntegrityClean?: boolean;
}

/** Whether a verdict's honesty block clears the harness's bar. Reasons list every failed criterion. */
export function meetsHonestyBar(
  block: HonestyBlock,
  bar: HonestyBar = {},
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (bar.minGrade !== undefined && GRADE_RANK[block.grade] < GRADE_RANK[bar.minGrade]) {
    reasons.push(`grade ${block.grade} below required ${bar.minGrade}`);
  }
  if (true === bar.requireIntegrityClean && !block.integrity.clean) {
    reasons.push(`integrity not clean: ${block.integrity.issues.join('; ')}`);
  }
  return { ok: 0 === reasons.length, reasons };
}

/**
 * The coverage sentence, kept only on a verdict that points at it.
 *
 * Exactly one branch of `decideVerified` promises it — the YES branch says "coverage was PARTIAL —
 * see `coverage` for what went unobserved". UNKNOWN keeps it too, because "I could not tell" is a
 * statement about what went unseen and the note is the answer. A NO has already named a concrete
 * counter-example, nothing directs the reader to `coverage`, and `partial` plus the spot kinds still
 * travel — so the prose there is cost with no question behind it.
 *
 * Measured: emitting it on every verdict regressed the benchmark's verification efficiency by 4.1%,
 * one note per observation. Accuracy outranks tokens, but this buys no accuracy — the promise is
 * kept wherever it is made.
 */
export function honestyForVerdict(verified: string, honesty: HonestyBlock): HonestyBlock {
  if (Verified.NO !== verified || honesty.coverage.note === undefined) return honesty;
  const { note: _dropped, ...coverage } = honesty.coverage;
  return { ...honesty, coverage };
}
