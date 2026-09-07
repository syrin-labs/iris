/**
 * Which project a repo binds to when the user does not say.
 *
 * Measured before this existed: two unrelated checkouts linked on one account both bound to a
 * project called "Default" and shared one key, merging their runs, issues and impact into a single
 * bucket. The dashboard's per-project view was describing nothing.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_ID, defaultProjectFor, slugifyProjectName } from './project-name.js';

describe('a repo is named after itself', () => {
  it('gives two different checkouts two different projects', () => {
    // The defect, stated as the property that was false.
    expect(defaultProjectFor('storefront', undefined)).not.toBe(
      defaultProjectFor('billing-svc', undefined),
    );
    expect(defaultProjectFor('storefront', undefined)).toBe('storefront');
  });

  it('is stable for the same repo, so re-linking is idempotent', () => {
    expect(defaultProjectFor('storefront', undefined)).toBe(
      defaultProjectFor('storefront', undefined),
    );
  });
});

describe('an existing binding always wins', () => {
  it('keeps the project a linked repo already reports to', () => {
    // The safety property of the whole change. People re-run `link` to rotate a key or repoint an
    // environment; if that moved them to a differently-named project their history would split in
    // two silently — a worse outcome than the shared bucket this fixes.
    expect(defaultProjectFor('storefront', 'default')).toBe('default');
  });

  it('does not treat an empty recorded id as a binding', () => {
    expect(defaultProjectFor('storefront', '')).toBe('storefront');
  });
});

describe('the slug is safe to put in a URL, a slot key and a project list', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyProjectName('My Cool App')).toBe('my-cool-app');
    expect(slugifyProjectName('Acme_Storefront')).toBe('acme-storefront');
  });

  it('collapses runs and trims the edges', () => {
    expect(slugifyProjectName('--web---app--')).toBe('web-app');
    expect(slugifyProjectName('...api...')).toBe('api');
  });

  it('caps the length without leaving a trailing hyphen', () => {
    const slug = slugifyProjectName(`${'a'.repeat(40)} ${'b'.repeat(40)}`);
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('falls back to the historical id when a name yields nothing usable', () => {
    // A checkout at `/` or in a directory named only in a non-latin script still has to link.
    expect(slugifyProjectName('...')).toBe(DEFAULT_PROJECT_ID);
    expect(slugifyProjectName('')).toBe(DEFAULT_PROJECT_ID);
    expect(slugifyProjectName('日本語')).toBe(DEFAULT_PROJECT_ID);
  });
});

/**
 * The server-first persona: somebody who signed up on the dashboard, made a project there, and is
 * now reading its Connect page to attach a repo.
 *
 * Their project already exists and has a NAME they chose. The directory-derived default is exactly
 * wrong for them, which is why `--project` has to win outright — and why the Connect page hands
 * them one command rather than a login followed by a link.
 */
describe('an explicitly named project always wins', () => {
  it('beats the directory name', () => {
    // `defaultProjectFor` is only ever consulted when no --project was given; this pins the
    // contract that makes that safe to rely on.
    expect(defaultProjectFor('some-checkout-dir', undefined)).toBe('some-checkout-dir');
    expect(defaultProjectFor('some-checkout-dir', 'chosen-on-the-dashboard')).toBe(
      'chosen-on-the-dashboard',
    );
  });
});
