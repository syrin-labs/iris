import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as constants from './source-constants.js';
import { renderSourceConstants } from '../scripts/gen-source-constants.mjs';

describe('source constants generation', () => {
  it('renders every exported constant into the CommonJS view', () => {
    const rendered = renderSourceConstants(constants);
    for (const [name, value] of Object.entries(constants)) {
      expect(rendered, `${name} must reach the CJS side`).toContain(name);
      expect(rendered, `${name}'s value must reach the CJS side`).toContain(JSON.stringify(value));
    }
  });

  it('renders a module a CommonJS build plugin can actually require', () => {
    const rendered = renderSourceConstants({ EXAMPLE: 'value' });
    expect(rendered).toContain("'use strict'");
    expect(rendered).toContain('exports.EXAMPLE');
    expect(rendered).toContain('Object.freeze(exports)');
  });

  it('marks the output as generated so nobody hand-edits it', () => {
    expect(renderSourceConstants(constants)).toMatch(/GENERATED/);
  });

  it('has a built CJS view matching the current source', () => {
    const dist = join(process.cwd(), 'dist');
    if (!existsSync(dist)) return;
    const built = join(dist, 'source-constants.cjs');
    expect(
      existsSync(built),
      'dist exists but the generated CJS source-constants does not — the generator did not run. ' +
        '@reticlehq/babel-plugin requires this file; without it source mapping is broken.',
    ).toBe(true);
    expect(readFileSync(built, 'utf8')).toBe(renderSourceConstants(constants));
  });
});
