import { describe, expect, it } from 'vitest';
import { migrateApprovals, APPROVAL_STAMP_FILE, type MigrationDeps } from './approval-migration.js';
import type { AgentWriterIo } from './agent-writer.js';

const STATE = '/home/u/.reticle';
const STAMP = `${STATE}/${APPROVAL_STAMP_FILE}`;

function fakeIo(files: Record<string, string>): AgentWriterIo & { files: Record<string, string> } {
  const store = { ...files };
  return {
    files: store,
    exists: (p) => p in store || Object.keys(store).some((f) => f.startsWith(`${p}/`)),
    readFile: (p) => {
      if (!(p in store)) throw new Error(`ENOENT ${p}`);
      return store[p] ?? '';
    },
    writeFile: (p, c) => {
      store[p] = c;
    },
    mkdirp: () => undefined,
  };
}

const deps = (io: AgentWriterIo, over: Partial<MigrationDeps> = {}): MigrationDeps => ({
  io,
  home: '/home/u',
  platform: 'linux',
  stateHome: STATE,
  version: '2.13.0',
  log: () => undefined,
  ...over,
});

describe('carrying pre-approval onto an existing install', () => {
  it('grants on the first launch of a new version', () => {
    const io = fakeIo({ '/home/u/.claude': '' });
    expect(migrateApprovals(deps(io)).granted).toEqual(['Claude Code']);
  });

  it('does not run again on the next launch of the same version', () => {
    const io = fakeIo({ '/home/u/.claude': '' });
    migrateApprovals(deps(io));
    expect(migrateApprovals(deps(io)).ran).toBe(false);
  });

  it('runs again after an upgrade, because a new version may add a client', () => {
    const io = fakeIo({ '/home/u/.claude': '' });
    migrateApprovals(deps(io));
    expect(migrateApprovals(deps(io, { version: '2.14.0' })).ran).toBe(true);
  });

  it('stamps even when the machine has no agents, so it stops scanning', () => {
    const io = fakeIo({});
    expect(migrateApprovals(deps(io)).ran).toBe(true);
    expect(io.files[STAMP]).toContain('2.13.0');
  });

  it('defers creating Cursor’s file, which would supersede what it cannot read', () => {
    const io = fakeIo({ '/home/u/.cursor': '' });
    const result = migrateApprovals(deps(io));
    expect(result.deferred).toEqual(['Cursor']);
    expect(result.granted).toEqual([]);
    expect(io.files['/home/u/.cursor/permissions.json']).toBeUndefined();
  });

  it('does merge into a Cursor file the user already owns', () => {
    const io = fakeIo({
      '/home/u/.cursor': '',
      '/home/u/.cursor/permissions.json': JSON.stringify({ mcpAllowlist: ['github:*'] }),
    });
    expect(migrateApprovals(deps(io)).granted).toEqual(['Cursor']);
    expect(io.files['/home/u/.cursor/permissions.json']).toContain('reticle:*');
  });

  it('reports what it did, for a process with no stdout to speak on', () => {
    const io = fakeIo({ '/home/u/.claude': '', '/home/u/.cursor': '' });
    const events: Array<Record<string, unknown>> = [];
    migrateApprovals(deps(io, { log: (_e, d) => events.push(d) }));
    expect(events[0]).toMatchObject({ granted: ['Claude Code'], deferred: ['Cursor'] });
  });

  it('treats an unreadable stamp as not-yet-run rather than never-again', () => {
    const io = fakeIo({ '/home/u/.claude': '', [STAMP]: '{ not json' });
    expect(migrateApprovals(deps(io)).ran).toBe(true);
  });

  it('survives a filesystem that refuses every write', () => {
    const io = fakeIo({ '/home/u/.claude': '' });
    const hostile: AgentWriterIo = {
      ...io,
      writeFile: () => {
        throw new Error('EROFS');
      },
    };
    expect(() => migrateApprovals(deps(hostile))).not.toThrow();
  });
});
