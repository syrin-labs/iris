/**
 * Which published route brought an install in.
 *
 * Four install routes ship at once and none of them could be told apart, so every question about
 * where distribution effort is working had no data behind it at all.
 *
 * ONE mechanism: an environment variable a channel sets on itself. Everything else that looked like
 * a signal turned out not to be one — see `InstallSource` in core for why `npm_config_user_agent`,
 * a `.claude-plugin/` directory and an installed skill folder all fail to separate these routes.
 *
 * WHICH CHANNELS ARE GENUINELY DETECTABLE TODAY, so nobody later reads a small `unknown` as success:
 *  - `plugin` — real. The Claude Code plugin registers the MCP server itself and can set the marker
 *    in that server's `env`, so it is carried by the process without anybody typing anything.
 *  - `skill_file` / `npx_skill` / `docs_site` / `readme` — real ONLY where that channel's own copy
 *    of the install command carries the marker. Each is a separately published artifact, so a copy
 *    that has not been updated is indistinguishable from no channel at all.
 *  - `cli_direct` — NOT detectable. Nobody types a marker to say they typed a command. It exists so
 *    a wrapper can declare it, and until something does, a direct install reports `unknown`.
 *
 * `unknown` is therefore expected to be the largest bucket for as long as the marker is spreading,
 * and shrinking it is a distribution job, never a classifier job. A guessed attribution is worse
 * than none: it is the number distribution decisions get steered on, and a guess and a measurement
 * are indistinguishable once they are in the same column.
 */
import { InstallSource } from '@reticlehq/core';
import { findProjectConfig } from '../cli/cli-port.js';

/** The one marker. Set by a channel on the process that runs the install. */
export const INSTALL_SOURCE_ENV = 'RETICLE_INSTALL_SOURCE';

const KNOWN: ReadonlySet<string> = new Set(Object.values(InstallSource));

/**
 * The declared install source, or `unknown`.
 *
 * Narrowed against the closed list rather than echoed: an echo would forward whatever somebody
 * exported — a path, a URL, a campaign string — straight onto the wire, which is the rule this
 * whole contract is built on. Trimmed and lowercased first, because the marker travels through
 * shell snippets and copy-paste, and `Skill_File` is the same channel as `skill_file`.
 */
export function resolveInstallSource(env: NodeJS.ProcessEnv = process.env): InstallSource {
  const declared = (env[INSTALL_SOURCE_ENV] ?? '').trim().toLowerCase();
  return KNOWN.has(declared) ? (declared as InstallSource) : InstallSource.UNKNOWN;
}

/**
 * The install source declared by the environment, or undefined when nothing declared one.
 *
 * Distinct from `resolveInstallSource`, which answers `unknown` so an event always carries a value.
 * A config file wants the opposite: writing `unknown` into `.reticle.json` is indistinguishable
 * from a config written before this field existed, and those two are different facts.
 */
export function declaredInstallSource(
  env: NodeJS.ProcessEnv = process.env,
): InstallSource | undefined {
  const declared = (env[INSTALL_SOURCE_ENV] ?? '').trim().toLowerCase();
  return KNOWN.has(declared) && InstallSource.UNKNOWN !== declared
    ? (declared as InstallSource)
    : undefined;
}

/**
 * The install source for a project: what its config recorded, else what the environment declares.
 *
 * The config wins because it is the durable answer. The marker is an environment variable set by
 * whichever channel ran the install, so it exists for exactly one command and is gone by the next
 * one — which is why this field reached a handful of events and nothing else, and why the question
 * it exists to answer could not be asked.
 *
 * Narrowed against the closed list on the way out, the same as the env path: a config file is user
 * data, and a hand-edited one must not be able to put an arbitrary string on the wire.
 */
export function projectInstallSource(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): InstallSource {
  const recorded = findProjectConfig(cwd)?.['installSource'];
  if ('string' === typeof recorded) {
    const narrowed = recorded.trim().toLowerCase();
    if (KNOWN.has(narrowed)) return narrowed as InstallSource;
  }
  return resolveInstallSource(env);
}

/**
 * The same config with `installSource` added, or `undefined` when there is nothing to add.
 *
 * `installSource` is written only when `.reticle.json` is CREATED, and `init` reports that file as
 * `already exists` on every re-run — so everyone who was already here when the marker shipped, and
 * everyone who ran `init` once without one, keeps `unknown` forever with no way to fix it. That is
 * most of the population the field exists to describe.
 *
 * An EXISTING value is never overwritten. The first channel is the one that brought the user in, and
 * a later `init` through a different route must not take credit for an acquisition it did not make.
 * Anything unparseable is left exactly as it is: a config is user data, and `init` rewriting a file
 * it could not read would be a far worse failure than a missing dimension.
 */
export function configWithInstallSource(
  source: string | null | undefined,
  declared: string | undefined,
): string | undefined {
  if (undefined === declared || null === source || undefined === source) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (null === parsed || 'object' !== typeof parsed || Array.isArray(parsed)) return undefined;
  const fields = parsed as Record<string, unknown>;
  if (undefined !== fields['installSource']) return undefined;
  return `${JSON.stringify({ ...fields, installSource: declared }, null, 2)}\n`;
}
