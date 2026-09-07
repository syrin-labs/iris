/**
 * The machine's credential store: which key belongs to which repo, and who is allowed to write it.
 *
 * Split out of `cloud-cli` because both halves — the lookup and the write — encode the same rule
 * from opposite ends, and reading one without the other is how the rule got broken twice. The store
 * is `~/.reticle/credentials.json`, a flat map from slot to key.
 *
 * There are three generations of slot, and the order matters:
 *   `<url>::org::<orgId>::<projectId>`  the only unambiguous one
 *   `<url>::<projectId>`                tells two clouds apart, but not two tenants
 *   `<projectId>`                       tells nothing apart; the original shape
 *
 * Each generation exists because the one before it was found to collide in the field, so the older
 * two are kept readable (a repo linked by an older CLI must not lose its key) and written only when
 * doing so cannot mislead somebody else.
 */
import { join } from 'node:path';
import { credentialSlot } from '../cloud/cloud-config.js';

/** Trailing slashes are not identity: `https://x/` and `https://x` are one cloud. */
const normalizeUrl = (url: string): string => url.replace(/\/+$/, '');

/** The key held in a slot, whether it is a bare string or the stamped `{ key, url }` shape. */
const heldKeyOf = (held: unknown): string | undefined => {
  if ('string' === typeof held) return held.length > 0 ? held : undefined;
  if ('object' !== typeof held || null === held) return undefined;
  const key = (held as Record<string, unknown>)['key'];
  return 'string' === typeof key && key.length > 0 ? key : undefined;
};

/**
 * Find this repo's key, newest slot generation first.
 *
 * A hit in an older slot is not proof the key is ours — only that nothing better was filed. The
 * caller is expected to establish the tenant before trusting what comes back.
 */
export const findCredential = (
  raw: unknown,
  projectId: string,
  url: string,
  orgId: string | undefined,
): string | undefined => {
  if ('object' !== typeof raw || null === raw) return undefined;
  const store = raw as Record<string, unknown>;
  const orgScoped = orgId === undefined ? undefined : store[credentialSlot(url, projectId, orgId)];
  if ('string' === typeof orgScoped && orgScoped.length > 0) return orgScoped;
  const composite = store[credentialSlot(url, projectId)];
  if ('string' === typeof composite && composite.length > 0) return composite;
  const found = store[projectId];
  if ('string' === typeof found) return found.length > 0 ? found : undefined;
  if ('object' !== typeof found || null === found) return undefined;
  const record = found as Record<string, unknown>;
  const key = heldKeyOf(record);
  const forUrl = record['url'];
  if (key === undefined) return undefined;
  // A credential stamped with a DIFFERENT cloud is not this project's, however much the ids match.
  if ('string' === typeof forUrl && normalizeUrl(forUrl) !== normalizeUrl(url)) return undefined;
  return key;
};

interface CredentialWrite {
  projectId: string;
  url: string;
  key: string;
  /** The tenant this key belongs to; undefined against a cloud that cannot name one. */
  orgId: string | undefined;
  /** The key this slot held before, if any — used to tell our own stale key from somebody else's. */
  priorKey: string | undefined;
  /** Whether that prior key was PROVED to belong to a different organisation. */
  priorIsForeign: boolean;
}

/**
 * Apply a link's key to the store, in place, and return it.
 *
 * The org slot is always ours to write. The two ambiguous slots are a compatibility shim for older
 * daemons, and a shim must not corrupt what it is shimming:
 *
 *   - Overwriting a slot that holds a DIFFERENT live key would hand this key to whichever repo that
 *     entry belongs to — the same cross-tenant disclosure as reusing theirs, pointing the other way.
 *   - An EMPTY ambiguous slot is a trap too, because the resolver prefers cloud+project over the
 *     bare legacy entry: filling a free `<url>::default` while another tenant's key sits in
 *     `default` silently redirects THEIR repo to our key.
 *
 * So once another tenant is known to be on this machine, only the org slot is written. Our own
 * stale or revoked key is not another tenant and is replaced normally — that is the ordinary
 * re-link, and refusing it would strand the repo.
 */
export const applyCredential = (
  store: Record<string, unknown>,
  write: CredentialWrite,
): Record<string, unknown> => {
  const { projectId, url, key, orgId, priorKey, priorIsForeign } = write;
  if (orgId !== undefined) store[credentialSlot(url, projectId, orgId)] = key;
  const mayOverwrite = (slot: string): boolean => {
    const held = heldKeyOf(store[slot]);
    if (held === undefined) return true; // free
    if (held === key) return true; // already ours
    return held === priorKey && !priorIsForeign; // our own stale key, not somebody else's
  };
  const cloudSlot = credentialSlot(url, projectId);
  if (!priorIsForeign && mayOverwrite(cloudSlot)) store[cloudSlot] = key;
  if (!priorIsForeign && mayOverwrite(projectId)) store[projectId] = { key, url };
  return store;
};

/** Where the store lives, given the reticle home directory. */
export const credentialsPath = (homeDir: string, file: string): string => join(homeDir, file);
