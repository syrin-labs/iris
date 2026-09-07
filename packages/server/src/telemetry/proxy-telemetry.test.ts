/**
 * POST socket failures are invisible to the two events that look like they would catch them:
 * `tool_refused` never fires (the handler never ran) and `mcp_connection_lost` never fires (the SSE
 * stream is fine). The counts therefore ride the existing session summary, omitted when zero.
 */
import { describe, expect, it } from 'vitest';
import { TelemetryEventKind } from '@reticlehq/core';
import { SessionMetrics } from './session-metrics.js';
import { createTelemetry } from './telemetry.js';
import { flushProxySessionMetrics } from './proxy-telemetry.js';

const TEST_ENV = {
  RETICLE_TELEMETRY_KEY: 'phc_test',
  RETICLE_TELEMETRY_URL: 'http://example.test',
};

const USER_PROJECT = '/tmp/some-user-app';

interface CapturedBatch {
  batch: Array<{ event: string; properties: Record<string, unknown> }>;
}

describe('socket-level POST failures are countable on the session summary', () => {
  it('counts a failure and a retry that then delivered, and omits both when none happened', () => {
    const m = new SessionMetrics(() => 0);
    expect(m.summarize(true).postSocketFailures).toBeUndefined();
    expect(m.summarize(true).postRetriesSaved).toBeUndefined();
    m.recordPostSocketFailure();
    m.recordPostRetrySaved();
    const s = m.summarize(true);
    expect(s.postSocketFailures).toBe(1);
    expect(s.postRetriesSaved).toBe(1);
  });

  it('an idle rollup is empty so a proxy that never hit the socket does not emit', () => {
    expect(new SessionMetrics(() => 0).empty).toBe(true);
  });

  it('a rollup with only socket failures is not empty — that is the whole signal', () => {
    const m = new SessionMetrics(() => 0);
    m.recordPostSocketFailure();
    expect(m.empty).toBe(false);
  });
});

describe('the proxy flushes those counts on an existing event, and awaits the send', () => {
  it('emits session_progress with session_postSocketFailures on the wire', async () => {
    const calls: CapturedBatch[] = [];
    const fetchImpl = ((_url: string, init: { body?: string }) => {
      calls.push(JSON.parse(init.body ?? '{}') as CapturedBatch);
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const telemetry = createTelemetry({
      version: '9.9.9',
      env: { ...TEST_ENV, RETICLE_TELEMETRY: '1' },
      fetchImpl,
      cwd: USER_PROJECT,
    });
    const metrics = new SessionMetrics(() => 0);
    metrics.recordPostSocketFailure();
    metrics.recordPostRetrySaved();
    await flushProxySessionMetrics(telemetry, metrics);
    expect(calls).toHaveLength(1);
    const properties = calls[0]?.batch[0]?.properties ?? {};
    expect(calls[0]?.batch[0]?.event).toBe(TelemetryEventKind.SESSION_PROGRESS);
    expect(properties.session_postSocketFailures, 'the count was dropped').toBe(1);
    expect(properties.session_postRetriesSaved, 'the saved-retry count was dropped').toBe(1);
  });

  it('emits nothing when the proxy never saw a socket failure', async () => {
    let sent = 0;
    const fetchImpl = (() => {
      sent += 1;
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const telemetry = createTelemetry({
      version: '9.9.9',
      env: { ...TEST_ENV, RETICLE_TELEMETRY: '1' },
      fetchImpl,
      cwd: USER_PROJECT,
    });
    await flushProxySessionMetrics(telemetry, new SessionMetrics(() => 0));
    expect(sent).toBe(0);
  });
});
