import { describe, expect, it } from 'vitest';
import { ActionType, AnchorKind, InstrumentationGapKind, type FlowStep } from '@reticlehq/core';
import { instrumentationGapsForFlows, lastSource } from './flow-instrument-gaps.js';
import { proposeInstrumentation } from './self-instrument.js';

function componentStep(file: string, line: number): FlowStep {
  return {
    action: ActionType.CLICK,
    anchor: { kind: AnchorKind.COMPONENT, source: { file, line } },
  } as FlowStep;
}
function testidStep(): FlowStep {
  return { action: ActionType.CLICK, anchor: { kind: AnchorKind.TESTID, value: 'x' } } as FlowStep;
}

describe('lastSource', () => {
  it('returns the last component-anchor source', () => {
    expect(lastSource([componentStep('a.tsx', 1), componentStep('b.tsx', 42)])).toEqual({
      file: 'b.tsx',
      line: 42,
    });
  });
  it('is undefined when no step carries a source stamp', () => {
    expect(lastSource([testidStep()])).toBeUndefined();
  });
});

describe('instrumentationGapsForFlows', () => {
  it('turns an unasserted flow into a located no-signal-on-mutation gap → a real proposal', () => {
    const steps = new Map<string, FlowStep[]>([['checkout', [componentStep('Checkout.tsx', 114)]]]);
    const gaps = instrumentationGapsForFlows(['checkout'], steps);
    expect(gaps).toEqual([
      {
        kind: InstrumentationGapKind.NO_SIGNAL_ON_MUTATION,
        file: 'Checkout.tsx',
        line: 114,
        name: 'checkout:done',
        context: 'flow "checkout" asserts no consequence',
      },
    ]);
    // and it composes into a ready-to-apply diff
    expect(proposeInstrumentation(gaps)[0]).toMatchObject({
      file: 'Checkout.tsx',
      line: 114,
      insert: "reticle.signal('checkout:done');",
    });
  });

  it('skips flows with no stamped source (nothing to locate)', () => {
    const steps = new Map<string, FlowStep[]>([['legacy', [testidStep()]]]);
    expect(instrumentationGapsForFlows(['legacy'], steps)).toEqual([]);
  });
});
