/**
 * Which tool results count as a completed verification, as one pure rule.
 *
 * It used to live inline in `runTool` and read `status === 'pass'`, mapping everything else to
 * "no verdict". That was wrong in both directions at once, and the shape of the error is visible in
 * the production data:
 *
 *   - a FAILING suite emitted nothing, so `verification_completed` only ever fired on greens while
 *     `bugsInResult` fired on the reds — bugs with no verifications to divide them by;
 *   - an EMPTY suite ("all 0 flows pass") emitted `verified: yes, passed: true`.
 *
 * Extracted because a rule this easy to get wrong, feeding the one number shown to investors, should
 * be readable and testable on its own rather than inferred from a ternary inside a dispatcher.
 */
import { type BrowserBrand, CaptureLoss, type Verification, VerifiedReason } from '@reticlehq/core';
import { VERDICT_TOOLS } from '../tools/feedback-tools.js';
import { getBrowserMode } from './browser-mode.js';

/**
 * The deciding clause, read off the result `decideVerified` wrote it onto.
 *
 * Narrowed against core's own list rather than forwarded: a result is an untyped record here, and a
 * value that is not a member is not a reason — absent beats a string nobody can group by. Derived
 * from the enum, never re-listed, so a new clause is covered the day it exists.
 */
const REASONS: ReadonlySet<string> = new Set(Object.values(VerifiedReason));
function reasonOf(result: Record<string, unknown>): VerifiedReason | undefined {
  const raw = result['verifiedReason'];
  return 'string' === typeof raw && REASONS.has(raw) ? (raw as VerifiedReason) : undefined;
}

/**
 * WHICH loss made the capture unclean, read off the honesty block the verdict already carries.
 *
 * Narrowed against core's own list for the same reason `reasonOf` is: a value that is not a member
 * is not an answer. Reported as `OTHER` rather than dropped when the block says the capture was
 * dirty and names no kind — the loss is real either way, and a silent absence there would read as
 * "no unclean verdicts happened", which is the opposite of the truth.
 */
const LOSSES: ReadonlySet<string> = new Set(Object.values(CaptureLoss));
function uncleanLossOf(
  result: Record<string, unknown>,
  reason: VerifiedReason | undefined,
): CaptureLoss | undefined {
  if (VerifiedReason.UNCLEAN_CAPTURE !== reason) return undefined;
  const honesty = result['honesty'];
  const integrity =
    null !== honesty && 'object' === typeof honesty
      ? (honesty as { integrity?: { losses?: unknown } }).integrity
      : undefined;
  const first = Array.isArray(integrity?.losses) ? (integrity.losses as unknown[])[0] : undefined;
  return 'string' === typeof first && LOSSES.has(first)
    ? (first as CaptureLoss)
    : CaptureLoss.OTHER;
}

/** Suite statuses. `unverifiable` is a suite that ran but proved nothing — including an empty one. */
const SuiteStatus = {
  PASS: 'pass',
  FAIL: 'fail',
} as const;

/**
 * Did the assertion itself pass, across three tool shapes that spell it three ways.
 *
 * `reticle_assert` spreads its verdict at the top level, so `pass` is right there. `flow_verify`
 * reports a suite `status`. **`reticle_act_and_wait` nests it under `verdict`**, and that omission is
 * why `falseGreenCaught` had never once been true in the field: `passed` came back `undefined` for
 * every act_and_wait, so `true === passed` was false whatever the app did, on the one tool the
 * product tells agents to reach for first.
 *
 * The metric it feeds is the product's central claim reduced to a boolean, and it was structurally
 * unable to fire on the flagship path. Worse, the test file pinned that: one case used the real
 * nested shape and asserted `falseGreenCaught: false`, directly beneath a comment calling this case
 * "the thesis", while the case that asserted `true` used a flat shape act_and_wait never emits.
 *
 * A permanently-zero metric is indistinguishable from a working one that has nothing to report, so
 * nobody could have noticed this from the data. It took reading the emit path.
 */
function passedOf(result: Record<string, unknown>, status: unknown): boolean | undefined {
  if ('boolean' === typeof result['pass']) return result['pass'];
  const verdict = result['verdict'];
  if (null !== verdict && 'object' === typeof verdict) {
    const nested = (verdict as Record<string, unknown>)['pass'];
    if ('boolean' === typeof nested) return nested;
  }
  if (status === SuiteStatus.PASS) return true;
  if (status === SuiteStatus.FAIL) return false;
  return undefined;
}

/**
 * The verification payload for a result, or undefined when nothing was verified.
 *
 * `falseGreenCaught` is the one that matters: the assertion PASSED and Reticle still refused to call
 * it verified. That is the product's thesis reduced to a boolean.
 */
export function verificationOf(
  toolName: string,
  result: Record<string, unknown>,
  durationMs: number,
  brand?: BrowserBrand,
): Verification | undefined {
  if (!VERDICT_TOOLS.has(toolName)) return undefined;
  // A paused session REFUSES the call — nothing driven, nothing asserted. The refusal carries a
  // verdict field so the agent never reads undefined off it, and that field must not be mistaken
  // here for work that happened.
  if (true === result['paused']) return undefined;
  const verified = 'string' === typeof result['verified'] ? result['verified'] : undefined;
  // flow_verify reports `status: pass|fail|unverifiable`; assert reports a boolean `pass`. Accept
  // either shape so the whole family is covered without normalizing four tools' contracts for a
  // metric's convenience — but a status that is neither pass nor fail is NOT a verdict, and an empty
  // suite reports exactly that.
  const status = result['status'];
  const passed = passedOf(result, status);
  if (verified === undefined && passed === undefined) return undefined;
  const reason = reasonOf(result);
  const uncleanLoss = uncleanLossOf(result, reason);
  return {
    via: toolName,
    verified: verified ?? (true === passed ? 'yes' : 'no'),
    passed: passed ?? 'yes' === verified,
    // The assertion passed and Reticle answered `no` anyway: a green actively refuted.
    //
    // Deliberately NOT widened to every refusal of a passing assertion, though several of them are
    // arguably false greens caught too. `decideVerified` refuses a green seven ways and only
    // `contradicted` answers `no`; the rest answer `unknown` on purpose, because UNKNOWN must never
    // collapse into NO. `already_true` is the tempting one: a green that proved nothing because the
    // condition already held before the action, found by a check built for exactly that.
    //
    // It stays out because `reason` is on this same payload. Anyone who wants the wider number can
    // count it without a definition change, and a definition that shifts underneath a metric is
    // worse than one that is narrow, because the old and new series look comparable and are not.
    // Widening it would also have landed in the same release as the fix above, making it impossible
    // to tell how much of any rise was the bug and how much was the redefinition.
    falseGreenCaught: true === passed && 'no' === verified,
    durationMs,
    // Headless CI, a human watching, or somebody's own dev server — three different products behind
    // one number until this was recorded.
    browser: getBrowserMode(),
    // WHICH browser, when the page said. `attached` is the common case and says only that Reticle
    // launched nothing; the brand is the difference between "somebody's own browser" and knowing it
    // was Edge. Omitted when unreported — a desktop webview and an older SDK both have no answer,
    // and "unknown" would be a value on a dashboard rather than a gap.
    ...(brand !== undefined ? { brand } : {}),
    // WHY, not just what. `verified: unknown` covered seven different clauses of the honesty rule
    // belonging to three different owners — the agent, the app, and Reticle's own blind spots — and
    // they need opposite responses. A suite verdict has no clause behind it and reports none.
    ...(reason === undefined ? {} : { reason }),
    // WHAT was lost, when the reason was that something was. Three owners, three fixes, one bar
    // until now.
    ...(uncleanLoss === undefined ? {} : { uncleanLoss }),
  };
}
