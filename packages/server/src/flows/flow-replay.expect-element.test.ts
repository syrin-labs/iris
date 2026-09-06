import { describe, expect, it } from 'vitest';
import {
  asRef,
  ActionType,
  AnchorKind,
  DriftReason,
  FLOW_FILE_VERSION,
  ReticleCommand,
  type CommandResult,
  type ElementDescriptor,
  type FlowFile,
  type FlowStep,
} from '@reticlehq/core';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';
import { proposeRebind } from './heal.js';
import { waitForPredicate } from '../events/predicate.js';
import { asString } from '../tools/tools-helpers.js';
import { ReticleTool } from '../tools/tool-names.js';

/**
 * #697: a step whose `expect.element` testid is absent after the action reported the ASSERTION's
 * target in the result's `anchor` — the field documented as the value the step is bound to — with
 * `testid_not_found`. Replay stops at the first drift, so that one result is everything the caller
 * sees about why the run ended, and it read as "this step's locator drifted" on a step whose
 * locator was fine and whose action had already fired.
 */
const FAST = 60;

function el(ref: string, testid: string): ElementDescriptor {
  return { ref: asRef(ref), role: 'button', name: testid, states: [], visible: true };
}

class FakeSession implements FlowReplaySession {
  readonly acts: string[] = [];
  constructor(private readonly present: Set<string>) {}

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === ReticleCommand.QUERY) {
      const value = asString(args['value']) ?? '';
      const elements = this.present.has(value) ? [el(`e-${value}`, value)] : [];
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: {
          elements,
          hint: { route: '/', presentTestids: [...this.present], knownEmptyState: false },
        },
      });
    }
    if (name === ReticleCommand.ACT) {
      this.acts.push(asString(args['ref']) ?? '');
      return Promise.resolve({ kind: 'command_result', id: 'a', ok: true, result: {} });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }

  eventsSince(): never[] {
    return [];
  }

  onEvent(): () => void {
    return () => undefined;
  }

  elapsed(): number {
    return 0;
  }
}

function step(value: string, expectTestid?: string): FlowStep {
  const s: FlowStep = {
    tool: ReticleTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value },
    action: ActionType.CLICK,
    args: {},
  };
  if (expectTestid !== undefined) s.expect = { element: { testid: expectTestid } };
  return s;
}

function flow(steps: FlowStep[]): FlowFile {
  return { version: FLOW_FILE_VERSION, name: 'f', createdAt: 0, steps };
}

describe('replayFlow expect.element drift is not anchor drift', () => {
  it("names the STEP's anchor, not the assertion's target", async () => {
    // "confirm" resolves and is clicked; the asserted "receipt" never appears.
    const session = new FakeSession(new Set(['confirm', 'sibling']));
    const steps = await replayFlow(
      session,
      flow([step('confirm', 'receipt')]),
      waitForPredicate,
      FAST,
    );

    expect(steps[0]?.ok).toBe(false);
    // The bug: this was "receipt", so the caller went looking for a renamed locator on a step
    // whose locator resolved fine.
    expect(steps[0]?.anchor).toBe('confirm');
    // The missing testid is still reported — on the drift, where it belongs.
    expect(steps[0]?.drift?.anchor).toBe('receipt');
  });

  it('reports a distinct reason kind from a missing anchor', async () => {
    const session = new FakeSession(new Set(['confirm', 'sibling']));
    const steps = await replayFlow(
      session,
      flow([step('confirm', 'receipt')]),
      waitForPredicate,
      FAST,
    );

    expect(steps[0]?.drift?.reasonKind).toBe(DriftReason.EXPECT_ELEMENT_NOT_FOUND);
    expect(steps[0]?.drift?.reason).toContain('expect.element');
  });

  it('still records that the action ran', async () => {
    const session = new FakeSession(new Set(['confirm', 'sibling']));
    await replayFlow(session, flow([step('confirm', 'receipt')]), waitForPredicate, FAST);

    // The click fired; only its consequence did not hold. Reporting it as anchor drift hid this.
    expect(session.acts).toContain('e-confirm');
  });

  it('a genuinely missing anchor is unchanged', async () => {
    // Regression guard on the other direction: when the step's own anchor is gone, the result and
    // the drift both name it and the reason stays testid_not_found.
    const session = new FakeSession(new Set(['sibling']));
    const steps = await replayFlow(
      session,
      flow([step('confirm', 'receipt')]),
      waitForPredicate,
      FAST,
    );

    expect(steps[0]?.anchor).toBe('confirm');
    expect(steps[0]?.drift?.anchor).toBe('confirm');
    expect(steps[0]?.drift?.reasonKind).toBe(DriftReason.TESTID_NOT_FOUND);
    expect(session.acts).toHaveLength(0);
  });

  it('no longer proposes a heal that could never apply', async () => {
    // proposeRebind only fires on TESTID_NOT_FOUND, and applyProposals drops a change whose `from`
    // is not the step's anchor. Under the old reason kind this produced a proposal keyed to the
    // assertion's testid that was then silently discarded.
    const session = new FakeSession(new Set(['confirm', 'sibling']));
    const steps = await replayFlow(
      session,
      flow([step('confirm', 'receipt')]),
      waitForPredicate,
      FAST,
    );
    const drift = steps[0]?.drift;

    expect(drift).toBeDefined();
    if (drift !== undefined) expect(proposeRebind(drift, 0)).toBeUndefined();
  });
});
