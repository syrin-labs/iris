import {
  InstrumentationGapKind,
  instrumentationGap,
  type FlowFile,
  type InstrumentationGap,
} from '@reticlehq/core';
import { IntentStore } from '../intent/intent-store.js';
import { classifyFlowAssertions } from './flow-classify.js';

/**
 * The link between a saved flow and the intent ledger — what the flow is FOR.
 *
 * A replay used to report only in the language of the DOM: step 3 drifted, this assertion failed.
 * True, actionable, and illegible — the reader still had to reconstruct what stopped working. The
 * ledger in `.reticle/intent.json` already holds the other half (prose statements, declared → bound
 * → proved, and the verdict that discharged each one), so a flow does not need its own notion of
 * intent. It needs an id.
 *
 * Nothing here derives an intent from step names. A flow that declares none reports that it declares
 * none — a guessed intent puts words in the product owner's mouth and an agent will act on them,
 * which is strictly worse than the honest absence.
 */

/** Namespaced so a flow-declared intent never collides with one an agent declared by hand. */
const FLOW_INTENT_ID_PREFIX = 'flow:';
const FLOW_VERDICT_ID_PREFIX = 'flow_replay:';
const ID_SEPARATOR = ':';

/** The ledger id a flow's own prose goal is declared under. */
export function flowIntentId(flowName: string): string {
  return `${FLOW_INTENT_ID_PREFIX}${flowName}`;
}

/** The verdict that a replay of this flow, at this time, constitutes — what `provenBy` records. */
export function flowReplayVerdictId(flowName: string, at: number): string {
  return `${FLOW_VERDICT_ID_PREFIX}${flowName}${ID_SEPARATOR}${String(at)}`;
}

/**
 * Which ledger row this flow answers to, or nothing.
 *
 * An explicit `intentId` wins, so a flow can discharge an intent that was declared before it existed.
 * Otherwise the flow's own prose implies one. A flow with neither has no intent, and says so.
 */
function intentIdOf(flow: FlowFile): string | undefined {
  if (flow.intentId !== undefined) return flow.intentId;
  // TRIMMED, not merely defined. `intent: "   "` satisfied `!== undefined` and silenced the gap, so
  // a flow whose stated goal is whitespace looked identical on disk to one somebody thought about.
  //
  // The worse direction of the two: this gap is the ONLY thing that would ever tell anyone the flow
  // has no goal, so suppressing it wrongly means the flow replays for months and the day it goes red
  // the report names the broken step and nothing else — the precise failure it was written to
  // prevent. Found by probing the seam rather than reading it.
  return undefined === flow.intent || '' === flow.intent.trim()
    ? undefined
    : flowIntentId(flow.name);
}

/**
 * Promote a flow's prose goal into the ledger and stamp the id back onto the flow.
 *
 * The binding is attached only when the flow asserts an observable consequence, because that is the
 * only case where replaying it green proves anything. A flow that asserts nothing leaves its intent
 * `declared` — and `dischargeIntent` refuses to prove an unbound intent, so an assertion-free flow
 * can never discharge one. That is the whole guard, and it is the ledger's own rule, not a new one.
 *
 * Returns the flow unchanged (and writes nothing) when there is no intent, so a flow file saved
 * before any of this existed keeps its exact bytes.
 */
export async function linkFlowIntent(store: IntentStore, flow: FlowFile): Promise<FlowFile> {
  const id = intentIdOf(flow);
  if (id === undefined) return flow;
  if (flow.intent !== undefined) {
    await store.declare([{ id, statement: flow.intent, surface: { flow: flow.name } }]);
  }
  if (classifyFlowAssertions(flow).hasConsequenceAssertion) {
    await store.bind(id, { flow: flow.name });
  }
  return { ...flow, intentId: id };
}

/**
 * The nudge a flow saved without an intent earns, or nothing.
 *
 * Every save path routes through here, so the three of them cannot drift into three different ways
 * of saying the same thing. It says it in the vocabulary the instrumentation gaps already use — what
 * is missing, what it costs, and the one change that closes it — because "nobody said what this is
 * for" is the same finding `undeclared-change` makes about an edit, one artifact later.
 *
 * Deliberately generic. It names no step, no assertion and not even the flow, for the reason this
 * file already gives twice: anything specific enough to identify the goal is specific enough to be
 * read AS the goal. It also never fails the save — a flow with no intent is still far better than no
 * flow, and a verification tool that refuses to record work is one people route around.
 */
export function flowIntentGap(flow: FlowFile): InstrumentationGap | undefined {
  if (intentIdOf(flow) !== undefined) return undefined;
  return instrumentationGap(
    InstrumentationGapKind.NO_FLOW_INTENT,
    'this flow declares no intent, so nothing on disk says what it is meant to prove',
    'it will replay for months, and the day it goes red the report can only name the step that broke — not the thing that stopped being true — so whoever reads it has to reconstruct the goal from the steps before they can tell a real regression from a moved button',
  );
}

/**
 * What the ledger currently says this flow is for, or undefined when nothing declared it.
 *
 * Read from the ledger rather than from the flow file's own copy: the ledger is where an amendment
 * lands, and a report that quotes the stale copy would be the two-vocabularies problem all over
 * again — one sentence in review, a different one in the failure message.
 */
export async function flowIntentStatement(
  store: IntentStore,
  flow: FlowFile,
): Promise<string | undefined> {
  const id = intentIdOf(flow);
  if (id === undefined) return undefined;
  const found = (await store.read()).find((intent) => intent.id === id);
  return found?.statement ?? flow.intent;
}

/**
 * Record that this replay proved the flow's intent. False when there was nothing to prove.
 *
 * Best-effort by construction: `IntentStore.discharge` returns false rather than throwing on an
 * unknown or unbound id, because discharge runs off the back of a verdict and must never be the
 * reason one fails to return.
 */
export async function dischargeFlowIntent(
  store: IntentStore,
  flow: FlowFile,
  proof: { verdictId: string; grade: string; at: number },
): Promise<boolean> {
  const id = intentIdOf(flow);
  if (id === undefined) return false;
  try {
    return await store.discharge(id, proof);
  } catch {
    // A ledger that cannot be written is a small problem; a verdict that never returns because of
    // one is a large problem. The replay already succeeded — the proof is simply not recorded.
    return false;
  }
}
