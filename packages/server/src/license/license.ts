/**
 * Enterprise license-key verification + the assertEnterprise gate. ENTERPRISE CODE (Reticle Enterprise
 * License — see./LICENSE), not the FSL that covers the rest of the server.
 *
 * Offline + no phone-home (preserves the no-telemetry brand): a key is a signed payload Reticle issues
 * with its private key; this verifies it against the issuer's PUBLIC key with Ed25519. Dev/eval is a
 * no-op (requireLicense:false) so the gate never gets in a contributor's way; only a production-mode
 * caller with requireLicense:true must present a valid, unexpired key. The clock is injected (rule 7).
 *
 * Rules for this directory: the free server must never import from ee/; ee/ depends only on protocol +
 * node + zod. This file imports neither server core nor any sibling outside ee/.
 */

import { createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { LicenseActivation } from '@reticlehq/core';

/** Outcome of verifying a license key. */
export const LicenseStatus = {
  VALID: 'valid',
  MISSING: 'missing',
  MALFORMED: 'malformed',
  BAD_SIGNATURE: 'bad-signature',
  EXPIRED: 'expired',
} as const;
export type LicenseStatus = (typeof LicenseStatus)[keyof typeof LicenseStatus];

/**
 * The signed claims inside a key. `exp` is epoch ms; `features` (optional) scopes which ee features
 * unlock.
 *
 * `lid` is the STABLE LICENSE ID and the only safe join key for per-customer usage: `org` is a display
 * name a human typed at signing time, so two customers called "Acme" merge into one and a customer who
 * renames splits into two. Every key carries one (minted by the issuer, `scripts/issue-license.mjs`),
 * which is why it is required rather than optional — an optional id is one that goes missing on exactly
 * the keys somebody later needs to attribute, and a key without it should be re-issued, not silently
 * counted as nobody.
 */
const LicensePayloadSchema = z.object({
  lid: z.string().min(1),
  org: z.string(),
  plan: z.string(),
  exp: z.number(),
  features: z.array(z.string()).optional(),
});
export type LicensePayload = z.infer<typeof LicensePayloadSchema>;

type LicenseCheck =
  | { status: typeof LicenseStatus.VALID; payload: LicensePayload }
  /**
   * EXPIRED carries the payload; the other failures cannot. The line is the SIGNATURE, not the
   * clock: an expired key was genuinely issued by us and its claims are exactly as trustworthy as
   * they were yesterday, so the licence id is safe to use. A malformed or wrongly-signed key has no
   * verified claims at all, and naming a customer from one would mean trusting whatever was pasted.
   */
  | { status: typeof LicenseStatus.EXPIRED; payload: LicensePayload }
  | {
      status: Exclude<LicenseStatus, typeof LicenseStatus.VALID | typeof LicenseStatus.EXPIRED>;
    };

/** A key is `base64url(payloadJson).base64url(ed25519Signature)`. */
const KEY_SEP = '.';

/** Sign a payload into a license key — the ISSUER side (Reticle's private key). Exposed for the issuer tool + tests. */
export function signLicenseKey(payload: LicensePayload, privateKey: KeyObject): string {
  const json = JSON.stringify(payload);
  const sig = edSign(null, Buffer.from(json, 'utf8'), privateKey);
  return `${Buffer.from(json, 'utf8').toString('base64url')}${KEY_SEP}${sig.toString('base64url')}`;
}

/** Verify a key against the issuer public key. Never throws — returns a structured status. */
export function verifyLicenseKey(
  key: string | undefined,
  publicKey: KeyObject,
  now: number,
): LicenseCheck {
  if (key === undefined || 0 === key.length) return { status: LicenseStatus.MISSING };
  const parts = key.split(KEY_SEP);
  if (
    parts.length !== 2 ||
    parts[0] === undefined ||
    parts[1] === undefined ||
    0 === parts[0].length
  ) {
    return { status: LicenseStatus.MALFORMED };
  }

  let json: string;
  let payload: LicensePayload;
  try {
    json = Buffer.from(parts[0], 'base64url').toString('utf8');
    const parsed = LicensePayloadSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return { status: LicenseStatus.MALFORMED };
    payload = parsed.data;
  } catch {
    return { status: LicenseStatus.MALFORMED };
  }

  let signatureOk = false;
  try {
    signatureOk = edVerify(
      null,
      Buffer.from(json, 'utf8'),
      publicKey,
      Buffer.from(parts[1], 'base64url'),
    );
  } catch {
    return { status: LicenseStatus.BAD_SIGNATURE };
  }
  if (!signatureOk) return { status: LicenseStatus.BAD_SIGNATURE };
  if (payload.exp <= now) return { status: LicenseStatus.EXPIRED, payload };
  return { status: LicenseStatus.VALID, payload };
}

/**
 * Where to get a key. A named constant because it appears in the gate's error AND in what
 * `reticle license` prints, and a contact address that drifts between the two is a support request
 * that reaches nobody.
 */
export const LICENSE_CONTACT = 'hey@reticle.sh';

/**
 * The features a licence gates in THIS build. The single source: `assertEnterprise` callers name a
 * member rather than a string literal, and `reticle license` reports the list, so what the CLI claims
 * is gated is derived from what is actually gated rather than a second list somebody maintains.
 *
 * It is deliberately short. Reticle's roadmap for enterprise is longer (SSO, SCIM, RBAC, multi-org,
 * policy gates), and none of it is here yet — printing a roadmap as though it were shipped is how a
 * buyer discovers on day two that the thing they paid for does not exist. What is listed is what the
 * running build will actually refuse without a key.
 */
export const EnterpriseFeature = {
  /** Recording an audit event. */
  AUDIT_LOG: 'audit-log',
} as const;
export type EnterpriseFeature = (typeof EnterpriseFeature)[keyof typeof EnterpriseFeature];

/** Thrown when a production-mode enterprise feature is used without a valid license. */
export class EnterpriseLicenseError extends Error {
  readonly feature: string;
  readonly reason: string;
  constructor(feature: string, reason: string) {
    super(
      `Reticle Enterprise feature "${feature}" requires a valid license (${reason}). Contact ${LICENSE_CONTACT}.`,
    );
    this.name = 'EnterpriseLicenseError';
    this.feature = feature;
    this.reason = reason;
  }
}

/** Context for the gate. requireLicense:false ⇒ dev/eval no-op. publicKey injectable for tests. */
export interface GateContext {
  requireLicense: boolean;
  now: () => number;
  key?: string;
  publicKey?: KeyObject;
}

/**
 * Gate an enterprise feature. No-op in dev/eval (requireLicense:false). In production it throws
 * EnterpriseLicenseError unless a valid, unexpired key that covers `feature` is present.
 */
export function assertEnterprise(
  feature: string,
  ctx: GateContext,
  env: NodeJS.ProcessEnv = process.env,
  baked?: string,
): void {
  if (!ctx.requireLicense) return;

  // Resolved exactly as the env-entry point resolves it: BAKED first, env only as the dev/test
  // hatch. This path used to read the environment alone, so on a real release, where the key is
  // baked and no env var is set, it denied every valid licence with `no-issuer-key` while
  // assertEnterpriseFromEnv allowed the same key on the same build. Two gates, one truth.
  const publicKey = ctx.publicKey ?? loadPublicKey(resolveIssuerPublicKeyPem(env, baked));
  if (publicKey === undefined) throw new EnterpriseLicenseError(feature, 'no-issuer-key');

  const check = verifyLicenseKey(ctx.key, publicKey, ctx.now());
  if (check.status !== LicenseStatus.VALID) throw new EnterpriseLicenseError(feature, check.status);

  const { features } = check.payload;
  if (features !== undefined && !features.includes(feature)) {
    throw new EnterpriseLicenseError(feature, 'feature-not-licensed');
  }
}

/** Env names that carry the activation: the operator's key, and the issuer public key baked at release. */
export const LICENSE_KEY_ENV = 'RETICLE_LICENSE_KEY';
export const LICENSE_PUBLIC_KEY_ENV = 'RETICLE_LICENSE_PUBLIC_KEY';

/**
 * Issuer public key COMPILED INTO the build. Empty in the source tree; the release pipeline replaces
 * this literal with the real spki PEM. Baking it (rather than only reading env) is what makes the
 * enterprise gate fail closed: a self-hosted operator can no longer disable enforcement by simply
 * never setting RETICLE_LICENSE_PUBLIC_KEY, because the baked key takes precedence. The public key is
 * safe to ship openly — it can only verify licenses, never mint them (that needs the private key).
 */
const BAKED_ISSUER_PUBLIC_KEY_PEM = '';

/**
 * Resolve the issuer public-key PEM enforcement uses: the baked-in release key wins, so it can't be
 * turned off from the environment. Only when nothing is baked (dev/repo) does the env var apply — that
 * env path is the test/self-eval escape hatch, not the production switch.
 */
function resolveIssuerPublicKeyPem(
  env: NodeJS.ProcessEnv,
  baked: string = BAKED_ISSUER_PUBLIC_KEY_PEM,
): string | undefined {
  if (baked.length > 0) return baked;
  const envPem = env[LICENSE_PUBLIC_KEY_ENV];
  return envPem !== undefined && envPem.length > 0 ? envPem : undefined;
}

/** The human-facing state of enterprise activation on this machine (what `reticle license status` shows). */
interface LicenseReport {
  /**
   * Typed against core's closed list rather than re-listing the strings here: this status is reported
   * on every telemetry event, so a member added in one place and not the other is a silently
   * miscounted column (telemetry contract, rule 4).
   */
  status: LicenseActivation;
  /** The stable license id — what usage is attributed to. Present only when `status` is `active`. */
  licenseId?: string;
  /**
   * What a licence unlocks in THIS build, and where to get one. Always reported, including on an
   * unlicensed install: `reticle license` was the one command that talks about licensing and it named
   * neither, so it told an interested reader to set a variable without saying what it would unlock or
   * how to obtain it. A dead end at exactly the moment somebody is asking.
   */
  /**
   * What a licence unlocks in this build. Present on every branch a PROSPECTIVE customer lands on,
   * because being told to set a variable with no idea what it unlocks is the dead end this exists to
   * close. Absent once a licence is `active`: that reader has already bought, so naming features at
   * them reveals the product surface and answers nothing they asked.
   */
  gated?: readonly string[];
  contact: string;
  /**
   * The key is valid, and scoped to features this build does not gate, so it unlocks nothing here.
   * Present only when true: a `false` on every healthy licence is noise on the common case.
   */
  coversNothingHere?: boolean;
  org?: string;
  plan?: string;
  expiresAt?: number;
  features?: string[];
  detail: string;
}

/**
 * The two fields every report carries, spread into each branch. One object rather than a field on each
 * return, because the value that must never go missing is the one on the branch nobody was thinking
 * about — and the branch an unlicensed reader lands on is exactly that branch.
 */
const LICENSE_OFFER: { readonly gated: readonly string[]; readonly contact: string } = {
  gated: Object.values(EnterpriseFeature),
  contact: LICENSE_CONTACT,
};

function loadPublicKey(pem: string | undefined): KeyObject | undefined {
  if (pem === undefined || 0 === pem.length) return undefined;
  try {
    return createPublicKey(pem);
  } catch {
    return undefined;
  }
}

/**
 * Resolve activation entirely from the environment — the install mechanism: the release bakes the
 * issuer public key, the operator sets RETICLE_LICENSE_KEY. No public key configured ⇒ evaluation mode
 * (enterprise features run free, dev/test only). Offline, no phone-home.
 */
export function describeLicense(
  now: number,
  env: NodeJS.ProcessEnv = process.env,
  baked: string = BAKED_ISSUER_PUBLIC_KEY_PEM,
): LicenseReport {
  const pem = resolveIssuerPublicKeyPem(env, baked);
  if (pem === undefined || 0 === pem.length) {
    // In a production runtime this is NOT a benign eval session — it is a mis-built release whose gate
    // is off, and assertEnterpriseFromEnv now denies rather than unlocking. Say so loudly here too.
    return isProductionEnv(env)
      ? {
          ...LICENSE_OFFER,
          status: LicenseActivation.INVALID,
          detail:
            'MISCONFIGURED — running in production with no issuer key baked; enterprise features are DENIED (rebuild with BAKED_ISSUER_PUBLIC_KEY_PEM stamped in)',
        }
      : {
          ...LICENSE_OFFER,
          status: LicenseActivation.EVAL,
          detail: 'evaluation mode: enterprise features run free (no issuer key configured)',
        };
  }
  const publicKey = loadPublicKey(pem);
  if (publicKey === undefined)
    return {
      ...LICENSE_OFFER,
      status: LicenseActivation.INVALID,
      detail: `${LICENSE_PUBLIC_KEY_ENV} is not a valid public key`,
    };

  const check = verifyLicenseKey(env[LICENSE_KEY_ENV], publicKey, now);
  if (check.status === LicenseStatus.VALID) {
    const { lid, org, plan, exp, features } = check.payload;
    // A key scoped to features this build does not gate is `active` and unlocks nothing. Both halves
    // were already on screen (`features` against `gated`) and nothing joined them, so the one word a
    // customer actually reads told them they were fine while every gated call refused them.
    const coversNothingHere =
      features !== undefined && !features.some((f) => LICENSE_OFFER.gated.includes(f));
    const detail = coversNothingHere
      ? `licensed to ${org} (${plan}), expires ${new Date(exp).toISOString()}. This key covers ${features?.join(', ')}, and nothing this build gates (${LICENSE_OFFER.gated.join(', ')}) is included. Contact ${LICENSE_CONTACT}`
      : `licensed to ${org} (${plan}), expires ${new Date(exp).toISOString()}`;
    return {
      contact: LICENSE_CONTACT,
      // The one active case that still needs the list: a key covering nothing this build gates is
      // reported here, and the sentence explaining it is unreadable without both sides named.
      ...(coversNothingHere ? { gated: LICENSE_OFFER.gated } : {}),
      status: LicenseActivation.ACTIVE,
      licenseId: lid,
      org,
      plan,
      expiresAt: exp,
      ...(features !== undefined ? { features } : {}),
      ...(coversNothingHere ? { coversNothingHere } : {}),
      detail,
    };
  }
  if (check.status === LicenseStatus.MISSING) {
    return {
      ...LICENSE_OFFER,
      status: LicenseActivation.MISSING,
      detail:
        `set ${LICENSE_KEY_ENV} to activate enterprise features in production. ` +
        `Request a key from ${LICENSE_CONTACT}`,
    };
  }
  if (check.status === LicenseStatus.EXPIRED) {
    // The id rides an expired key so a lapse can be attributed to a CUSTOMER. Without it, telemetry
    // reports that somebody's licence ran out and cannot say whose, which is not a renewal signal.
    return {
      ...LICENSE_OFFER,
      status: LicenseActivation.EXPIRED,
      licenseId: check.payload.lid,
      org: check.payload.org,
      expiresAt: check.payload.exp,
      detail: `license expired. Renew with ${LICENSE_CONTACT} to keep using enterprise features`,
    };
  }
  return {
    ...LICENSE_OFFER,
    status: LicenseActivation.INVALID,
    detail: `license key rejected (${check.status}). ${LICENSE_CONTACT} can re-issue it`,
  };
}

/** True in a production runtime (NODE_ENV=production) — where a missing issuer key is a mis-built
 *  release, not an eval session, so the gate must fail CLOSED rather than run features free. */
function isProductionEnv(env: NodeJS.ProcessEnv): boolean {
  return 'production' === env['NODE_ENV'];
}

/**
 * Gate an enterprise feature using env-resolved activation. Enforcement is ON when the issuer public key
 * is configured (a real release). Without it, behaviour splits on runtime:
 *  - dev/eval (NODE_ENV ≠ production): features run FREE — never blocks a contributor or CI.
 *  - production (NODE_ENV = production): FAIL CLOSED — a release that reaches production with no
 *    resolvable issuer key was mis-built (the baked key wasn't stamped in, BAKED_ISSUER_PUBLIC_KEY_PEM
 *    is still ''), and silently unlocking every ee feature with no key and no warning is the worst
 *    outcome. Deny instead, with a distinct reason so the misconfiguration is obvious.
 */
export function assertEnterpriseFromEnv(
  feature: string,
  now: number,
  env: NodeJS.ProcessEnv = process.env,
  baked: string = BAKED_ISSUER_PUBLIC_KEY_PEM,
): void {
  const publicKey = loadPublicKey(resolveIssuerPublicKeyPem(env, baked));
  if (publicKey === undefined) {
    if (isProductionEnv(env)) {
      throw new EnterpriseLicenseError(feature, 'enterprise-gate-unconfigured');
    }
    return; // dev/eval — free
  }
  const key = env[LICENSE_KEY_ENV];
  assertEnterprise(feature, {
    requireLicense: true,
    now: () => now,
    ...(key !== undefined ? { key } : {}),
    publicKey,
  });
}
