/**
 * A driven tab is not always a tab anybody can see.
 *
 * `reticle drive` attaches to the running daemon and gets a pooled HEADLESS context, so every HUD
 * push went to a browser with no human in front of it while the developer watched their own tab
 * show nothing. Reported from a monorepo, where it is easiest to notice; the mechanism has nothing
 * to do with paths.
 */

import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import {
  MessageKind,
  RETICLE_PROTOCOL_VERSION,
  ReticleCommand,
  SessionState,
  type HelloMessage,
} from '@reticlehq/core';
import { Session, SessionManager } from './session.js';

interface Captured {
  name?: string;
  sessionId?: string;
  args?: Record<string, unknown>;
}

function hello(sessionId: string, url: string, projectId?: string): HelloMessage {
  return {
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId,
    url,
    title: sessionId,
    adapters: [],
    hasCapabilities: false,
    ...(projectId === undefined ? {} : { projectId }),
  };
}

function open(sessionId: string, url: string, projectId?: string): [Session, Captured[]] {
  const sent: Captured[] = [];
  const socket = {
    readyState: 1,
    send: (raw: string): void => void sent.push(JSON.parse(raw) as Captured),
  } as unknown as WebSocket;
  return [new Session(hello(sessionId, url, projectId), socket, () => 0), sent];
}

const named = (sent: Captured[], name: string): Captured[] => sent.filter((m) => m.name === name);

describe('a headless driven session mirrors its HUD feed to the tabs a human can see', () => {
  it('mirrors narration and impact to another tab of the same project', () => {
    const manager = new SessionManager();
    const [driven] = open('lease-1', 'http://localhost:3000/', 'app');
    const [watcher, watched] = open('tab-1', 'http://localhost:3000/dashboard', 'app');
    manager.add(driven);
    manager.add(watcher);

    driven.pushNarration('clicked Submit');
    driven.pushImpact(() => ({ calls: 1 }) as never, true);

    expect(named(watched, ReticleCommand.NARRATE)).toHaveLength(1);
    expect(named(watched, ReticleCommand.IMPACT)).toHaveLength(1);
  });

  it('names the session the mirrored row came from, so the watcher is not lied to', () => {
    const manager = new SessionManager();
    const [driven] = open('lease-1', 'http://localhost:3000/', 'app');
    const [watcher, watched] = open('tab-1', 'http://localhost:3000/', 'app');
    manager.add(driven);
    manager.add(watcher);

    driven.pushNarration('clicked Submit');

    expect(named(watched, ReticleCommand.NARRATE)[0]?.args?.['text']).toContain('lease-1');
    expect(named(watched, ReticleCommand.NARRATE)[0]?.args?.['text']).toContain('clicked Submit');
  });

  it('does NOT mirror presenter lifecycle — only the driven tab is being driven', () => {
    const manager = new SessionManager();
    const [driven] = open('lease-1', 'http://localhost:3000/', 'app');
    const [watcher, watched] = open('tab-1', 'http://localhost:3000/', 'app');
    manager.add(driven);
    manager.add(watcher);

    driven.pushPresenter(SessionState.ACTIVE);

    expect(named(watched, ReticleCommand.PRESENTER)).toHaveLength(0);
  });

  it('does not mirror to a tab of a different project', () => {
    const manager = new SessionManager();
    const [driven] = open('lease-1', 'http://localhost:3000/', 'app');
    const [other, otherSent] = open('tab-1', 'http://localhost:5173/', 'other-app');
    manager.add(driven);
    manager.add(other);

    driven.pushNarration('clicked Submit');

    expect(otherSent).toHaveLength(0);
  });

  it('mirrors by origin when neither tab stamped a projectId', () => {
    const manager = new SessionManager();
    const [driven] = open('lease-1', 'http://localhost:3000/');
    const [watcher, watched] = open('tab-1', 'http://localhost:3000/settings');
    const [elsewhere, elsewhereSent] = open('tab-2', 'http://localhost:5173/');
    manager.add(driven);
    manager.add(watcher);
    manager.add(elsewhere);

    driven.pushNarration('clicked Submit');

    expect(named(watched, ReticleCommand.NARRATE)).toHaveLength(1);
    expect(elsewhereSent).toHaveLength(0);
  });

  it('a mirrored row is not itself mirrored (no echo between two watchers)', () => {
    const manager = new SessionManager();
    const [driven] = open('lease-1', 'http://localhost:3000/', 'app');
    const [a, aSent] = open('tab-1', 'http://localhost:3000/', 'app');
    const [b, bSent] = open('tab-2', 'http://localhost:3000/', 'app');
    manager.add(driven);
    manager.add(a);
    manager.add(b);

    driven.pushNarration('clicked Submit');

    expect(named(aSent, ReticleCommand.NARRATE)).toHaveLength(1);
    expect(named(bSent, ReticleCommand.NARRATE)).toHaveLength(1);
  });

  it("addresses a mirrored row to the WATCHER's own session id", () => {
    // The SDK refuses a command addressed to a different session ('two sessions on one socket'), so
    // a mirror stamped with the driven id would be rejected by every tab it reached.
    const manager = new SessionManager();
    const [driven] = open('lease-1', 'http://localhost:3000/', 'app');
    const [watcher, watched] = open('tab-1', 'http://localhost:3000/', 'app');
    manager.add(driven);
    manager.add(watcher);

    driven.pushNarration('clicked Submit');

    expect(named(watched, ReticleCommand.NARRATE)[0]?.sessionId).toBe('tab-1');
  });
});
