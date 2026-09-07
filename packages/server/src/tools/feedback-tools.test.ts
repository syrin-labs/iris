import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FeedbackKind, FEEDBACK_RATING_MAX, FEEDBACK_RATING_MIN } from '@reticlehq/core';
import * as feedbackModule from '../telemetry/feedback.js';
import * as telemetryModule from '../telemetry/telemetry.js';
import { TOOLS } from './tools.js';
import { ReticleTool } from './tool-names.js';
import { TOOL_SURFACE, filterTools } from './tool-surface.js';
import { buildErrorPayload, FEEDBACK_ASK, RECOVERY } from './error-recovery.js';
import { resetFeedbackPrompt, takeFeedbackPrompt, VERDICT_TOOLS } from './feedback-tools.js';
describe('reticle_feedback', () => {
  const tool = TOOLS.find((t) => t.name === ReticleTool.FEEDBACK);

  it('is registered', () => {
    expect(tool).toBeDefined();
  });

  /**
   * The tool exists to be CALLED by an agent that was not told about it in advance. Under a trimmed
   * profile an unadvertised tool is only reachable if the agent already knows the name — which, for a
   * feedback channel, means it collects nothing and is indistinguishable from not existing.
   */
  it('is advertised under every profile, not left behind the meta-tool hatch', () => {
    for (const profile of [TOOL_SURFACE.DEFAULT, TOOL_SURFACE.ALL]) {
      expect(
        filterTools(TOOLS, profile).map((t) => t.name),
        `profile '${profile}'`,
      ).toContain(ReticleTool.FEEDBACK);
    }
  });

  it('tells the agent not to paste app data — instruction is the first line of defense', () => {
    expect(tool?.description).toMatch(/never include app source|secrets|user data/i);
  });

  it('files a report with no session connected — "nothing ever connects" is the report we most need', async () => {
    const deps = {
      sessions: {
        resolve: () => {
          throw new Error('no browser session connected');
        },
      },
    } as unknown as Parameters<NonNullable<typeof tool>['handler']>[0];
    const result = (await tool?.handler(deps, {
      kind: 'gap',
      text: 'the SDK never appeared in reticle_sessions after starting the dev server',
    })) as { note: string };
    expect(result.note).toBeTypeOf('string');
  });
});

describe('the error-envelope ask', () => {
  it('asks for feedback on an UNRECOGNIZED error — the case where we learn something', () => {
    const payload = buildErrorPayload('the widget imploded in an entirely novel way');
    expect(payload.feedback).toBe(FEEDBACK_ASK);
    expect(payload.recovery).toBeUndefined();
  });

  it('stays silent when a recovery hint already gives the agent a next move', () => {
    const payload = buildErrorPayload('no browser session connected');
    expect(payload.recovery).toBe(RECOVERY.NO_SESSION);
    expect(payload.feedback).toBeUndefined();
  });
});

describe('the one-shot human prompt', () => {
  beforeEach(() => {
    resetFeedbackPrompt();
  });

  it('never fires for a non-verification tool', () => {
    expect(takeFeedbackPrompt(ReticleTool.SNAPSHOT)).toBeUndefined();
  });

  /**
   * Under vitest telemetry is disabled outright, which is precisely the state that must produce
   * silence: asking someone for feedback we have already been told not to collect spends their
   * attention on a message with nowhere to go.
   */
  it('stays silent when the channel is off, even on a verification', () => {
    expect(takeFeedbackPrompt(ReticleTool.ASSERT)).toBeUndefined();
  });

  it('covers the tools that actually end a verification', () => {
    expect(VERDICT_TOOLS.has(ReticleTool.ASSERT)).toBe(true);
    // Whole-suite replay and change verification are actions on the merged tool now, so the NAME
    // that has to be covered is the merged one — the members are never dispatched by their own name.
    expect(VERDICT_TOOLS.has(ReticleTool.VERIFY)).toBe(true);
    expect(VERDICT_TOOLS.has(ReticleTool.ACT_AND_WAIT)).toBe(true);
  });
});

/**
 * Re-arming, and its ceiling. Strictly-once was too fragile — a daemon lives for days, the prompt
 * landed on the first verification, and if the agent did not relay it in that turn the signal went to
 * zero for the whole process with nothing to tell us.
 */
describe('the human prompt re-arms, but is capped', () => {
  beforeEach(() => {
    resetFeedbackPrompt();
    vi.restoreAllMocks();
  });

  const enableChannel = (): void => {
    vi.spyOn(telemetryModule, 'getTelemetry').mockReturnValue({
      emit: () => Promise.resolve(true),
      enabled: true,
      firstRun: false,
    });
  };

  it('asks on the first verification, then stays quiet through the next run of work', () => {
    enableChannel();
    expect(takeFeedbackPrompt(ReticleTool.ASSERT)).toBeDefined();
    for (let i = 0; i < 20; i += 1) {
      expect(takeFeedbackPrompt(ReticleTool.ASSERT), `verification ${i}`).toBeUndefined();
    }
  });

  it('asks again once enough verifications have gone by', () => {
    enableChannel();
    takeFeedbackPrompt(ReticleTool.ASSERT);
    let second: unknown;
    for (let i = 0; i < 40 && second === undefined; i += 1) {
      second = takeFeedbackPrompt(ReticleTool.ASSERT);
    }
    expect(second).toBeDefined();
  });

  it('never asks more than three times, however long the session runs', () => {
    enableChannel();
    let asks = 0;
    for (let i = 0; i < 500; i += 1) {
      if (takeFeedbackPrompt(ReticleTool.ASSERT) !== undefined) asks += 1;
    }
    expect(asks).toBe(3);
  });
});

/**
 * The praise channel. Every kind the agent could file was a complaint, so the only thing an agent
 * could ever tell us was what was wrong — which makes the feedback corpus a defect list and leaves
 * "what is already worth keeping" with no evidence behind it at all.
 */
describe('an agent can report that something worked, not only that it broke', () => {
  const tool = TOOLS.find((t) => t.name === ReticleTool.FEEDBACK);
  const kindSchema = tool?.inputSchema['kind'] as z.ZodEnum<[string, ...string[]]> | undefined;
  const ratingSchema = tool?.inputSchema['rating'];

  it('offers the experience kind, which until now only a human could file', () => {
    expect(kindSchema?.options).toContain(FeedbackKind.EXPERIENCE);
  });

  it('takes a star rating on the same scale the human channel already uses', () => {
    // Reusing core's bounds rather than inventing a second scale: two rating scales in one corpus
    // cannot be averaged together, and nothing would say which one a row came from.
    expect(ratingSchema?.safeParse(FEEDBACK_RATING_MIN).success).toBe(true);
    expect(ratingSchema?.safeParse(FEEDBACK_RATING_MAX).success).toBe(true);
  });

  it('refuses a rating off the scale, rather than storing a number nothing can interpret', () => {
    expect(ratingSchema?.safeParse(FEEDBACK_RATING_MIN - 1).success).toBe(false);
    expect(ratingSchema?.safeParse(FEEDBACK_RATING_MAX + 1).success).toBe(false);
    expect(ratingSchema?.safeParse(4.5).success).toBe(false);
  });

  it('asks what happened, not just how many stars', () => {
    // A bare score is unusable: it cannot be acted on, cannot be quoted, and cannot be told apart
    // from a model being agreeable. The description has to demand the concrete moment behind it,
    // and has to say the quiet part out loud, that this is filed unprompted or not at all.
    expect(tool?.description).toMatch(/unprompted/i);
    expect(tool?.description).toMatch(/concretely|what happened|which call/i);
    const ratingDescription = JSON.stringify(tool?.inputSchema['rating']?.description ?? '');
    expect(ratingDescription).toMatch(/agreeable|never because you were asked/i);
  });

  it('carries the rating through to the report rather than dropping it silently', async () => {
    // The trap this pins: a new tool field needs the input schema AND the handler AND the wire
    // schema. Miss the handler and the call still succeeds, the receipt still says accepted, and
    // the number is simply never in the data.
    const filed: Record<string, unknown>[] = [];
    const spy = vi.spyOn(feedbackModule, 'submitFeedback').mockImplementation((input: unknown) => {
      filed.push(input as Record<string, unknown>);
      return Promise.resolve({ sent: false, accepted: true, redacted: [], note: '' } as never);
    });
    const deps = {
      sessions: {
        resolve: () => {
          throw new Error('no browser session connected');
        },
      },
    } as unknown as Parameters<NonNullable<typeof tool>['handler']>[0];

    await tool?.handler(deps, {
      kind: FeedbackKind.EXPERIENCE,
      text: 'act_and_wait proved the checkout flow in one call where I would have taken four.',
      rating: 5,
    });

    expect(filed[0]?.['rating']).toBe(5);
    expect(filed[0]?.['kind']).toBe(FeedbackKind.EXPERIENCE);
    spy.mockRestore();
  });
});
