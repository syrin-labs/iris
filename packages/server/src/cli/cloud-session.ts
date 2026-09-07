/**
 * The signed-in session on this machine: where it is stored, and how it is read back.
 *
 * Split out of `cloud-cli` for the file-size cap, but the unit is real — every rule about WHICH
 * credential may be sent to WHICH host is decided here, and the safety of that holds by
 * construction rather than by a guard somebody has to remember at each call site.
 */
import { z } from 'zod';
import { join } from 'node:path';

/** Where per-host sessions live under the reticle home directory. */
export const SESSIONS_DIR = 'sessions';

const SessionSchema = z.object({
  url: z.string(),
  token: z.string(),
  orgName: z.string(),
  /**
   * WHICH tenant this session signed into. Optional because every session file written before
   * org-scoped credentials lacks it; the link path treats "unknown" as "cannot prove a stored key
   * is ours" and mints, which is the safe direction.
   */
  orgId: z.string().optional(),
});
export type Session = z.infer<typeof SessionSchema>;

/** Trailing slashes are not identity: `https://x/` and `https://x` are one host. */
export const normalizeUrl = (url: string): string => url.replace(/\/+$/, '');

/**
 * A filesystem-safe name for one host. `https://app.reticle.sh` → `app.reticle.sh`,
 * `http://localhost:8890` → `localhost_8890`. The scheme is dropped deliberately: nobody runs the
 * same host over both http and https and means two different accounts by it.
 */
const hostSlug = (url: string): string =>
  normalizeUrl(url)
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[^a-zA-Z0-9.-]/g, '_');

export const sessionPath = (homeDir: string, url: string): string =>
  join(homeDir, SESSIONS_DIR, `${hostSlug(url)}.json`);

/** The ACTIVE session — the last host logged in to. What a bare command resolves its URL through. */
export const readSessionFrom = async (raw: Promise<unknown>): Promise<Session | null> => {
  const parsed = SessionSchema.safeParse(await raw);
  return parsed.success ? parsed.data : null;
};

/**
 * The session for ONE host, or null.
 *
 * This is the whole safety property, and it holds by construction rather than by a guard somebody
 * has to remember: a token is looked up BY the host it will be sent to, so there is no arrangement
 * of environment variables that fetches one host's credential for a request to another.
 *
 * Falls back to `session.json` when it names this host, so a machine that logged in before per-host
 * sessions existed keeps working and is not silently signed out by an upgrade.
 */
export const resolveSessionFor = (
  url: string,
  perHost: Session | null,
  active: Session | null,
): Session | null => {
  if (perHost !== null) return perHost;
  return null !== active && normalizeUrl(active.url) === normalizeUrl(url) ? active : null;
};
