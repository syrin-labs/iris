import * as net from 'node:net';
import { LOOPBACK_HOST } from '@reticlehq/core';

const DEFAULT_DAEMON_READY_TIMEOUT_MS = 10_000;
/**
 * How long to wait for the spawned daemon's port to accept connections before giving up. The default
 * suits a normal machine; a slow CI/VM (heavy headless-browser launch) can raise it via the
 * RETICLE_DAEMON_READY_TIMEOUT_MS env var. Invalid/absent values fall back to the default.
 */
const envDaemonReadyTimeoutMs = Number(process.env['RETICLE_DAEMON_READY_TIMEOUT_MS']);
const DAEMON_READY_TIMEOUT_MS =
  Number.isFinite(envDaemonReadyTimeoutMs) && envDaemonReadyTimeoutMs > 0
    ? envDaemonReadyTimeoutMs
    : DEFAULT_DAEMON_READY_TIMEOUT_MS;
const DAEMON_POLL_INTERVAL_MS = 100;
const DAEMON_POLL_MAX_INTERVAL_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function daemonPollDelayMs(attempt: number): number {
  return Math.min(DAEMON_POLL_INTERVAL_MS * attempt, DAEMON_POLL_MAX_INTERVAL_MS);
}

/**
 * Returns true if something is already listening on the reticle port.
 * Uses a plain TCP probe so we don't create a side-effectful SSE session
 * inside the daemon just to check reachability.
 */
export function probeDaemon(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, LOOPBACK_HOST);
  });
}

/** Poll until the daemon's HTTP port accepts connections or the deadline is reached. */
export async function waitForDaemon(port: number): Promise<void> {
  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    const reachable = await probeDaemon(port);
    if (reachable) return;
    attempt++;
    await delay(daemonPollDelayMs(attempt));
  }
  throw new Error(
    `reticle daemon did not become ready on port ${port} within ${DAEMON_READY_TIMEOUT_MS}ms`,
  );
}
