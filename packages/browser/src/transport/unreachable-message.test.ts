/**
 * The page reports what its own socket did, never what the daemon is doing.
 *
 * The SDK runs inside the browser. When its websocket does not open, the one thing it knows is that
 * its socket did not open, to a named address, N times. It cannot see whether a daemon is listening,
 * because "nothing answered me" and "something answered somebody else" are indistinguishable from
 * where it stands. The old message asked "Is the Reticle daemon running on that port?", which reads
 * as a diagnosis, and it was reported firing while the daemon was up and serving that exact session.
 *
 * A wrong cause costs more than no cause: no cause prompts investigation, a wrong cause ends it. An
 * agent told the daemon is down goes and restarts a healthy daemon, which is calls spent and, on a
 * shared port, somebody else's session taken out.
 *
 * The failures this page genuinely cannot tell apart are all reachability, not liveness: a daemon on
 * another host (container, devcontainer, WSL), an https page that may not open a `ws://` socket at
 * all, a wrong port. So the message states the observation, states that it is not evidence about the
 * daemon, and then lists the checks in the order that resolves them.
 *
 * Part of https://github.com/reticlehq/reticle/issues/310, whose rule is: report what you observed
 * and what you could not determine, never a cause.
 */

import { describe, expect, it } from 'vitest';
import { unreachableUrlIn } from '@reticlehq/core';
import { unreachableMessage } from './unreachable-message.js';

const message = (): string => unreachableMessage('ws://localhost:4400/reticle', 12);

describe('the unreachable warning states an observation, not a cause', () => {
  it('names the address it tried and how many attempts failed', () => {
    const text = message();
    expect(text).toContain('ws://localhost:4400/reticle');
    expect(text).toContain('12');
  });

  it('does not assert anything about the daemon, which it cannot see', () => {
    // The exact phrasings that made this a diagnosis. Asserted as absent rather than as an exact
    // string match on the whole message, so a rewording stays free while the claim stays banned.
    const text = message().toLowerCase();
    for (const claimed of [
      'is the reticle daemon running',
      'the daemon is not running',
      'no daemon',
      'the daemon is down',
    ]) {
      expect(text, `the page cannot observe this: "${claimed}"`).not.toContain(claimed);
    }
  });

  it('says explicitly that this is not evidence about the daemon', () => {
    // The load-bearing sentence. Without it a reader supplies the missing cause themselves, which is
    // the same wrong conclusion arrived at one step later.
    expect(message().toLowerCase()).toContain('cannot tell');
  });

  it('points at the command that CAN answer the question', () => {
    // The page cannot see the daemon; the shell can. A message that only refuses to diagnose leaves
    // the reader exactly where they were.
    expect(message()).toContain('status');
  });

  it('keeps the three reachability causes it genuinely cannot distinguish', () => {
    const text = message();
    expect(text, 'a daemon on another host').toMatch(/container|devcontainer|WSL/);
    expect(text, 'an https page cannot open a ws:// socket').toContain('https');
    expect(text, 'the explicit-URL escape hatch').toContain('reticle.connect');
  });

  it('says it is still retrying, so the reader does not act as though it stopped', () => {
    expect(message().toLowerCase()).toContain('retrying');
  });
});

/**
 * The daemon that leased this page reads the address back out of this line — it is the only way a
 * port mismatch can be named, because the page cannot see the daemon and the daemon never saw the
 * dial. That makes the sentence a wire format, and a rewording would break the lease hint with no
 * type error and no other failing test.
 */
describe('as a contract the daemon parses', () => {
  it('is readable by the shared parser, so a reword cannot silently break the lease hint', () => {
    expect(unreachableUrlIn(unreachableMessage('ws://localhost:4460/reticle', 3))).toBe(
      'ws://localhost:4460/reticle',
    );
  });
});
