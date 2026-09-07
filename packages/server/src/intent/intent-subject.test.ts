/**
 * Where an intent files itself, and why it is inferred rather than asked for.
 *
 * The real corpus this was built against: 141 intents in one 109KB object, of which FOUR carried a
 * surface. So the common case is an intent whose only structural evidence is the predicate it is
 * bound to, and a scheme that needs a caller-supplied category would put 137 of them in one pile.
 */
import { describe, expect, it } from 'vitest';
import { slugifySubject, subjectFor, UNSORTED_SUBJECT } from './intent-subject.js';

describe('the subject ladder', () => {
  it('takes an explicit subject over everything else', () => {
    expect(subjectFor({ subject: 'Checkout', surface: { flow: 'sign-in' } })).toBe('checkout');
  });

  it('prefers the flow, because a flow IS a feature', () => {
    expect(subjectFor({ surface: { flow: 'triage-queue', route: '/settings' } })).toBe(
      'triage-queue',
    );
  });

  it('falls back to the route, which is how the product is navigated and discussed', () => {
    expect(subjectFor({ surface: { route: '/issues?status=open' } })).toBe('issues');
  });

  it('reads the API path out of a binding when the UI says nothing', () => {
    // The common case in the real corpus: no surface at all, but a predicate naming an endpoint.
    expect(
      subjectFor({ binding: { kind: 'net', urlContains: '/v1/auth/signin', status: 200 } }),
    ).toBe('auth');
  });

  it('walks a nested predicate tree to find one', () => {
    expect(
      subjectFor({
        binding: {
          kind: 'allOf',
          predicates: [
            { kind: 'element', testid: 'x' },
            { kind: 'route', pathname: '/billing' },
          ],
        },
      }),
    ).toBe('billing');
  });

  it('never mistakes a version prefix or an id for a name', () => {
    expect(subjectFor({ binding: { kind: 'net', urlContains: '/v1/orders/42' } })).toBe('orders');
  });

  it('files the genuinely unplaceable somewhere visible, not somewhere plausible', () => {
    // Deliberately NOT inferred from prose: clustering sentences is how "sign-in works" ends up
    // under settings with nobody able to say why.
    expect(subjectFor({})).toBe(UNSORTED_SUBJECT);
    expect(subjectFor({ binding: { kind: 'element', testid: 'submit' } })).toBe(UNSORTED_SUBJECT);
  });

  it('always returns something — a store that can refuse a record loses records', () => {
    for (const e of [{}, { subject: '' }, { subject: '///' }, { surface: {} }]) {
      expect(subjectFor(e).length).toBeGreaterThan(0);
    }
  });
});

describe('the slug is a filename somebody reads in a listing', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifySubject('Sign In Flow')).toBe('sign-in-flow');
  });

  it('caps length without leaving a trailing hyphen', () => {
    const s = slugifySubject(`${'a'.repeat(38)} tail`);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('-')).toBe(false);
  });
});

/**
 * Subjects mined from a BINDING, and the ones that were never product areas at all.
 *
 * Measured on a real corpus of 200 records: 34 subjects, six of which were query-string values —
 * `category-minor`, `category-severe-status-open`, `category-vulnerability-2csevere`,
 * `projectid-storefront`. Each held exactly one record, each was unreadable, and together they made
 * the coverage map look like a product with two dozen tiny unrelated areas.
 *
 * The cause: rung 4 of the ladder mines `urlContains` for a path, and a `net` predicate's
 * `urlContains` is routinely a QUERY fragment — `category=severe` — which has no `?` to split on,
 * so the whole thing was taken as a path segment and slugified.
 */
describe('a binding that names a filter, not an area', () => {
  it('does not turn a bare query fragment into a subject', () => {
    expect(
      subjectFor({ binding: { kind: 'net', urlContains: 'category=vulnerability%2Csevere' } }),
    ).toBe(UNSORTED_SUBJECT);
  });

  it('does not turn a projectId filter into a subject', () => {
    expect(subjectFor({ binding: { kind: 'net', urlContains: 'projectId=storefront' } })).toBe(
      UNSORTED_SUBJECT,
    );
  });

  it('still mines a real API path, which is the rung’s whole purpose', () => {
    expect(subjectFor({ binding: { kind: 'net', urlContains: '/v1/issues' } })).toBe('issues');
  });

  it('takes the PATH from a url that also carries a query', () => {
    expect(
      subjectFor({ binding: { kind: 'net', urlContains: '/v1/issues?category=severe' } }),
    ).toBe('issues');
  });

  it('still accepts a bare resource name — "issues" is a path hint, "issues=1" is not', () => {
    expect(subjectFor({ binding: { kind: 'net', urlContains: 'issues' } })).toBe('issues');
  });

  it('skips the query part and keeps looking, rather than giving up on the whole binding', () => {
    expect(
      subjectFor({
        binding: {
          kind: 'allOf',
          predicates: [
            { kind: 'net', urlContains: 'status=open' },
            { kind: 'route', pathname: '/billing' },
          ],
        },
      }),
    ).toBe('billing');
  });
});

/**
 * The FILE a verdict touched, as a subject.
 *
 * Added after measuring the alternative and rejecting it. 68 records had no subject; 29 of them
 * carried a testid in their binding, and using the testid's prefix would have produced `confirm`,
 * `new` and `delete` — verbs, not areas of a product — recreating the fragmentation that
 * query-string subjects had just been fixed for. A path is structural rather than a guess: a
 * codebase already groups itself by feature, and the directory a file sits in is that grouping
 * stated by the people who wrote it.
 *
 * Ranked below the route, which is how the product is NAVIGATED and therefore how it is discussed,
 * and above the binding's API path, which names the domain only indirectly.
 */
describe('the file a verdict acted on', () => {
  it('takes the feature directory, which is the codebase’s own grouping', () => {
    expect(subjectFor({ surface: { files: ['src/features/auth/login-view.tsx'] } })).toBe('auth');
  });

  it('works several levels down a monorepo', () => {
    expect(
      subjectFor({ surface: { files: ['apps/console/src/features/billing/plan-panel.tsx'] } }),
    ).toBe('billing');
  });

  it('walks past a generic container rather than filing under "ui"', () => {
    // `src/ui/input.tsx` is every screen's shared control. Filing knowledge under `ui` would put
    // sign-in, billing and issues in one bucket named after a folder.
    expect(subjectFor({ surface: { files: ['src/ui/input.tsx'] } })).toBe(UNSORTED_SUBJECT);
  });

  it('gives up rather than inventing when every directory is generic', () => {
    expect(subjectFor({ surface: { files: ['src/lib/utils.ts'] } })).toBe(UNSORTED_SUBJECT);
  });

  it('handles a file at the root with no directory at all', () => {
    expect(subjectFor({ surface: { files: ['index.ts'] } })).toBe(UNSORTED_SUBJECT);
  });

  it('is outranked by the route, which is how the product is discussed', () => {
    expect(
      subjectFor({ surface: { route: '/billing', files: ['src/features/auth/login-view.tsx'] } }),
    ).toBe('billing');
  });

  it('outranks the binding, which names the domain only indirectly', () => {
    expect(
      subjectFor({
        surface: { files: ['src/features/checkout/total.ts'] },
        binding: { kind: 'net', urlContains: '/v1/orders' },
      }),
    ).toBe('checkout');
  });

  it('ignores an empty file list rather than treating it as evidence', () => {
    expect(subjectFor({ surface: { files: [] } })).toBe(UNSORTED_SUBJECT);
  });

  it('copes with a Windows path', () => {
    expect(subjectFor({ surface: { files: ['src\\features\\cart\\total.tsx'] } })).toBe('cart');
  });
});
