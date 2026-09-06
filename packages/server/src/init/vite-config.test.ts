import { describe, expect, it } from 'vitest';
import { patchViteConfig, VitePatchKind, VITE_IMPORT } from './vite-config.js';

const BASIC = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`;

describe('patchViteConfig', () => {
  it('adds the import and the reticle plugin FIRST in the plugins array', () => {
    const r = patchViteConfig(BASIC);
    expect(r.kind).toBe(VitePatchKind.APPLY);
    if (r.kind !== VitePatchKind.APPLY) return;
    expect(r.code).toContain(VITE_IMPORT);
    // Order is the invariant, not the argument list: the framework plugin must not transform an entry
    // before this one has stamped it. `[^)]*` so options in the call cannot silently relax that.
    expect(r.code).toMatch(/plugins:\s*\[reticle\([^)]*\),\s*react\(\)\]/);
  });

  it('places the import after the last existing import', () => {
    const r = patchViteConfig(BASIC);
    if (r.kind !== VitePatchKind.APPLY) throw new Error('expected apply');
    const importIdx = r.code.indexOf(VITE_IMPORT);
    const exportIdx = r.code.indexOf('export default');
    expect(importIdx).toBeGreaterThan(0);
    expect(importIdx).toBeLessThan(exportIdx);
  });

  it('is idempotent — already-patched configs are left alone', () => {
    const r = patchViteConfig(BASIC);
    if (r.kind !== VitePatchKind.APPLY) throw new Error('expected apply');
    expect(patchViteConfig(r.code).kind).toBe(VitePatchKind.ALREADY);
  });

  it('bakes a non-default port into the reticle() call', () => {
    const r = patchViteConfig(BASIC, 5000);
    if (r.kind !== VitePatchKind.APPLY) throw new Error('expected apply');
    expect(r.code).toContain('port: 5000');
  });

  it('omits the port argument when the default port is in use', () => {
    const r = patchViteConfig(BASIC);
    if (r.kind !== VitePatchKind.APPLY) throw new Error('expected apply');
    // Spaced to match the line it lands on: single-line arrays keep the space, multi-line ones
    // would otherwise be left with trailing whitespace for a formatter to rewrite.
    expect(r.code).toContain('reticle()');
    expect(r.code).not.toContain('port:');
  });

  /**
   * A config with no `plugins` key is a config we can still finish: the object literal is right
   * there and adding the key is the same edit as extending the array. Bailing here sent a user who
   * had only ever set `server.port` to a manual paste for a change we could make correctly.
   */
  it('adds a plugins array when defineConfig has none', () => {
    const r = patchViteConfig(`import { defineConfig } from 'vite';
export default defineConfig({ server: { port: 3000 } });
`);
    expect(r.kind).toBe(VitePatchKind.APPLY);
    if (r.kind !== VitePatchKind.APPLY) return;
    expect(r.code).toContain(VITE_IMPORT);
    expect(r.code).toContain('plugins: [reticle(');
    // The existing config must survive intact.
    expect(r.code).toContain('server: { port: 3000 }');
  });

  it('adds a plugins array to a multi-line defineConfig', () => {
    const r = patchViteConfig(`import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
  },
});
`);
    expect(r.kind).toBe(VitePatchKind.APPLY);
    if (r.kind !== VitePatchKind.APPLY) return;
    expect(r.code).toContain('plugins: [reticle(');
    expect(r.code).toContain('port: 3000');
  });

  it('adds a plugins array to a bare object export', () => {
    const r = patchViteConfig('export default {};\n');
    expect(r.kind).toBe(VitePatchKind.APPLY);
    if (r.kind !== VitePatchKind.APPLY) return;
    expect(r.code).toContain('plugins: [reticle(');
  });

  it('still bails to manual when there is no config object to extend', () => {
    const r = patchViteConfig(`import { defineConfig } from 'vite';
export default defineConfig(buildOptions());
`);
    expect(r.kind).toBe(VitePatchKind.MANUAL);
  });

  it('prepends the import when the config has none', () => {
    const r = patchViteConfig('export default { plugins: [] };\n');
    if (r.kind !== VitePatchKind.APPLY) throw new Error('expected apply');
    expect(r.code.startsWith(VITE_IMPORT)).toBe(true);
  });
});

/**
 * The patch lands in somebody's source file, so it has to look like something a person wrote. A
 * trailing space before a newline is exactly what a formatter rewrites, turning a one-line install
 * into a diff against the user's own style.
 */
describe('patchViteConfig — the edit reads like the file it lands in', () => {
  it('leaves no trailing whitespace on the plugins line', () => {
    const src = `import { defineConfig } from 'vite';\nexport default defineConfig({\n  plugins: [\n    react(),\n  ],\n});\n`;
    const r = patchViteConfig(src);
    if (r.kind !== VitePatchKind.APPLY) throw new Error('expected apply');
    for (const line of r.code.split('\n')) {
      expect(line, JSON.stringify(line)).toBe(line.replace(/\s+$/, ''));
    }
  });
});

/**
 * The plugin call `init` writes carries body capture, because without it the one bug class Reticle
 * exists to catch is unreachable on a default install.
 *
 * A 200 describes the transport, not the result. A write whose response body was never recorded
 * grades `unknown / outcome_unread` — so a refund that posts rupees into a paise field, answers 200,
 * and renders the amount the user typed rather than the amount the server returned, cannot be caught
 * by the tool built to catch exactly that. Measured on a real app: an agent asked to verify a refund
 * had to edit the app's own vite.config mid-task to see the payload, then tell its human to revert
 * the edit.
 *
 * Written into the USER'S config rather than flipped as an SDK default, and that is the whole point.
 * A body is the one part of a request that routinely carries personal data, and while the credential
 * classes are redacted (tokens, cookies, card numbers, cvv, ssn) an address or an email is not. So
 * the choice belongs where the user can see it, keep it, or delete it — not in a default that
 * changes what an already-installed SDK records the next time it updates.
 */
describe('the plugin call init writes', () => {
  // Body capture is OPT-IN as of #705. A healthcare workspace proxying authenticated API traffic
  // through Vite ran `init` and found login tokens and patient payloads in the daemon's buffer on
  // the first drive. The capability is worth having — without a body a 2xx write grades
  // `outcome_unread` — but writing it into somebody's config is a decision about THEIR data, made
  // by an agent running unattended, and the person who knows the data is sensitive is not there.
  it('does not enable body capture unless it was asked for', () => {
    const r = patchViteConfig('export default defineConfig({ plugins: [react()] });', 5000);
    expect(r.kind).toBe(VitePatchKind.APPLY);
    if (r.kind !== VitePatchKind.APPLY) return;
    expect(r.code).not.toContain('captureNetworkBodies');
  });

  it('writes it when the caller asked for it', () => {
    const r = patchViteConfig('export default defineConfig({ plugins: [react()] });', 5000, true);
    if (r.kind !== VitePatchKind.APPLY) return;
    expect(r.code).toContain('captureNetworkBodies: true');
  });

  it('still carries the port alongside it', () => {
    const r = patchViteConfig('export default defineConfig({ plugins: [react()] });', 5000);
    if (r.kind !== VitePatchKind.APPLY) return;
    expect(r.code).toContain('port: 5000');
  });

  // The default port needs no argument, so with capture off there is nothing to put in the braces.
  // A bare `reticle()` is the right call there — `reticle({  })` is a formatter's problem and reads
  // as though something was meant to be in it.
  it('emits a bare reticle() when there is nothing to configure', () => {
    const r = patchViteConfig('export default defineConfig({ plugins: [react()] });');
    if (r.kind !== VitePatchKind.APPLY) return;
    expect(r.code).toContain('reticle()');
    expect(r.code).not.toContain('captureNetworkBodies');
  });

  it('can still be asked for when there is no port to pass', () => {
    const r = patchViteConfig(
      'export default defineConfig({ plugins: [react()] });',
      undefined,
      true,
    );
    if (r.kind !== VitePatchKind.APPLY) return;
    expect(r.code).toContain('captureNetworkBodies: true');
  });
});
