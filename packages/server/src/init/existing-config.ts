import { devServerPortWarning, isLikelyDevServerPort } from '../cli/cli-port.js';

/** The project config file, named once. Lives here because this module is what reads it. */
export const RETICLE_CONFIG_FILE = '.reticle.json';

/**
 * Reading a `.reticle.json` that is ALREADY on disk.
 *
 * Split out of plan.ts when it crossed the line cap. These two are one job -- looking at a config
 * somebody else wrote and deciding what it tells us -- and neither knows anything about steps,
 * plans or the shape of a report, which is what made them the cohesive piece to lift rather than
 * the nearest thousand-line boundary.
 */

/**
 * What is wrong with the config that is already there, if anything.
 *
 * Reported from the field (#317): a project carried `"port": 3000` — its own dev-server port, which
 * is the confusion SKILL.md names as the top setup failure — and `init` printed `.reticle.json
 * already exists` on every re-run without reading a single field of it, so the file could never be
 * repaired by the command that wrote it. It stayed invisible because a daemon on `127.0.0.1:3000`
 * and Vite on `[::1]:3000` split the port by address family and neither reported a conflict.
 *
 * Narrower than the issue asked for on purpose: `init`'s IO surface is synchronous, so this cannot
 * probe what is LISTENING right now. `isLikelyDevServerPort` covers the framework defaults, which is
 * where the mistake is actually made.
 */
export function existingConfigProblem(source: string | null | undefined): string | undefined {
  if (null === source || source === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return (
      `${RETICLE_CONFIG_FILE} is present but is not valid JSON, so nothing reads it — neither the ` +
      'daemon nor the SDK. Delete it and re-run `reticle init`.'
    );
  }
  if ('object' !== typeof parsed || null === parsed) return undefined;
  const port = (parsed as Record<string, unknown>)['port'];
  if ('number' !== typeof port || !isLikelyDevServerPort(port)) return undefined;
  return `${devServerPortWarning(port)} Fix it by removing the "port" field from ${RETICLE_CONFIG_FILE}.`;
}

/**
 * The project a `.reticle.json` claims, or undefined when it does not claim one we can read.
 *
 * Unreadable is deliberately NOT a conflict. A file we cannot parse tells us nothing about which
 * app it points at, and refusing on it would block the redirect on any hand-edited config.
 */
export function projectIdOf(source: string | null | undefined): string | undefined {
  if (null === source || source === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  if ('object' !== typeof parsed || null === parsed) return undefined;
  const id = (parsed as Record<string, unknown>)['projectId'];
  return 'string' === typeof id && id.length > 0 ? id : undefined;
}
