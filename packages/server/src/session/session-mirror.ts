/**
 * What a tab that is only WATCHING gets to see of a drive happening somewhere else.
 *
 * Its own module because it is its own question — the rest of session.ts is about a session Reticle
 * is DRIVING, and this is about the one it is not. Split out when session.ts crossed the 1000-line
 * cap; the cap did its job, because these two had no reason to share a file beyond history.
 */

import { ReticleCommand } from '@reticlehq/core';

/**
 * How a mirrored row is introduced on a tab that is only WATCHING.
 *
 * The row happened somewhere else, and a HUD that prints it unlabelled tells the reader their own
 * tab was driven. Naming the session is also the handle they need to address it.
 */
export function mirroredNarration(sessionId: string, text: string): string {
  return `${sessionId} \u2192 ${text}`;
}

/** The pushes that are a REPORT of what happened, and so are worth showing to a watching tab. */
export const MIRRORED_COMMANDS: ReadonlySet<string> = new Set<string>([
  ReticleCommand.NARRATE,
  ReticleCommand.IMPACT,
]);
