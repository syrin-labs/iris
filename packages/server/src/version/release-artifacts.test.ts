import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What the release workflows will try to ship, checked before they try.
 *
 * Both halves of a release publish went red on the same tag, and neither was visible to any gate
 * that existed. The
 * npm job walks the workspace and publishes everything not marked `private`, so a fixture app that
 * arrived without the flag was offered to the registry under a name we do not own — a 403 AFTER all
 * ten real packages had already published, which is the worst place to fail: the release is out, the
 * workflow is red, and the two facts disagree.
 *
 * `cargo publish` refuses a dirty working tree, and bumping `Cargo.toml` without regenerating
 * `Cargo.lock` guarantees one: the first cargo command rewrites the lock, and the crate never ships.
 *
 * Both are one-line facts about files in this repo. Neither needs a release to discover.
 */
const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

describe('nothing under apps/ can reach a registry', () => {
  it('every app is private', () => {
    const appsDir = join(REPO, 'apps');
    const leaked: string[] = [];
    for (const entry of readdirSync(appsDir)) {
      const manifest = join(appsDir, entry, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      const isPrivate =
        'object' === typeof pkg && null !== pkg && true === (pkg as { private?: unknown }).private;
      if (!isPrivate) leaked.push(entry);
    }
    // `pnpm -r publish` skips private packages and offers everything else to npm. An app that is not
    // private is a fixture published under a name nobody here owns.
    expect(leaked).toEqual([]);
  });
});

describe('the Rust crate can actually be published', () => {
  it('Cargo.lock records the version Cargo.toml declares', () => {
    const dir = join(REPO, 'packages/tauri');
    const toml = readFileSync(join(dir, 'Cargo.toml'), 'utf8');
    const lock = readFileSync(join(dir, 'Cargo.lock'), 'utf8');
    const declared = /^version = "([^"]+)"/m.exec(toml)?.[1];
    const locked = /name = "reticle-tauri"\nversion = "([^"]+)"/.exec(lock)?.[1];
    expect(declared).toBeDefined();
    // Not cosmetic: a mismatch makes the first cargo command rewrite the lock, which leaves the tree
    // dirty, which makes `cargo publish` refuse. The crate silently never ships.
    expect(locked).toBe(declared);
  });
});
