/**
 * The last thing `init` prints, and the only part of it a user is asked to act on.
 *
 * Split out of `run.ts` because that file sits exactly at the 1000-line cohesion cap, and because
 * this IS a separate concern: everything else in `run.ts` decides what to write, and this decides
 * what to say afterwards. The two failure modes are different too — a wrong write breaks an
 * install, a wrong sentence loses a user quietly.
 */

import { Framework } from './detect.js';
import { StepStatus } from './plan.js';
import { wasMcpRegistered } from './mcp-registered.js';
import { CLI } from './agent-rules.js';

/**
 * The standing ask, printed at the end of every `init`.
 *
 * Addressed to the agent as much as the human: whichever of them just ran this command is the one
 * holding the experience, and neither has a Reticle tool surface to file through at this point.
 *
 * Printed by the `runInit` wrapper, NOT by `report()` — see the comment there for why, and for how
 * the workspace redirect is kept from asking twice.
 */
export const FEEDBACK_HINT =
  'Anything wrong, missing, or awkward — in this setup or in Reticle itself? Tell us; it is the ' +
  'one thing that decides what gets fixed:\n' +
  `  ${CLI} feedback --agent --kind <bug|gap|ambiguity|feature_request|improvement> "what happened"   (agents)\n` +
  `  ${CLI} feedback "what worked, what didn't"   (humans)`;

/**
 * What to say about the dev server.
 *
 * Names the project's own script when `package.json` has a recognisable one, and otherwise says the
 * THING rather than guessing the command.
 *
 * The guesses that used to live here — `vite`, `next dev`, `astro dev` — were wrong often enough to
 * be worth deleting. Measured on a real app: rowy has no `dev` script at all, so "Restart `vite`"
 * sent the reader to work out what was meant instead of starting a server. Nobody needs the guess:
 * an agent reading this can open package.json, and a human already knows how they start their own
 * app. A wrong command costs more than a missing one.
 */
function devServerRestart(_framework: Framework, devCommand?: string): string {
  return devCommand === undefined
    ? 'Restart your dev server'
    : `Restart your dev server (\`${devCommand}\`)`;
}

/**
 * The last two lines a user reads, and the order matters.
 *
 * This used to say only "Restart <dev server>, then ask your agent: List Reticle sessions" — and
 * asking the agent was the one thing that could not work yet. `init` registers the MCP server, but
 * an agent client reads its tool list when it STARTS and never re-reads it, so the session that
 * just ran `init` has no `reticle_*` tools however clean the install was. The user follows the
 * instruction, the agent answers "unknown tool", and the obvious conclusion is that the install
 * failed.
 *
 * So the reload is named FIRST, before the sentence that depends on it. Omitted entirely when this
 * run did not register MCP (`--no-mcp`), where it would be advice about something we did not do.
 */
export function restartHint(
  framework: Framework,
  mcpStatus: StepStatus | undefined,
  /** The project's own dev command, when package.json named one. */
  devCommand?: string,
): string {
  const dev = `${devServerRestart(framework, devCommand)}.`;
  // NAME THE COMMAND THAT PROVES IT, not one that merely asks.
  //
  // `init` writes files and stops; the install is not finished until an app carrying the SDK has
  // actually dialled the daemon, and nothing here confirmed that. The field shape is unambiguous:
  // people complete the agent half, never complete the app half, and keep a daemon running for
  // weeks with nothing to drive — so this is the last instruction most of them read.
  //
  // "Ask your agent: List Reticle sessions" asks a question whose failure is a dead end. `reticle
  // status` ANSWERS it: as of 2.7.0 it reports the session, or says why there is none — no app
  // running, an app running that never dialled us, a tab that closed — with the fix for each.
  // The one thing that works BEFORE the restart, so it goes before it.
  //
  // What comes after the restart, named as a JOB rather than as a capability.
  //
  // This used to point at a `reticle demo` command that opened its own browser and drove one
  // control. It was cut: a demo command is a side show. The thing a user needs to see is THEIR app,
  // instrumented in THEIR codebase, driven by THEIR agent through the tools they just installed —
  // because that is the workflow they are deciding whether to adopt, and a bespoke demo path proves
  // nothing about it.
  //
  // So the close hands the agent the sequence instead. It is deliberately one drive of one real
  // flow ending in a verdict, because an install that ends in "the tools are available" is an
  // install that ends in nothing.
  const demo =
    'Then drive one real flow of your app end to end and report the verdict — that is the install ' +
    "proving itself, and it is the agent's job, not a separate command.";
  const prove =
    'Then run `npx @reticlehq/server status` — it confirms the app connected, or says exactly why ' +
    'it has not.';
  // Nothing registered this run (`--no-mcp`, or a client that needs a manual edit): a restart picks
  // up nothing, so advice about one would be advice about something we did not do.
  if (!wasMcpRegistered(mcpStatus)) return `${dev}\n${demo}\n${prove}`;
  // ALREADY: the tools are reachable RIGHT NOW, and this is the branch that used to lie.
  //
  // `wasMcpRegistered` is true for both APPLY and ALREADY, which is correct for the funnel field it
  // was written for and wrong here, because the two cases have opposite answers to "must anybody
  // restart". Every second project on a machine, and every Claude Code plugin install, took the
  // APPLY text: "restart your agent — the tools only appear after that". An agent reads this AFTER
  // whatever its skill file said, and it describes the output in front of it, so it wins. The agent
  // stops with the project wired and nothing driven, which is the exact failure the install path
  // exists to prevent, caused by the install path itself.
  if (mcpStatus === StepStatus.ALREADY) {
    return (
      `${dev}\n` +
      `${demo}\n` +
      'The Reticle MCP server was already registered on this machine, so there is no restart to do ' +
      'and the tools are available now.\n' +
      `${prove}\n` +
      'Once it shows a session, drive a flow — that is the install finished. Carry straight on; ' +
      'nothing here is waiting on a human.'
    );
  }
  return (
    `${dev}\n` +
    `${demo}\n` +
    'Then restart your agent so it picks up the new MCP server — restart Claude Code, reload the ' +
    'window in Cursor, or hit Start in `.vscode/mcp.json` in VS Code.\n' +
    'The tools only appear after that: your agent read its server list before Reticle existed, ' +
    'and no slash command re-reads it (`/mcp` manages servers already loaded, so it cannot pick ' +
    'up a new one). This is once per machine — Reticle is registered globally, so every later ' +
    'project starts with the tools already there.\n' +
    `${prove}\n` +
    'Once it shows a session, drive one flow and report the verdict — that is the install ' +
    'finished. Do it now; nothing here is waiting on a human.'
  );
}
