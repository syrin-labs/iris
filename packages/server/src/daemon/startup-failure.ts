import { readFileSync } from 'node:fs';

/** The structured log event emitted when the daemon child cannot start. */
export const DAEMON_START_FAILED_EVENT = 'reticle_daemon_start_failed';

/**
 * Return the most recent startup cause written by this launch attempt.
 *
 * Daemon logs are append-only across launches, so an event name alone is not enough: surfacing an
 * older failure would confidently diagnose the wrong attempt. The parent supplies the timestamp it
 * captured immediately before spawning and this reader ignores every earlier record. Malformed or
 * unavailable logs are best-effort misses; the caller still has its generic fallback diagnosis.
 */
export function readDaemonStartupCause(path: string, sinceMs: number): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }

  const lines = contents.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (undefined === line || 0 === line.length) continue;

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || null === record) continue;

    const candidate = record as { event?: unknown; error?: unknown; t?: unknown };
    if (candidate.event !== DAEMON_START_FAILED_EVENT) continue;
    if (typeof candidate.t !== 'string' || typeof candidate.error !== 'string') continue;

    const recordedAt = Date.parse(candidate.t);
    const error = candidate.error.trim();
    if (!Number.isFinite(recordedAt) || recordedAt < sinceMs || 0 === error.length) continue;
    return error;
  }
  return undefined;
}
