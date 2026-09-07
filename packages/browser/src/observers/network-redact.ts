import { REDACTED_VALUE, URL_RAW } from '@reticlehq/core';
import { isSensitiveKey } from '../security/serialization.js';

/** A path segment name that is typically followed by a single-use secret token in the NEXT segment. */
const SENSITIVE_PATH_SEGMENT =
  /^(reset|verify|verification|confirm|activate|invite|magic|magiclink|token|key|oauth|unsubscribe|password)$/i;
/** Only mask a following segment that looks token-like — short ids/words (`reset/form`) are left alone. */
const PATH_TOKEN_MIN_LENGTH = 12;

/**
 * Redact credential-bearing values so they don't leak into the agent transcript / flow / run
 * artifacts: query params (`?access_token=…`, signed-URL keys) via the shared `isSensitiveKey` regex,
 * AND path-embedded tokens (`/reset/<token>`, `/invite/<token>`) that live in the path, not the query.
 * The hash is preserved and the URL is returned byte-for-byte when nothing matched.
 */
export function redactUrl(raw: string): string {
  const hashStart = raw.indexOf('#');
  const hash = -1 === hashStart ? '' : raw.slice(hashStart);
  const beforeHash = -1 === hashStart ? raw : raw.slice(0, hashStart);
  const queryStart = beforeHash.indexOf('?');
  const pathPart = -1 === queryStart ? beforeHash : beforeHash.slice(0, queryStart);
  const query = -1 === queryStart ? '' : beforeHash.slice(queryStart + 1);

  let changed = false;

  // Credentials in the authority (`scheme://user:pass@host`) never belong in a transcript.
  // Match to the LAST `@` before the path (`[^/]*@`, greedy), not the first — a password containing
  // `@` (`user:p@ss@host`) otherwise left its tail (`ss@host`) in the clear.
  let authority = pathPart;
  const userinfo = /^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i.exec(pathPart);
  if (userinfo !== null) {
    authority = `${userinfo[1] ?? ''}${REDACTED_VALUE}@${pathPart.slice(userinfo[0].length)}`;
    changed = true;
  }

  let newQuery = query;
  if (query !== '') {
    const params = new URLSearchParams(query);
    let queryChanged = false;
    for (const key of [...params.keys()]) {
      if (isSensitiveKey(key)) {
        params.set(key, REDACTED_VALUE);
        queryChanged = true;
      }
    }
    if (queryChanged) {
      newQuery = params.toString();
      changed = true;
    }
  }

  const segments = authority.split('/');
  for (let i = 0; i + 1 < segments.length; i++) {
    const name = segments[i];
    const next = segments[i + 1];
    if (
      name !== undefined &&
      next !== undefined &&
      next.length >= PATH_TOKEN_MIN_LENGTH &&
      SENSITIVE_PATH_SEGMENT.test(name)
    ) {
      segments[i + 1] = REDACTED_VALUE;
      changed = true;
    }
  }

  // OAuth implicit flow puts the access_token in the FRAGMENT (`#access_token=…`), and hash-routers carry
  // `?token=…` in the hash — redact sensitive params there too, leaving plain anchors (`#section`) alone.
  let newHash = hash;
  if (hash.length > 1) {
    newHash = hash.replace(/([A-Za-z0-9_.-]+)=([^&\s]+)/g, (m: string, key: string) =>
      isSensitiveKey(key) ? `${key}=${REDACTED_VALUE}` : m,
    );
    if (newHash !== hash) changed = true;
  }

  if (!changed) return raw;
  const queryOut = -1 === queryStart ? '' : `?${newQuery}`;
  return `${segments.join('/')}${queryOut}${newHash}`;
}

/**
 * Displayed URL plus, when redaction rewrote it, the raw request for graders.
 *
 * `url` is what the agent reads. `urlRaw` exists only so `urlContains` can still match a public
 * path segment that the heuristic rewrote (`/auth/token/refresh-context`). Omitted when nothing
 * changed, so an ordinary request pays nothing.
 */
export function netUrlFields(raw: string): { url: string } | { url: string; urlRaw: string } {
  const url = redactUrl(raw);
  return url === raw ? { url } : { url, [URL_RAW]: raw };
}
