/**
 * Dead HUD artwork used to ship in every user's page bundle: a ~5.5KB wordmark SVG plus aliases
 * nobody imported. The live HUD uses the mark and the FAB. This file fails if the retired symbols
 * come back, or if the live ones disappear.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as brand from './presenter-brand.js';
import * as config from './presenter-config.js';
import * as controls from './presenter-controls.js';
import * as shell from './presenter-shell.js';

const DIR = dirname(fileURLToPath(import.meta.url));

describe('retired presenter artwork stays out of the page bundle', () => {
  it('exports the live mark and FAB, not the wordmark or its aliases', () => {
    expect(brand.MARK_SVG).toContain('reticle-mark');
    expect(brand.FAB_TOGGLE_HTML).toContain('data-reticle-fab');
    expect(brand).not.toHaveProperty('WORDMARK_SVG');
    expect(brand).not.toHaveProperty('BRAND_HTML');
    expect(brand).not.toHaveProperty('TOOLBAR_BRAND_HTML');
    expect(brand).not.toHaveProperty('BRAND_MINI_CLASS');
  });

  it('does not keep the wordmark SVG in source, even unexported', () => {
    const src = readFileSync(join(DIR, 'presenter-brand.ts'), 'utf8');
    expect(src).not.toContain('WORDMARK_SVG');
    expect(src).not.toContain('reticle-wordmark');
    expect(src).not.toContain('reticle-brand--toolbar');
  });

  it('drops the unused presenter aliases listed beside the artwork', () => {
    expect(config).not.toHaveProperty('DockAlign');
    expect(config).not.toHaveProperty('PRESENTER_UI_VERSION');
    expect(controls).not.toHaveProperty('PAUSED_BADGE_LABEL');
    expect(controls).not.toHaveProperty('CONTROLS_HEAD_HTML');
    expect(shell).not.toHaveProperty('isDockDragged');
  });
});
