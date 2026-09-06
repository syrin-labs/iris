/**
 * Enterprise activation, as the three facts telemetry reports on every event.
 *
 * WHY IT IS ON EVERY EVENT, not just an activation one: the questions a licensed customer generates
 * are "how much is this org using it", "what is breaking for them", "did their key lapse" — and every
 * one of those is answered by an event that has nothing to do with licensing. A status that rode only
 * its own event would tell us a key verified once and nothing about the sessions it covered. Same
 * reasoning that moved `installSource` onto every event.
 *
 * WHY STATUS IS SEPARATE FROM IDENTITY: `licenseId` is only present while a key verifies, so on
 * identity alone a lapsed customer and a departed one are the same silence. `licenseStatus` keeps
 * reporting through `expired` and `invalid`, which is the difference between seeing a renewal coming
 * and hearing about it from the customer.
 *
 * WHAT IS DELIBERATELY ABSENT: the organisation NAME, and the PLAN. The name is free text somebody
 * typed at signing time, which rule 3 forbids outright. The plan is merely redundant, which is a
 * quieter reason to leave something out and an easy one to lose sight of: it is keyed by this same
 * `lid` in the issuance ledger, so sending it on every event from every machine forever pays a
 * per-event cost to carry what one local file already holds, and the join that turns a `lid` into a
 * company turns it into a plan at the same moment. `reticle license` still reports it locally, where
 * it costs nothing and answers a question the operator is actually asking.
 *
 * More on the name: It is free text somebody typed at signing time,
 * and rule 3 of the telemetry contract is names-never-values. `licenseId` is an opaque uuid that
 * resolves to a company only against the issuance ledger held locally, so the analytics backend never
 * holds a customer list.
 */
import { LicenseActivation } from '@reticlehq/core';
import { describeLicense, LICENSE_KEY_ENV } from '../license/license.js';

/** The activation facts that ride the wire. All absent on a build with no issuer key baked. */
interface LicenseFacts {
  licenseId?: string;
  licenseStatus?: LicenseActivation;
  /**
   * A key was placed, whether or not this build could judge it. See LICENSE_KEY_PRESENT in core.
   * Reported even in evaluation mode, which is the whole point: that is the case where every other
   * licence property is deliberately silent.
   */
  licenseKeyPresent?: boolean;
}

/**
 * Resolve activation for one event. The clock is passed in (rule 7) and is the EVENT's clock, not a
 * value captured at startup: sessions here run to eleven hours, so a key that expires mid-session must
 * start reporting `expired` from the event it expired on rather than the whole run inheriting the
 * status it had at boot.
 *
 * `eval` reports NOTHING. It means no issuer key is baked at all, which is every OSS install and every
 * source checkout, so emitting it would add three properties to the dominant population to say "not a
 * licensed build" — which absence already says, more cheaply. A mis-built production release resolves
 * to `invalid` rather than `eval` and IS reported, because that one we need to hear about.
 *
 * Never throws. A telemetry property may not change behaviour (rule 5), and this one sits in front of
 * key parsing, which is the part most likely to be handed something malformed.
 */
export function licenseFacts(
  now: number,
  env: NodeJS.ProcessEnv = process.env,
  baked?: string,
): LicenseFacts {
  try {
    const report =
      baked === undefined ? describeLicense(now, env) : describeLicense(now, env, baked);
    // Asked BEFORE the eval short-circuit, because eval is exactly the case that used to be silent.
    const keyPresent = (env[LICENSE_KEY_ENV] ?? '').length > 0;
    if (LicenseActivation.EVAL === report.status) {
      return keyPresent ? { licenseKeyPresent: true } : {};
    }
    return {
      licenseStatus: report.status,
      ...(keyPresent ? { licenseKeyPresent: true } : {}),
      ...(report.licenseId !== undefined ? { licenseId: report.licenseId } : {}),
    };
  } catch {
    return {};
  }
}
