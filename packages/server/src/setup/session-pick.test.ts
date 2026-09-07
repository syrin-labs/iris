import { describe, expect, it } from 'vitest';
import { pickSession, type CandidateSession } from './session-pick.js';

const S = (
  sessionId: string,
  url: string,
  extra: Partial<CandidateSession> = {},
): CandidateSession => ({
  sessionId,
  url,
  ...extra,
});

describe('choosing the session to drive', () => {
  it('has nothing to pick when the daemon holds nothing', () => {
    expect(pickSession([], 'http://localhost:5173')).toBeNull();
  });

  // The false green this guard exists for: another tab being alive says nothing about THIS app.
  it("never picks somebody else's tab", () => {
    expect(pickSession([S('other', 'http://localhost:9999/')], 'http://localhost:5173')).toBeNull();
  });

  it('matches despite a trailing slash on either side', () => {
    expect(
      pickSession([S('a', 'http://localhost:5173/x')], 'http://localhost:5173/')?.sessionId,
    ).toBe('a');
  });

  // The other false green: driving a tab from a dev server that died yesterday.
  it('prefers a session that is new since this run opened one', () => {
    const picked = pickSession(
      [S('old', 'http://localhost:5173/'), S('new', 'http://localhost:5173/')],
      'http://localhost:5173',
      new Set(['old']),
    );
    expect(picked?.sessionId).toBe('new');
  });

  it('prefers a visible tab over a hidden one, among equals', () => {
    const picked = pickSession(
      [
        S('hidden', 'http://localhost:5173/', { hidden: true }),
        S('shown', 'http://localhost:5173/'),
      ],
      'http://localhost:5173',
    );
    expect(picked?.sessionId).toBe('shown');
  });

  it('counts a throttled tab as not live', () => {
    const picked = pickSession(
      [
        S('throttled', 'http://localhost:5173/', { throttled: true }),
        S('shown', 'http://localhost:5173/'),
      ],
      'http://localhost:5173',
    );
    expect(picked?.sessionId).toBe('shown');
  });

  // Freshness outranks visibility: a new hidden tab is still THIS run's, while an old visible one is
  // a leftover that would be driven and reported on as though it were ours.
  it('takes a fresh hidden tab over an old visible one', () => {
    const picked = pickSession(
      [S('old', 'http://localhost:5173/'), S('new', 'http://localhost:5173/', { hidden: true })],
      'http://localhost:5173',
      new Set(['old']),
    );
    expect(picked?.sessionId).toBe('new');
  });

  it('falls back to the least stale when nothing else separates them', () => {
    const picked = pickSession(
      [
        S('stale', 'http://localhost:5173/', { hidden: true, lastSeenMs: 90_000 }),
        S('recent', 'http://localhost:5173/', { hidden: true, lastSeenMs: 200 }),
      ],
      'http://localhost:5173',
    );
    expect(picked?.sessionId).toBe('recent');
  });
});

/**
 * A browser tab is not a desktop app.
 *
 * The filter was url alone, and a desktop shell serves its renderer from an ordinary dev server — so
 * an Electron window and a browser tab open on the same origin are indistinguishable here. Driving
 * the tab passes: it is live, it is on the url, it has the SDK. It has none of the app's IPC, none
 * of its commands, and it does not render like it, so every verdict from it is about a different
 * program that happens to share a URL. That is the false green this module exists to prevent, in the
 * one shape it could not see.
 *
 * Only ever a REQUIREMENT for desktop. On the web the runtime carries no such distinction, and an
 * SDK too old to report one must not be excluded from its own install.
 */
const URL = 'http://localhost:5173/';

describe('a desktop install is verified by the desktop window', () => {
  const tab = { sessionId: 'browser', url: URL, runtime: 'web' };
  const app = { sessionId: 'shell', url: URL, runtime: 'electron' };

  it('picks the desktop window over a browser tab on the same url', () => {
    expect(pickSession([tab, app], URL, new Set(), 'electron')?.sessionId).toBe('shell');
  });

  it('refuses a browser tab when the desktop window has not appeared', () => {
    expect(pickSession([tab], URL, new Set(), 'electron')).toBeNull();
  });

  it('does not confuse one desktop runtime for the other', () => {
    expect(pickSession([app], URL, new Set(), 'tauri')).toBeNull();
  });

  // An SDK too old to report a runtime must still be able to install. Excluding it would refuse the
  // upgrade path — the only route an existing user has.
  it('accepts a session that reports no runtime at all', () => {
    const older = { sessionId: 'old', url: URL };
    expect(pickSession([older], URL, new Set(), 'electron')?.sessionId).toBe('old');
  });

  // Unchanged on the web: the runtime is not a distinction there, and a desktop window pointed at a
  // web project is still that project's app.
  it('requires nothing when the project is a web app', () => {
    expect(pickSession([tab], URL, new Set(), undefined)?.sessionId).toBe('browser');
    expect(pickSession([app], URL, new Set(), undefined)?.sessionId).toBe('shell');
  });

  // The existing preferences still decide among the sessions that qualify.
  it('still prefers a live window over a throttled one', () => {
    const sleeping = { sessionId: 'bg', url: URL, runtime: 'electron', throttled: true };
    const awake = { sessionId: 'fg', url: URL, runtime: 'electron' };
    expect(pickSession([sleeping, awake], URL, new Set(), 'electron')?.sessionId).toBe('fg');
  });
});
