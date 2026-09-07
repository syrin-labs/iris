/**
 * react-scripts had no automated connect path at all.
 *
 * Measured on a real CRA app: init reported `⚠ Connect snippet → index.html`. That target cannot
 * work — CRA's `public/index.html` is a static template the bundler never processes for modules, so
 * a bare `import '@reticlehq/react'` in it resolves to nothing. The connect has to arrive through
 * `src/index.tsx`, which IS bundled.
 *
 * CRA also cannot use the token trick every other stack uses. Vite defines `__RETICLE_TOKEN__` at
 * build time and the Astro/HTML snippets read the file in Node; `src/index.tsx` is browser code
 * inside a bundler that inlines exactly one thing — environment variables prefixed `REACT_APP_`. So
 * the token travels through `.env.development.local`, which is CRA's own documented mechanism and is
 * already gitignored by CRA's template.
 */

import { describe, expect, it } from 'vitest';
import {
  craImportPatch,
  craEnvPatch,
  craDevModuleFile,
  craDevModulePath,
  CRA_DEV_MODULE_IMPORT,
  CRA_TOKEN_MISSING_NOTE,
} from './cra.js';

describe('the import into src/index.tsx', () => {
  it('goes in after the existing imports, not before them', () => {
    const source = "import React from 'react';\nimport App from './App';\n\nrender(<App />);\n";
    const patched = craImportPatch(source);
    expect(patched).not.toBeNull();
    const lines = (patched ?? '').split('\n');
    const importLine = lines.findIndex((l) => l.includes(CRA_DEV_MODULE_IMPORT));
    expect(importLine).toBeGreaterThan(lines.findIndex((l) => l.includes("from './App'")));
  });

  it('is a no-op when it is already there, so a re-run changes nothing', () => {
    const already = `import React from 'react';\n${CRA_DEV_MODULE_IMPORT}\n`;
    expect(craImportPatch(already)).toBeNull();
  });

  it('handles a file with no imports at all rather than producing something invalid', () => {
    const patched = craImportPatch('console.log("hi");\n');
    expect(patched).toContain(CRA_DEV_MODULE_IMPORT);
  });
});

describe('the token, through the one channel CRA inlines', () => {
  it('creates the env line when there is no file', () => {
    expect(craEnvPatch(null, 'tok-123')).toContain('REACT_APP_RETICLE_TOKEN=tok-123');
  });

  it('appends to an existing file without disturbing it', () => {
    const patched = craEnvPatch('REACT_APP_API=http://localhost:9000\n', 'tok-123');
    expect(patched).toContain('REACT_APP_API=http://localhost:9000');
    expect(patched).toContain('REACT_APP_RETICLE_TOKEN=tok-123');
  });

  it('is a no-op when the same token is already set', () => {
    expect(craEnvPatch('REACT_APP_RETICLE_TOKEN=tok-123\n', 'tok-123')).toBeNull();
  });

  it('REPLACES a stale token rather than appending a second line', () => {
    // Two assignments of one variable is a silent coin flip on which wins.
    const patched = craEnvPatch('REACT_APP_RETICLE_TOKEN=old\n', 'tok-123') ?? '';
    expect(patched).toContain('REACT_APP_RETICLE_TOKEN=tok-123');
    expect(patched).not.toContain('old');
    expect(patched.match(/REACT_APP_RETICLE_TOKEN/g)).toHaveLength(1);
  });

  it('writes nothing when there is no token to write', () => {
    expect(craEnvPatch(null, '')).toBeNull();
  });
});

describe('the clone that has no token', () => {
  // The token is per-machine and .env.development.local is gitignored by CRA's own template, so it
  // never survives a clone. Before this, the app connected anyway and the ONLY signal was the
  // bridge's generic "authentication failed" in a console nobody had open.
  it('names the missing variable and the one command that fixes it', () => {
    const file = craDevModuleFile(4400, 'proj');
    expect(true).toBe(file.includes('console.error'));
    // The note is split across short string concatenations so printWidth 80 passes (#684).
    // Joined, it is still the same sentence the rest of the product names.
    const arg = file.split('console.error(')[1]?.split(');')[0] ?? '';
    const text = [...arg.matchAll(/"(?:\\.|[^"\\])*"/g)]
      .map((m) => JSON.parse(m[0]) as string)
      .join('');
    expect(text).toBe(`[reticle] ${CRA_TOKEN_MISSING_NOTE}`);
    expect(CRA_TOKEN_MISSING_NOTE).toContain('REACT_APP_RETICLE_TOKEN');
    expect(CRA_TOKEN_MISSING_NOTE).toContain('.env.development.local');
    // The RUNNABLE invocation, not the bin name. This note is printed into a CRA app where nothing
    // of ours is installed, and it used to read `npx reticle init` — which resolves the npm package
    // named `reticle`, published by somebody else. Asserting the bare name would pass on exactly
    // that string.
    expect(CRA_TOKEN_MISSING_NOTE).toContain('npx @reticlehq/server init');
  });

  it('still attempts the connect, so a bridge running without a token keeps working', () => {
    expect(craDevModuleFile(4400, 'proj')).toContain('reticle.connect(');
  });
});

describe('JavaScript CRA gets a .js module (#675)', () => {
  it('picks .js when the project has no TypeScript', () => {
    expect(craDevModulePath(false)).toBe('src/reticle-dev.js');
    expect(craDevModulePath(true)).toBe('src/reticle-dev.ts');
  });

  it('omits the TypeScript empty-module marker from the JS emit', () => {
    const js = craDevModuleFile(4400, 'proj', { typescript: false });
    expect(js).toContain('reticle.connect(');
    expect(js).not.toContain('export {}');
    expect(craDevModuleFile(4400, 'proj', { typescript: true })).toContain('export {}');
  });
});
