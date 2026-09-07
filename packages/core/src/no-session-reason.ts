/**
 * WHY an install has produced no session — the closed vocabulary, on its own.
 *
 * Split out of telemetry.ts when that file crossed the 1000-line cap. It belongs apart regardless:
 * telemetry.ts is the wire contract, and this is the taxonomy the no-session DIAGNOSIS owns, read
 * by `explainNoSession`, the session manager and the refusal reporter alike.
 *
 * `no_session` is the largest refusal cohort, and on its own it is a set difference: the daemon
 * started, no app connected, and nothing says which of several opposite situations that was.
 * "Restarted the dev server and it still did not connect" and "never started the app" need
 * opposite fixes and arrived as the same silence (#615).
 *
 * Derived from `explainNoSession`'s branches rather than classified beside them, so the code and
 * the sentence the user is shown cannot drift apart. A reason describing a diagnosis nobody
 * received would be worse than none.
 */
export const NoSessionReason = {
  /** Connected before; the session that went was a pooled lease that aged out. */
  LEASE_EXPIRED: 'lease_expired',
  /** Connected before; the tab was closed, navigated away, or hard-reloaded. */
  TAB_GONE: 'tab_gone',
  /** This project has connected before, but not to this daemon run. Usually a restart with no reopen. */
  APP_NOT_REOPENED: 'app_not_reopened',
  /** A `.reticle.json` exists OUTSIDE this daemon's directory: a scope problem, not an install one. */
  CONFIG_ELSEWHERE: 'config_elsewhere',
  /** Nothing listening on the scanned ports AND no config here. The weakest position, and common. */
  NO_LISTENER_NO_CONFIG: 'no_listener_no_config',
  /** Nothing listening, but the project is wired. The dev server is the missing half. */
  NO_LISTENER: 'no_listener',
  /** Something is listening, but there is no config in this directory. */
  NO_CONFIG: 'no_config',
  /** Wired, listening, and still nothing arrived: the SDK is not reaching this daemon. */
  SDK_NOT_REACHING_DAEMON: 'sdk_not_reaching_daemon',
} as const;
export type NoSessionReason = (typeof NoSessionReason)[keyof typeof NoSessionReason];
