import { describe, expect, it } from 'vitest';
import { statusNextAction, type StatusFacts } from './status-next-action.js';

/**
 * Wired, never yet connected. `previouslyConnected: true` reaches an earlier branch ("a session was
 * connected earlier") that never consults the listening list, so it cannot show anything about it.
 */
const wired: StatusFacts = {
  running: true,
  sessionCount: 0,
  previouslyConnected: false,
  initialized: true,
};

describe('status uses what dev servers announced', () => {
  /**
   * Without the announcement the CLI could see no listening ports at all, so a wired project with a
   * running dev server was told "the app is probably not running" — advice that contradicts the
   * terminal the user is looking at, and sends them to restart something already up.
   */
  it('stops claiming nothing is running when a dev server announced itself', () => {
    const action = statusNextAction({ ...wired, devServerPorts: [5173] });
    expect(action).toBeDefined();
    expect(action ?? '').not.toContain('probably not running');
  });

  it('still says nothing is running when nothing announced itself', () => {
    expect(statusNextAction({ ...wired, devServerPorts: [] }) ?? '').toContain(
      'probably not running',
    );
  });

  /**
   * A connected session means there is nothing to fix, and advice printed beside a working install
   * reads as though something is still wrong.
   */
  it('stays silent when a session is connected, whatever is listening', () => {
    expect(statusNextAction({ ...wired, sessionCount: 1, devServerPorts: [5173] })).toBeUndefined();
  });
});
