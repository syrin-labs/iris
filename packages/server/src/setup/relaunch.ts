/**
 * What restarting the calling client should do — decided, not performed.
 *
 * The dangerous case is the one this exists for: `--resume <id>` on an id with NO transcript opens
 * an EMPTY conversation under that id, silently. Nothing errors, the client starts, the session
 * looks real, and every tool the restart existed to load is missing. A restart that lands there is
 * worse than no restart, because it is indistinguishable from success.
 *
 * The decision is pure and testable; opening a terminal is neither, and is left to the caller.
 */

/** What the caller should do, once the environment has been read. */
export const RelaunchOutcome = {
  /** Claude Code named its own session and a transcript backs it. */
  CLAUDE: 'claude',
  /** No claude session, but a codex rollout in this directory identifies one. */
  CODEX: 'codex',
  /** A session id with nothing behind it — the case that looks like success. */
  REFUSED: 'refused',
  /** The client tells a child process nothing about which conversation it is. */
  UNKNOWN_CLIENT: 'unknown-client',
} as const;
export type RelaunchOutcome = (typeof RelaunchOutcome)[keyof typeof RelaunchOutcome];

export interface RelaunchEnv {
  /** Claude Code puts its session id in the environment; nothing else does. */
  readonly claudeSessionId?: string | undefined;
  /** Codex is recognised from the rollout file it is writing, not from the environment. */
  readonly codexSessionId?: string | undefined;
  /** Does a transcript actually exist for this id. */
  transcriptExists(sessionId: string): boolean;
  readonly cwd: string;
}

interface RelaunchDecision {
  readonly outcome: RelaunchOutcome;
  readonly message: string;
}

/** The prompt a resumed session is handed, so the restart continues the work rather than idling. */
const RESUME_PROMPT = 'Reticle is installed. Continue where we left off.';

export function relaunchDecision(env: RelaunchEnv): RelaunchDecision {
  const { claudeSessionId, codexSessionId } = env;
  // A claude id wins whenever there is one: that client named ITSELF, and a stale rollout file from
  // an earlier codex run in the same directory must not redirect the restart.
  if (claudeSessionId !== undefined && '' !== claudeSessionId) {
    if (!env.transcriptExists(claudeSessionId)) {
      return {
        outcome: RelaunchOutcome.REFUSED,
        message:
          `refusing to restart: no transcript exists yet for ${claudeSessionId}, and \`--resume\` ` +
          'on an id with no transcript opens an EMPTY conversation that looks exactly like it ' +
          'worked. Say something in this session first, then re-run with --relaunch.',
      };
    }
    return {
      outcome: RelaunchOutcome.CLAUDE,
      message:
        'restart this conversation with the tools loaded:\n  ' +
        `cd ${JSON.stringify(env.cwd)} && claude --resume ${claudeSessionId} ` +
        `${JSON.stringify(RESUME_PROMPT)}`,
    };
  }
  if (codexSessionId !== undefined && '' !== codexSessionId) {
    return {
      outcome: RelaunchOutcome.CODEX,
      message:
        'restart this conversation with the tools loaded:\n  ' +
        `cd ${JSON.stringify(env.cwd)} && codex resume ${codexSessionId} ` +
        `${JSON.stringify(RESUME_PROMPT)}`,
    };
  }
  return {
    outcome: RelaunchOutcome.UNKNOWN_CLIENT,
    message:
      'this client does not tell a child process which conversation it is, so nothing here can ' +
      'resume it. Restart it once and the reticle_* tools will be there.',
  };
}
