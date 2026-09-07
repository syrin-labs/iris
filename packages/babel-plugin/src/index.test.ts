import { describe, it, expect } from 'vitest';
import { transformSync } from '@babel/core';
// The module IS the plugin function (module.exports = fn) — a default import resolves to it under
// vite/node CJS interop, exactly as Babel's require() does. No named exports on the CJS module.
import plugin from './index.js';

import { DATA_RETICLE_SOURCE_ATTR } from '@reticlehq/core/source-constants';

const SOURCE_ATTR = DATA_RETICLE_SOURCE_ATTR;

function transform(code: string, filename = 'src/Foo.tsx'): string {
  const out = transformSync(code, {
    filename,
    plugins: [plugin],
    parserOpts: { plugins: ['jsx', 'typescript'] },
    configFile: false,
    babelrc: false,
  });
  return out?.code ?? '';
}

describe('reticle babel plugin', () => {
  it('stamps host elements with data-reticle-source (file:line:col)', () => {
    const out = transform('const x = <button>Hi</button>;');
    expect(out).toContain(SOURCE_ATTR);
    expect(out).toMatch(/src\/Foo\.tsx:1:\d+/);
  });

  it('emits forward slashes on every OS, so a pointer is the same string everywhere', () => {
    // `path.relative` returns the platform separator. On Windows this stamped `src\Foo.tsx:1:10`,
    // which is the headline `file:line` in a form that matches nothing else Reticle emits.
    const out = transform('const x = <span>Hi</span>;', 'src/deep/Bar.tsx');
    expect(out).toContain('src/deep/Bar.tsx:1:');
    expect(out).not.toContain('\\');
  });

  it('does not stamp components', () => {
    const out = transform('const x = <App />;');
    expect(out).not.toContain(SOURCE_ATTR);
  });

  it('is idempotent (does not double-stamp)', () => {
    const out = transform(`const x = <div ${SOURCE_ATTR}="existing">x</div>;`);
    // Built from SOURCE_ATTR, not the literal. Hardcoded, this counts occurrences of a string the
    // plugin no longer stamps the moment core renames the constant — so a legitimate rename reddens
    // it while real plugin-core drift stays unasserted, which is the alarm pointing the wrong way.
    expect((out.match(new RegExp(SOURCE_ATTR, 'g')) ?? []).length).toBe(1);
  });
});
