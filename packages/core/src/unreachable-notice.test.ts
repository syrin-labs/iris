/**
 * The page writes this line and the daemon parses it, across two packages that cannot import each
 * other. Nothing but this contract connects them, so these pin both halves.
 */
import { describe, it, expect } from 'vitest';
import { UNREACHABLE_NOTICE_PREFIX, unreachableUrlIn } from './unreachable-notice.js';

describe('the unreachable notice as a contract', () => {
  it('round-trips the address the page names', () => {
    const line = `${UNREACHABLE_NOTICE_PREFIX}ws://localhost:4460/reticle. 3 attempts, all failed. More prose here.`;
    expect(unreachableUrlIn(line)).toBe('ws://localhost:4460/reticle');
  });

  it('reads the address when the notice is the whole line', () => {
    expect(unreachableUrlIn(`${UNREACHABLE_NOTICE_PREFIX}ws://h:1/r`)).toBe('ws://h:1/r');
  });

  /**
   * The captured address outranks every inferred cause in the lease hint, so a loose match puts a
   * confident WRONG port in front of the agent — worse than the guess it replaces.
   */
  it("ignores Chromium's own websocket failure, which is not ours to keep stable", () => {
    expect(
      unreachableUrlIn("WebSocket connection to 'ws://localhost:9999/x' failed: net::ERR_FAILED"),
    ).toBeUndefined();
  });

  it('ignores application logging that merely carries a ws:// url', () => {
    expect(unreachableUrlIn('[app] streaming from ws://localhost:7777/feed')).toBeUndefined();
  });

  it('says nothing for an empty line rather than guessing', () => {
    expect(unreachableUrlIn('')).toBeUndefined();
  });
});
