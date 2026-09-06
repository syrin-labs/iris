import { describe, expect, it } from 'vitest';
import { InitConfirmation } from '@reticlehq/core';
import { confirmationMessage, sharpenWithDevServers } from './confirm.js';

const PORT = 4400;

const server = (port: number, url: string) => ({
  port,
  pid: 1,
  root: '/repo/apps/web',
  url,
  sdkVersion: '2.13.0',
  startedAt: 1,
});

describe('sharpenWithDevServers', () => {
  /**
   * The distinction this whole signal exists for. "No app connected" was one message covering two
   * situations with opposite fixes; an announced dev server is proof the config is right and the
   * process was restarted, so the only step left is opening the page.
   */
  it('turns NO_SESSION into NO_PAGE when an instrumented dev server is running', () => {
    expect(
      sharpenWithDevServers(InitConfirmation.NO_SESSION, [server(5173, 'http://localhost:5173/')]),
    ).toBe(InitConfirmation.NO_PAGE);
  });

  it('leaves NO_SESSION alone when nothing announced itself', () => {
    expect(sharpenWithDevServers(InitConfirmation.NO_SESSION, [])).toBe(
      InitConfirmation.NO_SESSION,
    );
  });

  /**
   * Only the unexplained case is sharpened. A connected app is the finished state, and a missing
   * daemon is a different fact entirely — neither becomes more true because a dev server is up.
   */
  it('never overrides a confirmation that already means something', () => {
    const running = [server(5173, 'http://localhost:5173/')];
    expect(sharpenWithDevServers(InitConfirmation.CONNECTED, running)).toBe(
      InitConfirmation.CONNECTED,
    );
    expect(sharpenWithDevServers(InitConfirmation.NO_DAEMON, running)).toBe(
      InitConfirmation.NO_DAEMON,
    );
  });
});

describe('the NO_PAGE message', () => {
  it('names the URL the dev server reported, and does not ask for a restart', () => {
    const message = confirmationMessage(InitConfirmation.NO_PAGE, PORT, [
      server(5173, 'http://localhost:5173/'),
    ]);
    expect(message).toContain('http://localhost:5173/');
    expect(message.toLowerCase()).not.toContain('restart');
  });

  /**
   * A monorepo announces one entry per frontend. Naming only the first would send the reader to the
   * wrong app half the time, which is worse than naming none.
   */
  it('names every announced app in a monorepo', () => {
    const message = confirmationMessage(InitConfirmation.NO_PAGE, PORT, [
      server(5173, 'http://localhost:5173/'),
      server(3000, 'http://localhost:3000/'),
    ]);
    expect(message).toContain('http://localhost:5173/');
    expect(message).toContain('http://localhost:3000/');
  });

  it('still asks for a restart when nothing announced itself', () => {
    const message = confirmationMessage(InitConfirmation.NO_SESSION, PORT, []);
    expect(message.toLowerCase()).toContain('restart');
  });
});
