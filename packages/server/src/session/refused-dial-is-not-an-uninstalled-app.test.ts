/**
 * #685: a globally-registered MCP server runs outside the project, and every symptom points
 * somewhere other than the cause.
 *
 * The daemon starts with a cwd of `/` or `$HOME`, finds no `.reticle.json` there, and refuses every
 * page on the pairing token — while `doctor`, run from the app directory, reports the project wired.
 * `reticle_sessions` then told the agent to run `reticle init` on a project that is already
 * instrumented. One reporter burned a turn re-running init over a working config.
 *
 * The daemon already RECORDED the refusal (`noteClosure(WS_CLOSE_REASON.AUTH_FAILED)`). Nothing read
 * it as a diagnosis.
 */
import { describe, expect, it } from 'vitest';
import { NoSessionAction } from '@reticlehq/core';
import { nextActionFor } from './no-session-next-action.js';

const LISTENING = [5173];

describe('a refused dial proves the app is instrumented', () => {
  it('does not tell an agent to init over a config that already works', () => {
    const next = nextActionFor({
      everConnected: false,
      initialized: false,
      listening: LISTENING,
      dev: undefined,
      authRefused: true,
    });

    expect(next.action).not.toBe(NoSessionAction.RUN_INIT);
    expect(next.action).toBe(NoSessionAction.OPEN_APP);
  });

  it('says why: the app is running and instrumented, the daemon is out of scope', () => {
    const next = nextActionFor({
      everConnected: false,
      initialized: false,
      listening: LISTENING,
      dev: undefined,
      authRefused: true,
    });

    expect(next.reason).toContain('refused on the pairing token');
    expect(next.reason).toContain('SCOPE problem');
    expect(next.reason).toContain('not an install problem');
  });

  it('tells the agent explicitly NOT to run init', () => {
    // The wrong action here is not merely unhelpful — `init` can overwrite the config that works.
    const next = nextActionFor({
      everConnected: false,
      initialized: false,
      listening: LISTENING,
      dev: undefined,
      authRefused: true,
    });

    expect(next.reason).toContain('Do NOT run `reticle init`');
    expect(next.command).toBeUndefined();
  });

  it('hands over the two things that DO work', () => {
    const next = nextActionFor({
      everConnected: false,
      initialized: false,
      listening: LISTENING,
      dev: undefined,
      authRefused: true,
    });

    expect(next.reason).toContain('reticle_lease');
    expect(next.reason).toContain("the app's own directory");
  });

  it('carries the listening port when there is exactly one', () => {
    const next = nextActionFor({
      everConnected: false,
      initialized: false,
      listening: [5173],
      dev: undefined,
      authRefused: true,
    });
    expect(next.port).toBe(5173);
  });
});

describe('the branches it must not disturb', () => {
  it('still says run init when nothing has dialled at all', () => {
    // No refusal means no evidence the app carries an SDK — the original diagnosis stands.
    const next = nextActionFor({
      everConnected: false,
      initialized: false,
      listening: LISTENING,
      dev: undefined,
    });

    expect(next.action).toBe(NoSessionAction.RUN_INIT);
  });

  it('still says run init when the fact is explicitly false', () => {
    const next = nextActionFor({
      everConnected: false,
      initialized: false,
      listening: LISTENING,
      dev: undefined,
      authRefused: false,
    });

    expect(next.action).toBe(NoSessionAction.RUN_INIT);
  });

  it('leaves a locally-initialized project alone', () => {
    const next = nextActionFor({
      everConnected: false,
      initialized: true,
      listening: LISTENING,
      dev: undefined,
      authRefused: true,
    });

    expect(next.action).not.toBe(NoSessionAction.RUN_INIT);
    expect(next.reason).not.toContain('SCOPE problem');
  });

  it('still reports a daemon split first, which outranks everything', () => {
    const next = nextActionFor({
      everConnected: false,
      initialized: false,
      listening: LISTENING,
      dev: undefined,
      authRefused: true,
      splitBrain: 'another daemon on 4401 serves this project',
    });

    expect(next.action).toBe(NoSessionAction.DAEMON_SPLIT);
  });

  it('still reopens for a project that connected earlier', () => {
    const next = nextActionFor({
      everConnected: true,
      initialized: false,
      listening: LISTENING,
      dev: undefined,
      authRefused: true,
    });

    expect(next.action).toBe(NoSessionAction.REOPEN_APP);
  });

  it('still starts the dev server when nothing is listening', () => {
    const next = nextActionFor({
      everConnected: false,
      initialized: false,
      listening: [],
      dev: undefined,
      authRefused: true,
    });

    expect(next.action).toBe(NoSessionAction.START_DEV_SERVER);
  });
});
