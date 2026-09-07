import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  alreadyWired,
  binaryExists,
  flowsSaved,
  OwnedDevServer,
  probePage,
} from './node-effects.js';

const isWindows = 'win32' === process.platform;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('the dev server this process owns', () => {
  // The promise: stopped on every ending except success. An interrupted run used to leave one
  // listening indefinitely, holding a port nobody could account for.
  it.skipIf(isWindows)(
    'stops what it started, including what that started',
    async () => {
      const port = 59_231;
      const server = new OwnedDevServer();
      // A shell that spawns node: the port belongs to the GRANDCHILD, which is the shape that makes
      // killing only the process we hold insufficient.
      server.start(
        `node -e "require('http').createServer((q,r)=>r.end('hi')).listen(${port},'127.0.0.1')"`,
        process.cwd(),
        {},
      );
      await sleep(1_200);
      const held = (): string =>
        spawnSync('sh', ['-c', `lsof -ti:${port} -sTCP:LISTEN || true`], {
          encoding: 'utf8',
        }).stdout.trim();
      expect(held(), 'the fixture server never came up').not.toBe('');
      server.stop();
      await sleep(700);
      expect(held(), 'stopping left the port held by an orphan').toBe('');
    },
    15_000,
  );

  it.skipIf(isWindows)(
    'leaves it running once handed over, because that is the deliverable',
    async () => {
      const port = 59_232;
      const server = new OwnedDevServer();
      server.start(
        `node -e "require('http').createServer((q,r)=>r.end('hi')).listen(${port},'127.0.0.1')"`,
        process.cwd(),
        {},
      );
      await sleep(1_200);
      server.handOver();
      server.stop();
      await sleep(400);
      const held = spawnSync('sh', ['-c', `lsof -ti:${port} -sTCP:LISTEN || true`], {
        encoding: 'utf8',
      }).stdout.trim();
      expect(held, 'a handed-over server must survive').not.toBe('');
      for (const pid of held.split('\n')) process.kill(Number(pid), 'SIGKILL');
    },
    15_000,
  );

  it('reports what the server printed, and how long it has been quiet', async () => {
    const server = new OwnedDevServer();
    server.start('echo "  Local: http://localhost:1234"', process.cwd(), {});
    await sleep(600);
    expect(server.output()).toContain('http://localhost:1234');
    expect(server.quietForMs()).toBeGreaterThanOrEqual(0);
    server.stop();
  }, 10_000);

  it('has nothing to stop when nothing was started', () => {
    expect(() => new OwnedDevServer().stop()).not.toThrow();
  });
});

describe('probing the page', () => {
  it('reports nothing answering as not served', async () => {
    expect(await probePage('http://127.0.0.1:59233/')).toMatchObject({ served: false });
  });
});

describe('reading the project', () => {
  it('finds a saved flow in any of the roots it is given', () => {
    const root = mkdtempSync(join(tmpdir(), 'flows-'));
    mkdirSync(join(root, 'apps', 'web', '.reticle', 'flows'), { recursive: true });
    writeFileSync(join(root, 'apps', 'web', '.reticle', 'flows', 'a.json'), '{}');
    // In a monorepo `.reticle/` sits at the APP root; looking only where setup was invoked reported
    // "no verdict" for a run whose drive had saved a flow and said so.
    expect(flowsSaved([root])).toBe(false);
    expect(flowsSaved([root, join(root, 'apps', 'web')])).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('knows an unwired project from a wired one', () => {
    const root = mkdtempSync(join(tmpdir(), 'wired-'));
    expect(alreadyWired(root)).toBe(false);
    writeFileSync(join(root, '.reticle.json'), '{}');
    expect(alreadyWired(root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('tells a binary that exists from one that does not', () => {
    expect(binaryExists('node')).toBe(true);
    expect(binaryExists('definitely-not-a-real-binary-xyz')).toBe(false);
  });
});

describe('handing the dev server over', () => {
  // The bug this pins produced no error and no failing assertion: `init` printed "setup complete"
  // and then sat there, because the child's stdout pipe still belonged to this process and an open
  // pipe holds the event loop by itself. The only visible symptom was a non-zero exit on a run that
  // had succeeded, which is why it survived every gate except the one that reads exit codes.
  it('lets the process exit, rather than holding it open on the child’s pipes', () => {
    const script = `
      import { OwnedDevServer } from '${pathToFileURL(join(process.cwd(), 'dist/setup/node-effects.js')).href}';
      const server = new OwnedDevServer();
      // A stand-in dev server: long-lived and chatty, so its pipes are genuinely active.
      server.start('node -e "setInterval(() => console.log(1), 50)"', process.cwd(), {});
      setTimeout(() => {
        console.log(JSON.stringify({ pid: server.pid() }));
        server.handOver();
      }, 300);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    // A timeout kill is exactly the failure: the process never ran out of work to do.
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    const reported: unknown = JSON.parse(child.stdout.trim().split('\n')[0] ?? '{}');
    const pid =
      'object' === typeof reported && null !== reported && 'pid' in reported
        ? Number((reported as { pid?: unknown }).pid ?? 0)
        : 0;
    if (0 < pid) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        /* the handed-over server is the point; cleaning it up is best effort */
      }
    }
  });
});
