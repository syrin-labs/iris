import { describe, expect, it } from 'vitest';
import { FEEDBACK_TEXT_MAX, StackUnknownReason } from '@reticlehq/core';
import {
  FEEDBACK_ENV,
  REDACTED,
  feedbackDisabled,
  redactFeedbackText,
  submitFeedback,
} from './feedback.js';
import { detectMcpScope, detectStack } from './feedback-context.js';

/**
 * The redaction tests are the privacy contract, written as examples of what must never reach the
 * wire. Feedback is the only free text Reticle sends, so each case here is a leak that would
 * otherwise be real: someone pastes a failing fetch, and the Authorization header rides along.
 */
describe('redactFeedbackText', () => {
  it('strips an email address', () => {
    const out = redactFeedbackText('login failed for ada@example.com on submit', FEEDBACK_TEXT_MAX);
    expect(out.text).not.toContain('ada@example.com');
    expect(out.text).toContain(REDACTED);
    expect(out.removed).toContain('email');
  });

  it('strips credentials inline in a URL but keeps the scheme, so the trace still reads', () => {
    const out = redactFeedbackText(
      'called https://admin:hunter2@api.internal/v1',
      FEEDBACK_TEXT_MAX,
    );
    expect(out.text).not.toContain('hunter2');
    expect(out.text).toContain('https://');
    expect(out.removed).toContain('url-credentials');
  });

  it('strips a credential VALUE and keeps its key — the key is the useful half', () => {
    const out = redactFeedbackText('header authorization: Bearer abc123XYZ', FEEDBACK_TEXT_MAX);
    expect(out.text).not.toContain('abc123XYZ');
    expect(out.text.toLowerCase()).toContain('authorization');
  });

  it.each([
    ['sk-abcdefghijklmnopqrstuvwx', 'vendor-key'],
    ['ghp_abcdefghijklmnopqrstuvwxyz1234', 'github-token'],
    ['AKIAIOSFODNN7EXAMPLE', 'aws-key'],
    ['xoxb-1234567890-abcdefghij', 'slack-token'],
  ])('strips the self-identifying token %s', (secret, label) => {
    const out = redactFeedbackText(`the request used ${secret} and failed`, FEEDBACK_TEXT_MAX);
    expect(out.text).not.toContain(secret);
    expect(out.removed).toContain(label);
  });

  it('strips a home directory path — it carries the account name', () => {
    const out = redactFeedbackText('stack at /Users/ada/projects/app.tsx:10', FEEDBACK_TEXT_MAX);
    expect(out.text).not.toContain('/Users/ada');
    expect(out.removed).toContain('home-path');
  });

  it('leaves an ordinary report untouched and reports nothing removed', () => {
    const clean = 'reticle_act clicked the button but no click event was observed';
    const out = redactFeedbackText(clean, FEEDBACK_TEXT_MAX);
    expect(out.text).toBe(clean);
    expect(out.removed).toEqual([]);
  });

  it('caps the length so a pasted log cannot become an unbounded upload', () => {
    const out = redactFeedbackText('x'.repeat(FEEDBACK_TEXT_MAX + 500), FEEDBACK_TEXT_MAX);
    expect(out.text).toHaveLength(FEEDBACK_TEXT_MAX);
  });
});

describe('feedbackDisabled', () => {
  it.each(['0', 'false', 'off', 'no'])('treats %s as off', (value) => {
    expect(feedbackDisabled({ [FEEDBACK_ENV]: value })).toBe(true);
  });

  it('is on when unset — the channel is opt-out, like the rest of telemetry', () => {
    expect(feedbackDisabled({})).toBe(false);
  });
});

describe('submitFeedback', () => {
  /**
   * Under vitest the emitter is a hard no-op (a test run is not a user), so every send here reports
   * `sent:false` with a reason. That is the assertion worth having: a disabled channel must DROP the
   * report and say so plainly, never silently pretend to have delivered it.
   */
  it('reports non-delivery instead of pretending, and still redacts + returns context', async () => {
    const receipt = await submitFeedback({
      source: 'agent',
      kind: 'bug',
      text: 'reticle_act failed; contact ada@example.com',
    });
    expect(receipt.sent).toBe(false);
    expect(receipt.reason).toBeDefined();
    expect(receipt.redacted).toContain('email');
  });

  it('never throws — a feedback send must not take down the call that reported the failure', async () => {
    await expect(submitFeedback({ source: 'agent', kind: 'gap', text: '' })).resolves.toMatchObject(
      { sent: false },
    );
  });

  it('refuses an explicit kill switch by name, so the reason is actionable', async () => {
    const receipt = await submitFeedback(
      { source: 'human', kind: 'experience', text: 'good', rating: 5 },
      { env: { [FEEDBACK_ENV]: '0' } },
    );
    expect(receipt.sent).toBe(false);
    expect(receipt.reason).toContain(FEEDBACK_ENV);
  });
});

describe('feedback context detection', () => {
  const pkg = (deps: Record<string, string>): string => JSON.stringify({ dependencies: deps });

  it('prefers the meta-framework over the view library it depends on', () => {
    // Every Next app also depends on react; reporting `react` would collapse the single most
    // important segment we have into the generic bucket.
    expect(detectStack('/p', () => pkg({ next: '15.0.0', react: '19.0.0' }))).toEqual({
      stack: 'next',
      stackMajor: 15,
      // `cwd` because the manifest was right here. `workspace` means discovery had to walk down to
      // find the app — the split that says how often our inference needs help.
      stackSource: 'cwd',
    });
    expect(detectStack('/p', () => pkg({ nuxt: '3.0.0', vue: '3.4.0' })).stack).toBe('nuxt');
  });

  it.each([
    [{ react: '^19.1.0' }, 'react', 19],
    [{ vue: '3.4.0' }, 'vue', 3],
    [{ astro: '~4.0.0' }, 'astro', 4],
    [{ 'solid-js': '1.8.0' }, 'solid', 1],
    [{ '@sveltejs/kit': '2.0.0' }, 'sveltekit', 2],
  ])('detects %o with its major version', (deps, stack, stackMajor) => {
    expect(detectStack('/p', () => pkg(deps))).toEqual({ stack, stackMajor, stackSource: 'cwd' });
  });

  it('reports the stack without a major when the range has no readable number', () => {
    expect(detectStack('/p', () => pkg({ react: 'workspace:*' }))).toEqual({
      stack: 'react',
      stackSource: 'cwd',
    });
  });

  it('returns nothing rather than guessing when package.json is unreadable', () => {
    // No guessed stack, as before. The miss now names itself (#617); an unreadable manifest is not
    // evidence ABOUT the app, so it reports NO_APP_FOUND rather than claiming we recognised nothing.
    const got = detectStack('/p', () => {
      throw new Error('ENOENT');
    });
    expect(got.stack).toBeUndefined();
    expect(got.stackMajor).toBeUndefined();
    expect(got.stackSource).toBeUndefined();
    expect(got.stackUnknownReason).toBe(StackUnknownReason.NO_APP_FOUND);
  });

  it('reads project scope from a checked-in MCP registration, user scope otherwise', () => {
    expect(detectMcpScope('/p', (path) => path.endsWith('.mcp.json'))).toBe('project');
    expect(detectMcpScope('/p', () => false)).toBe('user');
  });
});

/**
 * Feature requests from AGENTS.
 *
 * Reticle is built for agents, which makes the agent the user whose wishes decide the roadmap — and
 * the one user who never got asked. It would hit a limitation, work around it, finish the task, and
 * the wish would evaporate with its context window. These pin the channel that catches it.
 */
describe('agents can ask for things, not only report failures', () => {
  it('accepts a feature request with the why, the impact and the workaround', async () => {
    const receipt = await submitFeedback({
      source: 'agent',
      kind: 'feature_request',
      text: 'A way to assert that no request fired during an action.',
      need: 'Verifying a debounced search does NOT call the API on every keystroke.',
      impact: 'Removes a 3-call workaround from every debounce check.',
      currentApproach: 'Calling reticle_network before and after and diffing counts by hand.',
      model: 'claude-opus-4',
    });
    // Under vitest the emitter is a no-op, so the assertion is that it VALIDATES and is not rejected.
    expect(receipt.reason).not.toMatch(/invalid/i);
    expect(receipt.redacted).toEqual([]);
  });

  it('separates a feature request from an improvement — the responses differ completely', async () => {
    for (const kind of ['feature_request', 'improvement'] as const) {
      const receipt = await submitFeedback({ source: 'agent', kind, text: 'x' });
      expect(receipt.reason, `kind '${kind}' was rejected`).not.toMatch(/invalid/i);
    }
  });

  /**
   * The model cannot come from the transport: MCP's clientInfo carries a name and version and has no
   * concept of a model. Self-reporting is the only mechanism, so it must survive the pipeline.
   */
  it('carries the self-reported model, which no other channel can supply', async () => {
    const receipt = await submitFeedback({
      source: 'agent',
      kind: 'improvement',
      text: 'x',
      model: 'gpt-5',
    });
    expect(receipt.reason).not.toMatch(/invalid/i);
  });

  /**
   * A real leak, caught by writing the test properly.
   *
   * Redaction originally named `text` and `trace` explicitly, so when `need`, `impact` and
   * `currentApproach` were added they bypassed it entirely and went to the wire raw. The first
   * version of THIS test passed anyway — because it put an email in `text` and only checked that
   * something was redacted. Each field is now asserted on its own, with a secret that appears
   * nowhere else, so a bypass cannot hide behind a sibling field.
   */
  it.each([
    ['need', 'need', 'ada@example.com', 'email'],
    ['impact', 'impact', 'ada@example.com', 'email'],
    ['currentApproach', 'currentApproach', 'sk-abcdefghijklmnopqrstuvwx', 'vendor-key'],
    ['trace', 'trace', 'sk-abcdefghijklmnopqrstuvwx', 'vendor-key'],
  ])(
    'redacts %s — every author-written field, not just the ones named first',
    async (_label, field, secret, rule) => {
      const receipt = await submitFeedback({
        source: 'agent',
        kind: 'feature_request',
        // `text` is deliberately CLEAN, so a pass can only come from the field under test.
        text: 'a way to assert that no request fired',
        [field]: `we currently do it by ${secret}`,
      });
      expect(receipt.redacted, `${field} was not redacted`).toContain(rule);
    },
  );
});
