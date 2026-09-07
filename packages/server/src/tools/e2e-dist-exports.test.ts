/**
 * Named imports from server `dist` in the telemetry-events e2e spec must still be exported.
 *
 * That spec is the one that can see whether an emit actually lands (unit tests cannot: fire-and-forget
 * plus `process.exit`). It loads the built modules by name. Dropping `export` on one of those names
 * typechecks, unit-tests green, and then CI e2e dies with "X is not a function" — which is exactly
 * what happened to `reportVersionChange` when a dead-export sweep treated "no colocated .test.ts
 * importer" as "safe to unexport". Knip does not see `apps/e2e`. This gate does.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const TELEMETRY_EVENTS_SPEC = join(REPO, 'apps', 'e2e', 'specs', 'telemetry-events-test.mjs');
const SERVER_SRC = join(REPO, 'packages', 'server', 'src');
const DIST_IMPORT = /const \{([^}]+)\} = await import\(`\$\{DIST\}\/([^`]+)`\)/g;
const JS_SUFFIX = '.js';
const TS_SUFFIX = '.ts';

function isValueExport(source: string, name: string): boolean {
  const patterns = [
    new RegExp(`^export async function ${name}\\b`, 'm'),
    new RegExp(`^export function ${name}\\b`, 'm'),
    new RegExp(`^export const ${name}\\b`, 'm'),
    new RegExp(`^export class ${name}\\b`, 'm'),
    new RegExp(`^export enum ${name}\\b`, 'm'),
    new RegExp(`^export \\{[^}]*\\b${name}\\b[^}]*\\}`, 'm'),
  ];
  return patterns.some((p) => p.test(source));
}

function distImports(spec: string): readonly { names: readonly string[]; distPath: string }[] {
  const found: { names: readonly string[]; distPath: string }[] = [];
  for (const match of spec.matchAll(DIST_IMPORT)) {
    const namesRaw = match[1];
    const distPath = match[2];
    if (namesRaw === undefined || distPath === undefined) continue;
    const names = namesRaw
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    found.push({ names, distPath });
  }
  return found;
}

describe('e2e dist named imports stay exported from server source', () => {
  it('every name telemetry-events-test.mjs loads from dist is still an export', () => {
    const spec = readFileSync(TELEMETRY_EVENTS_SPEC, 'utf8');
    const imports = distImports(spec);
    expect(imports.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const { names, distPath } of imports) {
      const rel = distPath.endsWith(JS_SUFFIX) ? distPath.slice(0, -JS_SUFFIX.length) : distPath;
      const srcPath = join(SERVER_SRC, `${rel}${TS_SUFFIX}`);
      expect(existsSync(srcPath), srcPath).toBe(true);
      const source = readFileSync(srcPath, 'utf8');
      for (const name of names) {
        if (!isValueExport(source, name)) missing.push(`${rel}: ${name}`);
      }
    }
    expect(missing, missing.join(', ')).toEqual([]);
  });
});
