import * as http from 'node:http';
import { NodePlatform } from '../platform.js';
import { spawn } from 'node:child_process';
import { isOpaqueOrigin, LOOPBACK_HOST, STATUS_PATH } from '@reticlehq/core';
import { daemonFix, describeSkew } from '../version/version-skew.js';
import { CONTRACT_FINGERPRINT } from '@reticlehq/core';
import { SERVER_VERSION } from '../version/server-version.js';
import { log } from '../log.js';
import { loopbackAgent } from '../loopback-agent.js';

/**
 * CLI launch + status helpers — the daemon-introspection (`reticle status`) and the one-command
 * "show me the app" flow (`reticle open`). Split out of cli.ts so that file stays under the size cap.
 * The decision logic is pure (unit-tested); the IO (fetch, OS browser launch) is injected/isolated.
 */

/** One connected tab as `reticle status` reports it — the at-a-glance health line. */
interface StatusSession {
  sessionId: string;
  url: string;
  throttled: boolean;
  stale: boolean;
  pendingMarks: number;
  /** The tab is attached and answering nothing — see Session.unresponsive. Absent on an older daemon. */
  unresponsive?: true;
}

/**
 * Reduce the daemon's /status JSON to the compact view `reticle status` prints. Pure: narrows the
 * untrusted wire payload (never `any`) and tolerates a missing/partial body so a malformed response
 * degrades to "running, 0 sessions" instead of throwing.
 */
export function summarizeStatus(payload: unknown): {
  sessionCount: number;
  sessions: StatusSession[];
  why?: string;
} {
  if (typeof payload !== 'object' || null === payload) return { sessionCount: 0, sessions: [] };
  const obj = payload as Record<string, unknown>;
  // Carried through to the printed line: with no sessions this is the whole answer, and dropping it
  // here would silently undo the reason it is on the wire.
  const why = 'string' === typeof obj['why'] ? obj['why'] : undefined;
  const raw = Array.isArray(obj['sessions']) ? obj['sessions'] : [];
  const sessions = raw
    .map((s): StatusSession | null => {
      if (typeof s !== 'object' || null === s) return null;
      const r = s as Record<string, unknown>;
      const sessionId = 'string' === typeof r['sessionId'] ? r['sessionId'] : '';
      if ('' === sessionId) return null;
      return {
        sessionId,
        url: 'string' === typeof r['url'] ? r['url'] : '',
        throttled: true === r['throttled'],
        stale: true === r['stale'],
        pendingMarks: 'number' === typeof r['pendingMarks'] ? r['pendingMarks'] : 0,
        ...(true === r['unresponsive'] ? { unresponsive: true as const } : {}),
      };
    })
    .filter((s): s is StatusSession => s !== null);
  const sessionCount =
    'number' === typeof obj['sessionCount'] ? obj['sessionCount'] : sessions.length;
  return { sessionCount, sessions, ...(why === undefined ? {} : { why }) };
}

/** A string field off the /status body, or undefined on a daemon too old to report it. */
function statusField(payload: unknown, key: string): string | undefined {
  if (typeof payload !== 'object' || null === payload) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return 'string' === typeof value && value.length > 0 ? value : undefined;
}

/**
 * Warn when the daemon already on this port is a different version than this CLI, and attach anyway.
 *
 * Attaching to whatever owns the port is the point of a daemon — but it means an upgrade does not
 * take effect until that daemon dies, and nothing used to say so. Killing it here would take out
 * another agent's session on a version bump, which is worse than a loud line.
 */
export async function warnOnDaemonSkew(port: number): Promise<void> {
  const status = await fetchStatus(port);
  const daemonVersion = statusField(status, 'version');
  const skew = describeSkew(
    {
      what: 'the daemon already running on this port',
      version: daemonVersion,
      contract: statusField(status, 'contract'),
      // The daemon is the peer here and this process is the agent side.
      fix: daemonFix(daemonVersion, SERVER_VERSION),
    },
    { version: SERVER_VERSION, contract: CONTRACT_FINGERPRINT },
  );
  if (skew !== undefined) log('reticle_daemon_skew', { port, warning: skew });
}

/** How long the daemon /status probe waits before giving up — a local loopback call is near-instant. */
const STATUS_PROBE_TIMEOUT_MS = 1000;

/** GET the daemon's /status JSON. Resolves to the parsed body, or undefined on any failure. */
export function fetchStatus(port: number): Promise<unknown> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: LOOPBACK_HOST,
        port,
        path: STATUS_PATH,
        timeout: STATUS_PROBE_TIMEOUT_MS,
        // Shares the proxy's keep-alive agent: the proxy calls this on every reconnect, and a socket
        // per probe is the same churn the POST leg was fixed for.
        agent: loopbackAgent,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(undefined);
          }
        });
      },
    );
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
  });
}

/** What `reticle open` should do: reuse an already-connected tab, open a new one, or ask for a url. */
type OpenDecision =
  | { action: 'reuse'; url: string }
  /** A tab on that origin exists, but on another page — kept, and NOT reported as done. */
  | { action: 'left-as-is'; url: string; requested: string }
  | { action: 'open'; url: string }
  | { action: 'need-url' };

function sameOrigin(a: string, b: string): boolean {
  try {
    const origin = new URL(a).origin;
    // Two opaque origins (desktop webviews, file:// docs) BOTH stringify to "null", so comparing them
    // would call every desktop app the same app and reuse the wrong session. Never match on opaque.
    if (isOpaqueOrigin(origin)) return false;
    return origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Decide what `reticle open [url]` does, given the currently-connected tabs. Pure.
 * - no url + a tab connected → reuse it (the app is already open; don't spawn a duplicate).
 * - no url + nothing connected → ask for one.
 * - url + a tab already AT that url → reuse it (idempotent — re-running never piles up tabs).
 * - url + a tab on that origin but another page → keep it, and say so (`left-as-is`).
 * - url + no matching tab → open it.
 *
 * The origin match is why re-running this never piles up tabs, and it stays. What changed is the
 * REPORT: matching by origin meant `reticle open http://localhost:3000/settings` answered `reusing`
 * for a tab sitting on `http://localhost:3000/` and exited 0, so the caller read a success for a page
 * that was never opened. Navigating the tab instead was the other option and is worse: `reticle open`
 * is run by a human whose browser this is, and yanking the page they are looking at to somewhere else
 * is a bigger surprise than being told where the tab actually is.
 */
export function decideOpen(
  all: { url: string; unresponsive?: boolean }[],
  url: string | undefined,
): OpenDecision {
  // A tab that has stopped answering is not a tab you can be handed. `open` is the command a caller
  // reaches for to RECOVER, and reusing the wedged one left no way out short of killing the daemon:
  // ending the session only flips a flag on the record, it does not make the page answer.
  const sessions = all.filter((s) => true !== s.unresponsive);
  if (url === undefined) {
    const first = sessions[0];
    return first !== undefined ? { action: 'reuse', url: first.url } : { action: 'need-url' };
  }
  const exact = sessions.find((s) => s.url === url);
  if (exact !== undefined) return { action: 'reuse', url: exact.url };
  const onOrigin = sessions.find((s) => sameOrigin(s.url, url));
  return onOrigin !== undefined
    ? { action: 'left-as-is', url: onOrigin.url, requested: url }
    : { action: 'open', url };
}

/**
 * Percent-encode the cmd.exe metacharacters that `start` re-parses so a URL can't break out into
 * command execution on Windows (`?next=x&calc` → command chaining). `%` is left untouched so an
 * already-encoded URL isn't double-encoded; the browser decodes the escapes back to the real URL.
 */
function encodeForWindowsStart(url: string): string {
  return url.replace(/[&^|<>()"'!]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The OS command that opens a URL in the default browser, per platform. Pure — unit-tested. */
export function openCommand(
  url: string,
  platform: NodeJS.Platform,
): { cmd: string; args: string[] } {
  if (NodePlatform.MACOS === platform) return { cmd: 'open', args: [url] };
  if (NodePlatform.WINDOWS === platform) {
    return { cmd: 'cmd', args: ['/c', 'start', '', encodeForWindowsStart(url)] };
  }
  return { cmd: 'xdg-open', args: [url] };
}

/**
 * Launch the default browser at `url` (detached). The spawn is injected so tests stay hermetic.
 *
 * Resolves to whether the launch COMMAND started — not to whether a page appeared. It used to return
 * nothing at all and the caller printed `{"opened": url}` unconditionally, so a launcher that failed
 * outright still reported success. Reported from the field as twenty minutes lost chasing a phantom
 * port problem while nothing had ever opened.
 */
export async function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  run: (cmd: string, args: string[]) => Promise<string | null> = defaultRun,
): Promise<string | null> {
  const { cmd, args } = openCommand(url, platform);
  return run(cmd, args);
}

/**
 * What a finished launcher means, or null when nothing is wrong.
 *
 * Exported for its own tests: the headless case is the one that matters and it cannot be produced
 * by spawning a real launcher on a developer machine.
 */
export function launcherFailure(code: number | null, signal: NodeJS.Signals | null): string | null {
  if (null !== signal) return `the browser launcher was killed by ${signal}`;
  // null code with no signal: it never reported an outcome in the window we waited. Some desktop
  // launchers stay attached rather than handing off, and inventing a failure there would be worse
  // than the silence — it would send someone to fix a browser that opened.
  if (null === code || 0 === code) return null;
  return (
    `the browser launcher exited ${String(code)} — on a machine with no browser (CI, a container, ` +
    'an SSH session, WSL with no host browser) it starts fine and then has nothing to open'
  );
}

/** How long to wait for the launcher to hand off before assuming it did. */
const LAUNCHER_EXIT_MS = 2_000;

/** null when the launcher opened something; the failure message when it did not. */
function defaultRun(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // An unhandled 'error' on a ChildProcess throws — and ENOENT on the launcher is exactly the case
    // this function exists to report, so it must be listened for either way.
    child.on('error', (err: Error) => finish(err.message));
    // The EXIT, not the spawn. Answering "did the command begin" reported success on every headless
    // box, where the launcher begins perfectly well and then finds nothing to open — see
    // launcherFailure. Every launcher we use hands off and exits immediately, so this costs nothing
    // on the path where it works.
    child.on('exit', (code, signal) => finish(launcherFailure(code, signal)));
    // ...and a launcher that stays attached must not hold up the install.
    const timer = setTimeout(() => {
      child.unref();
      finish(null);
    }, LAUNCHER_EXIT_MS);
    timer.unref?.();
  });
}
