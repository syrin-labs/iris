/**
 * How one anchored step is turned into a live action.
 *
 * Split out of flow-replay.ts when adding the role+name runner pushed that file past the size cap.
 * These three share one shape — resolve an anchor to a ref, then dispatch — and the sharing is the
 * point: the action window must open and close identically no matter which anchor found the element,
 * or a step's events land in the wrong window depending on how it was addressed.
 */
import {
  AnchorKind,
  DEGRADED_ANCHOR_ROLE,
  DriftReason,
  QueryBy,
  ReticleCommand,
  type FlowAnchor,
  type FlowStep,
  type FlowStepResult,
} from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { replayActionArgs } from './replay.js';
import type { FlowReplaySession, Sleep } from './flow-replay.js';
import {
  anchorLabel,
  componentLabel,
  componentQueryArgs,
  resolveQuery,
  testidDrift,
} from './flow-replay.js';
import { nearestRoleName, type RoleCandidate } from './role-anchor-nearest.js';
import { roleDriftReason } from './role-drift-reason.js';

/** Query args for a NAMED role anchor — the handle that identifies an instance, not a JSX site. */
function roleQueryArgs(
  anchor: Extract<FlowAnchor, { kind: typeof AnchorKind.ROLE }>,
): Record<string, unknown> {
  return {
    by: QueryBy.ROLE,
    value: anchor.role,
    ...(anchor.name === undefined ? {} : { name: anchor.name }),
  };
}

/** Run one role+name-anchored step: re-resolve via QUERY by:'role', ACT on the live ref, else drift. */
/**
 * The controls actually on the page, as role + name, for the nearest-match scan.
 *
 * Reads the interactive snapshot rather than a second query per candidate: one round trip, and it is
 * the same view the coverage tool uses, so "what is on this page" has one definition.
 */
async function nearestRoleNameOnPage(
  session: FlowReplaySession,
  anchor: { role: string; name?: unknown },
): Promise<string | null> {
  const wanted = 'string' === typeof anchor.name ? anchor.name : undefined;
  if (wanted === undefined) return null;
  try {
    // Straight off the QUERY result: resolveQuery reduces to refs, and the NAMES are what this needs.
    const result = await session.command(ReticleCommand.QUERY, {
      by: QueryBy.ROLE,
      value: anchor.role,
    });
    const payload = result.result;
    const elements =
      'object' === typeof payload && payload !== null
        ? (payload as { elements?: unknown }).elements
        : undefined;
    if (!Array.isArray(elements)) return null;
    const candidates: RoleCandidate[] = elements
      .map((element) =>
        'object' === typeof element && element !== null
          ? (element as { name?: unknown }).name
          : undefined,
      )
      .filter((name): name is string => 'string' === typeof name && name.length > 0)
      .map((name) => ({ role: anchor.role, name }));
    return nearestRoleName(anchor.role, wanted, candidates);
  } catch {
    // A drift report must never fail because the suggestion lookup did.
    return null;
  }
}

export async function runRoleStep(
  session: FlowReplaySession,
  step: FlowStep,
  index: number,
  anchor: Extract<FlowAnchor, { kind: typeof AnchorKind.ROLE }>,
  confirmDangerous: boolean,
  sleep: Sleep,
): Promise<FlowStepResult> {
  const label = `${anchor.role} "${String(anchor.name)}"`;
  const { refs } = await resolveQuery(session, roleQueryArgs(anchor), sleep);
  const ref = refs[0];
  if (ref === undefined) {
    // `nearest` used to be the literal null, so heal answered "no nearest match cleared the
    // confidence floor" for EVERY role-anchored drift — a structural limit reported as a judgement
    // about candidates, when nothing had looked. It looks now, and it is deliberately stricter than
    // the testid path: a role name is user-visible text, so a near-match is far more likely to be a
    // different control than a renamed one. A candidate here is INFORMATION for the agent; heal
    // still refuses to rebind a role anchor on its own.
    const nearest = await nearestRoleNameOnPage(session, anchor);
    return {
      step: index,
      tool: step.tool,
      anchor: label,
      ok: false,
      drift: {
        reasonKind: DriftReason.COMPONENT_NOT_FOUND,
        reason: roleDriftReason(anchor.role, String(anchor.name), nearest),
        anchor: label,
        nearest,
      },
    };
  }
  return await actOnResolvedRef(session, step, index, label, ref, confirmDangerous);
}

/**
 * Dispatch one already-resolved step. Shared so every anchor kind runs the action the same way —
 * including the action window, whose open/close must not depend on which anchor found the element.
 */
async function actOnResolvedRef(
  session: FlowReplaySession,
  step: FlowStep,
  index: number,
  label: string,
  ref: string,
  confirmDangerous: boolean,
): Promise<FlowStepResult> {
  session.beginAction?.(ReticleTool.FLOW_REPLAY, { ref, action: step.action ?? '' });
  let act;
  try {
    act = await session.command(ReticleCommand.ACT, {
      ref,
      action: step.action ?? '',
      args: replayActionArgs(step.args, confirmDangerous),
    });
  } finally {
    session.finishAction?.();
  }
  const result: FlowStepResult = { step: index, tool: step.tool, anchor: label, ok: act.ok };
  if (!act.ok) result.error = act.error ?? 'command failed';
  return result;
}

/** Run one component-anchored step: re-resolve via QUERY by:'component', ACT on the live ref, else drift. */
export async function runComponentStep(
  session: FlowReplaySession,
  step: FlowStep,
  index: number,
  anchor: Extract<FlowAnchor, { kind: typeof AnchorKind.COMPONENT }>,
  confirmDangerous: boolean,
  sleep: Sleep,
): Promise<FlowStepResult> {
  const label = componentLabel(anchor);
  const { refs } = await resolveQuery(session, componentQueryArgs(anchor), sleep);
  if (0 === refs.length) {
    return {
      step: index,
      tool: step.tool,
      anchor: label,
      ok: false,
      drift: {
        reasonKind: DriftReason.COMPONENT_NOT_FOUND,
        reason: `component anchor "${label}" not found`,
        anchor: label,
        nearest: null,
      },
    };
  }
  const ref = refs[0] ?? '';
  // Attribute the step's effects to the step. Without this window they arrive with no actionId and are
  // learned as ambient churn on the very regions the flow exercises.
  session.beginAction?.(ReticleTool.FLOW_REPLAY, { ref, action: step.action ?? '' });
  let act;
  try {
    act = await session.command(ReticleCommand.ACT, {
      ref,
      action: step.action ?? '',
      args: replayActionArgs(step.args, confirmDangerous),
    });
  } finally {
    // Close on every exit so a throwing step cannot leak the window onto the next step's events.
    session.finishAction?.();
  }
  const result: FlowStepResult = { step: index, tool: step.tool, anchor: label, ok: act.ok };
  if (!act.ok) result.error = act.error ?? 'command failed';
  return result;
}

/**
 * DEGRADED_ANCHOR_ROLE is a MARKER ("no anchor could be determined"), never a locator.
 *
 * Recognising it is most of the fix: a nameless-ROLE anchor used to fall through to the testid
 * runner, which asked the DOM eight times for a testid literally named "unresolved", found none (it
 * never exists), and reported a MISSING ELEMENT. It then ran edit-distance against the word
 * "unresolved" and offered the nearest testid as a rebind target — which flow_verify printed while
 * flow_heal refused it on confidence. Two tools contradicting each other over a candidate that never
 * meant anything.
 *
 * Both recorders emit this sentinel, so the check belongs here on the replay side, where all of them
 * land.
 */
export function isDegradedAnchor(anchor: FlowAnchor): boolean {
  return (
    anchor.kind === AnchorKind.ROLE &&
    anchor.role === DEGRADED_ANCHOR_ROLE &&
    anchor.name === undefined
  );
}

/** What a step with no resolvable anchor reports, instead of a missing-element story. */
const DEGRADED_STEP_REASON =
  'recorded without a resolvable anchor (no data-testid, no accessible role+name), so it can never ' +
  'resolve on replay — add a data-testid to the element and record this flow again';

export function degradedStepResult(step: FlowStep, index: number, label: string): FlowStepResult {
  return {
    step: index,
    tool: step.tool,
    anchor: label,
    ok: false,
    drift: {
      reasonKind: DriftReason.ANCHOR_DEGRADED,
      reason: DEGRADED_STEP_REASON,
      anchor: label,
      // Deliberately null: the old path produced a nearest match to the WORD "unresolved", which is
      // not a candidate for anything.
      nearest: null,
    },
  };
}

/**
 * QUERY args for an element anchor — null when the anchor addresses no element.
 *
 * Exported for `arriveAtStartPath`, which has to ask "can step 1 resolve where we already are?"
 * before deciding to navigate. Sharing this mapping rather than repeating it keeps that question and
 * the step runner's own resolution asking the same thing of the same anchor.
 */
export function anchorQueryArgs(anchor: FlowAnchor): Record<string, unknown> | null {
  if (anchor.kind === AnchorKind.TESTID) return { by: QueryBy.TESTID, value: anchor.value };
  if (anchor.kind === AnchorKind.COMPONENT) return componentQueryArgs(anchor);
  if (anchor.kind === AnchorKind.ROLE && !isDegradedAnchor(anchor)) return roleQueryArgs(anchor);
  return null;
}

/**
 * Run an act_sequence step: resolve every sub-step's OWN anchor, then dispatch the whole thing as one
 * ACT_SEQUENCE — the same shape `replayProgram` already uses, so a recorded sequence and a saved one
 * execute identically.
 *
 * `replayFlow` had no sequence branch at all. It dispatches on `anchor.kind`, so a saved sequence fell
 * to the testid runner and ran ONE act with `action: ''` (a saved sequence carries no top-level
 * action) — sub-steps 2..n never executed. Fixing the anchor without this would have turned a visible
 * drift into a silent partial replay reporting ok.
 */
export async function runSequenceStep(
  session: FlowReplaySession,
  step: FlowStep,
  index: number,
  subs: readonly FlowStep[],
  confirmDangerous: boolean,
  sleep: Sleep,
): Promise<FlowStepResult> {
  const live: { ref: string; action: string; args: Record<string, unknown> }[] = [];
  for (const [subIndex, sub] of subs.entries()) {
    const label = `${anchorLabel(sub.anchor)} (sub-step ${String(subIndex)})`;
    const queryArgs = anchorQueryArgs(sub.anchor);
    if (null === queryArgs) return degradedStepResult(step, index, label);
    const { refs, hint } = await resolveQuery(session, queryArgs, sleep);
    const ref = refs[0];
    if (ref === undefined) {
      return {
        step: index,
        tool: step.tool,
        anchor: label,
        ok: false,
        drift:
          sub.anchor.kind === AnchorKind.TESTID
            ? testidDrift(sub.anchor.value, hint)
            : {
                reasonKind: DriftReason.COMPONENT_NOT_FOUND,
                reason: `anchor ${label} not found`,
                anchor: label,
                nearest: null,
              },
      };
    }
    live.push({
      ref,
      action: sub.action ?? '',
      args: replayActionArgs(sub.args, confirmDangerous),
    });
  }
  session.beginAction?.(ReticleTool.FLOW_REPLAY, { steps: live.length });
  let act;
  try {
    act = await session.command(ReticleCommand.ACT_SEQUENCE, { steps: live });
  } finally {
    session.finishAction?.();
  }
  const result: FlowStepResult = {
    step: index,
    tool: step.tool,
    anchor: anchorLabel(step.anchor),
    ok: act.ok,
  };
  if (!act.ok) result.error = act.error ?? 'command failed';
  return result;
}
