import { REDACTED_VALUE } from './constants.js';

/**
 * Wire redaction rules — which field names carry credentials, and which VALUE shapes are secrets
 * regardless of the field they sit in.
 *
 * These live in core because they are a property of the wire, not of one side of it. They were
 * implemented in the browser SDK, which was the only consumer until the driven path began capturing
 * request bodies straight from the network stack — those are raw and unscrubbed, and duplicating a
 * security regex to redact them would be the worst possible place to have two copies drift.
 */
// `token` must match auth CREDENTIALS, not compound design fields. Bare/separated `token(s)` and
// auth-prefixed tokens (accessToken, auth_token, sessionToken, …) are redacted; `colorToken`,
// `backgroundToken`, `tokenCount`, `designToken` are NOT — they were false-positives that redacted
// legitimate reticle_inspect/reticle_state output.
// `token` must match auth CREDENTIALS, not compound design fields (see note above). `cookie` is
// boundary-anchored the same way: it targets the `Cookie` / `Set-Cookie` HTTP HEADER names (which
// bundle the session credential and were the one wire payload reaching the journal + the agent
// unredacted), NOT any key that merely contains the substring — `scopecookie`, `cookieConsent`,
// `cookiePolicy` are legitimate app values an agent may need to read, and stay visible.
const SENSITIVE_KEY =
  /password|passwd|passcode|secret|(?:(?:access|refresh|auth|bearer|api|id|session|csrf|client)[-_]?tokens?|(?:^|[-_])tokens?(?=$|[-_]))|session[-_]?id|(?:^|[-_])(?:sid|pwd|jwt)(?=$|[-_])|authorization|(?:^|[-_])(?:set[-_])?cookie(?=$|[-_])|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|credit[-_]?card|card[-_]?number|cvv|cvc|ssn|(?:^|[-_])(?:signature|sig)$|(?:^|[-_])credential$|x-(?:amz|goog)-(?:signature|credential|security-token)$/i;

/**
 * The built-in rule, always available and never configurable.
 *
 * Separate from `isSensitiveKey` on purpose: the driven path needs a floor that no page-supplied
 * config can lower, and the conformance test needs something to compare an unconfigured policy
 * against. Every existing caller wants `isSensitiveKey`.
 */
export function defaultIsSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/**
 * An app's additions to (and subtractions from) the default rule.
 *
 * Additive by construction: `keys` can only ever redact MORE, and `allow` only exempts from the
 * DEFAULT rule. There is deliberately no way to replace the default set — a user who could would
 * eventually ship an app that leaks, and Reticle would be the thing that recorded it.
 */
export interface RedactionConfig {
  /**
   * Extra keys to redact. A string matches a key name EXACTLY (case-insensitively) — `'code'` does
   * not redact `codeOwner` — and a RegExp is tested against the key. Use a string unless you need a
   * pattern: only strings cross the bridge (see `wireRedactionKeys`).
   */
  keys?: ReadonlyArray<string | RegExp>;
  /**
   * Keys to exempt from the DEFAULT rule, for the false positives every app has its own version of
   * (`designToken`, an internal `sessionId` that is not a credential). Exact, case-insensitive.
   * Loses to `keys`: an explicit redact instruction beats an exemption.
   */
  allow?: readonly string[];
}

/** A resolved rule. An object rather than a bare function so a caller can hold one per session. */
export interface RedactionPolicy {
  isSensitiveKey: (key: string) => boolean;
}

function normalizeNames(values: readonly string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length > 0) out.add(trimmed);
  }
  return out;
}

/**
 * Resolve a config into a rule.
 *
 * `onWarn` fires ONCE here, at build time, rather than per key: the check runs on every serialized
 * key of every event, so a per-key warning would flood the console of the app it is trying to help.
 */
export function buildRedactionPolicy(
  config?: RedactionConfig,
  onWarn?: (message: string) => void,
): RedactionPolicy {
  const literalKeys = normalizeNames(
    config?.keys?.filter((k): k is string => 'string' === typeof k),
  );
  const patterns = (config?.keys ?? []).filter((k): k is RegExp => k instanceof RegExp);
  const allowed = normalizeNames(config?.allow);
  // Exempting a key the default rule calls a credential is a deliberate choice with a real blast
  // radius: that value now reaches the agent transcript and the on-disk journal. Say it once, name
  // the keys, and say nothing about the ordinary case — an exemption for a key the rule never
  // matched is the false-positive fix this option exists for, and warning about it would train
  // people to ignore the warning that matters.
  const exemptedCredentials = [...allowed].filter(
    (key) => defaultIsSensitiveKey(key) && !literalKeys.has(key),
  );
  if (exemptedCredentials.length > 0 && onWarn !== undefined) {
    onWarn(
      `[reticle] redact.allow is exempting ${exemptedCredentials.join(', ')} from redaction. The ` +
        `default rule treats ${1 === exemptedCredentials.length ? 'that key' : 'those keys'} as a ` +
        `credential, so ${1 === exemptedCredentials.length ? 'its value' : 'their values'} will now ` +
        `reach the agent transcript and the on-disk journal in cleartext.`,
    );
  }
  return {
    isSensitiveKey: (key: string): boolean => {
      const normalized = key.toLowerCase();
      if (literalKeys.has(normalized)) return true;
      for (const pattern of patterns) {
        // `test` on a /g regex advances lastIndex between calls, so the same key alternates
        // true/false. Reset it rather than trusting every caller to omit the flag.
        pattern.lastIndex = 0;
        if (pattern.test(key)) return true;
      }
      if (allowed.has(normalized)) return false;
      return defaultIsSensitiveKey(key);
    },
  };
}

/**
 * The rule in force for THIS process.
 *
 * Ambient rather than threaded through the ~10 call sites that redact, so configuring it changes
 * every one of them at once and adding a new one cannot accidentally opt out. Set by `connect()` in
 * the browser, where one page means one config.
 *
 * The server deliberately does NOT set this. A daemon serves many sessions in one process, so an
 * ambient policy there would let one app's config decide another app's redaction; the driven path
 * holds its own policy per daemon instead, built only from what sessions declared as EXTRA keys.
 */
let activePolicy: RedactionPolicy | undefined;

export function setActiveRedactionPolicy(policy: RedactionPolicy): void {
  activePolicy = policy;
}

export function resetActiveRedactionPolicy(): void {
  activePolicy = undefined;
}

/** Whether a key carries a credential, under the policy in force. */
export function isSensitiveKey(key: string): boolean {
  return activePolicy === undefined ? defaultIsSensitiveKey(key) : activePolicy.isSensitiveKey(key);
}

/** Cap on how many declared keys travel in a hello — a bound, not a limit anyone should reach. */
export const MAX_WIRE_REDACT_KEYS = 64;
/** Cap on one declared key's length, so a hello cannot be inflated by a pathological name. */
export const MAX_WIRE_REDACT_KEY_LENGTH = 128;

/**
 * The part of a config that may cross the bridge, so the server redacts an app's own credentials on
 * the driven path too — where request bodies are captured raw from the network stack and never pass
 * through the SDK at all.
 *
 * Two deliberate exclusions, and both are the safe direction of the asymmetry:
 *
 *  - **RegExp entries do not travel.** Compiling a pattern that arrived over a socket and running it
 *    against every key of every request body is a ReDoS surface handed to whatever is on the page.
 *    A dropped pattern means the driven path over-redacts relative to the config, never under.
 *  - **`allow` never travels.** It is the only part of the config that REMOVES redaction, so a page
 *    able to send it could quietly un-redact `password` in the daemon's journal for every session.
 *    The driven path keeps the default floor.
 *
 * Both limitations are documented for users in docs/usage.md ("Extending the redaction rules").
 */
export function wireRedactionKeys(config?: RedactionConfig): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of config?.keys ?? []) {
    if (typeof key !== 'string') continue;
    const trimmed = key.trim();
    if (0 === trimmed.length || trimmed.length > MAX_WIRE_REDACT_KEY_LENGTH) continue;
    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(trimmed);
    if (out.length >= MAX_WIRE_REDACT_KEYS) break;
  }
  return out;
}

// High-confidence credential SHAPES, redacted regardless of key name — for scanning body/value text where
// a secret can sit under a benign key (`{"note":"<jwt>"}`, `<meta content="sk_live_…">`). Deliberately
// narrow (JWT, known provider prefixes) so it never corrupts legitimate prose the way a broad
// entropy/length heuristic would.
//
// Every entry is a vendor-RESERVED prefix plus a length floor, which is the property that makes the
// rule safe to widen: `github_pattern_matching`, `ASIAN_MARKETS`, and `AIzawa` are all prose that
// starts with one of these prefixes and none of them reaches the floor. A vendor that ships a new
// prefix belongs here; a shape recognisable only by entropy does not.
//
//  - `AKIA` / `ASIA` are both AWS access key ids: long-term and STS-temporary. They are the same 20
//    characters and leak from the same places, so covering one and not the other was an accident of
//    which one got written down first.
//  - `github_pat_` is GitHub's fine-grained token, now the default a user is handed. It does not
//    share the `gh[pousr]_` shape of the classic tokens.
//  - `AIza` is the Google API key handed out for Maps/Firebase/YouTube, the one credential most
//    likely to sit in a front-end request this SDK is watching.
//  - `sk-<product>-` covers the LLM-provider keys (OpenAI `sk-proj-`, Anthropic `sk-ant-`). The
//    product segment is required: bare `sk-` is two characters and would catch prose.
const KNOWN_SECRET =
  /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|sk-(?:ant|proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|ya29\.[A-Za-z0-9._-]{20,}/g;

/** Redact high-confidence secret shapes anywhere in a text/value, independent of any surrounding key. */
export function scrubKnownSecrets(text: string): string {
  return text.replace(KNOWN_SECRET, REDACTED_VALUE);
}
