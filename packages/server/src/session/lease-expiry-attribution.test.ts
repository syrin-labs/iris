/**
 * Which vanished session gets blamed on an expired lease.
 *
 * `leaseExpired` used to be `reapedLeaseCount() > 0` — a monotonic lifetime total on the pool that
 * is never reset and carries no identity. So once ANY lease had ever aged out, the diagnosis led
 * with the lease story for every closed session for the rest of the daemon's life, including plain
 * human tabs that were never leases. The advice that followed pointed at
 * `reticle_lease {acquire}`, which opens an unauthenticated headless context and loses the app
 * session: the worst available next action, recommended confidently (#611).
 *
 * The flag is now decided from the session that actually went away.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNoSessionWatch } from './no-session-watch.js';
import type { SessionManager } from './session-manager.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'reticle-lease-attr-'));
  dirs.push(dir);
  return dir;
}

/** The few things the watch asks of a SessionManager, and nothing else. */
function stubSessions(departed: string | undefined): {
  manager: SessionManager;
  hint: () => string;
} {
  let installed: (() => string | undefined) | undefined;
  const manager = {
    count: () => 0,
    // The daemon has had a session before: that is what puts the diagnosis on the branch where
    // the lease sentence is a candidate at all.
    everConnected: () => true,
    lastDeparted: () => departed,
    // Registered alongside the hint (#615): the branch code for the same diagnosis.
    setNoSessionReason: () => {},
    setNoSessionHint: (hint: (() => string | undefined) | undefined) => {
      installed = hint;
    },
    setNoSessionNextAction: () => undefined,
    setConnectionRecorder: () => undefined,
  } as unknown as SessionManager;
  return { manager, hint: () => installed?.() ?? '' };
}

function hintFor(departed: string | undefined, reaped: string[]): string {
  const { manager, hint } = stubSessions(departed);
  const stop = startNoSessionWatch({
    sessions: manager,
    port: 4599,
    initialized: true,
    directory: projectDir(),
    wasReapedLease: (id) => reaped.includes(id),
    // Not `async () =>`: the repo's require-await rule rejects an async function with no await.
    occupiedSiblings: () => Promise.resolve([]),
  });
  const text = hint();
  stop();
  return text;
}

describe('attributing a vanished session to an expired lease', () => {
  it('blames the lease when the session that went away was the reaped lease', () => {
    expect(hintFor('lease-1', ['lease-1'])).toContain('was a pooled lease and it aged out');
  });

  it('does not blame the lease for a human tab, even after a lease has aged out', () => {
    // The reported bug: 'human-tab' was never a lease, but a lease had aged out earlier in the
    // daemon's life, so the old lifetime-count flag reported this as an expired lease anyway.
    const text = hintFor('human-tab', ['lease-1']);
    expect(text).not.toContain('was a pooled lease and it aged out');
    expect(text).toContain('closed');
  });

  it('keeps answering correctly for later human tabs, not just the first', () => {
    // The latch was permanent: this is the assertion that the flag no longer sticks.
    expect(hintFor('human-tab-2', ['lease-1', 'lease-2'])).not.toContain(
      'was a pooled lease and it aged out',
    );
  });

  it('does not blame a lease when nothing has departed at all', () => {
    expect(hintFor(undefined, ['lease-1'])).not.toContain('was a pooled lease and it aged out');
  });
});
