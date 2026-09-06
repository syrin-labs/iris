/**
 * Stage the docs and the skill file into `@reticlehq/server` before it is packed.
 *
 * Was four shell commands in the package's prepack — `cp ../../SKILL.md .`, `rm -rf docs`,
 * `cp -R ../../docs .`, `rm -rf docs/images docs/logo docs/favicon docs/matrix`. None of `cp`,
 * `cp -R` or `rm -rf` exists on Windows, so the publish could only ever be cut from a POSIX
 * machine. Node has had `cpSync` since 16; there is no reason for a shell here.
 *
 * The excluded directories are IMAGES, and they are excluded on size: the published tarball is what
 * every user downloads, and a logo is not something anybody reads out of node_modules.
 *
 * Source and destination are arguments so the guard in package-payload.test.ts can RUN this against
 * a fixture instead of reading it. That guard used to string-match the prepack for `docs/images`,
 * and when this moved out of the shell the match was satisfied by the sentence three lines above —
 * a green from a comment. Behaviour is the only thing worth asserting here.
 */
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.argv[2] ?? join(import.meta.dirname, '..');
const HERE = process.argv[3] ?? process.cwd();

/** Site assets: every docs image reference is an absolute site path, so none of them resolve here. */
export const PRUNED_ASSET_DIRS = ['images', 'logo', 'favicon', 'matrix'];

/** Deleting into a directory Windows still holds a handle on is the normal case, so retry. */
const GONE = { recursive: true, force: true, maxRetries: 8, retryDelay: 250 };

cpSync(join(ROOT, 'SKILL.md'), join(HERE, 'SKILL.md'));

rmSync(join(HERE, 'docs'), GONE);
cpSync(join(ROOT, 'docs'), join(HERE, 'docs'), { recursive: true });
for (const dir of PRUNED_ASSET_DIRS) rmSync(join(HERE, 'docs', dir), GONE);

console.error('pack-docs: staged SKILL.md and docs (images excluded)');
