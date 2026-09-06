/**
 * "authentication failed" when the real problem is a daemon from another project.
 *
 * Reported from the field: a sweep ended, its daemon was left holding port 4400, and the NEXT app —
 * freshly inited in a different worktree with its own pairing token — dialled that stale daemon and
 * got `bridge refused the connection: authentication failed`. The app was fine; the same fixture had
 * passed the gate minutes earlier. (Reproduced independently here: a leaked daemon on 4400 from my
 * own probes turned the e2e battery red in exactly this way.)
 *
 * "Authentication failed" sends someone to check a token. The token is correct — it is simply a
 * DIFFERENT project's token, because the daemon answering belongs to a different project. Those need
 * opposite fixes: one is "fix your token", the other is "that daemon is not yours, stop it".
 *
 * The discriminator is EVIDENCE, not derivation. The daemon and the SDK derive their project ids by
 * different schemes, so comparing them would report "different project" on every auth failure — the
 * same confidently-wrong diagnostic this is meant to replace. What the daemon knows for certain is
 * which projects it has ALREADY accepted a session from. If it has served project X and a HELLO
 * arrives for project Y with a bad token, this daemon demonstrably belongs to someone else.
 */

import { describe, expect, it } from 'vitest';
import { authFailureReason } from './auth-failure-reason.js';

describe('why the bridge refused', () => {
  it('says so when this daemon has only ever served another project', () => {
    const reason = authFailureReason(new Set(['proj-abc']), 'proj-xyz');
    expect(reason).toContain('different project');
    // Actionable: the fix is to stop the daemon, not to hunt for a token.
    expect(reason).toContain('reticle stop');
  });

  it('stays plain when this daemon HAS served the same project', () => {
    // Same project, wrong token: that really is a token problem.
    const reason = authFailureReason(new Set(['proj-abc', 'proj-other']), 'proj-abc', 'wrong');
    expect(reason).toContain('authentication failed');
    expect(reason).not.toContain('different project');
    expect(reason).not.toContain('no pairing token');
  });

  it('stays plain when the daemon has served nothing yet — there is no evidence either way', () => {
    // A fresh daemon rejecting the first app it sees is a token problem until proven otherwise.
    expect(authFailureReason(new Set(), 'proj-xyz', 'wrong')).toContain('authentication failed');
    expect(authFailureReason(new Set(), 'proj-xyz', 'wrong')).not.toContain('no pairing token');
  });

  it('stays plain when the HELLO names no project but did present a token', () => {
    expect(authFailureReason(new Set(['proj-abc']), undefined, 'wrong')).toContain(
      'authentication failed',
    );
    expect(authFailureReason(new Set(['proj-abc']), undefined, 'wrong')).not.toContain(
      'no pairing token',
    );
  });

  it('names a missing token, because a reload cannot mint one into a frozen snippet', () => {
    const reason = authFailureReason(new Set(), undefined, undefined);
    expect(reason).toContain('no pairing token');
    expect(reason).not.toMatch(/reload/i);
  });

  it('treats an empty token the same as a missing one', () => {
    expect(authFailureReason(new Set(['proj-abc']), 'proj-abc', '')).toContain('no pairing token');
  });

  it('names a missing token even when this daemon has already served the same project', () => {
    expect(authFailureReason(new Set(['proj-abc']), 'proj-abc', undefined)).toContain(
      'no pairing token',
    );
  });

  it('fits a WebSocket close reason, which is capped at 123 bytes', () => {
    // A reason that exceeds the frame limit throws in ws and closes with nothing at all.
    const reason = authFailureReason(new Set(['a'.repeat(120)]), 'b'.repeat(120));
    expect(Buffer.byteLength(reason, 'utf8')).toBeLessThanOrEqual(123);
  });
});
