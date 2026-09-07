/**
 * Two durable bits about the CLIENT side of the install: has an MCP client ever started Reticle's
 * MCP server on this port, and has one ever asked it for the tool list.
 *
 * Some hosts register the server, start it, and then never send `tools/list` until the client is
 * restarted. The agent has no Reticle tools, the user has no message, and from our side that install
 * is byte-identical to one somebody wired and abandoned: daemon idle, no sessions, nothing to say.
 * `status` could report "registered" and "connected"; it could not report the state in between,
 * which is the one with an answer ("restart your client").
 *
 * Both bits record something that HAPPENED — the proxy ran, a `tools/list` arrived — never an
 * inference from a config file. A config entry proves somebody wrote a line of JSON; it does not
 * prove a client ever read it, which is precisely the thing in question here.
 *
 * Deliberately the same shape as `connection-memory.ts`: one small JSON file per port under the
 * daemon's state home, best-effort in both directions. It is a HINT, so every failure degrades to
 * "we do not know" rather than throwing — a diagnostic that can crash the process it is diagnosing
 * is worse than no diagnostic at all.
 *
 * KNOWN LIMIT, and why the messages below say so out loud: the record is per PORT, not per client.
 * Two clients on one machine share it, so a healthy one masks a broken one, and the record itself
 * only begins on the version that introduced it — a long-working install reads as never attached
 * until its client next starts the server. Both limits are stated in the text the user reads,
 * because an honest "here is what I can see, here is what to check" beats a confident wrong no.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What the client side of this install has been observed doing on this port. */
export const AttachState = {
  /** No client has started Reticle's MCP server here, as far as this record goes. */
  NEVER_ATTACHED: 'never-attached',
  /** A client started it and never asked for the tool list — the state that needs a restart. */
  NEVER_ENUMERATED: 'never-enumerated',
  /**
   * The catalogue was read and no tool was ever called: both ends healthy, nothing crossing.
   *
   * Reported from the field as the hardest state to diagnose, and it is the one every component
   * check passes. The browser SDK is injected, the daemon has a live session, the client lists all
   * the tools, and the agent still reports Reticle as absent. `enumerated` used to cover this, which
   * meant the most-broken install we know of read identically to a perfect one.
   */
  NEVER_CALLED: 'never-called',
  /** Started, enumerated, and actually used. Nothing to say. */
  ENUMERATED: 'enumerated',
} as const;
export type AttachState = (typeof AttachState)[keyof typeof AttachState];

/**
 * What to do about a client that started Reticle and never listed its tools.
 *
 * Names the cause AND the action, like the rest of the doctor/status vocabulary, and names its own
 * blind spot: this record cannot see WHICH client asked, so it must not tell somebody running two
 * of them that the one in front of them is the broken one.
 */
const NEVER_ENUMERATED_ACTION =
  'an MCP client started Reticle on this port and never asked for the tool list, so the tools are ' +
  'here and your client has not read them — restart your MCP client, which is what makes it list ' +
  'them again. This record is per port, not per client, so with more than one client registered ' +
  'the one that never listed may not be the one you are looking at.';

/**
 * What to do when nothing has ever attached.
 *
 * The hedge is not padding. This record begins the first time a client starts the server on a
 * version that keeps it, so an install that has worked for months reads as never attached until its
 * client next starts Reticle — and telling that user their server is unregistered would send them
 * to re-run `init` over a working setup.
 */
/**
 * The link that is broken, named as a link rather than as a component.
 *
 * Every other check in this product is about a PIECE: is the daemon up, is the SDK injected, is a
 * session live, are the tools registered. This state is the one where every piece passes and the
 * chain still does not carry anything, so the message has to say which hop failed and what to do
 * about it, not repeat that the pieces are fine.
 */
const NEVER_CALLED_ACTION =
  "an MCP client listed Reticle's tools on this port and has never called one, so the tools are " +
  'registered and no request has reached the daemon. That is the agent-to-daemon hop, not the ' +
  'browser or the daemon: both of those can look healthy while this one is broken. Ask your agent ' +
  'to run `reticle_sessions` explicitly. If it answers, the link is fine and the agent simply had ' +
  'no reason to call it; if it says Reticle is unavailable, the client is talking to a different ' +
  'server than the one this record belongs to, so re-check which command and port it launches. ' +
  'This record is per port, not per client.';

const NEVER_ATTACHED_ACTION =
  'no MCP client has started Reticle on this port, so either the server is not registered with your ' +
  'client or nothing has attached since this record began — register it with `npx ' +
  '@reticlehq/server init`, then restart your MCP client and run status again.';

interface AttachRecord {
  /** A client started the MCP server on this port. */
  attached: boolean;
  /** A client asked that server for the tool list. */
  enumerated: boolean;
  /** A client actually CALLED one of them. The bit that separates a working link from a listed one. */
  called: boolean;
}

const EMPTY: AttachRecord = { attached: false, enumerated: false, called: false };

function memoryPath(stateDir: string, port: number): string {
  return join(stateDir, `attach-${String(port)}.json`);
}

/** The record for a port. Empty on absent, unreadable, or malformed state. */
function read(stateDir: string, port: number): AttachRecord {
  try {
    const parsed: unknown = JSON.parse(readFileSync(memoryPath(stateDir, port), 'utf8'));
    if ('object' !== typeof parsed || null === parsed) return EMPTY;
    const record = parsed as Partial<Record<keyof AttachRecord, unknown>>;
    return {
      attached: true === record.attached,
      enumerated: true === record.enumerated,
      called: true === record.called,
    };
  } catch {
    return EMPTY;
  }
}

/** Write the record back, best-effort. A hint must never be the reason a proxy fails to serve. */
function write(stateDir: string, port: number, record: AttachRecord): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(memoryPath(stateDir, port), JSON.stringify(record), 'utf8');
  } catch {
    // An unwritable state home is already reported elsewhere; it must not break the client path.
  }
}

/** Record that an MCP client started the proxy on this port. */
export function rememberProxyStarted(stateDir: string, port: number): void {
  const known = read(stateDir, port);
  if (known.attached) return;
  write(stateDir, port, { ...known, attached: true });
}

/**
 * Record that a client actually CALLED a tool here, not merely listed them.
 *
 * Written once and then skipped, like the other two: this runs on the hot path of every tool call,
 * and a diagnostic that writes a file per call would cost more than it tells anybody.
 */
export function rememberToolCalled(stateDir: string, port: number): void {
  const known = read(stateDir, port);
  if (known.called) return;
  write(stateDir, port, { ...known, called: true });
}

/**
 * Record that a client asked for the tool list on this port.
 *
 * Enumeration implies attachment — a `tools/list` cannot arrive at a server nobody started — so this
 * sets both bits, and a record written by an older proxy that only ever set one is still read
 * correctly.
 */
export function rememberEnumerated(stateDir: string, port: number): void {
  const known = read(stateDir, port);
  if (known.enumerated) return;
  write(stateDir, port, { ...known, attached: true, enumerated: true });
}

/** Which of the four client-side states this port is in. */
export function attachState(stateDir: string, port: number): AttachState {
  const known = read(stateDir, port);
  // Ordered outward along the chain: attached, then listed, then actually used. The last hop is
  // the one every component check misses, so it is asked last and answered explicitly.
  if (!known.attached) return AttachState.NEVER_ATTACHED;
  if (!known.enumerated) return AttachState.NEVER_ENUMERATED;
  return known.called ? AttachState.ENUMERATED : AttachState.NEVER_CALLED;
}

/**
 * The sentence to print for a state, or `undefined` when there is nothing to fix.
 *
 * The healthy case has to stay silent: advice printed beside a working client reads as though
 * something is still wrong, which is its own kind of lie.
 */
export function describeAttachState(state: AttachState): string | undefined {
  if (state === AttachState.NEVER_ENUMERATED) return NEVER_ENUMERATED_ACTION;
  if (state === AttachState.NEVER_ATTACHED) return NEVER_ATTACHED_ACTION;
  if (state === AttachState.NEVER_CALLED) return NEVER_CALLED_ACTION;
  return undefined;
}

/** What `reticle status` reports about the client side of the install. */
interface AttachStatusFields {
  mcpClient: AttachState;
  mcpClientAction?: string;
}

/**
 * The client-side fields for one `status` run.
 *
 * The state is reported on EVERY run, healthy included — "the client has read the tools" is the
 * fact that was missing, and reporting it only when broken leaves the reader unable to tell a
 * healthy client from a version too old to look. The advice rides along only when there is any.
 */
export function attachStatusFields(stateDir: string, port: number): AttachStatusFields {
  const state = attachState(stateDir, port);
  const action = describeAttachState(state);
  // OMITTED rather than undefined: `exactOptionalPropertyTypes` is on, and an absent key is also
  // what keeps the healthy line to one fact.
  return { mcpClient: state, ...(action === undefined ? {} : { mcpClientAction: action }) };
}
