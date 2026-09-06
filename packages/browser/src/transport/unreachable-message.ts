/**
 * What the page says when its websocket never opened.
 *
 * Pulled out of the connect path so it is a pure string function with a test on its CLAIMS rather
 * than a template inlined in a warn call. The rule it exists to hold: report what this page observed
 * and what it could not determine, never a cause. See unreachable-message.test.ts.
 */

import { UNREACHABLE_NOTICE_PREFIX } from '@reticlehq/core';

/**
 * The page tried, failed, and cannot see why. Names the address and the attempt count, refuses to
 * diagnose the daemon, and lists the checks in the order that actually resolves the ambiguity.
 */
export function unreachableMessage(url: string, attempts: number): string {
  return (
    `${UNREACHABLE_NOTICE_PREFIX}${url}. ${String(attempts)} attempts, all ` +
    `failed. That is everything the page can see: from inside the browser it cannot tell a daemon ` +
    `that is not there from one it is not allowed to reach, so this is not evidence about the ` +
    `daemon. What answers it: run \`npx @reticlehq/server status\` to see whether one is listening ` +
    `and on which port. If your app runs in a container, devcontainer or WSL, the daemon is on a ` +
    `different host, so set the URL explicitly (Vite: VITE_RETICLE_WS_URL, or ` +
    `reticle.connect({ url })). An https page cannot open a ws:// socket at all. Still retrying…`
  );
}

/**
 * The same fact, sized for the HUD's one-line status row.
 *
 * The console warning explains; this one only has room to name the URL, which is the answer in
 * most cases anyway — a bridge on a port the page is not dialling.
 */
export function unreachableStripText(url: string, attempts: number): string {
  return `no bridge at ${url} — ${String(attempts)} attempt${1 === attempts ? '' : 's'}`;
}
