import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DESKTOP_CONTRACT } from './desktop-contract.js';
import { renderDesktopContract } from '../scripts/gen-desktop-contract.mjs';

/**
 * The desktop contract has to hold across module systems that cannot import each other: a CommonJS
 * Electron preload, the ESM renderer SDK, and the Node daemon. It used to hold because six files
 * hand-copied the same strings, and a rename in any one broke desktop silently.
 *
 * Now the CommonJS view is GENERATED from the TypeScript source, so drift is not something to police
 * — it is impossible by construction. What is still worth asserting is that the generator stays
 * honest and that the committed build output is current.
 */
describe('desktop contract generation', () => {
  it('renders every exported constant into the CommonJS view', () => {
    const rendered = renderDesktopContract(DESKTOP_CONTRACT);
    for (const [name, value] of Object.entries(DESKTOP_CONTRACT)) {
      expect(rendered, `${name} must reach the CJS side`).toContain(name);
      expect(rendered, `${name}'s value must reach the CJS side`).toContain(JSON.stringify(value));
    }
  });

  it('renders a module a CommonJS preload can actually require', () => {
    const rendered = renderDesktopContract({ EXAMPLE: 'value' });
    expect(rendered).toContain("'use strict'");
    expect(rendered).toContain('exports.EXAMPLE');
    // Frozen so a misbehaving app cannot mutate the contract out from under the SDK.
    expect(rendered).toContain('Object.freeze(exports)');
  });

  it('marks the output as generated so nobody hand-edits it', () => {
    expect(renderDesktopContract(DESKTOP_CONTRACT)).toMatch(/GENERATED/);
  });

  /**
   * Catches the two failures the generator cannot prevent: a constant changed in source and the
   * package published without rebuilding, and the generator not running at all.
   *
   * The skip is keyed on `dist/` rather than on the CJS file itself, and that distinction is the
   * whole test. Skipping when the OUTPUT is absent cannot tell "nobody has built yet" from "the
   * build ran and silently produced nothing" — and the second is exactly what happened: the
   * generator's CLI-entry guard compared `import.meta.url` against a hand-concatenated
   * `file://${process.argv[1]}`, which never matches on Windows, so `pnpm build` reported success
   * while writing no CJS view at all. Every Electron app built there died at boot on a missing
   * module, and this test passed the whole time.
   */
  it('has a built CJS view matching the current source', () => {
    const dist = join(process.cwd(), 'dist');
    if (!existsSync(dist)) return; // genuinely un-built tree — there is nothing to compare yet
    const built = join(dist, 'desktop-contract.cjs');
    expect(
      existsSync(built),
      'dist exists but the generated CJS contract does not — the generator did not run. An ' +
        'Electron main process requires this file at boot; without it desktop support is dead.',
    ).toBe(true);
    expect(readFileSync(built, 'utf8')).toBe(renderDesktopContract(DESKTOP_CONTRACT));
  });
});

/**
 * The Rust side of the contract, which no generator can reach.
 *
 * `reticle-tauri` writes the capture file and the daemon decides whether to read it, and the two
 * agree only on a shared filename prefix. They are in different languages and different build
 * systems, so nothing but this test stands between a rename here and screenshots that go on being
 * written while the daemon silently refuses every one of them.
 */
describe('desktop contract — the Rust capture helper', () => {
  const CRATE = join(process.cwd(), '..', 'tauri', 'src', 'capture.rs');

  it('spells the capture prefix exactly as the daemon requires', () => {
    if (!existsSync(CRATE)) return; // the crate is not part of the TypeScript build
    const source = readFileSync(CRATE, 'utf8');
    expect(source).toContain(`{CAPTURE_FILE_PREFIX}`);
  });

  it('defines that prefix as the value the daemon checks for', () => {
    const lib = join(process.cwd(), '..', 'tauri', 'src', 'lib.rs');
    if (!existsSync(lib)) return;
    expect(readFileSync(lib, 'utf8')).toContain(
      `const CAPTURE_FILE_PREFIX: &str = "${DESKTOP_CONTRACT.RETICLE_CAPTURE_FILE_PREFIX}";`,
    );
  });

  it('spells the full-page refusal exactly as the daemon reads it', () => {
    const lib = join(process.cwd(), '..', 'tauri', 'src', 'lib.rs');
    if (!existsSync(lib)) return;
    expect(readFileSync(lib, 'utf8')).toContain(
      `pub const FULL_PAGE_UNSUPPORTED: &str = "${DESKTOP_CONTRACT.RETICLE_FULL_PAGE_UNSUPPORTED}";`,
    );
  });

  it('registers the command name the SDK invokes', () => {
    const capture = existsSync(CRATE) ? readFileSync(CRATE, 'utf8') : '';
    if ('' === capture) return;
    expect(capture).toContain(`pub async fn ${DESKTOP_CONTRACT.RETICLE_TAURI_CAPTURE_COMMAND}(`);
  });

  /**
   * `hide()` after load used to be the headless path on every OS. A hidden macOS WKWebView has
   * been observed to go quiet after a pause; the macOS arm parks off-screen instead of asserting
   * that `hide()` is dead on every machine.
   */
  it('parks the macOS headless window off-screen rather than calling hide()', () => {
    const lib = join(process.cwd(), '..', 'tauri', 'src', 'lib.rs');
    if (!existsSync(lib)) return;
    const source = readFileSync(lib, 'utf8');
    expect(source).toContain('OFFSCREEN_PX');
    const fn = source.split('pub fn on_page_load')[1];
    expect(fn, 'on_page_load missing from lib.rs').toBeDefined();
    const macosArm = (fn ?? '').split('target_os = "macos"')[1];
    expect(macosArm, 'macOS arm missing from on_page_load').toBeDefined();
    const arm = macosArm ?? '';
    const untilNextCfg = arm.split('#[cfg')[0] ?? arm;
    expect(untilNextCfg).toContain('set_position');
    expect(untilNextCfg).not.toMatch(/\.hide\(\)/);
  });
});
