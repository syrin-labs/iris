/**
 * Whether a failed observation cell is rig noise worth one retry.
 *
 * Playwright MCP initialize and browser_click time out under CI load. The cell is then recorded
 * NOT MEASURED, which leaves the catch-rate denominator and trips the coverage floor while every
 * rate stays 1.0. Replay-detect already retries a flaky baseline for the same reason; this is that
 * rule for Layer A. A missing tool or a thrown injector is still a real miss.
 */
export function isObservationRetryable(error) {
  const msg = String(error);
  return (
    /timeout after \d+ms on /i.test(msg) ||
    /TimeoutError/i.test(msg) ||
    /cell exceeded \d+ms/i.test(msg)
  );
}
