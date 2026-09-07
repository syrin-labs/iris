/**
 * Reconnect backoff, shared by the SSE stream and the POST leg.
 *
 * Its own module only because both halves need it and they must not import each other: the proxy
 * owns the stream, the post transport owns the request, and a cycle between them to reach three
 * lines of arithmetic would be the wrong price.
 */

/** Linear and capped, so a briefly-restarting daemon is picked up fast. */
export const RECONNECT_BASE_MS = 250;
export const RECONNECT_CAP_MS = 5_000;

export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * attempt, RECONNECT_CAP_MS);
}
