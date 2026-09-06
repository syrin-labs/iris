/**
 * #689: the largest single cluster of field reports is not a defect in any tool — it is that the
 * tools were not loaded in the client, and there was no supported way to reach a verdict.
 *
 * `verify` refuses because the daemon owns the port, which is precisely the state a successful
 * install leaves you in. The refusal's first suggestion was "ask the daemon through the Reticle
 * tools" — the one thing a reader who arrived here by construction cannot do, since not having the
 * tools is what sent them to the CLI.
 *
 * `reticle drive` already ATTACHES to a running daemon rather than binding (see drive-attach.ts). It
 * needs no tools and stops nothing, and the message did not mention it.
 */
import { describe, expect, it } from 'vitest';
import { portBusyMessage } from './cli-verify.js';

const message = portBusyMessage(4400);

describe('the port-busy refusal', () => {
  it('says a busy port is the normal state, not a fault', () => {
    // A reader who arrives here has done nothing wrong and should not go looking for what they broke.
    expect(message).toContain('NORMAL state');
    expect(message.toLowerCase()).toContain('not a fault');
  });

  it('leads with the option that needs no tools and stops nothing', () => {
    const drive = message.indexOf('drive <url>');
    const tools = message.indexOf('reticle_run');
    expect(drive).toBeGreaterThan(-1);
    expect(drive).toBeLessThan(tools);
  });

  it('says out loud that drive attaches rather than taking the port', () => {
    expect(message).toContain('already there');
    expect(message).toContain('stops nothing');
  });

  it('qualifies the tools option instead of assuming the reader has them', () => {
    // The old wording was "If you have the Reticle tools" as the FIRST option, to a reader whose
    // problem is that they do not.
    expect(message).toContain('If your client HAS the Reticle tools');
  });

  it('keeps stopping the daemon on the list, last, with the reason', () => {
    const stop = message.indexOf('stop --port');
    expect(stop).toBeGreaterThan(message.indexOf('drive <url>'));
    expect(message).toContain('MCP link');
    expect(message).toContain('respawns');
  });

  it('still names the port and every escape it named before', () => {
    expect(message).toContain('4400');
    expect(message).toContain('RETICLE_PORT');
    expect(message).toContain('stop --port 4400');
  });

  it('is still never a bare node error', () => {
    expect(message).not.toMatch(/EADDRINUSE|node:net/);
  });
});
