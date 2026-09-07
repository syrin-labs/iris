import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectCloud, CLOUD_LINK_FILE, CREDENTIALS_FILE } from './cloud-config.js';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';

describe('resolveProjectCloud — per-project cloud binding + sync policy', () => {
  let dir: string;
  let reticleRoot: string; // <dir>/proj/.reticle
  let homeDir: string; // <dir>/home  (holds .reticle/credentials.json)
  let fs: FileSystemPort;
  const env: NodeJS.ProcessEnv = {};

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-cloudcfg-'));
    reticleRoot = join(dir, 'proj', '.reticle');
    homeDir = join(dir, 'home');
    await mkdir(reticleRoot, { recursive: true });
    fs = createNodeFileSystem();
  });
  afterEach(async () => {
    await removeTempDir(dir);
  });

  const writeLink = (obj: unknown): Promise<void> =>
    writeFile(join(reticleRoot, CLOUD_LINK_FILE), JSON.stringify(obj));
  const writeCreds = async (obj: unknown): Promise<void> => {
    await mkdir(join(homeDir, '.reticle'), { recursive: true });
    await writeFile(join(homeDir, '.reticle', CREDENTIALS_FILE), JSON.stringify(obj));
  };

  /**
   * Two ACCOUNTS on one cloud, which is one machine with a work login and a personal one.
   *
   * `link` names every project "default", so both tenants claimed the slot `<url>::default` and the
   * last writer won. Measured end to end: a brand-new workspace signed in and was handed a stored
   * key belonging to a different organisation — valid, so every check passed, and its runs would
   * have been pushed into a stranger's dashboard.
   */
  describe('two tenants on one cloud', () => {
    const URL = 'https://cloud.test';
    const bothTenants = {
      [`${URL}::org::org_mine::default`]: 'rk_live_mine',
      [`${URL}::org::org_theirs::default`]: 'rk_live_theirs',
      // The ambiguous shim an older link left behind, pointing at the OTHER tenant.
      [`${URL}::default`]: 'rk_live_theirs',
      default: { key: 'rk_live_theirs', url: URL },
    };

    it('sends MY key when the binding names my org, not whoever wrote the shared slot', async () => {
      await writeLink({ projectId: 'default', orgId: 'org_mine', url: URL });
      await writeCreds(bothTenants);
      const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, env);
      expect(cloud.config?.apiKey).toBe('rk_live_mine');
    });

    it('keeps the other tenant on their own key from the same keystore', async () => {
      await writeLink({ projectId: 'default', orgId: 'org_theirs', url: URL });
      await writeCreds(bothTenants);
      const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, env);
      expect(cloud.config?.apiKey).toBe('rk_live_theirs');
    });

    it('still resolves a binding written before orgs were recorded', async () => {
      // The compatibility half. A repo linked by an older CLI has no orgId and must keep working
      // through the ambiguous slot rather than losing its credential to a stricter lookup.
      await writeLink({ projectId: 'default', url: URL });
      await writeCreds(bothTenants);
      const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, env);
      expect(cloud.config?.apiKey).toBe('rk_live_theirs');
    });
  });

  it('falls back to env creds when the project has no cloud.json (single-project / CI)', async () => {
    const withEnv = { RETICLE_CLOUD_URL: 'https://cloud.test', RETICLE_CLOUD_KEY: 'rk_live_env' };
    const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, withEnv);
    expect(cloud.config).toEqual({ url: 'https://cloud.test', apiKey: 'rk_live_env' });
    expect(cloud.policy).toEqual({ runs: true, memory: true, flows: true });
    expect(cloud.projectId).toBeNull();
  });

  it('resolves url from cloud.json + key from the user keystore (secret stays out of the repo)', async () => {
    await writeLink({ projectId: 'shop', url: 'https://cloud.test/' });
    await writeCreds({ shop: 'rk_live_shopkey', blog: 'rk_live_other' });
    const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, env);
    expect(cloud.config).toEqual({ url: 'https://cloud.test', apiKey: 'rk_live_shopkey' });
    expect(cloud.projectId).toBe('shop');
  });

  it('reports cloud NOT attached when linked but no credential exists for the project', async () => {
    await writeLink({ projectId: 'shop', url: 'https://cloud.test' });
    await writeCreds({ blog: 'rk_live_other' }); // no key for 'shop'
    const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, env);
    expect(cloud.config).toBeNull();
    expect(cloud.projectId).toBe('shop'); // still know which project it WANTS to attach to
  });

  it('honors a per-project sync policy (e.g. push flows only, not runs/memory)', async () => {
    await writeLink({
      projectId: 'shop',
      url: 'https://cloud.test',
      sync: { runs: false, memory: false, flows: true },
    });
    await writeCreds({ shop: 'rk_live_shopkey' });
    const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, env);
    expect(cloud.policy).toEqual({ runs: false, memory: false, flows: true });
    expect(cloud.config).not.toBeNull();
  });

  it('parses verify:server and defaults verify to local otherwise', async () => {
    await writeLink({ projectId: 'shop', url: 'https://cloud.test', verify: 'server' });
    await writeCreds({ shop: 'rk_live_shopkey' });
    expect((await resolveProjectCloud(fs, reticleRoot, homeDir, env)).verify).toBe('server');

    await writeLink({ projectId: 'shop', url: 'https://cloud.test' });
    expect((await resolveProjectCloud(fs, reticleRoot, homeDir, env)).verify).toBe('local');
  });

  it('a malformed cloud.json degrades to the env fallback (never throws)', async () => {
    await writeFile(join(reticleRoot, CLOUD_LINK_FILE), '{ not valid json');
    const withEnv = { RETICLE_CLOUD_URL: 'https://cloud.test', RETICLE_CLOUD_KEY: 'rk_live_env' };
    const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, withEnv);
    expect(cloud.config).toEqual({ url: 'https://cloud.test', apiKey: 'rk_live_env' });
  });

  it('is fully local when neither a link nor env creds exist (no phone-home)', async () => {
    const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, {});
    expect(cloud.config).toBeNull();
  });

  describe('a credential belongs to the cloud that minted it', () => {
    /*
     * The collision, measured on a real machine: `reticle link` names every project "default", so a
     * repo on a self-hosted install and a repo on the hosted service both claimed the slot
     * `default`. The production key overwrote the local one and was then sent to localhost, which
     * answered 401.
     *
     * Same class as sending a session token to a host that did not issue it, and the same answer:
     * no credential at all beats one belonging to somewhere else.
     */
    it('refuses a key stamped with a different cloud, even when the project ids match', async () => {
      await writeLink({ projectId: 'default', url: 'http://localhost:8890' });
      await writeCreds({ default: { key: 'rk_live_prod', url: 'https://app.reticle.sh' } });

      const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, env);

      expect(cloud.config, 'the prod key must not be dialled at localhost').toBeNull();
    });

    it('uses a key stamped with the SAME cloud', async () => {
      await writeLink({ projectId: 'default', url: 'http://localhost:8890' });
      await writeCreds({ default: { key: 'rk_live_local', url: 'http://localhost:8890' } });

      const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, env);

      expect(cloud.config?.apiKey).toBe('rk_live_local');
    });

    it('ignores a trailing slash when comparing clouds', async () => {
      await writeLink({ projectId: 'default', url: 'https://app.reticle.sh' });
      await writeCreds({ default: { key: 'rk_live_prod', url: 'https://app.reticle.sh/' } });

      const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, env);

      expect(cloud.config?.apiKey).toBe('rk_live_prod');
    });

    it('holds TWO clouds that each call their project "default"', async () => {
      // The collision itself, not just the leak. Stamping stopped the wrong key being sent; only
      // keying by cloud lets a self-hosted repo and a hosted-service repo both work on one machine.
      await writeLink({ projectId: 'default', url: 'http://localhost:8890' });
      await writeCreds({
        'http://localhost:8890::default': 'rk_live_local',
        'https://app.reticle.sh::default': 'rk_live_prod',
      });

      const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, env);

      expect(cloud.config?.apiKey).toBe('rk_live_local');
    });

    it('prefers the composite slot over an ambiguous legacy one', async () => {
      await writeLink({ projectId: 'default', url: 'http://localhost:8890' });
      await writeCreds({
        'http://localhost:8890::default': 'rk_live_right',
        default: 'rk_live_ambiguous',
      });

      const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, env);

      expect(cloud.config?.apiKey).toBe('rk_live_right');
    });

    it('still honours a LEGACY bare-string credential', async () => {
      // Refusing these would silently unlink every repo that predates the change — a worse outage
      // than the collision being fixed. Re-linking upgrades a repo to the stamped shape.
      await writeLink({ projectId: 'default', url: 'http://localhost:8890' });
      await writeCreds({ default: 'rk_live_legacy' });

      const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, env);

      expect(cloud.config?.apiKey).toBe('rk_live_legacy');
    });
  });
});
