/**
 * "No browser session connected", as something an agent can RUN.
 *
 * The prose diagnosis next door is good and it is prose: the agent has to read four hedged sentences
 * and decide which of them is about its situation. This is the same decision, decided here, as one
 * value plus one literal command — so the branch happens in the daemon, which has the evidence,
 * rather than in the agent, which does not.
 *
 * The rule that outranks helpfulness: never invent a command. If the project has no dev script, this
 * says there is none. A command that does not exist sends the agent chasing a phantom error in its
 * own repo.
 *
 * Pure. The facts arrive from the watch; nothing here touches the disk or the clock.
 */

import { NoSessionAction } from '@reticlehq/core';
import type { DevCommand } from './dev-command.js';

/** The executable half of the no-session payload. */
export interface NoSessionNextAction {
  action: NoSessionAction;
  /** The literal command to run. Absent whenever it could not be sourced without guessing. */
  command?: string;
  /** The port this action is about — where the app is, or where the dev script will put it. */
  port?: number;
  /** One sentence: why this is the action, and — when there is no command — why there is none. */
  reason: string;
}

interface NextActionFacts {
  everConnected: boolean;
  initialized: boolean;
  listening: readonly number[];
  dev: DevCommand | undefined;
  /** Configs found in other workspace directories: positive evidence of a scope mismatch. */
  configsElsewhere?: readonly { directory: string; projectId?: string }[];
  /**
   * The sentence for a live daemon elsewhere that this project's app is actually connected to.
   *
   * Passed rendered rather than as ports, because the rule that produces it lives in the module that
   * owns "which daemon is whose" and this file must stay pure. Absent when there is no split.
   */
  splitBrain?: string;
  /**
   * An app for this project has connected on this port before, from durable state.
   *
   * Outranks `initialized`, which is only ever "is there a `.reticle.json` in the ONE directory this
   * daemon stands in". In a monorepo, or under an editor that starts the MCP server from the user's
   * home, that answer is no for projects that are wired and have connected — and the action handed
   * back was `reticle init`, which is the one action that cannot help and can overwrite the config
   * that works.
   */
  previouslyConnected?: boolean;
  /**
   * A page reached this daemon and was REFUSED on the pairing token.
   *
   * Positive evidence, and the only fact here that proves the app is both running and instrumented:
   * nothing dials the bridge but an SDK, so a refused hello means the wiring works and the daemon
   * would not serve it. That happens whenever an IDE registers the MCP server GLOBALLY -- the daemon
   * starts with a cwd of `/` or `$HOME`, finds no `.reticle.json` there, and refuses every page
   * while `doctor` run from the app directory reports the project wired (#685).
   *
   * Without it, `initialized: false` plus a listening port reads as "the app may carry no SDK" and
   * the action handed back is `reticle init` -- over a config that already works, which is the one
   * action that cannot help and can overwrite it.
   */
  authRefused?: boolean;
}

/** `reticle init`, the only command here that is Reticle's own and so cannot be wrong. */
const INIT_COMMAND = 'reticle init';
const OPEN_COMMAND = 'reticle open';
const LOCALHOST = 'http://localhost';

export function nextActionFor(facts: NextActionFacts): NoSessionNextAction {
  // FIRST, above every other cause, because it is the only one supported by positive evidence about
  // a daemon rather than by an absence. This project's own connection record names a live daemon
  // that is not this one, which means the app is up and instrumented and the agent is simply looking
  // at the wrong process. Every branch below would send it to fix something that is not broken —
  // start a dev server that is running, open a page that is open, or re-run `init` over a config
  // that works — and the agent has no way to suspect the real cause from here.
  const splitBrain = facts.splitBrain;
  if (splitBrain !== undefined) {
    return { action: NoSessionAction.DAEMON_SPLIT, reason: splitBrain };
  }

  if (facts.everConnected) {
    const listening = facts.listening;
    const only = 1 === listening.length ? listening[0] : undefined;
    const bound =
      0 === listening.length
        ? ''
        : only === undefined
          ? ` An app is already listening on ${listening.join(', ')}; just open the URL the human names — do not start a second stack.`
          : ` An app is already listening on ${String(only)}; just open ${LOCALHOST}:${String(only)} — do not start a second stack.`;
    return {
      action: NoSessionAction.REOPEN_APP,
      ...(only === undefined
        ? {}
        : { command: `${OPEN_COMMAND} ${LOCALHOST}:${String(only)}`, port: only }),
      reason:
        'a session was connected to this daemon earlier, so the wiring is correct — the tab was ' +
        'closed, reloaded, or the lease aged out. Reopen the app, or take one you own with ' +
        'reticle_lease {action:"acquire", url}.' +
        bound,
    };
  }

  const configsElsewhere = facts.configsElsewhere ?? [];
  if (!facts.initialized && configsElsewhere.length > 0) {
    const named = configsElsewhere
      .map((config) =>
        config.projectId === undefined
          ? config.directory
          : `${config.directory} ('${config.projectId}')`,
      )
      .join(', ');
    const projectIds = configsElsewhere.flatMap((config) =>
      config.projectId === undefined ? [] : [config.projectId],
    );
    const leaseAlternative =
      0 === projectIds.length
        ? ''
        : ' Alternatively, acquire the app URL explicitly with reticle_lease ' +
          '{action:"acquire", url, projectId} using the matching projectId above.';
    return {
      action: NoSessionAction.OPEN_APP,
      reason:
        `a \`.reticle.json\` was found outside this daemon's directory: ${named}. This is a ` +
        "scope problem, not an install problem. Restart the daemon from the app's directory (or " +
        `point it there), then open the app.${leaseAlternative}`,
    };
  }

  if (0 === facts.listening.length) {
    const dev = facts.dev;
    if (dev === undefined) {
      return {
        action: NoSessionAction.START_DEV_SERVER,
        reason:
          'nothing is listening on the ports Reticle scans, so the app is probably not running — ' +
          'but this project declares no dev script (no `dev`, `develop` or `start` in its ' +
          'package.json), so there is no command to hand you. Ask the human how their app is ' +
          'started, and for the URL it serves on.',
      };
    }
    return {
      action: NoSessionAction.START_DEV_SERVER,
      command: dev.command,
      ...(dev.port === undefined ? {} : { port: dev.port }),
      // "Probably", to match the branch above it and the paragraph beside it.
      //
      // The same fact was stated at two confidence levels by one function: no dev script said the
      // app was "probably not running", and THIS branch — the one that hands over a command to run
      // — asserted it flatly. That is the branch where being wrong costs something, because the
      // agent then starts a SECOND dev server on a second port, which the guard below calls the
      // exact confusion this probe exists to prevent.
      //
      // It also contradicted its own payload: the prose beside it says the scan is narrow, that a
      // server on any other port is invisible to it, and that a running app should be checked for
      // rather than assumed away. Measured on a machine with three dev servers up on ports the scan
      // does not cover, it reported the app was not running.
      reason:
        'nothing is listening on the ports Reticle scans, so the app is probably not running — ' +
        'though that scan is narrow, so if it IS up on another port, ask for its URL instead of ' +
        `starting a second one. This is the project's own \`${dev.script}\` script — run it in the ` +
        'background, tell the human it is running, then call reticle_sessions again.',
    };
  }

  // Something IS up. Whatever else is true, do NOT hand back a start command: a second dev server on
  // a second port is the exact confusion the probe exists to prevent.
  const ports = facts.listening.join(', ');
  const only = 1 === facts.listening.length ? facts.listening[0] : undefined;

  // A refused dial outranks the absence of a local config, for the same reason `previouslyConnected`
  // does: it is positive evidence about the app, and `initialized` only ever answers "is there a
  // `.reticle.json` in the ONE directory this daemon stands in". A globally-registered daemon stands
  // in `/` or `$HOME`, so that answer is no for every project it serves -- and every page it turns
  // away is proof that the project it turned away is wired.
  if (!facts.initialized && true === facts.authRefused) {
    return {
      action: NoSessionAction.OPEN_APP,
      ...(only === undefined ? {} : { port: only }),
      reason:
        `a page dialled this daemon and was refused on the pairing token, so the app IS running ` +
        `and instrumented (${ports} listening) — this is a SCOPE problem, not an install problem. ` +
        'This daemon was started outside the project (an IDE that registers the MCP server ' +
        'globally starts it in `/` or your home directory), so it has no `.reticle.json` to match ' +
        'the page against. Do NOT run `reticle init`: the config it would write is already correct ' +
        'somewhere else. Take a context you own instead with reticle_lease {action:"acquire", url, ' +
        "projectId}, or restart the daemon from the app's own directory.",
    };
  }

  if (!facts.initialized && true !== facts.previouslyConnected) {
    return {
      action: NoSessionAction.RUN_INIT,
      command: INIT_COMMAND,
      ...(only === undefined ? {} : { port: only }),
      reason:
        `something is listening (${ports}) but no \`.reticle.json\` was found, so the app may ` +
        "carry no Reticle SDK. Run this in the APP's own directory — in a monorepo that is not " +
        'where this daemon stands — then restart the dev server.',
    };
  }

  if (only === undefined) {
    return {
      action: NoSessionAction.OPEN_APP,
      reason:
        `this project is wired and no page is open. Several ports are listening (${ports}) and ` +
        'none of them can be attributed to this project, so open the one the human names: ' +
        `\`${OPEN_COMMAND} <url>\`.`,
    };
  }
  // Two causes sit under this branch and only one of them is fixed by opening a page.
  //
  // The prose diagnosis next door already ranks them and puts the stale bundle first: `init` writes
  // the plugin into a config the RUNNING dev server has already read, so the served bundle carries
  // no SDK and reloading it cannot ever produce a session. This function — the half an agent
  // actually executes — used to say only "open the app", which is the answer to the OTHER cause.
  // An agent that follows it opens a bundle with no Reticle in it, sees no session, and has been
  // given no reason to suspect the one thing that would have worked.
  //
  // Named only while nothing has EVER connected. Once a session has been here the wiring is proven
  // and sending an agent to restart a working dev server is a wild goose chase.
  const neverConnected = true !== facts.previouslyConnected;
  return {
    action: NoSessionAction.OPEN_APP,
    command: `${OPEN_COMMAND} ${LOCALHOST}:${String(only)}`,
    port: only,
    reason: neverConnected
      ? 'this project is wired and a dev server is listening, but no app has ever connected to ' +
        'this daemon — Reticle only ever sees a page a browser has LOADED, and nothing has loaded ' +
        'one. If opening it does not produce a session, the dev server is older than the Reticle ' +
        'plugin and its bundle carries no SDK: restart the dev server (do not rely on HMR) and ' +
        'load the page again.'
      : 'this project is wired and a dev server is listening — Reticle only ever sees a page a ' +
        'browser has LOADED, and nothing has loaded one.',
  };
}

/** The same action as one sentence, for the prose message the human reads. */
export function renderNextAction(next: NoSessionNextAction): string {
  const command = next.command;
  return command === undefined
    ? `NEXT ACTION: ${next.reason}`
    : `NEXT ACTION: run \`${command}\` — ${next.reason}`;
}
