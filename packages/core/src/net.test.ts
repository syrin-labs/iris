import { describe, expect, it } from 'vitest';
import { DevToolingChannel, isDevToolingUrl, isThirdPartyUrl, urlForMatch } from './net.js';

describe('isDevToolingUrl — traffic the framework makes about ITSELF', () => {
  it.each(Object.values(DevToolingChannel))('recognises %s', (pattern) => {
    expect(true).toBe(isDevToolingUrl(`http://localhost:3000${pattern}x`));
  });

  it('recognises the real URLs each framework fires in dev', () => {
    for (const url of [
      // Next dev overlay resolving a source map for a React key warning — the reported false negative.
      'http://localhost:3000/__nextjs_original-stack-frames',
      'http://localhost:3000/__nextjs_original-stack-frame?isServer=false',
      '/__nextjs_launch-editor?file=app/page.tsx',
      '/__nextjs_source-map?filename=x',
      '/_next/static/webpack/633457081244afec.webpack.hot-update.json',
      '/_next/webpack-hmr',
      '/@vite/client',
      '/@vite/env',
      '/@react-refresh',
      '/__vite_ping',
      '/main.a1b2c3.hot-update.js',
    ]) {
      expect(`${url} is dev tooling`).toBe(
        `${url} is ${isDevToolingUrl(url) ? 'dev tooling' : 'APP TRAFFIC'}`,
      );
    }
  });

  /**
   * The over-exclusion guard. Everything below is the app's own traffic and MUST still count against
   * settle — a pattern wide enough to swallow one of these turns this false negative into a false
   * green, which is the worse defect of the two.
   */
  it('leaves the app own traffic alone', () => {
    for (const url of [
      '/api/users',
      'http://localhost:3000/api/checkout',
      '/_next/static/chunks/main-app.js',
      '/_next/image?url=%2Fhero.png',
      '/_next/data/build/products.json',
      '/dashboard?__nextjs=1',
      '/_astro/index.BdF3k2.js',
      '/__data.json',
      'ipc://save_invoice',
      '/graphql',
    ]) {
      expect(`${url} is app traffic`).toBe(
        `${url} is ${isDevToolingUrl(url) ? 'DEV TOOLING' : 'app traffic'}`,
      );
    }
  });

  it('is false for a missing url', () => {
    expect(false).toBe(isDevToolingUrl(undefined));
  });
});

describe('isThirdPartyUrl — whose site is this call to?', () => {
  const APP = 'http://localhost:3000/dashboard';

  it('calls an analytics beacon third-party', () => {
    expect(true).toBe(isThirdPartyUrl('https://www.google-analytics.com/g/collect', APP));
    expect(true).toBe(isThirdPartyUrl('https://cdn.segment.com/analytics.js/v1/k/a.min.js', APP));
  });

  it('calls the app’s own traffic first-party, however it is written', () => {
    // Relative, absolute, and absolute on another PORT — a dev app on :3000 talking to its API on
    // :8787 is the ordinary local setup and must not read as a stranger's.
    expect(false).toBe(isThirdPartyUrl('/api/todos', APP));
    expect(false).toBe(isThirdPartyUrl('http://localhost:3000/api/todos', APP));
    expect(false).toBe(isThirdPartyUrl('http://localhost:8787/api/todos', APP));
  });

  it('calls a sibling subdomain first-party — api.example.com IS app.example.com’s backend', () => {
    expect(false).toBe(
      isThirdPartyUrl('https://api.example.com/todos', 'https://app.example.com/dashboard'),
    );
  });

  it('declines to judge what is not an http call at all', () => {
    // A desktop IPC command and a page-made blob are the app's own machinery, not somebody's server.
    expect(false).toBe(isThirdPartyUrl('ipc://todos:archive', APP));
    expect(false).toBe(isThirdPartyUrl('blob:http://localhost:3000/abc', APP));
  });

  it('declines to judge at all when the app’s own page is unknown', () => {
    expect(false).toBe(isThirdPartyUrl('https://www.google-analytics.com/g/collect', undefined));
    expect(false).toBe(isThirdPartyUrl(undefined, APP));
  });
});

describe('urlForMatch — grader haystack, not the transcript', () => {
  it('prefers the raw URL when the observer kept one', () => {
    expect(
      urlForMatch({ url: '/auth/token/[REDACTED]', urlRaw: '/auth/token/refresh-context' }),
    ).toBe('/auth/token/refresh-context');
  });

  it('falls back to the displayed URL when nothing was redacted', () => {
    expect(urlForMatch({ url: '/api/users' })).toBe('/api/users');
  });
});
