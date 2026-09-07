import { AnchorKind, InstrumentationGapKind, type FlowStep } from '@reticlehq/core';
import type { LocatedGap } from './self-instrument.js';

/**
 * Bridge domain gaps → LOCATED instrumentation gaps. A flow that asserts no consequence should emit one —
 * and the flow's own step anchors carry the source file:line the babel/next plugin stamped, so we know
 * WHERE to add it. This is the plumbing that turns "flow X asserts nothing" into "add reticle.signal at
 * Checkout.tsx:114". Pure; feeds proposeInstrumentation.
 */

/** The last COMPONENT-anchor source in a flow — where a post-action consequence signal belongs. */
export function lastSource(steps: readonly FlowStep[]): { file: string; line: number } | undefined {
  let found: { file: string; line: number } | undefined;
  const walk = (list: readonly FlowStep[]): void => {
    for (const step of list) {
      if (step.anchor.kind === AnchorKind.COMPONENT && step.anchor.source !== undefined) {
        found = { file: step.anchor.source.file, line: step.anchor.source.line };
      }
      if (step.steps !== undefined) walk(step.steps);
    }
  };
  walk(steps);
  return found;
}

/**
 * Turn unasserted flows into no-signal-on-mutation gaps at each flow's source location. Flows with
 * no stamped source are skipped (no location to propose). The suggested signal name is `<flow>:done`.
 */
export function instrumentationGapsForFlows(
  unassertedFlows: readonly string[],
  flowStepsByName: ReadonlyMap<string, readonly FlowStep[]>,
): LocatedGap[] {
  const gaps: LocatedGap[] = [];
  for (const name of unassertedFlows) {
    const steps = flowStepsByName.get(name);
    const source = steps === undefined ? undefined : lastSource(steps);
    if (source === undefined) continue;
    gaps.push({
      kind: InstrumentationGapKind.NO_SIGNAL_ON_MUTATION,
      file: source.file,
      line: source.line,
      name: `${name}:done`,
      context: `flow "${name}" asserts no consequence`,
    });
  }
  return gaps;
}
