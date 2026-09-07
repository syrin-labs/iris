import { describe, expect, it } from 'vitest';
import { REDACTED_VALUE } from './constants.js';
import { scrubKnownSecrets } from './redaction.js';

/**
 * Value-shape redaction: the half of the rule that does not depend on a key name.
 *
 * A key-based rule only fires when the credential sits under a name it recognises. These are the
 * shapes that leak under a benign one: a token pasted into a `note` field, echoed in a custom
 * header, or carried in a form body the driven path captured straight off the network stack. Each
 * entry is anchored to a vendor-reserved prefix and a length floor, which is what keeps the rule
 * from touching prose.
 */
describe('scrubKnownSecrets: vendor-prefixed credential shapes', () => {
  const SECRETS: ReadonlyArray<readonly [string, string]> = [
    ['JWT', 'eyJhbGciOi.eyJzdWIiOi.abc123XYZ'],
    ['Stripe secret key', 'sk_live_abcd1234efgh5678'],
    ['Stripe restricted key', 'rk_test_abcd1234efgh5678'],
    ['AWS long-term access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['AWS temporary access key id', 'ASIAIOSFODNN7EXAMPLE'],
    ['GitHub classic token', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'],
    [
      'GitHub fine-grained token',
      'github_pat_11ABCDEFG0abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234567890AB',
    ],
    ['Google API key', 'AIzaSyD-ABCdefGHIjklMNOpqrSTUvwxYZ0123456'],
    ['Google OAuth access token', 'ya29.a0ARrdaM-ABCdefGHIjklMNOpqrSTUvwxYZ'],
    ['Slack bot token', 'xoxb-1234567890-ABCDEFGHIJ'],
    ['OpenAI project key', 'sk-proj-ABCdefGHIjklMNOpqrSTUvwxYZ0123456789abcdefXYZ'],
    ['Anthropic API key', 'sk-ant-api03-ABCdefGHIjklMNOpqrSTUvwxYZ0123456789-abcdefAA'],
  ];

  for (const [name, secret] of SECRETS) {
    it(`redacts a ${name} sitting under a benign key`, () => {
      const out = scrubKnownSecrets(`{"note":"${secret}"}`);
      expect(out).not.toContain(secret);
      expect(out).toContain(REDACTED_VALUE);
    });
  }

  it('redacts every shape in one pass when several share a body', () => {
    const body = SECRETS.map(([, secret]) => secret).join(' ');
    const out = scrubKnownSecrets(body);
    for (const [name, secret] of SECRETS) {
      expect(out, `expected the ${name} to be redacted`).not.toContain(secret);
    }
  });
});

/**
 * The other half of the contract, and the reason each pattern is anchored rather than generic. A
 * broad entropy or length heuristic would redact identifiers an agent needs to read, and a value
 * quietly rewritten is as misleading here as a value quietly dropped.
 */
describe('scrubKnownSecrets: leaves legitimate values alone', () => {
  const KEEP: readonly string[] = [
    'the sk-eleton key opens the admin drawer',
    'AIzawa Shouta is the account holder',
    'ASIAN_MARKETS_ENABLED',
    'github_pattern_matching',
    'commit ghp is not a token',
    'sk-ant is too short to be a key',
    'AKIASHORT',
    'https://api.example.com/v1/orders?page=2&sort=asc',
  ];

  for (const value of KEEP) {
    it(`leaves "${value}" byte-for-byte`, () => {
      expect(scrubKnownSecrets(value)).toBe(value);
    });
  }
});
