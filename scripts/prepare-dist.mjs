/**
 * Prepare a package's `dist` for packing: drop the tests, then drop the source maps.
 *
 * The test half used to be `find dist -name "*.test.*" -delete`, in the prepack of all eight
 * publishable packages. On Windows `find` is `C:\Windows\System32\find.exe`, a string search with
 * no relation to the POSIX tool, so that line did not prune anything — it failed with "Access
 * denied - DIST / File not found - -NAME / File not found - -DELETE" and took the whole prepack
 * with it. Every `@reticlehq/*` package was therefore unpackable and unpublishable from a Windows
 * machine, which nothing had noticed because releases have only ever been cut from a mac. Found by
 * making the install gate run on Windows, where the first thing it does is publish to a local
 * registry. It is folded in here rather than given its own script because this already walks the
 * same tree for the same reason, one step later.
 *
 * The source-map half:
 *
 * The maps we were shipping could not work. They reference `../src/*.ts`, and the published package
 * contains only `dist`, `README.md` and `NOTICE` — no sources — and tsc emits no `sourcesContent`
 * because `inlineSources` is off. So a consumer's debugger followed the map, looked for a file that
 * is not in the tarball, and gave up. Measured on `@reticlehq/browser`: 340KB of the 947KB package,
 * 36% of what users download, for nothing. It is also what pushed the SDK past its 900KB budget.
 *
 * The two honest options were "ship the sources so the maps resolve" (+479KB, taking the package to
 * 1.44MB — 60% over budget for a dev-only SDK) or "stop shipping maps" (621KB, back under budget
 * with the headroom the budget was written for). This is the second.
 *
 * Maps are still EMITTED — `tsc -b` is untouched, so they exist in `dist` for local debugging and
 * for anything in this repo that runs against built output. Only the tarball loses them.
 *
 * The `sourceMappingURL` comments go too. Leaving them would trade dead bytes for a worse problem:
 * DevTools fetches the missing `.map` and logs a failure in the console of every app embedding a
 * tool whose entire job is to be trustworthy about what it observes.
 */
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAP_COMMENT = /\n?\/\/# sourceMappingURL=.*\.map\s*$/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--')) ?? 'dist';

// `--clean` is the other half of a prepack: `rm -rf dist` before `tsc -b --force`, so a stale file
// from a previous build cannot ride along in the tarball. Only `@reticlehq/server` needs it, and it
// lives here rather than in a script of its own because it is the same directory and the same
// reason. Windows has no `rm`, and the retries are for the same EPERM every Windows delete can hit.
if (args.includes('--clean')) {
  rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  console.error(`prepare-dist: cleaned ${target}`);
  process.exit(0);
}
let removed = 0;
let stripped = 0;

let tests = 0;

for (const file of walk(target)) {
  // Tests first, so their maps are never counted or rewritten on the way out.
  if (/\.test\./.test(file.split(/[\\/]/).pop() ?? '')) {
    rmSync(file);
    tests += 1;
    continue;
  }
  if (file.endsWith('.map')) {
    rmSync(file);
    removed += 1;
    continue;
  }
  if (!file.endsWith('.js') && !file.endsWith('.d.ts') && !file.endsWith('.cjs')) continue;
  const before = readFileSync(file, 'utf8');
  const after = before.replace(MAP_COMMENT, '\n');
  if (after !== before) {
    writeFileSync(file, after);
    stripped += 1;
  }
}

// stderr, NOT stdout. `npm pack --json` writes its report to stdout and the size gate parses it —
// one console.log here makes that JSON unparseable and takes the gate down with a syntax error
// rather than a size failure. Verified: it did exactly that the first time.
console.error(
  `prepare-dist: removed ${String(tests)} test files and ${String(removed)} maps, stripped ${String(stripped)} references`,
);
