/**
 * A retired env var advertised as the live knob is worse than no docs: an agent follows it, gets
 * the default surface, and concludes the product is broken.
 *
 * The code retired RETICLE_TOOL_PROFILE and still maps old values so shell profiles do not break.
 * Three published pages, a StartOptions JSDoc, and the reticle_tools catalog note kept telling
 * people to set it. Nothing in CI reads the docs site, so this is the gate.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { advertisedTools } from '../mcp/mcp.js';
import { ADVERTISE_ALL_ENV, TOOL_PROFILE_ENV, TOOL_SURFACE } from './tool-surface.js';
import { TOOLS } from './tools.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

describe('retired RETICLE_TOOL_PROFILE is not advertised as the live knob', () => {
  it('docs/packages/server.mdx does not default toolProfile to the retired env and `full`', () => {
    const text = read('docs/packages/server.mdx');
    expect(text).not.toMatch(/toolProfile[\s\S]{0,80}RETICLE_TOOL_PROFILE[\s\S]{0,40}`full`/);
    expect(text).toContain(ADVERTISE_ALL_ENV);
  });

  it('docs/tools-tools-and-run.mdx does not tell agents to change the retired env', () => {
    const text = read('docs/tools-tools-and-run.mdx');
    expect(text).not.toMatch(new RegExp(`change ${TOOL_PROFILE_ENV}`));
    expect(text).toContain(ADVERTISE_ALL_ENV);
  });

  it('StartOptions.toolProfile JSDoc does not claim the retired env is the live default', () => {
    const text = read('packages/server/src/index.ts');
    expect(text).not.toMatch(/Defaults to env RETICLE_TOOL_PROFILE, else 'full'/);
    expect(text).toContain(ADVERTISE_ALL_ENV);
  });
});

describe('verify busy-port docs match the three-option message', () => {
  it('docs/cli/verify.mdx does not claim a raw EADDRINUSE stack', () => {
    const text = read('docs/cli/verify.mdx');
    expect(text).not.toMatch(/EADDRINUSE/);
    expect(text).not.toMatch(/raw `Error:/);
    expect(text).toContain('RETICLE_PORT');
  });
});

/**
 * Counts in a nearby comment drifted from surface-sizes.test.ts once (extended 30 vs 29). If this
 * file restates a size, it must match the live surface; if it does not restate one, it must point
 * at the file that does.
 */
describe('unadvertised-help header stays in lockstep with the surface-size gate', () => {
  const header = (): string => {
    const text = read('packages/server/src/tools/unadvertised-help.ts');
    const cut = text.indexOf('import');
    return -1 === cut ? text : text.slice(0, cut);
  };

  it('points at surface-sizes.test.ts rather than becoming a second source of truth', () => {
    expect(header()).toContain('surface-sizes.test.ts');
  });

  it('any restated size matches advertisedTools / TOOLS, so a drift is a red test', () => {
    const text = header();
    const extended = /extended one (\d+)/.exec(text);
    if (null !== extended) {
      expect(Number(extended[1])).toBe(advertisedTools(TOOL_SURFACE.ALL).length);
    }
    const advertised = /advertises (\d+) of (\d+)/.exec(text);
    if (null !== advertised) {
      expect(Number(advertised[1])).toBe(advertisedTools(TOOL_SURFACE.DEFAULT).length);
      expect(Number(advertised[2])).toBe(TOOLS.length);
    }
  });
});
