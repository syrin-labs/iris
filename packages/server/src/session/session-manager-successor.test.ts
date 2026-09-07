/**
 * A dead sessionId after a full-document navigation used to be a dead end.
 *
 * The agent still holds the id of the page that just unloaded. The new page has already HELLO'd,
 * often under a new id. `resolve` now follows the unique same-origin successor instead of refusing
 * — which is how `assert` after `act_and_wait` on an MPA link starts working. An id that was never
 * seen still refuses, and two live tabs at that origin still refuse: those are guesses.
 */

import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import { RETICLE_PROTOCOL_VERSION, MessageKind, type HelloMessage } from '@reticlehq/core';
import { Session, SessionManager } from './session.js';

const fakeSocket = { send: (): void => {} } as unknown as WebSocket;

function hello(id: string, url: string, projectId?: string): HelloMessage {
  return {
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId: id,
    url,
    title: id,
    adapters: [],
    hasCapabilities: false,
    ...(projectId === undefined ? {} : { projectId }),
  };
}

function session(id: string, url: string, projectId?: string): Session {
  return new Session(hello(id, url, projectId), fakeSocket, () => 0);
}

describe('resolve follows a unique same-origin successor', () => {
  it('rebinds the departed id to the one live session at that origin', () => {
    const mgr = new SessionManager();
    const old = session('old', 'http://localhost:3000/orders', 'shop');
    mgr.add(old);
    mgr.remove(old);
    const next = session('new', 'http://localhost:3000/orders/42', 'shop');
    mgr.add(next);

    expect(mgr.resolve('old').id).toBe('new');
  });

  it('does not rebind an id that was never connected', () => {
    const mgr = new SessionManager();
    mgr.add(session('live', 'http://localhost:3000/', 'shop'));
    expect(() => mgr.resolve('ghost')).toThrow(/ghost/);
  });

  it('does not guess when two tabs share the origin', () => {
    const mgr = new SessionManager();
    const old = session('old', 'http://localhost:3000/a', 'shop');
    mgr.add(old);
    mgr.remove(old);
    mgr.add(session('a', 'http://localhost:3000/a', 'shop'));
    mgr.add(session('b', 'http://localhost:3000/b', 'shop'));
    expect(() => mgr.resolve('old')).toThrow(/old/);
  });

  it('does not rebind across origins', () => {
    const mgr = new SessionManager();
    const old = session('old', 'http://localhost:3000/a', 'shop');
    mgr.add(old);
    mgr.remove(old);
    mgr.add(session('other', 'http://localhost:9999/a', 'shop'));
    expect(() => mgr.resolve('old')).toThrow(/old/);
  });
});
