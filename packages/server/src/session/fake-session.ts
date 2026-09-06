/**
 * One complete, inert `Session` for tests that only care about two or three of its methods.
 *
 * Test-only. Every consumer of `Session` used to hand-roll a `Partial<Session>` and cast it through
 * `as Session`, and the cast is the problem: it silences the type system, so a method added to
 * `Session` breaks nothing at compile time and then throws at runtime inside files that have
 * nothing to do with the change. That has now happened four times -- `occludedBy` (#227),
 * `bufferHealth` (#228), the case recorded at the top of `assert-contradiction-plumbing.test.ts`,
 * and `lostSince`, which needed the identical one-line stub added to seven files (#726).
 *
 * This returns a REAL `Session`, built with an inert socket and a frozen clock, so a new method
 * arrives with a working default instead of `undefined`. `Session` holds `#private` fields, so a
 * structural stub cannot be one -- constructing the real thing is what makes the guarantee hold.
 *
 * Overrides are applied as own properties, shadowing the prototype method for that instance. Pass
 * only the behaviour a test actually asserts on; leave the rest to the defaults.
 */
import { MessageKind, RETICLE_PROTOCOL_VERSION, type HelloMessage } from '@reticlehq/core';
import type { WebSocket } from 'ws';
import { Session } from './session.js';

/** Accepts and discards. A fake session is never expected to reach a peer. */
const INERT_SOCKET = {
  send: () => undefined,
  close: () => undefined,
} as unknown as WebSocket;

/** Frozen at 0, so `elapsed()`, `lastSeenMs()` and `agentIdleMs()` are all deterministic zeroes. */
const FROZEN_CLOCK = (): number => 0;

/**
 * The handshake a fake session reports.
 *
 * `sessionId: 'demo'` matches what the hand-rolled stubs used, so tests asserting on the id in a
 * message keep passing without an override.
 */
export function fakeHello(overrides: Partial<HelloMessage> = {}): HelloMessage {
  return {
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId: 'demo',
    url: 'http://localhost/',
    title: 'Demo',
    adapters: [],
    ...overrides,
  };
}

/** Whether `key` resolves to a getter somewhere on the prototype chain rather than a plain slot. */
function isAccessor(target: object, key: string): boolean {
  let proto: object | null = target;
  while (null !== proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    if (undefined !== descriptor) return undefined !== descriptor.get;
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return false;
}

/**
 * A real `Session` with inert defaults, plus whatever this test needs it to do differently.
 *
 * @param overrides Written onto the instance after construction, shadowing the real member for
 *   this session only. `runtime`, `engine`, `brand` and `actionCount` are getter-only accessors on
 *   the prototype -- a plain assignment to one throws -- so those are redefined as instance values
 *   instead. Overriding them is what a test wants: the real ones are fed by `applyHealth` and the
 *   journal, which a fake session has neither of.
 * @param hello Handshake fields, when a test cares about the id, url or redact keys.
 */
export function createFakeSession(
  overrides: Partial<Session> = {},
  hello: Partial<HelloMessage> = {},
): Session {
  const session = new Session(fakeHello(hello), INERT_SOCKET, FROZEN_CLOCK);
  for (const [key, value] of Object.entries(overrides)) {
    if (isAccessor(session, key)) {
      Object.defineProperty(session, key, {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    } else {
      (session as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return session;
}
