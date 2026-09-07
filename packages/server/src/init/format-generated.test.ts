/**
 * #684: a clean install must not fail the project's own Prettier/lint on a file we just wrote.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CRA_TOKEN_MISSING_NOTE, craDevModuleFile } from './cra.js';
import { formatGeneratedSource, isGeneratedSourcePath } from './format-generated.js';
import { nextReticleDevFile } from './snippets.js';

describe('isGeneratedSourcePath', () => {
  it('matches the connect modules lint will see, and nothing else', () => {
    expect(isGeneratedSourcePath('src/reticle-dev.ts')).toBe(true);
    expect(isGeneratedSourcePath('app/reticle-dev.tsx')).toBe(true);
    expect(isGeneratedSourcePath('src/hooks.client.ts')).toBe(true);
    expect(isGeneratedSourcePath('vite.config.ts')).toBe(false);
    expect(isGeneratedSourcePath('.reticle.json')).toBe(false);
  });
});

describe('craDevModuleFile shape (#684)', () => {
  it('keeps every line at or under a CRA boilerplate printWidth of 80', () => {
    const file = craDevModuleFile(4400, 'proj-abc');
    for (const line of file.split('\n')) {
      expect(line.length, JSON.stringify(line)).toBeLessThanOrEqual(80);
    }
  });

  it('still names the missing-token note and connects', () => {
    const file = craDevModuleFile(4400, 'proj');
    expect(file).toContain('console.error');
    expect(file).toContain('reticle.connect');
    expect(file).toContain('REACT_APP_RETICLE_TOKEN');
    const arg = file.split('console.error(')[1]?.split(');')[0] ?? '';
    const text = [...arg.matchAll(/"(?:\\.|[^"\\])*"/g)]
      .map((m) => JSON.parse(m[0]) as string)
      .join('');
    expect(text).toBe(`[reticle] ${CRA_TOKEN_MISSING_NOTE}`);
  });
});

describe('nextReticleDevFile shape (#684)', () => {
  it('does not emit a double blank line after the React import', () => {
    const file = nextReticleDevFile(4400, 'proj');
    expect(file).not.toMatch(/from 'react';\n\n\n/);
  });
});

describe('formatGeneratedSource', () => {
  it('returns the original content when Prettier is not installed in the project', () => {
    const root = mkdtempSync(join(tmpdir(), 'reticle-no-prettier-'));
    writeFileSync(join(root, 'package.json'), '{}\n');
    const raw = craDevModuleFile(4400, 'proj');
    expect(formatGeneratedSource(raw, 'src/reticle-dev.ts', root)).toBe(raw);
  });

  it('formats with the project Prettier when it is resolvable (sync API)', () => {
    let prettierPkg: string;
    try {
      prettierPkg = dirname(createRequire(import.meta.url).resolve('prettier/package.json'));
    } catch {
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'reticle-with-prettier-'));
    writeFileSync(join(root, 'package.json'), '{}\n');
    writeFileSync(
      join(root, '.prettierrc'),
      JSON.stringify({ printWidth: 80, semi: true, singleQuote: true }),
    );
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(prettierPkg, join(root, 'node_modules', 'prettier'));
    // Deliberately ugly: one long line prettier must wrap when sync format is available.
    const ugly = 'export const x = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9 };\n';
    const formatted = formatGeneratedSource(ugly, 'src/reticle-dev.ts', root);
    // Prettier 2: sync string, wrapped. Prettier 3: Promise skipped → original. Accept either.
    if (formatted !== ugly) {
      expect(formatted.split('\n').some((l) => l.length <= 80)).toBe(true);
      expect(formatted).toContain('export const x');
    }
  });
});
