import { describe, expect, it } from 'vitest';
import { isObservationRetryable } from './observation-retry.mjs';

/**
 * Playwright MCP initialize and browser_click time out on CI. The cell is recorded NOT MEASURED,
 * coverage shrinks, the catch-rate stays 1.0, and the gate goes red. Those timeouts are the machine,
 * not the scenario — retry once. A missing tool is still a miss.
 */

describe('isObservationRetryable', () => {
  it('retries an initialize handshake that never answered', () => {
    expect(isObservationRetryable(new Error('timeout after 60000ms on initialize'))).toBe(true);
  });

  it('retries a Playwright click that hung', () => {
    expect(
      isObservationRetryable(
        new Error('tool browser_click failed: ### Error\nTimeoutError: browserBackend.callTool:'),
      ),
    ).toBe(true);
  });

  it('retries a cell the harness itself abandoned', () => {
    expect(isObservationRetryable(new Error('cell exceeded 240000ms and was abandoned'))).toBe(
      true,
    );
  });

  it('does not retry a missing tool — that is a real miss', () => {
    expect(isObservationRetryable(new Error('Tool browser_click not found'))).toBe(false);
  });
});
