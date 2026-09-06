/**
 * Enterprise activation, as the wire reports it.
 *
 * Its own file rather than another block in `telemetry.ts`: this vocabulary is shared by the LICENCE
 * GATE (`describeLicense` types its report against it) and by the telemetry that reports the gate's
 * outcome, and those are the two sides a copied enum silently drifts between. Keeping it at the bottom
 * of the graph is what lets both import the same list instead of each keeping their own.
 */

/**
 * How enterprise activation resolved on the machine that sent an event. The closed list, defined HERE
 * so the license gate and the telemetry that reports it cannot drift apart: `describeLicense` in the
 * server types its report against this rather than re-listing the strings (rule 4 — a copied
 * vocabulary is a correctness hazard the moment it is a number somebody reads).
 *
 * This is a STATUS, never an identity. It says whether a key verified, not whose key it is; the
 * separate `licenseId` carries the opaque id, and the organisation NAME never goes on the wire at all.
 */
/**
 * A licence key is present in the environment — whatever this build was able to conclude about it.
 *
 * Separate from `licenseStatus` because status can be ABSENT: `eval` reports nothing at all, by
 * design, since it means no issuer key is baked and that is every OSS install. The consequence was
 * that a customer who pastes a real enterprise key into a build which cannot verify it produced no
 * licence signal whatsoever — indistinguishable from someone who has never held a key. The one
 * population most worth seeing was the one that could not be seen.
 *
 * Never the key. This is a boolean; the key itself is a credential and never leaves the machine.
 */
export const LICENSE_KEY_PRESENT = 'licenseKeyPresent';

export const LicenseActivation = {
  /** A valid, unexpired, correctly-signed key covering this build. */
  ACTIVE: 'active',
  /** An issuer key is baked but no license key is set — an unlicensed install of a release build. */
  MISSING: 'missing',
  /** A key was present and rejected: malformed, wrong issuer, or a tampered payload. */
  INVALID: 'invalid',
  /**
   * A key that verified but whose expiry has passed. The renewal signal: this arriving from a machine
   * that used to report `active` is a lapse we can see BEFORE the customer reports it, and it is the
   * whole reason status is reported separately from identity — a lapsed customer stops sending
   * `licenseId`, so on identity alone a lapse and a churn look identical.
   */
  EXPIRED: 'expired',
  /** No issuer key configured at all: a source build or a dev checkout, where features run free. */
  EVAL: 'eval',
} as const;
export type LicenseActivation = (typeof LicenseActivation)[keyof typeof LicenseActivation];
