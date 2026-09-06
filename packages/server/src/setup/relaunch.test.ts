import { describe, expect, it } from 'vitest';
import { relaunchDecision, RelaunchOutcome, type RelaunchEnv } from './relaunch.js';

/**
 * `--resume <id>` on an id with NO transcript opens an empty conversation under that id, silently.
 * There is no error anywhere: the client starts, the session looks real, and every tool the restart
 * existed to load is absent. A restart that lands there is worse than no restart, because it looks
 * exactly like success.
 *
 * The decision is pure and the terminal-opening is not, so only the decision lives here — which is
 * also the half that can be wrong in a way nobody notices.
 */
const env = (over: Partial<RelaunchEnv> = {}): RelaunchEnv => ({
  claudeSessionId: undefined,
  codexSessionId: undefined,
  transcriptExists: () => false,
  cwd: '/app',
  ...over,
});

describe('relaunch refuses what would look like success', () => {
  it('refuses a claude session id with no transcript, and says why', () => {
    const decision = relaunchDecision(
      env({ claudeSessionId: 'definitely-not-real-0000', transcriptExists: () => false }),
    );
    expect(decision.outcome).toBe(RelaunchOutcome.REFUSED);
    expect(decision.message).toContain('no transcript exists yet');
    expect(decision.message).toContain('EMPTY conversation');
  });

  it('names the resume command when the transcript is really there', () => {
    const decision = relaunchDecision(
      env({ claudeSessionId: 'abc-123', transcriptExists: (id) => 'abc-123' === id }),
    );
    expect(decision.outcome).toBe(RelaunchOutcome.CLAUDE);
    expect(decision.message).toContain('claude --resume abc-123');
    expect(decision.message).toContain('/app');
  });

  // Codex does not name its session in the environment; it is recognised from the rollout file it
  // is writing, which is why this is a separate branch and not a table of two.
  it('uses the codex session when there is no claude one', () => {
    const decision = relaunchDecision(env({ codexSessionId: 'rollout-9' }));
    expect(decision.outcome).toBe(RelaunchOutcome.CODEX);
    expect(decision.message).toContain('codex resume rollout-9');
  });

  // Most clients tell a child nothing at all. Saying so is better than a resume command that
  // cannot work.
  it('says plainly when the client identifies no conversation', () => {
    const decision = relaunchDecision(env());
    expect(decision.outcome).toBe(RelaunchOutcome.UNKNOWN_CLIENT);
    expect(decision.message).toContain('does not tell a child process');
  });

  // A claude id always wins: it is the client that named itself, and a stale rollout file from an
  // earlier codex run in the same directory must not redirect the restart.
  it('prefers the claude session over a codex rollout', () => {
    const decision = relaunchDecision(
      env({ claudeSessionId: 'abc', codexSessionId: 'r-1', transcriptExists: () => true }),
    );
    expect(decision.outcome).toBe(RelaunchOutcome.CLAUDE);
  });
});
