import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDaemonForProject,
  adoptable,
  resolveMcpPort,
  daemonsServingProjectElsewhere,
  splitBrainNote,
} from './daemon-resolve.js';

/**
 * Which daemon does THIS project belong to?
 *
 * The system used to answer that question two incompatible ways. Build plugins asked the registry by
 * projectId; the CLI and the MCP proxy asked a port number — `envPort ?? projectPort ?? 4400` — and
 * then attached to whatever happened to own it. So every project on a machine funnelled into one
 * daemon, whose recorded identity was whichever project won the race to the port, and the registry
 * entry became a lie the moment a second project attached.
 *
 * It worked anyway, by luck: everyone defaulted to the same number, so everyone found each other.
 * The luck runs out the moment a daemon is anywhere but 4400 — and it takes the whole machine's
 * agents with it, because one kill on that port drops all of them at once.
 *
 * These pin the resolver that makes the registry the single answer on both sides.
 */
const live = (): boolean => true;
const dead = (): boolean => false;

describe('resolveDaemonForProject', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function home(entries: readonly Record<string, unknown>[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-reg-'));
    dirs.push(dir);
    for (const e of entries) {
      writeFileSync(join(dir, `daemon-${String(e['port'])}.json`), JSON.stringify(e));
    }
    return dir;
  }

  it('finds this project’s daemon wherever it is listening', () => {
    const dir = home([{ port: 47311, pid: 1, cwd: '/a', startedAt: 1, projectId: 'shop' }]);
    expect(resolveDaemonForProject('shop', dir, live)).toBe(47311);
  });

  /** The whole point: another project's daemon is not ours, however convenient its port. */
  it('refuses a daemon that belongs to a different project', () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/b', startedAt: 1, projectId: 'blog' }]);
    expect(resolveDaemonForProject('shop', dir, live)).toBeUndefined();
  });

  it('ignores a daemon whose process is gone', () => {
    const dir = home([{ port: 47311, pid: 1, cwd: '/a', startedAt: 1, projectId: 'shop' }]);
    expect(resolveDaemonForProject('shop', dir, dead)).toBeUndefined();
  });

  it('is deterministic when one project somehow has two daemons', () => {
    const dir = home([
      { port: 47399, pid: 1, cwd: '/a', startedAt: 1, projectId: 'shop' },
      { port: 47311, pid: 2, cwd: '/a', startedAt: 2, projectId: 'shop' },
    ]);
    expect(resolveDaemonForProject('shop', dir, live)).toBe(47311);
  });

  it('survives a corrupt entry rather than failing the whole lookup', () => {
    const dir = home([{ port: 47311, pid: 1, cwd: '/a', startedAt: 1, projectId: 'shop' }]);
    writeFileSync(join(dir, 'daemon-9999.json'), '{ not json');
    expect(resolveDaemonForProject('shop', dir, live)).toBe(47311);
  });

  it('says nothing when the project has no id to match on', () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/a', startedAt: 1, projectId: 'shop' }]);
    expect(resolveDaemonForProject(undefined, dir, live)).toBeUndefined();
  });

  it('says nothing when the registry directory does not exist', () => {
    expect(
      resolveDaemonForProject('shop', join(tmpdir(), 'reticle-nope-xyz'), live),
    ).toBeUndefined();
  });
});

/**
 * Adoption is the other half. Resolution finds OUR daemon; adoption decides whether a daemon already
 * sitting on the port we were about to use may be taken over.
 */
describe('adoptable', () => {
  /** A daemon started in a directory with no `.reticle.json` belongs to nobody, so it belongs to
   *  whoever asks. Refusing here would break every user who runs Reticle globally. */
  it('allows adopting a daemon that claims no project', () => {
    expect(adoptable(undefined, 'shop')).toBe(true);
  });

  it('allows adopting our own project’s daemon', () => {
    expect(adoptable('shop', 'shop')).toBe(true);
  });

  it('refuses another project’s daemon, which is the cross-project bleed', () => {
    expect(adoptable('blog', 'shop')).toBe(false);
  });

  /** An un-init'd caller has no identity to defend, so it keeps the old permissive behaviour. */
  it('allows a caller with no project of its own to adopt anything', () => {
    expect(adoptable('blog', undefined)).toBe(true);
  });
});

/**
 * The decision an agent's MCP proxy makes on startup, which is where the machine-wide daemon came
 * from: a second project probed the default port, found a healthy daemon, and attached to it.
 */
describe('resolveMcpPort', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function home(entries: readonly Record<string, unknown>[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-mcp-'));
    dirs.push(dir);
    for (const e of entries) {
      writeFileSync(join(dir, `daemon-${String(e['port'])}.json`), JSON.stringify(e));
    }
    return dir;
  }
  const present = (): Promise<boolean> => Promise.resolve(true);
  const absent = (): Promise<boolean> => Promise.resolve(false);
  const assigned = (): Promise<number> => Promise.resolve(51234);

  it('uses our own daemon wherever it moved to, ignoring the preferred port', async () => {
    const dir = home([{ port: 47311, pid: 1, cwd: '/a', startedAt: 1, projectId: 'shop' }]);
    await expect(
      resolveMcpPort(4400, 'shop', dir, {
        alive: live,
        daemonPresent: present,
        pickPort: assigned,
      }),
    ).resolves.toBe(47311);
  });

  it('takes the preferred port when nothing is on it', async () => {
    const dir = home([]);
    await expect(
      resolveMcpPort(4400, 'shop', dir, { alive: live, daemonPresent: absent, pickPort: assigned }),
    ).resolves.toBe(4400);
  });

  /** THE defect: project B probing 4400, finding project A's daemon, and quietly joining it. */
  it('relocates rather than adopting another project’s daemon', async () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/a', startedAt: 1, projectId: 'blog' }]);
    await expect(
      resolveMcpPort(4400, 'shop', dir, {
        alive: live,
        daemonPresent: present,
        pickPort: assigned,
      }),
    ).resolves.toBe(51234);
  });

  /** A daemon nobody claims stays shareable, or every global install breaks. */
  it('adopts an unclaimed daemon on the preferred port', async () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/a', startedAt: 1 }]);
    await expect(
      resolveMcpPort(4400, 'shop', dir, {
        alive: live,
        daemonPresent: present,
        pickPort: assigned,
      }),
    ).resolves.toBe(4400);
  });

  it('lets an un-init’d caller keep using whatever is there', async () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/a', startedAt: 1, projectId: 'blog' }]);
    await expect(
      resolveMcpPort(4400, undefined, dir, {
        alive: live,
        daemonPresent: present,
        pickPort: assigned,
      }),
    ).resolves.toBe(4400);
  });

  it('does not reuse a daemon of ours whose process has died', async () => {
    const dir = home([{ port: 47311, pid: 1, cwd: '/a', startedAt: 1, projectId: 'shop' }]);
    await expect(
      resolveMcpPort(4400, 'shop', dir, { alive: dead, daemonPresent: absent, pickPort: assigned }),
    ).resolves.toBe(4400);
  });
});

/**
 * The other half of the split brain: not "which daemon do I take", but "did the app take a
 * different one". `resolveMcpPort` relocating is correct and invisible; the app resolving its own
 * port independently and landing on the daemon the proxy just refused is the failure nobody reports,
 * because from either side alone everything looks healthy.
 */
describe('daemonsServingProjectElsewhere', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function home(entries: readonly Record<string, unknown>[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-split-'));
    dirs.push(dir);
    for (const e of entries) {
      writeFileSync(join(dir, `daemon-${String(e['port'])}.json`), JSON.stringify(e));
    }
    return dir;
  }

  const connectedOn =
    (...ports: number[]) =>
    (port: number): boolean =>
      ports.includes(port);

  it('names the live daemon this project’s app actually connected to', () => {
    const dir = home([
      { port: 4400, pid: 1, cwd: '/other', startedAt: 1, projectId: 'blog' },
      { port: 51234, pid: 2, cwd: '/shop', startedAt: 2, projectId: 'shop' },
    ]);
    expect(daemonsServingProjectElsewhere('shop', 51234, dir, live, connectedOn(4400))).toEqual([
      4400,
    ]);
  });

  it('says nothing when the app connected to the daemon we are asking from', () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/shop', startedAt: 1, projectId: 'shop' }]);
    expect(daemonsServingProjectElsewhere('shop', 4400, dir, live, connectedOn(4400))).toEqual([]);
  });

  it('ignores a daemon whose process is gone — history is not a split', () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/other', startedAt: 1, projectId: 'blog' }]);
    expect(daemonsServingProjectElsewhere('shop', 51234, dir, dead, connectedOn(4400))).toEqual([]);
  });

  it('ignores a live daemon this project never connected to', () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/other', startedAt: 1, projectId: 'blog' }]);
    expect(daemonsServingProjectElsewhere('shop', 51234, dir, live, connectedOn())).toEqual([]);
  });

  /** No identity, no claim: a caller with no projectId cannot tell its own sessions from anyone's. */
  it('says nothing for a caller with no project', () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/other', startedAt: 1, projectId: 'blog' }]);
    expect(daemonsServingProjectElsewhere(undefined, 51234, dir, live, connectedOn(4400))).toEqual(
      [],
    );
  });
});

describe('splitBrainNote', () => {
  it('is silent when there is no split', () => {
    expect(splitBrainNote(4400, [])).toBeUndefined();
  });

  it('names both ports, says the attached one is the empty half, and gives a command', () => {
    const note = splitBrainNote(51234, [4400]);
    expect(note).toContain(':4400');
    expect(note).toContain(':51234');
    expect(note).toContain('reticle stop --port 4400');
  });

  /** The advice that would be wrong: this is not an install problem and must not read as one. */
  it('does not send the reader back to init', () => {
    expect(splitBrainNote(51234, [4400])).not.toContain('init');
  });
});
