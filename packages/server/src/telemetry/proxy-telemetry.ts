/**
 * The MCP proxy's session rollup.
 *
 * POST socket failures (`ENOBUFS`, `EMFILE`, `ECONNREFUSED` before any bytes were sent) happen in
 * this process, not the daemon's. `tool_refused` never fires (the handler never ran) and
 * `mcp_connection_lost` never fires (the SSE stream is fine). Counts live on SessionMetrics here
 * and leave as one `session_progress` — an existing kind, omitted when nothing happened.
 *
 * The send is awaited. Fire-and-forget microseconds before `process.exit` is how `daemon_stopped`
 * never arrived: the POST was killed every time and nothing threw.
 */
import { TelemetryEventKind } from '@reticlehq/core';
import { getSessionMetrics, type SessionMetrics } from './session-metrics.js';
import { getTelemetry, type Telemetry } from './telemetry.js';

export async function flushProxySessionMetrics(
  telemetry: Telemetry = getTelemetry(),
  metrics: SessionMetrics = getSessionMetrics(),
): Promise<void> {
  if (metrics.empty) return;
  await telemetry.emit(TelemetryEventKind.SESSION_PROGRESS, {
    session: metrics.summarize(true),
  });
}
