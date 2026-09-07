import { describe, it, expect } from 'vitest';
import { ActionType, DANGEROUS_ACTION_CONFIRM_ARG, QueryBy } from '@reticlehq/core';
import { RecordingStore, type RecordedStep, type CompiledProgram } from './recordings.js';
import { captureAct, compileActStep, compileSequenceStep } from './replay.js';

const step = (tool: string, stable = true): RecordedStep => ({ tool, stable, args: {} });

describe('RecordingStore', () => {
  it('accumulates captured steps and clears on stop', () => {
    const store = new RecordingStore();
    store.start('flow', 0);
    expect(store.isRecording('flow')).toBe(true);
    store.capture(step('reticle_act'));
    store.capture(step('reticle_act_sequence'));
    const rec = store.stop('flow');
    expect(rec?.steps).toHaveLength(2);
    expect(rec?.cursor).toBe(0);
    expect(store.isRecording('flow')).toBe(false);
    expect(store.stop('flow')).toBeUndefined();
  });

  it('capture with no active recording is a no-op', () => {
    const store = new RecordingStore();
    expect(() => {
      store.capture(step('reticle_act'));
    }).not.toThrow();
    expect(store.active()).toEqual([]);
  });

  it('appends captured steps to every active recording', () => {
    const store = new RecordingStore();
    store.start('a', 0);
    store.start('b', 5);
    store.capture(step('reticle_act'));
    expect(store.stop('a')?.steps).toHaveLength(1);
    expect(store.stop('b')?.steps).toHaveLength(1);
  });

  it('round-trips compiled programs by name', () => {
    const store = new RecordingStore();
    const program: CompiledProgram = { name: 'flow', version: 1, steps: [step('reticle_act')] };
    store.saveCompiled(program);
    expect(store.getCompiled('flow')).toBe(program);
    expect(store.getCompiled('nope')).toBeUndefined();
  });

  it('never persists one-shot destructive-action confirmations', () => {
    const act = compileActStep(
      {
        ref: 'e1',
        action: ActionType.CLICK,
        args: { [DANGEROUS_ACTION_CONFIRM_ARG]: true, value: 'kept' },
      },
      { testid: 'delete-account' },
    );
    expect(act.args['args']).toEqual({ value: 'kept' });

    const sequence = compileSequenceStep(
      {
        steps: [
          {
            ref: 'e1',
            action: ActionType.CLICK,
            args: { [DANGEROUS_ACTION_CONFIRM_ARG]: true },
          },
        ],
      },
      { steps: [{ testid: 'delete-account' }] },
    );
    expect((sequence.args['steps'] as { args: Record<string, unknown> }[])[0]?.args).toEqual({});
  });

  /**
   * The sequence compiler understood ONLY a testid, while the act compiler had long since learned
   * role+name and component/source. So on any app without testids every sub-step fell to a volatile
   * ref, `stable` went false, the saved flow carried the degraded `unresolved` sentinel, and replay
   * drifted — 7 apps out of 7 in a field sweep, with heal correctly refusing to match a placeholder.
   * One compiler, one anchor priority: testid > role+name > component/source.
   */
  it('compiles a sequence sub-step by role+name, and by component, when there is no testid', () => {
    const sequence = compileSequenceStep(
      {
        steps: [
          { ref: 'e1', action: ActionType.CLICK, args: {} },
          { ref: 'e2', action: ActionType.CLICK, args: {} },
        ],
      },
      {
        steps: [
          { role: 'button', name: 'Pay now' },
          { component: 'Row', source: { file: 'src/Row.tsx', line: 12 } },
        ],
      },
    );
    expect(sequence.stable).toBe(true);
    const steps = sequence.args['steps'] as Record<string, unknown>[];
    expect(steps[0]).toMatchObject({ by: QueryBy.ROLE, value: 'button', name: 'Pay now' });
    expect(steps[1]).toMatchObject({
      by: QueryBy.COMPONENT,
      component: 'Row',
      source: { file: 'src/Row.tsx', line: 12 },
    });
  });

  it('leaves a sub-step ref-bound (unstable) only when the element has no anchor at all', () => {
    const sequence = compileSequenceStep(
      { steps: [{ ref: 'e3', action: ActionType.CLICK, args: {} }] },
      { steps: [{}] },
    );
    expect(sequence.stable).toBe(false);
    expect((sequence.args['steps'] as Record<string, unknown>[])[0]).toMatchObject({ ref: 'e3' });
  });

  it('compiles a stable component (auto-anchor) step when the result has no testid but a component/source', () => {
    const act = compileActStep(
      { ref: 'e9', action: ActionType.CLICK, args: {} },
      {
        component: 'NewDeployButton',
        source: { file: 'src/Deployments.tsx', line: 107, column: 4 },
      },
    );
    expect(act.stable).toBe(true); // NOT degraded — the auto-anchor keeps it replayable
    expect(act.args['by']).toBe('component');
    expect(act.args['component']).toBe('NewDeployButton');
    expect(act.args['source']).toEqual({ file: 'src/Deployments.tsx', line: 107, column: 4 });
  });

  it('falls back to a ref-bound (unstable) step only when there is neither testid nor component/source', () => {
    const act = compileActStep({ ref: 'e9', action: ActionType.CLICK, args: {} }, { effect: {} });
    expect(act.stable).toBe(false);
    expect(act.args['ref']).toBe('e9');
  });

  it('keeps a recorded until that locates by role and name', () => {
    const store = new RecordingStore();
    store.start('trip', 0);
    captureAct(
      store,
      {
        ref: 'e1',
        action: ActionType.CLICK,
        until: { kind: 'element', query: { role: 'button', name: '0 Clicks' } },
      },
      { testid: 'counter' },
    );
    expect(store.stop('trip')?.steps[0]?.expect).toEqual({
      element: { role: 'button', name: '0 Clicks' },
    });
  });
});

describe('anchor priority — which handle survives a replay', () => {
  const step = (result: Record<string, unknown>) =>
    compileActStep({ action: 'click', ref: 'e7' }, result);

  it('prefers a testid above everything', () => {
    const args = step({ testid: 'save', role: 'button', name: 'Save', component: 'Form' }).args;
    expect(args['by']).toBe('testid');
    expect(args['value']).toBe('save');
  });

  /**
   * A component/source anchor names the JSX SITE. One `<input>` written inside a row renders once per
   * row, so every row's copy collapses onto the same anchor — measured on a shipments console, three
   * different rows' checkboxes compiled identically and a replay resolved all three to one element
   * (91 matches, first taken). The accessible name separates them.
   */
  it('prefers role+name over a component anchor, because a name identifies the INSTANCE', () => {
    const args = step({
      role: 'checkbox',
      name: 'select ATL-100001',
      component: 'ShipmentsTable',
      source: { file: 'src/ShipmentsTable.tsx', line: 204 },
    }).args;
    expect(args['by']).toBe('role');
    expect(args['value']).toBe('checkbox');
    expect(args['name']).toBe('select ATL-100001');
    // Provenance still rides along — it answers "which file?", not "which element?".
    expect(args['source']).toBeDefined();
  });

  it('falls back to the component anchor when the element has no accessible name', () => {
    const args = step({
      component: 'ShipmentsTable',
      source: { file: 'src/ShipmentsTable.tsx', line: 204 },
    }).args;
    expect(args['by']).toBe('component');
  });

  it('records an unstable ref only when there is no anchor at all', () => {
    const compiled = step({});
    expect(compiled.stable).toBe(false);
    expect(compiled.args['ref']).toBe('e7');
  });

  it('does not claim a role anchor when the name is empty', () => {
    // A nameless control cannot be addressed by role+name; saying otherwise compiles an anchor that
    // resolves to the wrong element or to nothing.
    const args = step({ role: 'button', component: 'Toolbar' }).args;
    expect(args['by']).toBe('component');
  });
});
