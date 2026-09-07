import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOOPBACK_HOST } from '@reticlehq/core';
import { expect, it, vi } from 'vitest';
import { handleStatus } from '../cli.js';
import { STATE_DIR_ENV, writePid } from '../daemon/daemon.js';
import { handleDoctor } from './cli-doctor.js';

async function reserveThenReleasePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  if (null === address || 'string' === typeof address) throw new Error('TCP port was not assigned');
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (undefined === error ? resolve() : reject(error)));
  });
  return address.port;
}

it('doctor and status both report stopped when a live recorded pid has no daemon port', async () => {
  const port = await reserveThenReleasePort();
  const stateHome = mkdtempSync(join(tmpdir(), 'reticle-health-parity-'));
  const previousStateHome = process.env[STATE_DIR_ENV];
  let doctorOutput = '';
  let statusOutput = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    doctorOutput += String(chunk);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    statusOutput += String(chunk);
    return true;
  });

  try {
    process.env[STATE_DIR_ENV] = stateHome;
    writePid(port); // Records this still-live Vitest process: the exact shortcut that made status lie.

    await handleStatus(port);
    await handleDoctor(port);

    const statusLine = statusOutput
      .split('\n')
      .find((line) => line.includes('"event":"reticle_status"'));
    expect(statusLine).toBeDefined();
    expect(JSON.parse(statusLine ?? '{}')).toMatchObject({
      event: 'reticle_status',
      port,
      running: false,
      presence: 'free',
    });
    expect(doctorOutput).toMatch(new RegExp(`daemon\\s+✗ not running on :${String(port)}`));
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    if (undefined === previousStateHome) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = previousStateHome;
    rmSync(stateHome, { recursive: true, force: true });
  }
});
