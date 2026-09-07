/**
 * A run must say WHICH agent produced it, and must never invent one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearMcpClientIdentityHook,
  mcpClientIdentity,
  setMcpClientIdentityHook,
} from './client-identity.js';

afterEach(() => clearMcpClientIdentityHook());

describe('mcpClientIdentity', () => {
  it('reports the client the handshake actually named', () => {
    setMcpClientIdentityHook(() => ({ name: 'claude-code', version: '1.4.2' }));
    expect(mcpClientIdentity()).toStrictEqual({ name: 'claude-code', version: '1.4.2' });
  });

  it('distinguishes one agent from another — the whole point of recording it', () => {
    setMcpClientIdentityHook(() => ({ name: 'cursor-vscode' }));
    expect(mcpClientIdentity().name).toBe('cursor-vscode');
  });

  it('reports NOTHING when no peer introduced itself, rather than guessing a vendor', () => {
    expect(mcpClientIdentity()).toStrictEqual({});
    setMcpClientIdentityHook(() => undefined);
    expect(mcpClientIdentity()).toStrictEqual({});
    setMcpClientIdentityHook(() => ({ name: '' }));
    expect(mcpClientIdentity()).toStrictEqual({});
  });

  it('bounds what a client can write into an artifact', () => {
    setMcpClientIdentityHook(() => ({ name: 'x'.repeat(500), version: 'v'.repeat(500) }));
    const id = mcpClientIdentity();
    expect(id.name).toHaveLength(64);
    expect(id.version).toHaveLength(32);
  });

  it('a throwing hook never breaks the caller — this is descriptive, not load-bearing', () => {
    setMcpClientIdentityHook(() => {
      throw new Error('transport died mid-handshake');
    });
    expect(mcpClientIdentity()).toStrictEqual({});
  });
});
