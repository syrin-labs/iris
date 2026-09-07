import { describe, expect, it } from 'vitest';
import { ActionType, QueryBy } from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { recordedStepToFlowStep } from './flows.js';

/**
 * A saved flow must never carry a credential.
 *
 * `.reticle/flows/` is the GIT-CHECKED flow store — that is the whole point of it, and the file
 * header already says a volatile ref must never "leak into a git-checked file". A password did.
 *
 * Recording a sign-in captures the fill VALUE verbatim, so the first flow anybody records on an
 * authenticated app writes their password into a file they then commit. Found by driving a fresh
 * workspace: `.reticle/flows/console-4734c2f0/sign-in.json` held `"drive-demo-password"` in
 * plaintext and `git ls-files` confirmed it tracked.
 *
 * For an enterprise this is a security review that ends the evaluation, and it is caused by the
 * product doing exactly what it was asked to do.
 */

const fillStep = (testid: string, value: string) => ({
  tool: ReticleTool.ACT,
  stable: true,
  args: { by: QueryBy.TESTID, value: testid, action: ActionType.FILL, args: { value } },
});

/*
 * The typed text sits FLAT on the step's args; the field's identity is the anchor. That split is
 * what makes redaction decidable here at all — the anchor names the field, so  can
 * be recognised without inspecting the value and guessing whether it looks like a secret.
 */
const filledValue = (step: ReturnType<typeof recordedStepToFlowStep>): unknown =>
  step.args?.['value'];

describe('a recorded flow never persists a secret', () => {
  it('redacts what was typed into a password field', () => {
    const step = recordedStepToFlowStep(fillStep('auth-password', 'hunter2-and-then-some'));
    expect(filledValue(step)).not.toBe('hunter2-and-then-some');
  });

  it('redacts an api key field', () => {
    const step = recordedStepToFlowStep(fillStep('api-key', 'rk_live_deadbeef'));
    expect(filledValue(step)).not.toBe('rk_live_deadbeef');
  });

  /**
   * The value has to be REPLACED, not dropped: replay still needs a step there, and a flow that
   * silently loses its password step drifts at sign-in forever with no explanation.
   */
  it('leaves a placeholder rather than an empty value', () => {
    const step = recordedStepToFlowStep(fillStep('auth-password', 'hunter2'));
    expect(typeof filledValue(step)).toBe('string');
    expect(String(filledValue(step)).length).toBeGreaterThan(0);
  });

  /**
   * Over-redaction would be its own bug. A flow that cannot record what a user typed into a search
   * box is not a flow — the rule has to be about credentials, not about text.
   */
  it('keeps an ordinary field exactly as typed', () => {
    const step = recordedStepToFlowStep(fillStep('issue-search', 'checkout total'));
    expect(filledValue(step)).toBe('checkout total');
  });

  it('keeps an email, which replay needs and which is not a secret', () => {
    const step = recordedStepToFlowStep(fillStep('auth-email', 'ada@acme.co'));
    expect(filledValue(step)).toBe('ada@acme.co');
  });
});

/**
 * An app WITHOUT test ids is exactly the app whose flows get recorded by role — so checking only
 * the testid anchor would redact the tidy codebase and quietly leak the untidy one.
 */
describe('a password found by role, not by testid', () => {
  const roleStep = (name: string, value: string) => ({
    tool: ReticleTool.ACT,
    stable: false,
    args: { by: QueryBy.ROLE, value: 'textbox', name, action: ActionType.FILL, args: { value } },
  });

  it('is redacted too', () => {
    const step = recordedStepToFlowStep(roleStep('Password', 'hunter2'));
    expect(step.args?.['value']).not.toBe('hunter2');
  });

  it('leaves an ordinary role-anchored field alone', () => {
    const step = recordedStepToFlowStep(roleStep('Search issues', 'checkout'));
    expect(step.args?.['value']).toBe('checkout');
  });
});
