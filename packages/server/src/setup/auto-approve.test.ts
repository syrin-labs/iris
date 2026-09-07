import { describe, expect, it } from 'vitest';
import {
  APPROVAL_GRANTS,
  ApprovalOutcome,
  grantAutoApproval,
  type ApprovalGrant,
} from './auto-approve.js';
import type { AgentWriterIo } from './agent-writer.js';

const WHERE = { home: '/home/u', platform: 'linux' } as const;

function fakeIo(files: Record<string, string>): AgentWriterIo & { files: Record<string, string> } {
  const store = { ...files };
  return {
    files: store,
    exists: (p) => p in store || Object.keys(store).some((f) => f.startsWith(`${p}/`)),
    readFile: (p) => store[p] ?? '',
    writeFile: (p, c) => {
      store[p] = c;
    },
    mkdirp: () => undefined,
  };
}

const grantById = (id: string): ApprovalGrant => {
  const found = APPROVAL_GRANTS.find((g) => id === g.id);
  if (undefined === found) throw new Error(`no grant ${id}`);
  return found;
};

const written = (io: { files: Record<string, string> }, file: string): Record<string, unknown> =>
  JSON.parse(io.files[file] ?? '{}') as Record<string, unknown>;

describe('pre-approving Reticle', () => {
  it('writes nothing for an agent that is not installed', () => {
    const io = fakeIo({});
    for (const r of grantAutoApproval(io, WHERE)) expect(r.outcome).toBe(ApprovalOutcome.ABSENT);
    expect(Object.keys(io.files)).toEqual([]);
  });

  it('allows Claude Code’s tools by server name, and only ours', () => {
    const io = fakeIo({ '/home/u/.claude': '' });
    grantAutoApproval(io, WHERE, [grantById('claude-code')]);
    expect(written(io, '/home/u/.claude/settings.json')).toEqual({
      permissions: { allow: ['mcp__reticle'] },
    });
  });

  it('keeps every rule the user already had', () => {
    const io = fakeIo({
      '/home/u/.claude': '',
      '/home/u/.claude/settings.json': JSON.stringify({
        model: 'opus',
        permissions: { allow: ['WebSearch'], deny: ['Bash(rm *)'] },
      }),
    });
    grantAutoApproval(io, WHERE, [grantById('claude-code')]);
    expect(written(io, '/home/u/.claude/settings.json')).toEqual({
      model: 'opus',
      permissions: { allow: ['WebSearch', 'mcp__reticle'], deny: ['Bash(rm *)'] },
    });
  });

  it('is idempotent, so a re-run does not stack duplicates', () => {
    const io = fakeIo({ '/home/u/.claude': '' });
    grantAutoApproval(io, WHERE, [grantById('claude-code')]);
    const second = grantAutoApproval(io, WHERE, [grantById('claude-code')]);
    expect(second[0]?.outcome).toBe(ApprovalOutcome.ALREADY);
  });

  it('uses Cursor’s own allowlist spelling', () => {
    const io = fakeIo({ '/home/u/.cursor': '' });
    grantAutoApproval(io, WHERE, [grantById('cursor')]);
    expect(written(io, '/home/u/.cursor/permissions.json')).toEqual({
      mcpAllowlist: ['reticle:*'],
    });
  });

  it('warns that a new Cursor permissions file supersedes what was approved in the app', () => {
    const io = fakeIo({ '/home/u/.cursor': '' });
    expect(grantAutoApproval(io, WHERE, [grantById('cursor')])[0]?.warn).toContain('ask again');
  });

  it('does not repeat that warning once the file is the user’s own', () => {
    const io = fakeIo({
      '/home/u/.cursor': '',
      '/home/u/.cursor/permissions.json': JSON.stringify({ mcpAllowlist: ['github:*'] }),
    });
    const result = grantAutoApproval(io, WHERE, [grantById('cursor')])[0];
    expect(result?.warn).toBeUndefined();
    expect(written(io, '/home/u/.cursor/permissions.json')['mcpAllowlist']).toEqual([
      'github:*',
      'reticle:*',
    ]);
  });

  it('uses Antigravity’s permission-pattern spelling', () => {
    const io = fakeIo({ '/home/u/.config/Antigravity': '' });
    grantAutoApproval(io, WHERE, [grantById('antigravity')]);
    expect(written(io, '/home/u/.gemini/antigravity-cli/settings.json')).toEqual({
      permissions: { allow: ['mcp(reticle/*)'] },
    });
  });

  it('trusts the Gemini entry in place, since Gemini has no allowlist', () => {
    const io = fakeIo({
      '/home/u/.gemini': '',
      '/home/u/.gemini/settings.json': JSON.stringify({
        mcpServers: { reticle: { command: 'npx' }, other: { command: 'x' } },
      }),
    });
    grantAutoApproval(io, WHERE, [grantById('gemini-cli')]);
    expect(written(io, '/home/u/.gemini/settings.json')).toEqual({
      mcpServers: { reticle: { command: 'npx', trust: true }, other: { command: 'x' } },
    });
  });

  it('never grants a blanket pass to every MCP server', () => {
    const io = fakeIo({
      '/home/u/.claude': '',
      '/home/u/.cursor': '',
      '/home/u/.gemini': '',
      '/home/u/.config/Antigravity': '',
    });
    grantAutoApproval(io, WHERE);
    const all = Object.values(io.files).join('\n');
    expect(all).not.toContain('mcp(*)');
    expect(all).not.toContain('"*"');
    expect(all).not.toContain('autoRun');
  });

  it('reports an unwritable config instead of failing the other agents', () => {
    const io = fakeIo({ '/home/u/.claude': '', '/home/u/.cursor': '' });
    const broken: AgentWriterIo = {
      ...io,
      writeFile: (p, c) => {
        if (p.includes('.cursor')) throw new Error('EACCES');
        io.writeFile(p, c);
      },
    };
    const results = grantAutoApproval(broken, WHERE, [
      grantById('cursor'),
      grantById('claude-code'),
    ]);
    expect(results[0]?.outcome).toBe(ApprovalOutcome.FAILED);
    expect(results[1]?.outcome).toBe(ApprovalOutcome.GRANTED);
  });

  it('leaves a settings file it cannot parse exactly as it is', () => {
    const io = fakeIo({ '/home/u/.claude': '', '/home/u/.claude/settings.json': '{ not json' });
    expect(grantAutoApproval(io, WHERE, [grantById('claude-code')])[0]?.outcome).toBe(
      ApprovalOutcome.FAILED,
    );
    expect(io.files['/home/u/.claude/settings.json']).toBe('{ not json');
  });
});
