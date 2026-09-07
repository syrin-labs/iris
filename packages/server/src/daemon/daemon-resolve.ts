/**
 * Which daemon does THIS project belong to?
 *
 * The system answered that two incompatible ways. Build plugins asked the registry by projectId, the
 * way `pickDaemonPort` was designed to be asked. The CLI and the MCP proxy asked a NUMBER —
 * `envPort ?? projectPort ?? 4400` — and then attached to whatever owned it, whoever it belonged to.
 *
 * So every project on a machine funnelled into one daemon. Its recorded identity was whichever
 * project won the race to the port, which made the registry entry wrong the moment a second project
 * attached, and made one `kill` on one well-known port a machine-wide outage for every agent at once.
 *
 * It worked anyway, by luck: everyone defaulted to the same number, so everyone found each other.
 * The luck ends the moment a daemon is anywhere but the default — which is exactly when discovery was
 * supposed to help, and exactly when it returned nothing.
 *
 * This module is the one answer both sides now use. It is pure and injectable: no process spawning,
 * no port binding, nothing that needs a real `~/.reticle` to test.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DaemonRegistryEntrySchema,
  daemonRegistryPort,
  pickDaemonPort,
  type DaemonRegistryEntry,
} from '@reticlehq/core';

/**
 * Every well-formed registry entry in `home`.
 *
 * A corrupt or half-written entry is skipped rather than thrown on: the registry is written by other
 * processes that can be killed mid-write, and one bad file must not make a machine's daemons
 * undiscoverable. Validated through core's schema so a shape change cannot silently pass here.
 */
function readDaemonRegistry(home: string): DaemonRegistryEntry[] {
  let files: string[];
  try {
    files = readdirSync(home);
  } catch {
    return []; // no ~/.reticle yet: no daemon has ever run here
  }
  const entries: DaemonRegistryEntry[] = [];
  for (const file of files) {
    if (null === daemonRegistryPort(file)) continue;
    try {
      const parsed = DaemonRegistryEntrySchema.safeParse(
        JSON.parse(readFileSync(join(home, file), 'utf8')),
      );
      if (parsed.success) entries.push(parsed.data);
    } catch {
      continue;
    }
  }
  return entries;
}

/**
 * The port of the live daemon serving `projectId`, or undefined when this project has none.
 *
 * Undefined means "start one", never "use the default and hope". That distinction is the fix: the old
 * path had no way to express "no daemon of mine exists", so it fell through to a number and attached
 * to a stranger.
 *
 * The selection rule is core's `pickDaemonPort`, shared with every build plugin, so the daemon side
 * and the app side cannot disagree about which daemon is ours.
 */
export function resolveDaemonForProject(
  projectId: string | undefined,
  home: string,
  alive: (pid: number) => boolean,
): number | undefined {
  return pickDaemonPort(readDaemonRegistry(home), projectId, alive) ?? undefined;
}

/**
 * May `caller` take over a daemon already sitting on the port it wanted?
 *
 * Two deliberate escape hatches, both of which keep an existing install working:
 *
 * A daemon that claims NO project was started somewhere without a `.reticle.json` — the global MCP
 * registration in a directory that is not an app, which is the majority of daemons in the field. It
 * belongs to nobody, so it belongs to whoever asks; refusing would break every user running Reticle
 * globally, which is how it is documented to be installed.
 *
 * A caller with no project of its own has no identity to defend and nothing to be confused about, so
 * it keeps the old permissive behaviour rather than being locked out of a daemon it can use.
 *
 * Everything else — a named daemon and a differently-named caller — is the cross-project bleed, and
 * is the one case this refuses.
 */
export function adoptable(
  daemonProjectId: string | undefined,
  callerProjectId: string | undefined,
): boolean {
  if (daemonProjectId === undefined || 0 === daemonProjectId.length) return true;
  if (callerProjectId === undefined || 0 === callerProjectId.length) return true;
  return daemonProjectId === callerProjectId;
}

/** The project a daemon on `port` claims, or undefined when it claims none / is not registered. */
export function daemonProjectAt(port: number, home: string): string | undefined {
  return readDaemonRegistry(home).find((e) => e.port === port)?.projectId;
}

/**
 * Live daemons OTHER than `myPort` that an app for this project has connected to.
 *
 * The split brain this whole module was written to prevent has a second half nobody was reporting.
 * `resolveMcpPort` correctly refuses to adopt a stranger's daemon and relocates to an OS-assigned
 * port — and the APP, which resolves its own port independently (core's `pickDaemonPort` in the
 * build plugin, falling back to the documented default when nothing matches), can land on the
 * stranger. The pairing token is per USER, not per project, so that connect SUCCEEDS: the app is
 * live on one daemon and the agent is attached to a different, empty one.
 *
 * Every individual check is then green. The browser shows an instrumented page, `reticle status`
 * reports a session, the agent reports Reticle registered and enabled — and the agent's tools see
 * nothing, with a no-session diagnosis that tells it to start a dev server that is already running.
 *
 * `connectedOn` is injected rather than imported so this stays free of the session layer (which
 * imports from here) and so the rule is testable without a real `~/.reticle`. Callers pass
 * `hasProjectConnectedBefore` bound to the same projectId.
 *
 * Only LIVE daemons are named: a port a session used yesterday is history, not a split.
 */
export function daemonsServingProjectElsewhere(
  projectId: string | undefined,
  myPort: number,
  home: string,
  alive: (pid: number) => boolean,
  connectedOn: (port: number) => boolean,
): readonly number[] {
  if (projectId === undefined || 0 === projectId.length) return [];
  return readDaemonRegistry(home)
    .filter((entry) => entry.port !== myPort && alive(entry.pid) && connectedOn(entry.port))
    .map((entry) => entry.port)
    .sort((a, b) => a - b);
}

/**
 * The sentence for a split brain, or `undefined` when there is none.
 *
 * Stated as a fact about two ports rather than a hedge, because unlike the sibling-port observation
 * next door this is not "something is listening somewhere" — it is this project's own connection
 * record naming a daemon that is not the one being asked. The wording says which side is empty,
 * since the failure is invisible precisely because both sides look healthy from where they stand.
 */
export function splitBrainNote(myPort: number, elsewhere: readonly number[]): string | undefined {
  if (0 === elsewhere.length) return undefined;
  const listed = elsewhere.map((port) => `:${String(port)}`).join(', ');
  const first = elsewhere[0] ?? myPort;
  return (
    `this project's app is connected to a DIFFERENT Reticle daemon (${listed}), while this one is ` +
    `on :${String(myPort)} — two daemons for one project, and the agent is attached to the empty ` +
    'half. Nothing is wrong with the app or the wiring. Stop the other daemon with ' +
    `\`reticle stop --port ${String(first)}\` and restart the dev server so the app rediscovers ` +
    'this one, or start the agent and the dev server from the same project directory so both ' +
    'resolve the same daemon.'
  );
}

/**
 * The other stance on the same split, for a command standing on the port that HAS the app.
 *
 * `splitBrainNote` is asked from the empty daemon and reads the connection record. From the daemon
 * the app is connected to there is nothing missing to notice — sessions are live, every check is
 * green — and the only visible fact is that this project ALSO owns a live daemon somewhere else.
 * One project, two daemons, is a split whichever end you are standing on, and saying it from both
 * ends is the difference between a user inferring it from two green checkmarks and being told.
 *
 * Silent for a caller with no project (it owns no daemon to be split from) and silent when the port
 * being inspected is the project's own.
 */
export function wrongDaemonNote(
  inspectedPort: number,
  ownPort: number | undefined,
): string | undefined {
  if (ownPort === undefined || ownPort === inspectedPort) return undefined;
  return (
    `this is not this project's own daemon: the registry says it owns a live daemon on ` +
    `:${String(ownPort)} and this command is looking at :${String(inspectedPort)}. Two daemons for ` +
    'one project means the half your agent is attached to and the half your app is connected to can ' +
    'be different processes, with both reporting healthy. Stop one of them and restart the dev ' +
    'server so everything lands on the same port.'
  );
}

/**
 * The port this agent's MCP proxy should serve, decided BEFORE the proxy starts.
 *
 * Resolved once rather than per reconnect because the proxy's transport is built around a fixed
 * number, and making it chase a moving port would mean reworking the reconnect path — the one piece
 * of this system whose failure mode is "the MCP server disappeared mid-session". The port it settles
 * on is this project's own, so the thing it would be chasing is a daemon it alone is responsible for.
 *
 * The order is the whole fix:
 *   1. our project's live daemon, wherever it is listening — a daemon that moved is still ours;
 *   2. the preferred port, but only if free or holding a daemon we may adopt;
 *   3. a port the OS gives us, when the preferred one belongs to somebody else.
 *
 * Step 3 is what stops a second project from attaching to the first project's daemon. That single
 * silent adoption is what made every agent on a machine share one process, one identity and one
 * blast radius.
 */
export async function resolveMcpPort(
  preferred: number,
  projectId: string | undefined,
  home: string,
  deps: {
    alive: (pid: number) => boolean;
    daemonPresent: (port: number) => Promise<boolean>;
    pickPort: (preferred: number) => Promise<number>;
  },
): Promise<number> {
  const mine = resolveDaemonForProject(projectId, home, deps.alive);
  if (mine !== undefined) return mine;
  if (!(await deps.daemonPresent(preferred))) return preferred;
  return adoptable(daemonProjectAt(preferred, home), projectId)
    ? preferred
    : deps.pickPort(preferred);
}
