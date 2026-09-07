/**
 * Config discovery read exactly one directory chain, and editors do not start us where we expect.
 *
 * An MCP server is launched from wherever the client likes — in one popular editor that is the
 * user's home directory. The project config then sits at `<repo>/apps/web/.reticle.json`, the
 * up-walk from home never reaches it, and Reticle reports the project unwired: the reader is sent
 * to run an install they have already run, on an app that is working.
 *
 * Two fixes, and the second matters as much as the first:
 *   1. look where the config actually lives — a repo root, and the conventional workspace
 *      directories the manifest itself declares
 *   2. when nothing is found, say WHERE WE LOOKED. "There is no `.reticle.json`" with no locations
 *      attached is a claim the reader cannot check, and it was wrong often enough to matter.
 *
 * And when several are found, NAME them rather than silently adopting one — picking a config is
 * picking a project, and picking the wrong project produces confident verdicts about code the agent
 * never touched.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverProjectConfigs } from './config-discovery.js';

let root = '';

function write(relative: string, contents: string): string {
  const path = join(root, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reticle-discovery-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('discoverProjectConfigs', () => {
  it('finds the config in the directory it is handed', () => {
    const path = write('.reticle.json', '{"projectId":"here"}');
    expect(discoverProjectConfigs(root).found.map((f) => f.path)).toEqual([path]);
  });

  it('finds a workspace app config from a repo root that has none of its own', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    const path = write('apps/web/.reticle.json', '{"projectId":"web"}');
    expect(discoverProjectConfigs(root).found.map((f) => f.path)).toContain(path);
  });

  it('finds a config under packages/ too', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    const path = write('packages/dashboard/.reticle.json', '{"projectId":"dash"}');
    expect(discoverProjectConfigs(root).found.map((f) => f.path)).toContain(path);
  });

  it('honours the directories the workspace manifest itself declares', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    write('package.json', JSON.stringify({ workspaces: ['frontends/*'] }));
    const path = write('frontends/admin/.reticle.json', '{"projectId":"admin"}');
    expect(discoverProjectConfigs(root).found.map((f) => f.path)).toContain(path);
  });

  it('finds a config when a declared workspace is the app itself', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    write('package.json', JSON.stringify({ workspaces: ['web'] }));
    const path = write('web/.reticle.json', '{"projectId":"web"}');
    expect(discoverProjectConfigs(root).found.map((f) => f.path)).toContain(path);
  });

  it('reads the pnpm workspace manifest as well', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    write('pnpm-workspace.yaml', 'packages:\n  - "sites/*"\n');
    const path = write('sites/store/.reticle.json', '{"projectId":"store"}');
    expect(discoverProjectConfigs(root).found.map((f) => f.path)).toContain(path);
  });

  it('names every config it found rather than silently choosing one', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    write('apps/web/.reticle.json', '{"projectId":"web"}');
    write('apps/admin/.reticle.json', '{"projectId":"admin"}');
    expect(discoverProjectConfigs(root).found).toHaveLength(2);
  });

  it('reports where it looked when it found nothing', () => {
    const report = discoverProjectConfigs(root);
    expect(report.found).toHaveLength(0);
    expect(report.searched.length).toBeGreaterThan(0);
    expect(report.searched).toContain(root);
  });

  it('does not report workspace directories that do not exist', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    const report = discoverProjectConfigs(root);
    expect(report.searched).not.toContain(join(root, 'apps'));
    expect(report.searched).not.toContain(join(root, 'packages'));
  });

  it('walks up to the repo root from a directory inside it', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    const path = write('.reticle.json', '{"projectId":"root"}');
    const deep = join(root, 'src', 'components');
    mkdirSync(deep, { recursive: true });
    expect(discoverProjectConfigs(deep).found.map((f) => f.path)).toContain(path);
  });

  it('never throws on an unreadable or malformed tree', () => {
    write('apps/web/.reticle.json', 'not json');
    expect(() => discoverProjectConfigs(root)).not.toThrow();
  });

  it('carries the projectId of each config, so a caller can name the projects', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    write('apps/web/.reticle.json', '{"projectId":"web-1"}');
    expect(discoverProjectConfigs(root).found[0]?.projectId).toBe('web-1');
  });
});
