/**
 * Every bench harness must still be able to load what it imports.
 *
 * None of these scripts is in `bench-all`, in `test:unit`, or in any CI job, so a harness whose
 * import broke would stay broken until somebody happened to run it by hand — and several are the
 * only measurement we have for their subject (`claude-agent-loop.mjs` is the one place a real model
 * freely chooses tools; `leak-stress.mjs` is the only daemon leak check).
 *
 * This is not hypothetical. On 2026-08-23 a new probe client was added as `mcp-client.mjs`, the
 * name an existing shared module already had, and it silently replaced a 173-line
 * `McpStdioClient` with a 77-line one exporting a different symbol. Six harnesses lost their
 * import. Every gate stayed green, and the answer to "did we break anything" was "no".
 *
 * Checks the import GRAPH, not behaviour: these scripts need a live daemon and a live app, so
 * running them here would be slow and flaky. A resolvable import is the cheap half that would have
 * caught the real failure.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every relative import a harness declares, as a path on disk. */
function localImports(file) {
  const src = readFileSync(join(HERE, file), 'utf8');
  return [...src.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => resolve(HERE, m[1]));
}

const harnesses = readdirSync(HERE).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));

describe('bench harnesses import files that exist', () => {
  it('finds harnesses to check, so a rename cannot make this vacuous', () => {
    expect(harnesses.length).toBeGreaterThan(10);
  });

  it.each(harnesses)('%s', (file) => {
    for (const target of localImports(file)) {
      expect(existsSync(target), `${file} imports ${target}, which does not exist`).toBe(true);
    }
  });
});

/**
 * Every harness must also still PARSE.
 *
 * The import check catches a moved file; it does not catch a harness that stopped being valid
 * JavaScript. Neither would be noticed otherwise: of the 21 harnesses outside `bench-all`, every
 * one is referenced from documentation — they are a deliberate manual toolkit, not dead weight —
 * and a manual tool is exactly the thing nobody runs until the day they need it and it is broken.
 *
 * `--check` parses without executing, which matters: these scripts spawn daemons, drive browsers
 * and call paid APIs on import. Parsing is the most that can honestly be done in a unit gate.
 */
describe('bench harnesses are still valid JavaScript', () => {
  it.each(harnesses)('%s parses', (file) => {
    expect(() => execFileSync(process.execPath, ['--check', join(HERE, file)])).not.toThrow();
  });
});

describe('the shared MCP clients keep the names their callers use', () => {
  /** The exact symbol six harnesses import. Renaming it is a breaking change to all of them. */
  it('mcp-client.mjs still exports McpStdioClient', () => {
    expect(readFileSync(join(HERE, 'mcp-client.mjs'), 'utf8')).toContain(
      'export class McpStdioClient',
    );
  });

  it('mcp-line-client.mjs still exports connect', () => {
    expect(readFileSync(join(HERE, 'mcp-line-client.mjs'), 'utf8')).toContain(
      'export function connect',
    );
  });
});
