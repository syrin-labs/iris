/**
 * An ADVISORY marker that a run looks automated, for the runs `ci` cannot see.
 *
 * `ci` is a single environment variable, which is exactly right for a GitHub Actions runner and
 * blind to everything else: our own gate has run from a datacenter and landed in the user data
 * indistinguishable from somebody at a laptop.
 *
 * ADVISORY, and never a filter. A real person works inside a container, inside a Codespace, and over
 * an ssh session with no terminal attached, and every one of them is a user. Nothing may drop a row
 * because this is set; it exists so a surprising number can be looked at from a second angle, and a
 * hint that starts being used as an exclusion has stopped being a hint. Absent means "nothing here
 * looked automated", never "a human was present".
 *
 * WHAT WAS REJECTED, so nobody re-proposes it:
 *  - IP address, ASN or datacenter geolocation. Not knowable client-side, and it is a stronger
 *    identifier than anything else we collect. The one signal that would actually separate a cloud
 *    sandbox from a laptop is the one we will not collect.
 *  - Hostname patterns (`runner-*`, `ip-10-*`). A hostname is user data, and matching names is
 *    guesswork dressed as a measurement — a guessed dimension and a measured one are
 *    indistinguishable once they are in the same column.
 *  - Process ancestry. Costs a spawn on a path that must never tax a command, and reads the name of
 *    somebody else's program to classify our own user.
 *  - `npm_config_user_agent`. Says which package manager ran us, which every route shares.
 *  - An absent `$DISPLAY`. Every Linux server, every ssh session, and a large share of genuine
 *    developer machines trip it; it separates nothing.
 */
import { existsSync } from 'node:fs';
import { AutomationHint } from '@reticlehq/core';

/** Container runtimes drop one of these at the filesystem root. */
const CONTAINER_MARKERS = ['/.dockerenv', '/run/.containerenv'] as const;

/** Hosted dev environments that declare themselves. Self-declared, never inferred. */
const HOSTED_WORKSPACE_ENV = [
  'CODESPACES',
  'GITPOD_WORKSPACE_ID',
  'CLOUD_SHELL',
  'REMOTE_CONTAINERS',
] as const;

interface AutomationInput {
  env: NodeJS.ProcessEnv;
  fileExists: (path: string) => boolean;
  hasTty: boolean;
}

/**
 * The most specific signal that fires, or undefined.
 *
 * Ordered most specific first: a container inside a Codespace with no terminal is one fact about the
 * run, and sending the weakest of the three would waste the field. Omitted rather than sent as a
 * "none" value, so its presence is itself the signal — the convention every other advisory field
 * here follows.
 */
export function resolveAutomationHint(input: AutomationInput): AutomationHint | undefined {
  if (CONTAINER_MARKERS.some((m) => input.fileExists(m))) return AutomationHint.CONTAINER;
  if (HOSTED_WORKSPACE_ENV.some((k) => (input.env[k] ?? '') !== ''))
    return AutomationHint.HOSTED_WORKSPACE;
  if (!input.hasTty) return AutomationHint.NO_TTY;
  return undefined;
}

/** The real reading, taken once per process. */
export function currentAutomationHint(env: NodeJS.ProcessEnv): AutomationHint | undefined {
  return resolveAutomationHint({
    env,
    fileExists: (p) => {
      try {
        return existsSync(p);
      } catch {
        return false; // an unreadable root is not evidence of anything
      }
    },
    // Both ends, because a piped stdout alone is how `reticle status | jq` looks, and that is a
    // person typing.
    hasTty: true === process.stdout.isTTY || true === process.stdin.isTTY,
  });
}
