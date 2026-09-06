/**
 * Per-project cloud resolution for a SHARED daemon. One reticle MCP/daemon serves many projects; each
 * project declares its own cloud binding + sync policy in `<root>/.reticle/cloud.json`, and the SECRET
 * (the API key) lives once per user in `~/.reticle/credentials.json` (keyed by cloud project id) — never
 * in the repo. The daemon resolves "is cloud attached for THIS project, and what should I push where?"
 * from those two files, falling back to the global `RETICLE_CLOUD_*` env vars for the single-project /
 * CI case (backward compatible).
 *
 * Vercel-style split: `.reticle/cloud.json` is the safe-to-commit-but-gitignored binding, the key is a
 * user-level credential. "Cloud attached" = a valid link file AND a key for its project id (or env creds).
 */
import { join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import type { FileSystemPort } from '../project/fs-port.js';
import { resolveCloudConfig, type CloudConfig } from './cloud-sync.js';

/** `<reticleRoot>/cloud.json` — the project's cloud binding + sync policy (non-secret). */
/** Re-exported so the existing importers keep working; the string itself lives in core. */
export const CLOUD_LINK_FILE = ReticleDir.CLOUD_LINK_FILE;
/** `~/.reticle/credentials.json` — the user's per-cloud-project API keys (the only secret). */
export const CREDENTIALS_FILE = 'credentials.json';

/** What the daemon mirrors to the cloud for a project. Each surface is independently toggleable. */
interface SyncPolicy {
  /** Push verification-run artifacts to the dashboard Runs tab. */
  runs: boolean;
  /** Push per-flow project-memory outcomes (the regression history). */
  memory: boolean;
  /** Sync saved flow files (the shared regression suite). */
  flows: boolean;
}
const DEFAULT_SYNC_POLICY: SyncPolicy = { runs: true, memory: true, flows: true };

/** Where a verification actually executes. Reserved for the hosted-runner path; default local. */
export const VerifyMode = { LOCAL: 'local', SERVER: 'server' } as const;
export type VerifyMode = (typeof VerifyMode)[keyof typeof VerifyMode];

/** The resolved cloud picture for one project. `config === null` ⇒ cloud NOT attached (stay 100% local). */
export interface ProjectCloud {
  config: CloudConfig | null;
  policy: SyncPolicy;
  verify: VerifyMode;
  /** The cloud project id this project is linked to (for display/logging); null when env-fallback. */
  projectId: string | null;
}

interface CloudLink {
  projectId: string;
  /** Which tenant this binding belongs to. Absent in a cloud.json written before org-scoped slots. */
  orgId: string | undefined;
  url: string;
  sync: Partial<SyncPolicy>;
  verify: VerifyMode;
}

const asBool = (v: unknown, fallback: boolean): boolean => ('boolean' === typeof v ? v : fallback);

/** Read + JSON-parse a file, or null on any problem (missing/malformed) — never throws. */
async function readJson(fs: FileSystemPort, path: string): Promise<unknown> {
  try {
    if (!(await fs.exists(path))) return null;
    return JSON.parse(await fs.readFile(path));
  } catch {
    return null;
  }
}

/** Validate the shape of `.reticle/cloud.json`. Requires projectId + url; policy/verify default in. */
function parseLink(raw: unknown): CloudLink | null {
  if (typeof raw !== 'object' || null === raw) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.projectId !== 'string' || 0 === o.projectId.length) return null;
  if (typeof o.url !== 'string' || 0 === o.url.length) return null;
  const sync =
    'object' === typeof o.sync && o.sync !== null ? (o.sync as Record<string, unknown>) : {};
  return {
    projectId: o.projectId,
    orgId: 'string' === typeof o.orgId && o.orgId.length > 0 ? o.orgId : undefined,
    url: o.url,
    sync: {
      runs: asBool(sync.runs, DEFAULT_SYNC_POLICY.runs),
      memory: asBool(sync.memory, DEFAULT_SYNC_POLICY.memory),
      flows: asBool(sync.flows, DEFAULT_SYNC_POLICY.flows),
    },
    verify: o.verify === VerifyMode.SERVER ? VerifyMode.SERVER : VerifyMode.LOCAL,
  };
}

/** Look up the API key for a cloud project id in the user credentials map. */
/**
 * The API key this machine holds for one project ON ONE CLOUD.
 *
 * The store used to be keyed by cloud project id ALONE, which collides in the case that is not rare
 * at all — it is the default. `reticle link` names every project "default", so a repo linked to a
 * self-hosted install and a repo linked to the hosted service both claim the slot `default`, and
 * whichever was linked last wins. Measured: two repos on one machine, and the production key was
 * being sent to a localhost server, which answered 401.
 *
 * That is the same class of defect as sending a session token to a host that did not issue it, and
 * it deserves the same answer: a credential is scoped to the cloud that minted it, and no credential
 * at all is better than one belonging to somewhere else.
 *
 * Two shapes are accepted. `{ key, url }` is what is written now and is checked against the URL
 * being dialled. A bare string is the legacy shape, has no URL to check, and is still honoured —
 * refusing it would silently unlink every repo that predates this change, which is a worse outage
 * than the collision. Re-linking upgrades a repo to the safe shape.
 */
export const credentialSlot = (url: string, projectId: string, orgId?: string): string =>
  orgId === undefined || 0 === orgId.length
    ? `${normalizeCloudUrl(url)}::${projectId}`
    : `${normalizeCloudUrl(url)}::org::${orgId}::${projectId}`;

function credentialFor(
  raw: unknown,
  projectId: string,
  url: string,
  orgId?: string,
): string | null {
  if (typeof raw !== 'object' || null === raw) return null;
  const store = raw as Record<string, unknown>;
  /*
   * The ORG slot first, because cloud + project is still not an identity.
   *
   * `link` names every project "default", so two ACCOUNTS on one cloud both claimed the slot
   * `<url>::default` and the last link won. Measured on a laptop: a brand-new workspace ran
   * `reticle login` and was handed a stored key belonging to a different organisation — valid, so
   * every validation passed, and every run it pushed would have landed in a stranger's dashboard.
   * Keying by cloud fixed two clouds colliding; only keying by ORG fixes two tenants colliding.
   */
  const orgScoped = orgId === undefined ? undefined : store[credentialSlot(url, projectId, orgId)];
  if ('string' === typeof orgScoped && orgScoped.length > 0) return orgScoped;
  /*
   * Then the cloud+project slot, which is what every repo linked before this change still holds. It
   * is ambiguous between tenants by construction, which is why it is consulted second and why the
   * writer above stopped producing it as the only entry.
   */
  const composite = store[credentialSlot(url, projectId)];
  if ('string' === typeof composite && composite.length > 0) return composite;
  const entry = store[projectId];
  if ('string' === typeof entry) return entry.length > 0 ? entry : null;
  if (typeof entry !== 'object' || null === entry) return null;
  const record = entry as Record<string, unknown>;
  const key = record['key'];
  const forUrl = record['url'];
  if ('string' !== typeof key || 0 === key.length) return null;
  // A credential stamped with a DIFFERENT cloud is not this project's credential, however much the
  // project ids match. Refuse rather than dial somewhere with somebody else's key.
  if ('string' === typeof forUrl && normalizeCloudUrl(forUrl) !== normalizeCloudUrl(url))
    return null;
  return key;
}

/** Trailing slashes are not identity: `https://x/` and `https://x` are one cloud. */
const normalizeCloudUrl = (url: string): string => url.replace(/\/+$/, '');

/**
 * Resolve the cloud picture for a project rooted at `reticleRoot`. Reads the project's link file + the
 * user credential store; if the project isn't linked (no cloud.json), falls back to the global env creds
 * so the single-project / CI flow is unchanged. `homeDir` is injected (testable; `os.homedir()` at call).
 */
export async function resolveProjectCloud(
  fs: FileSystemPort,
  reticleRoot: string,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): Promise<ProjectCloud> {
  const link = parseLink(await readJson(fs, join(reticleRoot, CLOUD_LINK_FILE)));
  if (null === link) {
    // No per-project link → the env vars are the whole story (legacy single-project / CI behaviour).
    return {
      config: resolveCloudConfig(env),
      policy: DEFAULT_SYNC_POLICY,
      verify: VerifyMode.LOCAL,
      projectId: null,
    };
  }
  const policy: SyncPolicy = {
    runs: link.sync.runs ?? DEFAULT_SYNC_POLICY.runs,
    memory: link.sync.memory ?? DEFAULT_SYNC_POLICY.memory,
    flows: link.sync.flows ?? DEFAULT_SYNC_POLICY.flows,
  };
  const key = credentialFor(
    await readJson(fs, join(homeDir, ReticleDir.ROOT, CREDENTIALS_FILE)),
    link.projectId,
    link.url,
    link.orgId,
  );
  const config: CloudConfig | null =
    key !== null ? { url: link.url.replace(/\/+$/, ''), apiKey: key } : null;
  return { config, policy, verify: link.verify, projectId: link.projectId };
}
