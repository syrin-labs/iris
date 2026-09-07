/**
 * Which of the usual dev-server ports have something listening on them.
 *
 * The one fact that separates "the app is not running" from "the app is running and never dialled
 * us" — the difference between two completely different next actions for the agent, which the
 * no-session message could not tell apart before. See no-session-diagnosis.ts.
 *
 * Kept out of the hot path: `SessionManager.resolve` is synchronous and runs on every tool call, so
 * the probe refreshes in the background and the resolve path reads a cached answer. A stale answer
 * is fine here — it is a hint in an error message, not a decision.
 */

import { request } from 'node:http';
import { DEV_SERVER_PORTS } from '../cli/cli-port.js';
import { looksLikeDevServer } from './looks-like-dev-server.js';

/**
 * Give up fast, but do not call giving up an absence.
 *
 * This budget suits Vite handing back a static index.html. It does NOT suit an SSR framework
 * compiling a route on the first request: Nuxt and Next routinely take seconds cold, and treating
 * that as "nothing is there" told a reporter to start a dev server that was already serving 57KB of
 * HTML — advice that would have hit their dev lock with a second `nuxt dev`.
 *
 * So the budget stays short and the TIMEOUT changed meaning instead. See PortState.
 */
const HTTP_PROBE_TIMEOUT_MS = 400;

/**
 * What the probe actually learned about a port. Three states, because two cannot express this.
 *
 * A bare TCP connect is not enough (macOS AirPlay Receiver holds 5000 on every Mac and would read as
 * the user's dev server), and a document check alone is not enough either (a compiling SSR server
 * reads as absent). The thing in between — accepted the connection, said nothing in time — is a
 * listener we cannot classify, and reporting that honestly is the point.
 */
export const PortState = {
  /** Nothing accepted a connection on either loopback family. */
  CLOSED: 'closed',
  /** Accepted a connection, then answered nothing within the budget. Something IS there. */
  CONNECTED_NO_ANSWER: 'connected-no-answer',
  /** Answered with a document: a dev server serving an app. */
  SERVES_DOCUMENT: 'serves-document',
} as const;
export type PortState = (typeof PortState)[keyof typeof PortState];

/** The probe's answer for one port, however it was obtained. */
export function classifyPort(
  port: number,
  probe: (port: number) => Promise<PortState>,
): Promise<PortState> {
  return probe(port).catch(() => PortState.CLOSED);
}
/**
 * `localhost`, not `127.0.0.1` — so BOTH address families are tried.
 *
 * Measured: a plain `vite --port 4311` on this machine listens on `[::1]` only, and a probe pinned to
 * the IPv4 loopback cannot see it. The old TCP probe had the same blind spot, which meant the
 * diagnostic could miss the very dev server it exists to find while still reporting an unrelated
 * service that happens to bind both stacks (macOS AirPlay does).
 */
/**
 * Both loopback addresses, BY ADDRESS — never by the name `localhost`.
 *
 * A dev server started with `--host` binds the wildcards `0.0.0.0` and `[::]` rather than the
 * loopbacks, and a wildcard bind serves only the family it belongs to. Asking for `localhost` hands
 * the choice of family to the resolver: on Windows it prefers `::1`, so a `0.0.0.0` listener is
 * invisible and the scan reports "nothing is listening" about a dev server that is plainly running.
 * Reported from the field on exactly that setup.
 *
 * `[::1]` is also how a `[::]` bind is reached, and on most stacks a `[::]` bind additionally
 * accepts v4-mapped connections — so between the two, every ordinary bind is covered.
 */
export const PROBE_HOSTS: readonly string[] = ['127.0.0.1', '::1'];

/**
 * Does this port serve a DOCUMENT — i.e. is it a dev server rather than merely something listening?
 *
 * A bare TCP connect reported macOS ControlCenter (AirPlay Receiver, on by default on every Mac,
 * port 5000) as the user's dev server. See looks-like-dev-server for what it actually answers and
 * why "a socket accepted" is the wrong question.
 */
function probeState(port: number, host: string): Promise<PortState> {
  return new Promise((resolve) => {
    // Whether the SOCKET came up is tracked separately from whether a response did, because that is
    // the whole difference between "nothing is there" and "something is there and still compiling".
    let connected = false;
    const req = request(
      { host, port, path: '/', method: 'GET', timeout: HTTP_PROBE_TIMEOUT_MS },
      (res) => {
        const answer = looksLikeDevServer(res.statusCode ?? 0, res.headers['content-type']);
        res.resume(); // drain, so the socket closes rather than lingering
        resolve(answer ? PortState.SERVES_DOCUMENT : PortState.CLOSED);
      },
    );
    req.once('socket', (socket) => {
      socket.once('connect', () => {
        connected = true;
      });
    });
    req.once('timeout', () => {
      req.destroy();
      resolve(connected ? PortState.CONNECTED_NO_ANSWER : PortState.CLOSED);
    });
    req.once('error', () => resolve(PortState.CLOSED));
    req.end();
  });
}

/** Kept for callers that only need the yes/no. A slow listener is NOT a dev server, but it is not absent. */
function servesDocument(port: number, host: string): Promise<boolean> {
  return probeState(port, host).then((state) => state === PortState.SERVES_DOCUMENT);
}

/**
 * Is anything serving a document on this port, on EITHER loopback family?
 *
 * "Either" and not "both": one answer is enough, and requiring both would make the wildcard binds
 * this exists to see fail the check again. A family that errors (no IPv6 stack at all) is an
 * absence, never a rejection — a diagnostic must not throw at the tool it is diagnosing.
 */
export async function anyFamilyServes(
  port: number,
  probe: (port: number, host: string) => Promise<boolean> = servesDocument,
): Promise<boolean> {
  const answers = await Promise.all(
    PROBE_HOSTS.map((host) => probe(port, host).catch(() => false)),
  );
  return answers.some((up) => up);
}

/**
 * Every candidate port, split by what the probe could actually establish.
 *
 * `slow` is the set that accepted a connection and then said nothing inside the budget. Those ports
 * are NOT dev servers as far as this check knows, and they are emphatically not absent — an SSR
 * framework compiling its first route lands here every time. Reported separately so the diagnosis
 * can stop telling people to start a server that is already running.
 */
export async function probeDevServerStates(
  ports: readonly number[] = [...DEV_SERVER_PORTS],
  probe: (port: number) => Promise<PortState> = (p) => anyFamilyState(p),
): Promise<{ serving: number[]; slow: number[] }> {
  const states = await Promise.all(
    ports.map((p) => classifyPort(p, probe).then((state) => ({ port: p, state }))),
  );
  const pick = (want: PortState): number[] =>
    states
      .filter((s) => s.state === want)
      .map((s) => s.port)
      .sort((a, b) => a - b);
  return { serving: pick(PortState.SERVES_DOCUMENT), slow: pick(PortState.CONNECTED_NO_ANSWER) };
}

/**
 * The strongest state either loopback family reports.
 *
 * Serving a document beats a bare connection beats nothing, so a server bound to only one family is
 * still seen at its best — the same "either, not both" rule `anyFamilyServes` follows, extended to
 * three states.
 */
async function anyFamilyState(
  port: number,
  probe: (port: number, host: string) => Promise<PortState> = probeState,
): Promise<PortState> {
  const answers = await Promise.all(
    PROBE_HOSTS.map((host) => probe(port, host).catch(() => PortState.CLOSED)),
  );
  if (answers.includes(PortState.SERVES_DOCUMENT)) return PortState.SERVES_DOCUMENT;
  if (answers.includes(PortState.CONNECTED_NO_ANSWER)) return PortState.CONNECTED_NO_ANSWER;
  return PortState.CLOSED;
}

/** Every candidate port serving a document, in ascending order. Never rejects. */
export async function probeDevServers(
  ports: readonly number[] = [...DEV_SERVER_PORTS],
  probe: (port: number) => Promise<boolean> = (p) => anyFamilyServes(p),
): Promise<number[]> {
  const results = await Promise.all(ports.map((p) => probe(p).then((up) => (up ? p : null))));
  return results.filter((p): p is number => p !== null).sort((a, b) => a - b);
}
