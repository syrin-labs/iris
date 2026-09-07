import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:net';
import { pickDaemonPortToBind, portIsFree, osAssignedPort } from './free-port.js';
import { LOOPBACK_HOST } from '@reticlehq/core';

describe('pickDaemonPortToBind', () => {
  it('keeps the documented default when it is free, so ordinary installs do not move', async () => {
    await expect(
      pickDaemonPortToBind(
        4400,
        () => Promise.resolve(true),
        () => Promise.resolve(51234),
      ),
    ).resolves.toBe(4400);
  });

  /** The many-to-many case: a second project must get its own daemon, not fight for the first's. */
  it('takes an OS-assigned port when the preferred one is taken', async () => {
    await expect(
      pickDaemonPortToBind(
        4400,
        () => Promise.resolve(false),
        () => Promise.resolve(51234),
      ),
    ).resolves.toBe(51234);
  });
});

/**
 * These bind real sockets, because the property under test is about the kernel and a fake would only
 * assert that the fake was called.
 */
describe('against real sockets', () => {
  it('reports a port taken by somebody else as not free', async () => {
    const held: Server = createServer();
    const port = await osAssignedPort();
    await new Promise<void>((r) => held.listen(port, LOOPBACK_HOST, r));
    try {
      await expect(portIsFree(port)).resolves.toBe(false);
    } finally {
      await new Promise<void>((r) => held.close(() => r()));
    }
  });

  it('hands back a port that can then actually be bound', async () => {
    const port = await osAssignedPort();
    expect(port).toBeGreaterThan(0);
    await expect(portIsFree(port)).resolves.toBe(true);
  });

  /** Two asks in a row must not return the same number to two racing agents. */
  it('does not hand the same port to a caller still holding the last one', async () => {
    const first = await osAssignedPort();
    const held: Server = createServer();
    await new Promise<void>((r) => held.listen(first, LOOPBACK_HOST, r));
    try {
      const second = await pickDaemonPortToBind(first);
      expect(second).not.toBe(first);
    } finally {
      await new Promise<void>((r) => held.close(() => r()));
    }
  });
});
