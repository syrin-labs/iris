import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import { RETICLE_PROTOCOL_VERSION, MessageKind, type HelloMessage } from '@reticlehq/core';
import { Session, SessionManager } from './session.js';
import { decideOpen, summarizeStatus } from '../cli/cli-launch.js';

/**
 * A tab that is attached and answers nothing must stop being reported as a usable tab.
 *
 * The wedge this pins: the SDK keeps streaming events (so `lastSeenMs` stays fresh and the session
 * looks healthy) while every COMMAND times out. `reticle open` then reused that tab forever, and
 * `reticle_session{action:"end"}` did not help — it flips a state flag, it does not make the page
 * answer. The only escape was killing the daemon.
 *
 * The evidence is already in hand at the moment it matters: the daemon watched the page miss its
 * command budget. Counting that is the whole liveness proof — no extra probe, no new route.
 */

const HELLO: HelloMessage = {
  kind: MessageKind.HELLO,
  protocolVersion: RETICLE_PROTOCOL_VERSION,
  sessionId: 'wedged',
  url: 'http://localhost:4321/',
  title: 'Demo',
  adapters: [],
  hasCapabilities: false,
};

const fakeSocket = { send: (): void => {} } as unknown as WebSocket;

/** A session whose page never replies: every command runs its timer out. */
function wedgedSession(): Session {
  return new Session(HELLO, fakeSocket, () => Date.now());
}

/** Drive `n` commands to their timeout with a 1ms budget (real timers, no clock assertions). */
async function timeOutCommands(session: Session, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await session.command('snapshot', {}, 1).catch(() => undefined);
  }
}

describe('a page that does not answer is not a usable session', () => {
  it('reports unresponsive once the page has missed its command budget repeatedly', async () => {
    const session = wedgedSession();
    expect(session.unresponsive()).toBe(false);
    await timeOutCommands(session, 2);
    expect(session.unresponsive()).toBe(true);
    expect(session.info().unresponsive).toBe(true);
  });

  it('one slow command is not a wedge — a busy page gets the benefit of the doubt', async () => {
    const session = wedgedSession();
    await timeOutCommands(session, 1);
    expect(session.unresponsive()).toBe(false);
  });

  it('forgets the wedge the moment the page answers anything', async () => {
    const session = wedgedSession();
    await timeOutCommands(session, 3);
    expect(session.unresponsive()).toBe(true);
    // A reply is proof the command channel works, whichever command it belonged to.
    session.handleResult({
      kind: MessageKind.COMMAND_RESULT,
      id: 'c99',
      ok: true,
      result: {},
    });
    expect(session.unresponsive()).toBe(false);
  });

  /**
   * `reticle open` is the command a caller reaches for to RECOVER. Handing back the tab that is
   * refusing to answer is the one thing it must not do — the reported symptom was `{"reusing": …}`
   * followed by 8000ms timeouts with no way out short of killing the daemon.
   */
  it('reticle open opens a fresh tab instead of reusing a wedged one', () => {
    const url = 'http://localhost:4321/';
    expect(decideOpen([{ url, unresponsive: true }], url)).toEqual({ action: 'open', url });
    // Same tab answering normally: reuse, exactly as before.
    expect(decideOpen([{ url }], url)).toEqual({ action: 'reuse', url });
  });

  it('does not reuse a wedged tab when no url was named either', () => {
    expect(decideOpen([{ url: 'http://localhost:4321/', unresponsive: true }], undefined)).toEqual({
      action: 'need-url',
    });
  });

  /**
   * The same bug one layer down: auto-selection scored on recency, and a wedged tab keeps STREAMING
   * events, so it looks like the freshest tab in the app while being the one tab that cannot answer.
   */
  it('auto-selection prefers a healthy sibling over the wedged tab', async () => {
    const sessions = new SessionManager();
    const wedged = wedgedSession();
    const healthy = new Session({ ...HELLO, sessionId: 'healthy' }, fakeSocket, () => Date.now());
    sessions.add(wedged);
    sessions.add(healthy);
    await timeOutCommands(wedged, 2);
    expect(sessions.resolve().id).toBe('healthy');
  });

  it('carries the flag off the daemon /status wire so the CLI can see it', () => {
    const { sessions } = summarizeStatus({
      sessions: [{ sessionId: 's1', url: 'http://localhost:4321/', unresponsive: true }],
    });
    expect(sessions[0]?.unresponsive).toBe(true);
  });
});
