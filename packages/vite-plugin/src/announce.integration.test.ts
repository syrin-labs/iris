import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DevServerEntrySchema, ReticleEnv, devServerRegistryPort } from '@reticlehq/core';
import { reticle } from './index.js';

/**
 * The announcement, against a REAL Vite dev server bound to an EPHEMERAL port.
 *
 * `port: 0` is the point of this suite, not an incidental choice. The whole design claim is that
 * nothing about the user's setup is assumed — not the dev command, not the package manager, not the
 * framework, and not the port. A test against a fixed port could pass on a plugin that hardcoded
 * that port; only a port chosen by the kernel at listen time can distinguish "read from the server"
 * from "guessed correctly".
 */

interface DevServerLike {
  listen: () => Promise<unknown>;
  close: () => Promise<void>;
  resolvedUrls?: { local: string[] };
  httpServer?: { address(): string | { port: number } | null } | null;
}
type CreateServer = (inline: Record<string, unknown>) => Promise<DevServerLike>;

let createServer: CreateServer | undefined;

const HOOK_TIMEOUT_MS = 60_000;
/** Same generous budget the sibling integration suite uses, and for the same reason. */
const SERVER_BOOT_BUDGET_MS = 120_000;

beforeAll(async () => {
  const vite = (await import('vite')) as { createServer: CreateServer };
  createServer = vite.createServer;
}, HOOK_TIMEOUT_MS);

const dirs: string[] = [];
const servers: DevServerLike[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env[ReticleEnv.STATE_DIR];
});

function appRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'reticle-announce-app-'));
  dirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src/sdk.js'),
    'export const reticle = { connect(){} };\nexport const install = () => {};\n',
  );
  writeFileSync(
    join(root, 'index.html'),
    '<html><body><script type="module" src="/src/main.js"></script></body></html>',
  );
  writeFileSync(join(root, 'src/main.js'), 'export const app = 1;\n');
  return root;
}

function entriesIn(home: string): { port: number; body: unknown }[] {
  return readdirSync(home)
    .map((file) => ({ file, port: devServerRegistryPort(file) }))
    .filter((e): e is { file: string; port: number } => null !== e.port)
    .map((e) => ({
      port: e.port,
      body: JSON.parse(readFileSync(join(home, e.file), 'utf8')) as unknown,
    }));
}

describe('a running Vite dev server announces itself', () => {
  it(
    'writes an entry naming the port the kernel actually gave it',
    async () => {
      const create = createServer;
      if (create === undefined) throw new Error('vite.createServer did not resolve');
      const home = mkdtempSync(join(tmpdir(), 'reticle-announce-home-'));
      dirs.push(home);
      process.env[ReticleEnv.STATE_DIR] = home;

      const root = appRoot();
      const server = await create({
        root,
        logLevel: 'silent',
        configFile: false,
        // The kernel picks. Nothing in the plugin could have known this number in advance.
        server: { port: 0, host: '127.0.0.1' },
        resolve: { alias: { '@reticlehq/react': join(root, 'src/sdk.js') } },
        plugins: [reticle()],
      });
      servers.push(server);
      await server.listen();

      const bound = server.httpServer?.address();
      const boundPort = 'object' === typeof bound && null !== bound ? bound.port : undefined;
      expect(boundPort).toBeDefined();

      const found = entriesIn(home);
      expect(found).toHaveLength(1);
      expect(found[0]?.port).toBe(boundPort);

      const parsed = DevServerEntrySchema.safeParse(found[0]?.body);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.port).toBe(boundPort);
        expect(parsed.data.pid).toBe(process.pid);
        // Read off the server, not composed: this is the URL Vite itself prints.
        expect(parsed.data.url).toBe(server.resolvedUrls?.local[0]);
        // realpath both sides: Vite normalises its root, and macOS's tmpdir is a symlink into
        // /private. The claim is "the directory this server serves", not a particular spelling of it.
        expect(realpathSync(parsed.data.root)).toBe(realpathSync(root));
      }
    },
    SERVER_BOOT_BUDGET_MS,
  );

  /**
   * A closed dev server that still claims to be running is worse than one that never announced: it
   * reports a wired, live app over a dead port and sends the reader to look at their browser.
   */
  it(
    'withdraws the entry when the server closes',
    async () => {
      const create = createServer;
      if (create === undefined) throw new Error('vite.createServer did not resolve');
      const home = mkdtempSync(join(tmpdir(), 'reticle-announce-home-'));
      dirs.push(home);
      process.env[ReticleEnv.STATE_DIR] = home;

      const root = appRoot();
      const server = await create({
        root,
        logLevel: 'silent',
        configFile: false,
        server: { port: 0, host: '127.0.0.1' },
        resolve: { alias: { '@reticlehq/react': join(root, 'src/sdk.js') } },
        plugins: [reticle()],
      });
      await server.listen();
      expect(entriesIn(home)).toHaveLength(1);

      await server.close();
      expect(entriesIn(home)).toHaveLength(0);
    },
    SERVER_BOOT_BUDGET_MS,
  );
});
