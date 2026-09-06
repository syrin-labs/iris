/**
 * A capsule is filed against the codebase that produced the failure.
 *
 * Found by driving Persona 5 with the impact fix already in: the ledgers separated correctly and
 * the capsule did not. A failing assertion on an app in repo B wrote its capsule into repo A —
 * the daemon's own root — where it names B's source file (`ui/global-nav.tsx:62`) inside a
 * checkout that has no such file.
 *
 * That is worse than a miscount, because a capsule outlives the turn: it becomes a regression flow
 * the moment it goes green, so the wrong repo inherits a test for somebody else's bug.
 */
import { describe, expect, it, vi } from 'vitest';
import { join, sep } from 'node:path';
import { saveFailedAssertCapsule } from './act-capsule.js';
import type { ToolDeps } from './tool-kit.js';

// Host-native, because the assertions below are `startsWith` over paths the callee builds with
// `path.join`. A literal '/daemon/.reticle' makes every one of them fail on Windows for a reason
// that has nothing to do with which root won — which is the only thing this file is about.
const DAEMON_ROOT = join(sep, 'daemon', '.reticle');
const HER_ROOT = join(sep, 'her-app', '.reticle');

/**
 * Deps whose session resolves to HER project, with an fs that records where writes landed.
 *
 * `artifactRootFor` is the same seam nine other modules use; `sessionRoot` consults it via the
 * session's projectId, so wiring it here is what the real daemon does.
 */
function depsWritingTo(): { deps: ToolDeps; written: string[] } {
  const written: string[] = [];
  const fs = {
    mkdir: () => Promise.resolve(),
    writeFile: (path: string) => {
      written.push(path);
      return Promise.resolve();
    },
    readFile: () => Promise.reject(new Error('missing')),
    exists: () => Promise.resolve(false),
    readdir: () => Promise.resolve([]),
    rm: () => Promise.resolve(),
  };
  const deps = {
    fs,
    reticleRoot: DAEMON_ROOT,
    now: () => 1_000,
    sessions: { resolve: () => ({ projectId: 'her-app' }) },
    artifactRootFor: (projectId: string | undefined) =>
      'her-app' === projectId
        ? { root: HER_ROOT, reason: 'matched-project' }
        : { root: DAEMON_ROOT, reason: 'no-match' },
  } as unknown as ToolDeps;
  return { deps, written };
}

const failing = {
  verdict: { pass: false, failureReason: 'expected no error entries but found 1' },
  capsule: { summary: {}, firstDivergence: null, blastRadius: [] } as never,
  links: [],
  args: { sessionId: 'her-session', ref: 'e44', action: 'click' },
  actResult: { result: { testid: 'nav' } },
};

describe('where a failed-assert capsule is filed', () => {
  it('uses the root the CALLER resolved — the session the act actually drove', async () => {
    // The case the first version of this fix got wrong, caught by driving rather than by a test:
    // re-resolving from `args.sessionId` fails when the arg is absent AND more than one tab is
    // connected, because `sessions.resolve(undefined)` throws when it cannot choose. That is the
    // multi-project case, i.e. exactly the situation the routing exists for. The caller holds the
    // session it drove (including one followed through a navigation), so it passes the answer.
    const written: string[] = [];
    const deps = {
      fs: {
        mkdir: () => Promise.resolve(),
        writeFile: (path: string) => {
          written.push(path);
          return Promise.resolve();
        },
        readFile: () => Promise.reject(new Error('missing')),
        exists: () => Promise.resolve(false),
        readdir: () => Promise.resolve([]),
        rm: () => Promise.resolve(),
      },
      reticleRoot: DAEMON_ROOT,
      now: () => 1_000,
      // Ambiguous on purpose: two tabs connected, no id given.
      sessions: {
        resolve: () => {
          throw new Error('several sessions connected and none was named');
        },
      },
    } as unknown as ToolDeps;

    await saveFailedAssertCapsule({ deps, ...failing, args: {}, root: HER_ROOT });

    expect(written.every((p) => p.startsWith(HER_ROOT))).toBe(true);
    expect(written.some((p) => p.startsWith(DAEMON_ROOT))).toBe(false);
  });

  it("writes into the failing app's OWN .reticle, not the daemon's", async () => {
    const { deps, written } = depsWritingTo();

    await saveFailedAssertCapsule({ deps, ...failing });

    expect(written.length).toBeGreaterThan(0);
    // Assert the inverse too: before the fix every path here began with the daemon root, and a
    // test that only checked "something was written" would have passed throughout.
    expect(written.every((p) => p.startsWith(HER_ROOT))).toBe(true);
    expect(written.some((p) => p.startsWith(DAEMON_ROOT))).toBe(false);
  });

  it('falls back to the daemon root when no project can be named', async () => {
    const written: string[] = [];
    const deps = {
      fs: {
        mkdir: () => Promise.resolve(),
        writeFile: (path: string) => {
          written.push(path);
          return Promise.resolve();
        },
        readFile: () => Promise.reject(new Error('missing')),
        exists: () => Promise.resolve(false),
        readdir: () => Promise.resolve([]),
        rm: () => Promise.resolve(),
      },
      reticleRoot: DAEMON_ROOT,
      now: () => 1_000,
      // `sessions.resolve` throws when nothing is connected, when the id names no session, and when
      // several are connected and none was named. All three mean the same thing: we cannot tell.
      sessions: {
        resolve: () => {
          throw new Error('no session');
        },
      },
    } as unknown as ToolDeps;

    await saveFailedAssertCapsule({ deps, ...failing });

    expect(written.every((p) => p.startsWith(DAEMON_ROOT))).toBe(true);
  });

  it('writes nothing for a passing verdict', async () => {
    const { deps, written } = depsWritingTo();

    const id = await saveFailedAssertCapsule({ ...failing, deps, verdict: { pass: true } });

    expect(id).toBeUndefined();
    expect(written).toEqual([]);
  });

  it('never lets a failed write break the run that found the bug', async () => {
    // Capturing evidence is best-effort by design: the assertion already failed, and losing the
    // capsule must not also lose the verdict.
    const deps = {
      fs: {
        mkdir: () => Promise.reject(new Error('disk full')),
        writeFile: vi.fn(),
        readFile: () => Promise.reject(new Error('missing')),
        exists: () => Promise.resolve(false),
        readdir: () => Promise.resolve([]),
        rm: () => Promise.resolve(),
      },
      reticleRoot: DAEMON_ROOT,
      now: () => 1_000,
      sessions: { resolve: () => ({ projectId: 'her-app' }) },
      artifactRootFor: () => ({ root: HER_ROOT, reason: 'matched-project' }),
    } as unknown as ToolDeps;

    await expect(saveFailedAssertCapsule({ deps, ...failing })).resolves.not.toThrow();
  });
});
