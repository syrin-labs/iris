import { describe, expect, it } from 'vitest';
import { restartHint } from './closing-hint.js';
import { StepStatus } from './plan.js';
import { Framework } from './detect.js';

/**
 * `init`'s last line is the one an agent acts on, and it was telling agents to stop when they should
 * have carried on.
 *
 * The restart advice branched on `wasMcpRegistered`, which is true for BOTH `APPLY` (we registered
 * the server just now) and `ALREADY` (it was registered by an earlier install). That predicate is
 * right for the funnel field it was written for — "is MCP registered on this machine" — and wrong
 * for the question the hint asks, because those two cases have opposite answers: a fresh
 * registration needs a client restart before the tools exist, and a pre-existing one does not.
 *
 * So on every machine that had ever run `init` before, and on every Claude Code plugin install
 * (where the plugin registers the server itself), the report ended with "restart your agent — the
 * tools only appear after that". An agent reads that AFTER whatever the skill file told it, and it
 * describes the tool output in front of it, so it wins: the agent stops, the user restarts for no
 * reason, and the onboarding turn ends with a wired project and nothing driven. That is the failure
 * the whole install path is written to avoid, produced by the install path itself.
 *
 * The rule these pin: only a registration that HAPPENED THIS RUN may ask anybody to restart.
 */
describe("init's closing advice only asks for a restart when one is actually needed", () => {
  it('asks for the restart when this run registered the server', () => {
    const hint = restartHint(Framework.VITE, StepStatus.APPLY);
    expect(hint).toContain('restart your agent');
    expect(hint).toContain('The tools only appear after that');
  });

  /**
   * The regression. `ALREADY` means the tools are reachable right now, so naming a restart is not
   * merely redundant: it is an instruction to stop, handed to the one reader who was about to keep
   * going.
   */
  it('never mentions a restart when the server was already registered', () => {
    const hint = restartHint(Framework.VITE, StepStatus.ALREADY);
    expect(hint).not.toContain('restart your agent');
    expect(hint).not.toContain('The tools only appear after that');
    expect(hint).not.toContain('reload the window');
  });

  /**
   * And it must say so positively rather than falling silent. A hint that merely omits the restart
   * leaves an agent that has just read about restarts in a skill file to supply one from memory.
   */
  it('says the tools are already there, so the reader carries on instead of guessing', () => {
    const hint = restartHint(Framework.VITE, StepStatus.ALREADY);
    expect(hint).toMatch(/already registered/i);
    expect(hint).toMatch(/no restart/i);
  });

  it('still names the dev-server restart and the command that proves the install, in every case', () => {
    for (const status of [
      StepStatus.APPLY,
      StepStatus.ALREADY,
      StepStatus.SKIP,
      StepStatus.MANUAL,
      undefined,
    ]) {
      const hint = restartHint(Framework.VITE, status);
      expect(hint, `status ${String(status)}`).toContain('npx @reticlehq/server status');
      expect(hint, `status ${String(status)}`).toMatch(/restart/i);
    }
  });

  /**
   * `--no-mcp` and a manual registration both mean the tools are NOT reachable, and neither is
   * something a restart fixes: there is nothing registered to pick up. Advice about a restart would
   * be advice about something this run did not do.
   */
  it('gives no client-restart advice when nothing was registered', () => {
    for (const status of [StepStatus.SKIP, StepStatus.MANUAL, undefined]) {
      const hint = restartHint(Framework.VITE, status);
      expect(hint, `status ${String(status)}`).not.toContain('restart your agent');
    }
  });
});
