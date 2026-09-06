/**
 * Types for the shared orphan scanner behind every package's `orphan-modules.test.ts`.
 *
 * The scanner is plain ESM so it needs no build step and no package boundary of its own; this file
 * is what lets each package's TypeScript test import it without an implicit `any` (#548).
 */

/** One package's reachability result. */
export interface OrphanScan {
  /** Modules with no production importer and no entry in the allowlist, sorted. */
  orphans: string[];
  /** Allowlisted modules that are now imported or published, so the declaration is stale. */
  stale: string[];
  /** Source files this package's `exports` map publishes, sorted. */
  entries: string[];
}

/** Source files a package's manifest publishes, as candidate `.ts`/`.tsx` paths. */
export function entryPoints(packageDir: string): Set<string>;

/** Production source files under `srcDir`, relative to it and POSIX-separated. */
export function sourceFiles(srcDir: string): string[];

/**
 * Scan one package for undeclared orphans and stale declarations.
 *
 * @param packageDir Absolute path to the package root (the directory holding `package.json`).
 * @param declaredUnwired Module path relative to `src/` -> the reason it is allowed to stay.
 */
export function scanPackage(
  packageDir: string,
  declaredUnwired?: Record<string, string>,
): OrphanScan;
