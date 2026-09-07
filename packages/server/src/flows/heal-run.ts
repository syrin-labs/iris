/**
 * The self-heal state machine — load → replay → collect confident proposals → (apply ? verify+write:
 * dry). Split out of flow-tools.ts (which keeps only the FLOW_HEAL ToolDef) as a sibling of
 * flow-replay-run.ts. Never silently rewrites: only proposals that cleared HEAL_CONFIDENCE_MIN are
 * eligible, and only when apply:true; before persisting it re-verifies the success consequence still
 * fires (heal the locator, never the intent).
 */
import {
  FLOW_SIGNAL_TIMEOUT_MS,
  HEAL_CONFIDENCE_MIN,
  HealStatus,
  ReplayStatus,
  type FlowHealResult,
  type HealChange,
  type HealProposal,
} from '@reticlehq/core';
import { asString } from '../tools/tools-helpers.js';
import { waitForPredicate } from '../events/predicate.js';
import { replayFlow } from './flow-replay.js';
import { applyHealChanges, collectProposals } from './heal.js';
import { assertSuccess, dynamicTestids, successLabel } from './flow-success.js';
import { flowErrorMessage, sessionProjectId } from './flow-replay-run.js';
import type { ToolDeps } from '../tools/tools.js';
import { flowsForSession } from './flow-store-for-session.js';

const HEAL_MESSAGES = {
  NOTHING: 'nothing to heal — every anchor resolved on replay',
  HEALED:
    "rewrote drifted testid anchors to their nearest surviving match and re-verified the flow's success consequence still fires",
  DRIFT_DRY: 'confident rebind(s) proposed — re-run with apply:true to write them to disk',
  UNHEALABLE: `drift found, but no nearest match cleared the confidence floor (HEAL_CONFIDENCE_MIN=${HEAL_CONFIDENCE_MIN}); file left untouched; add a data-testid or fix the flow by hand`,
  HEALED_UNVERIFIED:
    'rewrote drifted testid anchors — but this flow declares no success consequence, so the rebind resolves a locator without proving the intent still holds. Add a success-state assertion (reticle_annotate) so future heals can be verified.',
  CONSEQUENCE_BROKEN:
    'rebind resolves the drifted locator to a surviving element, but the healed flow no longer satisfies its success consequence — refusing to write (a heal that loses the intent would ship a green-but-dead test). Fix by hand and verify',
} as const;

function toChange(proposal: HealProposal): HealChange {
  return { step: proposal.step, from: proposal.from, to: proposal.to };
}

export async function healFlow(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<FlowHealResult> {
  const name = asString(args['flowName']) ?? '';
  const apply = true === args['apply'];
  const projectId = sessionProjectId(deps, asString(args['sessionId']));
  const loaded = await flowsForSession(deps, projectId).flows.load(name, projectId);
  if (!loaded.ok) {
    return {
      name,
      status: HealStatus.ERROR,
      applied: false,
      proposals: [],
      changed: [],
      message: flowErrorMessage(loaded.code, loaded.detail),
      error: { code: loaded.code, message: flowErrorMessage(loaded.code, loaded.detail) },
    };
  }

  const session = deps.sessions.resolve(asString(args['sessionId']));
  const steps = await replayFlow(
    session,
    loaded.value,
    waitForPredicate,
    FLOW_SIGNAL_TIMEOUT_MS,
    true === args['confirmDangerous'],
  );
  const drifted = steps.some((s) => s.drift !== undefined);
  const failed = steps.find((s) => !s.ok && s.drift === undefined);
  if (failed !== undefined) {
    const message = failed.error ?? 'flow replay failed before an anchor could be healed';
    return {
      name,
      status: HealStatus.ERROR,
      applied: false,
      proposals: [],
      changed: [],
      message,
      error: { code: ReplayStatus.ERROR, message },
    };
  }
  if (!drifted) {
    return {
      name,
      status: HealStatus.NOTHING_TO_HEAL,
      applied: false,
      proposals: [],
      changed: [],
      message: HEAL_MESSAGES.NOTHING,
    };
  }

  const proposals = collectProposals(steps);
  if (0 === proposals.length) {
    return {
      name,
      status: HealStatus.UNHEALABLE,
      applied: false,
      proposals: [],
      changed: [],
      message: HEAL_MESSAGES.UNHEALABLE,
    };
  }

  if (!apply) {
    return {
      name,
      status: HealStatus.DRIFT,
      applied: false,
      proposals,
      changed: [],
      message: HEAL_MESSAGES.DRIFT_DRY,
    };
  }

  // Heal the locator, never the intent: verify the rebind on a healed copy before persisting. A rebound
  // testid can resolve to a real but WRONG element that no longer triggers the success consequence.
  const { flow: healed } = applyHealChanges(loaded.value, proposals.map(toChange));
  if (healed.success !== undefined) {
    // Verify from the FIRST DRIFTED step forward, not the whole flow — re-running the prefix would
    // double-execute a non-idempotent flow (a false CONSEQUENCE_BROKEN that refuses a correct heal).
    const firstDrift = steps.findIndex((s) => s.drift !== undefined);
    const toVerify = firstDrift > 0 ? { ...healed, steps: healed.steps.slice(firstDrift) } : healed;
    // Floor the success oracle at the start of the VERIFY replay so the earlier drift replay's signal
    // cannot fake the verification.
    const verifyFloor = session.elapsed();
    const verifySteps = await replayFlow(
      session,
      toVerify,
      waitForPredicate,
      FLOW_SIGNAL_TIMEOUT_MS,
      true === args['confirmDangerous'],
    );
    const verifyClean =
      verifySteps.length > 0 && verifySteps.every((s) => s.ok && s.drift === undefined);
    const verdict = verifyClean
      ? await assertSuccess(
          session,
          healed.success,
          dynamicTestids(healed),
          waitForPredicate,
          FLOW_SIGNAL_TIMEOUT_MS,
          verifyFloor,
        )
      : { pass: false, failureReason: 'healed flow did not replay cleanly' };
    if (!verdict.pass) {
      return {
        name,
        status: HealStatus.CONSEQUENCE_BROKEN,
        applied: false,
        proposals,
        changed: [],
        message: `${HEAL_MESSAGES.CONSEQUENCE_BROKEN} (${successLabel(healed.success)}: ${verdict.failureReason ?? 'not satisfied'})`,
      };
    }
  }

  // Healing WRITES, so it must land where the load came from — a heal that read the app's flow and
  // wrote the daemon's copy would silently fork the two.
  const written = await flowsForSession(deps, projectId).flows.heal(
    name,
    proposals.map(toChange),
    projectId,
  );
  if (!written.ok) {
    return {
      name,
      status: HealStatus.ERROR,
      applied: false,
      proposals,
      changed: [],
      message: flowErrorMessage(written.code),
      error: { code: written.code, message: flowErrorMessage(written.code) },
    };
  }
  return {
    name,
    status: HealStatus.HEALED,
    applied: written.value.changed.length > 0,
    proposals,
    changed: written.value.changed,
    message:
      loaded.value.success !== undefined ? HEAL_MESSAGES.HEALED : HEAL_MESSAGES.HEALED_UNVERIFIED,
  };
}
