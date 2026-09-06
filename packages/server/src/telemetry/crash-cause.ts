/**
 * What a crash was, when the stack cannot say where it was.
 *
 * `reticleFrames` keeps only frames inside our own published packages, on the rule that a crash
 * stack is mostly the user's application and node internals and neither is ours to collect. That
 * rule is right and stays. But a refused socket has a stack that is ENTIRELY node internals:
 *
 *     Error: connect ECONNREFUSED 127.0.0.1:4400
 *         at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1637:16)
 *
 * so every crash of that shape arrives with an error type, a redacted message, and nothing else —
 * 65 of them in one measured day, one fingerprint, zero location on all 65, and 63 of those from
 * two people who emitted no other event of any kind. A loopback-heavy tool produces plenty of
 * these, and the next one is just as blind.
 *
 * Everything here is derived from a Node SYSTEM ERROR's own structured properties, and every field
 * is chosen so that it carries nothing of the reporter's: the syscall and errno are our own
 * vocabulary, `loopback` is one bit, the port is compared against values we already know and
 * reported as an enum, and the frame names a line in NODE's source. The address and the port number
 * are read and deliberately thrown away.
 */

/** The structured cause of a crash, when the error carries one. Every field is optional. */
interface CrashCause {
  syscall?: string;
  errno?: string;
  loopback?: boolean;
  port?: CrashPort;
  internalFrame?: string;
}

import { CrashPort } from '@reticlehq/core';
import { reticleFrames } from './error-fingerprint.js';

/** IPv4 loopback is the whole 127/8 block, not just 127.0.0.1. */
const IPV4_LOOPBACK = /^127\./;
/** `node:net:1637` out of `at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1637:16)`. */
const NODE_INTERNAL_FRAME = /\((node:[\w/.-]+):(\d+):\d+\)/;
/** V8 renders an IPv4-mapped IPv6 address this way; the mapped half is what decides loopback. */
const IPV6_MAPPED_PREFIX = '::ffff:';

/**
 * Was this aimed at the machine it was running on?
 *
 * One bit, and it splits two populations with different owners: refused ON loopback is a Reticle
 * lifecycle problem (a daemon that is not up), refused off-box is a network problem that is not
 * ours. Today they are indistinguishable in the data.
 */
function isLoopback(address: string): boolean {
  const host = address.toLowerCase();
  if ('::1' === host || 'localhost' === host) return true;
  const unmapped = host.startsWith(IPV6_MAPPED_PREFIX)
    ? host.slice(IPV6_MAPPED_PREFIX.length)
    : host;
  return IPV4_LOOPBACK.test(unmapped);
}

/**
 * The innermost frame that names NODE's own source.
 *
 * Innermost because that is where the failure actually happened, and it distinguishes a connect
 * from a DNS lookup from a TLS handshake — the thing that, in the report this came from, had to be
 * worked out by hand from a proxy's reject path. `node:net:1637` is a line in Node's published
 * source: it carries nothing about the machine, the app, or anyone's directory layout, which is
 * why it can be kept when the user's own frames cannot.
 */
export function innermostInternalFrame(stack: string): string | undefined {
  for (const line of stack.split('\n')) {
    const match = line.match(NODE_INTERNAL_FRAME);
    if (null === match) continue;
    const [, module, lineNumber] = match;
    if (module === undefined || lineNumber === undefined) continue;
    return `${module}:${lineNumber}`;
  }
  return undefined;
}

/**
 * Read a Node system error's structured cause, keeping only what is ours to keep.
 *
 * `knownPorts` is passed IN rather than read from the environment so this stays pure and so the
 * comparison is testable — the port itself is used to answer one enum and is then discarded.
 */
export function crashCause(value: unknown, knownPorts: readonly number[]): CrashCause {
  if (!(value instanceof Error)) return {};
  const error: NodeJS.ErrnoException & { address?: unknown; port?: unknown } = value;
  const cause: CrashCause = {};

  if ('string' === typeof error.syscall && error.syscall.length > 0) cause.syscall = error.syscall;
  // `code` (`ECONNREFUSED`), not the numeric `errno` (-61): the symbolic name is stable across
  // platforms, where the number is not.
  if ('string' === typeof error.code && error.code.length > 0) cause.errno = error.code;
  if ('string' === typeof error.address) cause.loopback = isLoopback(error.address);
  if ('number' === typeof error.port) {
    cause.port = knownPorts.includes(error.port) ? CrashPort.RETICLE : CrashPort.OTHER;
  }

  // Only for a SYSTEM error, and only when nothing of ours is on the stack.
  //
  // Both halves are about collecting the minimum that answers the question. Any error raised
  // anywhere in Node carries `node:internal/*` frames from whatever called it, so an ungated rule
  // would attach one to every crash — noise on the reports that already have a location, and more
  // than we need. The blind reports are the ones with a syscall and no frames of our own, and they
  // are the only ones this exists for.
  if (cause.syscall === undefined && cause.errno === undefined) return cause;
  if (reticleFrames(error.stack ?? '').length > 0) return cause;
  const frame = innermostInternalFrame(error.stack ?? '');
  if (frame !== undefined) cause.internalFrame = frame;
  return cause;
}
