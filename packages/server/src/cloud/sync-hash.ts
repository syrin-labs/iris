/**
 * The content hash both halves of sync compare on.
 *
 * The server answers "here is a hash per record you have already sent me"; the machine hashes what
 * it holds and sends only what differs. That only works if the two sides compute the SAME number
 * from the same record, so this function is a CONTRACT, not a utility — it has to stay byte-for-byte
 * equivalent to the server's, and it is separated out and tested against fixed vectors for exactly
 * that reason.
 *
 * Keys are sorted before serialising because two structurally identical records must hash the same
 * however they happened to be written out. Without that, a machine whose JSON key order differed
 * from the server's would re-upload the same unchanged record on every cycle, forever, and the whole
 * point of hashing — not paying for what has not moved — would be lost silently.
 */
import { createHash } from 'node:crypto';

/** How much of the digest is kept. Long enough that a collision is not a practical concern here. */
const HASH_LENGTH = 32;

/** Recursively sort object keys so serialisation is canonical. Arrays keep their order — it is data. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && 'object' === typeof value) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/** A stable content hash of one derived record. Must equal the server's for the same input. */
export function hashPayload(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(payload)))
    .digest('hex')
    .slice(0, HASH_LENGTH);
}
