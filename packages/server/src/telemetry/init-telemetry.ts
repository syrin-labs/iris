/**
 * How `reticle init` went.
 *
 * The onboarding funnel had no instrumentation at all, which meant the two most different failure
 * modes were indistinguishable: someone whose setup died on a missing dependency looked exactly like
 * someone who installed the package and never ran the command. One is a bug we can fix; the other is
 * a marketing problem. Both showed up as silence.
 *
 * `reticle init` runs as a one-shot CLI command that exits immediately, so the send is DETACHED — the
 * same treatment `cli_command_run` gets, for the same reason: an in-process fetch would keep the
 * event loop alive and tax the command by most of a second.
 */
import { TelemetryEventKind, type InitOutcome } from '@reticlehq/core';
import { getTelemetry } from './telemetry.js';
import { resolveInstallSource } from './install-source.js';

/** Classified init failures — our own vocabulary, never a raw error or a path. */
export const InitFailure = {
  /** Run outside a project root. The single most common first-run mistake. */
  NO_PACKAGE_JSON: 'no_package_json',
  /** The manifest exists and is not valid JSON — a trailing comma, usually. Never a stack trace. */
  MALFORMED_PACKAGE_JSON: 'malformed_package_json',
  /** The package manager failed: offline, a locked registry, a broken install. */
  DEPENDENCY_INSTALL: 'dependency_install',
  /** The `claude mcp add` step failed — the CLI is missing or refused. Reticle installs but is unreachable. */
  MCP_REGISTRATION: 'mcp_registration',
  OTHER: 'other',
} as const;
export type InitFailure = (typeof InitFailure)[keyof typeof InitFailure];

/** Report one init outcome. Best-effort; setup must never fail because a metric did. */
export function reportInitOutcome(init: InitOutcome): void {
  try {
    void getTelemetry().emit(TelemetryEventKind.INIT_COMPLETED, {
      init,
      detach: true,
      // The other half of attribution: `reticle_installed` says a machine arrived, this says the
      // setup on it finished, and only together do they say which route converts. Same self-declared
      // marker, same refusal to infer — see install-source.ts.
      installSource: resolveInstallSource(),
    });
  } catch {
    /* a metric must never break `reticle init` */
  }
}
