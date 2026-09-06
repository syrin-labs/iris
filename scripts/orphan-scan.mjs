// Shared scanner behind every package's `orphan-modules.test.ts`.
//
// A module that nothing imports must be *declared* unwired, not discovered later as dead code. The
// guard does not ban orphans; it requires every deliberate one to be named with the reason it stays,
// and fails when a production module becomes unreachable without that decision.
//
// It lives here rather than in a package because three copies of it had already been written by hand
// and were identical apart from their allowlists (#548). A fourth would have been copied with the
// same bug: entry points were the literal set `{'index.ts'}`, so any package publishing a subpath
// export — `@reticlehq/react/store` is one, and `docs/usage.md` tells users to import it — would
// report its own published entry as an orphan. Entry points are derived from the package's
// `exports` map instead, so the guard and the manifest cannot disagree.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Extensions the scanner treats as source. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

/** Suffixes that are test scaffolding rather than production modules. */
const TEST_SUFFIXES = ['.test.ts', '.test.tsx', '.test-harness.ts', '.live.test.ts'];

/**
 * Every build output named anywhere in a package manifest, flattened.
 *
 * `exports` nests by condition (`types`, `import`, `require`, `default`) to arbitrary depth, and a
 * package may also name entries through `main`, `module`, `types` or `bin`. All of them are entry
 * points as far as reachability is concerned: something outside the package imports them.
 */
function manifestTargets(manifest) {
  const targets = [];
  const visit = (value) => {
    if (typeof value === 'string') {
      targets.push(value);
      return;
    }
    if (value && typeof value === 'object')
      for (const nested of Object.values(value)) visit(nested);
  };
  visit(manifest.exports);
  visit(manifest.main);
  visit(manifest.module);
  visit(manifest.types);
  visit(manifest.bin);
  return targets;
}

/**
 * Source files a manifest target could have been built from.
 *
 * `./dist/store.js` maps to `store.ts` and `store.tsx`; the `.d.ts` spellings map to the same place.
 * Both candidates are returned because the manifest names the output, not the input, and asking the
 * build which source produced which file would make a unit test depend on a build having run.
 */
function sourceCandidates(target) {
  const raw = String(target);
  // Only build outputs map back to source. A manifest also points at things that never had any -
  // `"./package.json": "./package.json"`, JSON schema assets - and turning those into `.ts`
  // candidates would silently excuse a real source file that happened to share the name.
  if (!/\.(d\.(ts|cts|mts)|js|cjs|mjs)$/.test(raw)) return [];
  const withoutDist = raw
    .replace(/^\.\//, '')
    .replace(/^dist\//, '')
    .replace(/\.d\.(ts|cts|mts)$/, '')
    .replace(/\.(js|cjs|mjs)$/, '');
  if (!withoutDist || withoutDist.includes('..')) return [];
  return SOURCE_EXTENSIONS.map((extension) => `${withoutDist}${extension}`);
}

/** Entry points for a package: every source file its manifest publishes. */
export function entryPoints(packageDir) {
  const manifestPath = join(packageDir, 'package.json');
  if (!existsSync(manifestPath)) return new Set();
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entries = new Set();
  for (const target of manifestTargets(manifest)) {
    for (const candidate of sourceCandidates(target)) entries.add(candidate);
  }
  return entries;
}

/** Production source files under `srcDir`, repo-relative to it, POSIX-separated. */
export function sourceFiles(srcDir) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) continue;
      if (TEST_SUFFIXES.some((suffix) => entry.endsWith(suffix))) continue;
      found.push(relative(srcDir, full).split(sep).join('/'));
    }
  };
  walk(srcDir);
  return found.sort();
}

/** True when some other production module names `file`'s built specifier. */
function isImported(file, corpus) {
  const base = file.replace(/\.tsx?$/, '');
  const specifier = `${base.split('/').pop() ?? base}.js`;
  return corpus.some(
    (candidate) =>
      candidate.path !== file &&
      !TEST_SUFFIXES.some((suffix) => candidate.path.endsWith(suffix)) &&
      candidate.text.includes(specifier),
  );
}

/**
 * Scan one package.
 *
 * @param {string} packageDir Absolute path to the package root (the one holding `package.json`).
 * @param {Record<string, string>} declaredUnwired Module path -> the reason it is allowed to stay.
 * @returns {{orphans: string[], stale: string[], entries: string[]}} `orphans` are undeclared and
 *   unreachable; `stale` are declared but now imported, so the declaration is a lie. Both are
 *   reported from one scan, because stopping at the first failure hides half the work.
 */
export function scanPackage(packageDir, declaredUnwired = {}) {
  const srcDir = join(packageDir, 'src');
  const files = sourceFiles(srcDir);
  const corpus = files.map((file) => ({
    path: file,
    text: readFileSync(join(srcDir, file), 'utf8'),
  }));
  const entries = entryPoints(packageDir);

  const orphans = files.filter(
    (file) =>
      !entries.has(file) && !isImported(file, corpus) && declaredUnwired[file] === undefined,
  );
  const stale = Object.keys(declaredUnwired)
    .filter((declared) => isImported(declared, corpus) || entries.has(declared))
    .sort();

  return { orphans, stale, entries: [...entries].sort() };
}
