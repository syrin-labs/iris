/**
 * A recording that leaves a page and comes back cannot replay: the flow has clicks, not navigations.
 *
 * Reported as a flow that clicked into a product, then "back" to search — both clicks saved, the
 * route change between them dropped. Replay lands on the product page and looks for a search-only
 * control. The shape is visible from the route list with no format change, so save/stop can warn
 * instead of writing a flow that fails on the next click.
 */
import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { recordingBacktrackWarning, routesFromRecording } from './recording-backtrack.js';

const change = (pathname: string, hash = ''): ReticleEvent => ({
  t: 1,
  type: EventType.ROUTE_CHANGE,
  sessionId: 's',
  data: { pathname, ...(0 === hash.length ? {} : { hash }) },
});

describe('recordingBacktrackWarning', () => {
  it('is silent on a single page', () => {
    expect(recordingBacktrackWarning(['/search'])).toBeUndefined();
  });

  it('is silent on a linear journey that never returns', () => {
    expect(recordingBacktrackWarning(['/search', '/product/1', '/cart'])).toBeUndefined();
  });

  it('warns when the journey returns to an earlier page', () => {
    const warning = recordingBacktrackWarning(['/search', '/product/1', '/search']);
    expect(warning).toContain('/search');
    expect(warning).toContain('/product/1');
    expect(warning).toMatch(/returned/i);
  });

  it('collapses a stay on the same page so a re-render is not a backtrack', () => {
    expect(recordingBacktrackWarning(['/search', '/search', '/search'])).toBeUndefined();
  });
});

describe('routesFromRecording', () => {
  it('starts from the recorded startPath and follows route changes', () => {
    expect(routesFromRecording('/search', [change('/product/1'), change('/search')])).toEqual([
      '/search',
      '/product/1',
      '/search',
    ]);
  });

  it('reads a hash-router journey as pages, not as repeated /', () => {
    expect(
      routesFromRecording('/#/search', [change('/', '#/product/1'), change('/', '#/search')]),
    ).toEqual(['/search', '/product/1', '/search']);
  });

  it('ignores events that are not route changes', () => {
    const other: ReticleEvent = { t: 1, type: EventType.DOM_ADDED, sessionId: 's', data: {} };
    expect(routesFromRecording('/a', [other, change('/b')])).toEqual(['/a', '/b']);
  });

  it('reads a route-change that names the page as `to`', () => {
    const renamed: ReticleEvent = {
      t: 1,
      type: EventType.ROUTE_CHANGE,
      sessionId: 's',
      data: { to: '/b' },
    };
    expect(routesFromRecording('/a', [renamed])).toEqual(['/a', '/b']);
  });
});
