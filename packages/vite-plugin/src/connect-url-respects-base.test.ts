import { describe, expect, it } from 'vitest';
import { connectModuleUrl, reticle, RETICLE_CONNECT_MODULE } from './index.js';

/**
 * #676: the injected `<script src>` pointed at the SERVER ROOT and ignored Vite's `base`.
 *
 * With `base: '/playground/'` the browser asked for `/@reticle-connect`, Vite answered 404 — with
 * its own "did you mean /playground/@reticle-connect" hint — and the page rendered perfectly while
 * never connecting. `doctor` and `status` both reported the project correctly wired, so nothing in
 * the diagnostic surface pointed at the one thing that was wrong.
 */
describe('connectModuleUrl', () => {
  it('leaves the module id alone at the default base', () => {
    expect(connectModuleUrl('/')).toBe(RETICLE_CONNECT_MODULE);
    expect(connectModuleUrl(undefined)).toBe(RETICLE_CONNECT_MODULE);
  });

  it('joins a sub-path base without doubling the slash', () => {
    expect(connectModuleUrl('/playground/')).toBe('/playground/@reticle-connect');
    // Vite resolves `base` with a trailing slash, but a hand-written config may not have one.
    expect(connectModuleUrl('/playground')).toBe('/playground/@reticle-connect');
    expect(connectModuleUrl('/a/b/')).toBe('/a/b/@reticle-connect');
  });

  it('does not prefix an external base onto a dev-server module', () => {
    // Vite serves the dev app from the root when `base` is an absolute URL; prefixing the CDN
    // origin here would point the tag off-host at a module only this dev server can serve.
    expect(connectModuleUrl('https://cdn.example.com/assets/')).toBe(RETICLE_CONNECT_MODULE);
    expect(connectModuleUrl('./relative/')).toBe(RETICLE_CONNECT_MODULE);
  });
});

describe('the injected tag under a non-root base', () => {
  const srcOf = (plugin: ReturnType<typeof reticle>): unknown => {
    const tags = plugin.transformIndexHtml?.('<html></html>') ?? [];
    return tags.find((tag) => 'script' === tag.tag && undefined !== tag.attrs?.['src'])?.attrs?.[
      'src'
    ];
  };

  it('points at base + the module id once Vite has resolved the config', () => {
    const plugin = reticle();
    plugin.configResolved?.({ root: '/repo', command: 'serve', base: '/playground/' });
    expect(srcOf(plugin)).toBe('/playground/@reticle-connect');
  });

  it('still points at the module id when the app is served from the root', () => {
    const plugin = reticle();
    plugin.configResolved?.({ root: '/repo', command: 'serve', base: '/' });
    expect(srcOf(plugin)).toBe(RETICLE_CONNECT_MODULE);
  });

  it('falls back to the root path when configResolved never ran', () => {
    // A host that constructs the plugin and renders HTML without Vite's config pass gets the old
    // behaviour rather than an undefined-shaped URL.
    expect(srcOf(reticle())).toBe(RETICLE_CONNECT_MODULE);
  });
});

describe('the base trim is linear', () => {
  it('handles a long run of trailing slashes without backtracking', () => {
    // The `/\/+$/` this replaced is a polynomial-backtracking shape over a value read from the
    // user's vite config. Same answer, no quantifier.
    expect(connectModuleUrl(`/app${'/'.repeat(50_000)}`)).toBe('/app/@reticle-connect');
    expect(connectModuleUrl('/'.repeat(50_000))).toBe(RETICLE_CONNECT_MODULE);
  });
});
