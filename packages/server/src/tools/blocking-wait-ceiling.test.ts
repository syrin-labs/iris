import { describe, expect, it } from 'vitest';
import { MAX_BLOCKING_WAIT_MS, MAX_TIMEOUT_MS, timeoutMsSchema } from './numeric-bounds.js';

/**
 * An advertised bound has to be one we can actually honour.
 *
 * `timeout_ms` accepted up to 120s while the MCP SDK's default request timeout is 60s, and clients
 * configure it lower. A caller who believed the advertised bound and asked for 90s got a TRANSPORT
 * error at 60s: no verdict, no near-miss diagnosis, nothing to act on. The wait was honoured right
 * up to the moment the only thing that could report it had gone (#601).
 *
 * The ceiling is therefore below the SDK default, not at it. The margin is what lets Reticle's own
 * "timed out, here is the near miss" answer beat the client's abort.
 */
describe('a blocking wait is bounded by what the client will wait for', () => {
  it('refuses a wait longer than an MCP client will hold the request open', () => {
    expect(timeoutMsSchema.safeParse(90_000).success).toBe(false);
    expect(timeoutMsSchema.safeParse(60_000).success).toBe(false);
  });

  it('leaves room for the answer to arrive before the client gives up', () => {
    // At exactly 60s the verdict races the abort and loses: the reply has to be produced,
    // serialised and written after the wait ends. The margin is the point of the constant.
    expect(MAX_BLOCKING_WAIT_MS).toBeLessThan(60_000);
  });

  it('still accepts the ceiling itself and the ordinary budgets', () => {
    // A ceiling that refuses its own value turns a documented bound into a lie in the other
    // direction, and 4000 is the default assert budget.
    expect(timeoutMsSchema.safeParse(MAX_BLOCKING_WAIT_MS).success).toBe(true);
    expect(timeoutMsSchema.safeParse(4_000).success).toBe(true);
  });

  it('keeps `timeout_ms: 0` legal — it means evaluate once, not "wait forever"', () => {
    expect(timeoutMsSchema.safeParse(0).success).toBe(true);
  });

  it('does not lower the ceiling for arguments the caller does NOT block on', () => {
    // Only a wait the request is held open for is bounded by the client's patience. Folding the
    // two together would shrink unrelated bounds in the name of a transport constraint they
    // never touch.
    expect(MAX_TIMEOUT_MS).toBeGreaterThan(MAX_BLOCKING_WAIT_MS);
  });
});
