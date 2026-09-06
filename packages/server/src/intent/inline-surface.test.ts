import { describe, expect, it } from 'vitest';
import { surfaceForInlineIntent } from './inline-intent.js';

/**
 * Where an inline intent was captured, so the store can file it.
 *
 * Measured on a real corpus: 167 of 173 things a project knew landed in `unsorted`, because
 * `act_and_wait({ intent })` declared a statement and nothing else. The subject ladder had no flow,
 * no route and no explicit subject to work from, so every record fell to the bucket of last resort
 * — and a coverage map that is one pile with six labels tells a manager the team knows nothing,
 * when the truth is that it knows a great deal and none of it is filed.
 *
 * The route is the fix because it is ALWAYS available: an agent is always somewhere. The flow name
 * is better when there is one, and the ladder in `intent-subject.ts` already prefers it.
 */

describe('the surface an inline intent is captured on', () => {
  it('takes the pathname from the session URL', () => {
    expect(surfaceForInlineIntent('http://localhost:4320/issues', undefined)).toEqual({
      route: '/issues',
    });
  });

  /** Query and hash are per-visit, not per-subject: `/issues?category=severe` is still `/issues`. */
  it('drops the query and hash, which are not what a record is about', () => {
    expect(
      surfaceForInlineIntent('http://localhost:4320/issues?category=severe#top', undefined),
    ).toEqual({ route: '/issues' });
  });

  /** A flow is a feature, so it beats a route — the same order the subject ladder already uses. */
  it('carries the flow name when one is running, alongside the route', () => {
    expect(surfaceForInlineIntent('http://localhost:4320/checkout', 'checkout-pay')).toEqual({
      route: '/checkout',
      flow: 'checkout-pay',
    });
  });

  /**
   * Undefined, not an empty object. A surface that says nothing is worse than no surface: it looks
   * like the capture recorded a location and found none, rather than never having had one.
   */
  it('is undefined when there is nothing to record', () => {
    expect(surfaceForInlineIntent(undefined, undefined)).toBeUndefined();
    expect(surfaceForInlineIntent('not a url', undefined)).toBeUndefined();
  });

  /** A bare origin has no path worth filing under; `/` would file everything under one bucket. */
  it('is undefined for a bare origin', () => {
    expect(surfaceForInlineIntent('http://localhost:4320/', undefined)).toBeUndefined();
  });
});

/**
 * The FILE a captured intent is about.
 *
 * `IntentSurface` has carried `files` all along and nothing inline ever wrote it: measured on a real
 * corpus, 185 things a project knew and not one named a file. The route says which page a rule is
 * about, which is the right axis for filing it; the file says where somebody would go to change it,
 * which is what a reviewer actually needs and the one thing the record never had.
 *
 * It comes from the element the verdict ACTED ON — the honest claim being "this was proved by acting
 * on something defined here", not "this rule lives in this file", which nothing can know.
 */
describe('the file an inline intent is about', () => {
  it('records the acted element’s file', () => {
    expect(
      surfaceForInlineIntent('http://localhost:4320/cart', undefined, 'src/cart/total.tsx'),
    ).toEqual({ route: '/cart', files: ['src/cart/total.tsx'] });
  });

  /** The label arrives as `file:line`; the line is not what a record is filed under. */
  it('keeps the path and drops the line number', () => {
    expect(
      surfaceForInlineIntent('http://localhost:4320/cart', undefined, 'src/cart/total.tsx:168'),
    ).toEqual({ route: '/cart', files: ['src/cart/total.tsx'] });
  });

  /** A file alone is still worth filing — an assertion with no usable URL still names its source. */
  it('is enough on its own when there is no route and no flow', () => {
    expect(surfaceForInlineIntent(undefined, undefined, 'src/cart/total.tsx')).toEqual({
      files: ['src/cart/total.tsx'],
    });
  });

  it('omits files entirely when the verdict had no element to point at', () => {
    expect(surfaceForInlineIntent('http://localhost:4320/cart', undefined, undefined)).toEqual({
      route: '/cart',
    });
  });

  /** A Windows path carries a drive colon, which a naive line-strip would cut the path in half at. */
  it('does not mistake a drive letter for a line number', () => {
    expect(surfaceForInlineIntent(undefined, undefined, 'C:\\app\\src\\cart.tsx:12')).toEqual({
      files: ['C:\\app\\src\\cart.tsx'],
    });
  });
});
