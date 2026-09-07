/**
 * "Registered" and "usable" are two different states, and `status` could only report one of them.
 *
 * Some MCP hosts register the Reticle server, start it, and never send `tools/list` until the client
 * is restarted. From our side that user is indistinguishable from somebody who installed Reticle and
 * lost interest; from theirs, Reticle is a tool that does nothing and says nothing about why.
 *
 * Two durable bits tell those apart, and both are records of something that HAPPENED rather than an
 * inference: a client started the MCP server on this port, and a client asked it for the tool list.
 * These tests pin the three states those bits produce, and pin that the healthy one stays silent —
 * advice printed beside a working install reads as though something is wrong.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AttachState,
  attachState,
  attachStatusFields,
  describeAttachState,
  rememberEnumerated,
  rememberProxyStarted,
  rememberToolCalled,
} from './attach-memory.js';

describe('attach memory', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reticle-attach-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports never attached when no client has started the MCP server on this port', () => {
    expect(attachState(dir, 4400)).toBe(AttachState.NEVER_ATTACHED);
  });

  it('reports never enumerated when a client started the server and never asked for the tools', () => {
    rememberProxyStarted(dir, 4400);
    expect(attachState(dir, 4400)).toBe(AttachState.NEVER_ENUMERATED);
  });

  // Listing the tools is no longer the END of the chain: a client that lists and never calls is the
  // state the field reports as hardest to diagnose, so it has a name of its own now. Reaching
  // `enumerated` takes an actual call.
  it('reports enumerated once a tool list was asked for AND a tool was called', () => {
    rememberProxyStarted(dir, 4400);
    rememberEnumerated(dir, 4400);
    rememberToolCalled(dir, 4400);
    expect(attachState(dir, 4400)).toBe(AttachState.ENUMERATED);
  });

  it('keys the record on the port, so another port is not evidence about this one', () => {
    rememberProxyStarted(dir, 4400);
    rememberEnumerated(dir, 4400);
    expect(attachState(dir, 4500)).toBe(AttachState.NEVER_ATTACHED);
  });

  it('survives a restart of the process that recorded it', () => {
    rememberEnumerated(dir, 4400);
    rememberToolCalled(dir, 4400);
    // Same state home, a fresh read: the bits are on disk, not in this process.
    expect(attachState(dir, 4400)).toBe(AttachState.ENUMERATED);
  });

  it('says nothing at all in the healthy state', () => {
    expect(describeAttachState(AttachState.ENUMERATED)).toBeUndefined();
  });

  it('tells a client that never enumerated to restart, and names the cause', () => {
    const message = describeAttachState(AttachState.NEVER_ENUMERATED) ?? '';
    expect(message).toContain('tool list');
    expect(message).toContain('restart');
  });

  it('admits it cannot see WHICH client, rather than blaming the one in front of the reader', () => {
    // The record is per port. With two clients registered, one healthy client hides a broken one,
    // and a confident "your client never enumerated" would be a guess wearing a diagnosis.
    expect(describeAttachState(AttachState.NEVER_ENUMERATED) ?? '').toContain('per port');
  });

  it('admits the never-attached state can also be a gap in its own record', () => {
    // The record starts empty on the version that introduced it, so a long-working install reads as
    // never attached until its client next starts the server. Saying so beats a confident wrong no.
    const message = describeAttachState(AttachState.NEVER_ATTACHED) ?? '';
    expect(message).toContain('init');
    expect(message).toContain('record');
  });

  it('gives `status` a state on every run, and advice only when there is any', () => {
    // What `reticle status` spreads into its output. The healthy run carries the state and NOTHING
    // else: the field is the answer to "is the client side wired", and a second sentence beside a
    // working one is the noise this whole diagnosis exists to replace.
    rememberProxyStarted(dir, 4400);
    rememberEnumerated(dir, 4400);
    rememberToolCalled(dir, 4400);
    expect(attachStatusFields(dir, 4400)).toEqual({ mcpClient: AttachState.ENUMERATED });
  });

  it('carries the restart advice for the state that has an answer', () => {
    rememberProxyStarted(dir, 4400);
    const fields = attachStatusFields(dir, 4400);
    expect(fields.mcpClient).toBe(AttachState.NEVER_ENUMERATED);
    expect(fields.mcpClientAction).toBe(describeAttachState(AttachState.NEVER_ENUMERATED));
  });

  it('carries the registration advice when nothing has ever attached', () => {
    const fields = attachStatusFields(dir, 4400);
    expect(fields.mcpClient).toBe(AttachState.NEVER_ATTACHED);
    expect(fields.mcpClientAction).toBe(describeAttachState(AttachState.NEVER_ATTACHED));
  });

  it('degrades to never attached rather than throwing on an unreadable state home', () => {
    // A diagnostic that can crash the tool it is diagnosing is worse than no diagnostic.
    expect(attachState(join(dir, 'nope'), 4400)).toBe(AttachState.NEVER_ATTACHED);
    expect(() => {
      rememberProxyStarted('/dev/null/nope', 4400);
    }).not.toThrow();
  });
});

/**
 * The state past `enumerated`, and the one the field actually reports.
 *
 * A careful evaluator had the browser side provably working — SDK injected, overlay visible, a live
 * session on the daemon — registered the MCP server in three separate agents, watched one of them
 * list every tool, and then had the agent tell them Reticle was not present on the machine. Both
 * ends healthy, nothing crossing between them.
 *
 * `enumerated` cannot describe that. It means a client read the catalogue, which is exactly what
 * that user's agent did, so the most-broken install we know of reports the same state as a perfect
 * one. What distinguishes them is whether a tool was ever CALLED, and nothing recorded it.
 */
describe('a client that listed the tools and never called one', () => {
  it('is a state of its own, not "enumerated"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-attach-called-'));
    rememberProxyStarted(dir, 4400);
    rememberEnumerated(dir, 4400);
    expect(attachState(dir, 4400)).toBe(AttachState.NEVER_CALLED);
  });

  it('becomes enumerated-and-used once a tool is actually called', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-attach-called-'));
    rememberProxyStarted(dir, 4400);
    rememberEnumerated(dir, 4400);
    rememberToolCalled(dir, 4400);
    expect(attachState(dir, 4400)).toBe(AttachState.ENUMERATED);
  });

  // The action has to be worth reading: this user spent hours on it and had no way to tell which
  // link was broken, so the message must name the link rather than the component.
  it('names the link that is broken, not a component', () => {
    const action = describeAttachState(AttachState.NEVER_CALLED) ?? '';
    expect(action.length).toBeGreaterThan(0);
    expect(action).toMatch(/tool/i);
  });

  // The earlier states must not regress: a client that never listed is still the restart case.
  it('leaves the never-enumerated state alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-attach-called-'));
    rememberProxyStarted(dir, 4400);
    expect(attachState(dir, 4400)).toBe(AttachState.NEVER_ENUMERATED);
  });
});
