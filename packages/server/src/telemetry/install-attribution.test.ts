/**
 * How a user arrived must survive past the command that installed them.
 *
 * The marker is an environment variable set by whichever channel ran the install, so it exists for
 * exactly one process and is gone by the next command. It was also read per-call, which meant it
 * rode `reticle_installed` and `init_completed` and nothing else — two of the rarest events there
 * are, and neither of them says whether the user ever got anywhere.
 *
 * The consequence was not a missing column. It was that the question the whole acquisition strategy
 * turns on, which channel actually converts, could not be asked of the data at all: every event
 * capable of answering it carried `unknown`.
 *
 * So the source is written into the project config at install time and read from there for the life
 * of the project, exactly like `projectId`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstallSource } from '@reticlehq/core';
import {
  configWithInstallSource,
  declaredInstallSource,
  projectInstallSource,
  resolveInstallSource,
  INSTALL_SOURCE_ENV,
} from './install-source.js';
import { reticleConfigContent } from '../init/snippets.js';

describe('the install source survives the install', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-install-src-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is read from the project config when the environment no longer carries it', async () => {
    await writeFile(
      join(dir, '.reticle.json'),
      reticleConfigContent('vite', undefined, 'p1', InstallSource.SKILL_FILE),
    );
    // An empty environment is the NORMAL case: every command after the install runs without it.
    expect(projectInstallSource(dir, {})).toBe(InstallSource.SKILL_FILE);
  });

  it('falls back to the environment when the project has no record', () => {
    expect(projectInstallSource(dir, { [INSTALL_SOURCE_ENV]: InstallSource.NPX_SKILL })).toBe(
      InstallSource.NPX_SKILL,
    );
    expect(projectInstallSource(dir, {})).toBe(InstallSource.UNKNOWN);
  });

  it('narrows a hand-edited config against the closed list, never echoing it', async () => {
    // The config is user data. Echoing it would put an arbitrary string on the wire, which is the
    // one rule this whole contract is built on.
    await writeFile(
      join(dir, '.reticle.json'),
      JSON.stringify({ installSource: '/Users/me/repo' }),
    );
    expect(projectInstallSource(dir, {})).toBe(InstallSource.UNKNOWN);
  });

  it('does not record `unknown`, because that is not the same as a config written before this', () => {
    // `resolveInstallSource` answers `unknown` so an event always carries a value. A config wants
    // the opposite: absent means "nobody knew", and writing `unknown` erases the difference.
    expect(resolveInstallSource({})).toBe(InstallSource.UNKNOWN);
    expect(declaredInstallSource({})).toBeUndefined();
    expect(declaredInstallSource({ [INSTALL_SOURCE_ENV]: InstallSource.UNKNOWN })).toBeUndefined();
    expect(reticleConfigContent('vite', undefined, 'p1', undefined)).not.toContain('installSource');
  });

  it('accepts the spellings a marker actually travels in', () => {
    // It rides shell snippets and copy-paste, so case and whitespace are not signal.
    expect(projectInstallSource(dir, { [INSTALL_SOURCE_ENV]: '  Skill_File  ' })).toBe(
      InstallSource.SKILL_FILE,
    );
  });
});

/**
 * The half the config write could not reach: everyone who was already here.
 *
 * `installSource` is only written when `.reticle.json` is CREATED, and `init` reports that file as
 * `already exists` on every re-run. So a user who arrived before the marker shipped — or who ran
 * `init` once with no marker and again through a marked channel — kept an attribution of `unknown`
 * forever, and re-running through the channel that actually brought them could not fix it. That is
 * most of the population the field exists to describe.
 */
describe('a config written before the marker existed can still learn where it came from', () => {
  it('adds the declared source to a config that has none', () => {
    const backfilled = configWithInstallSource(
      JSON.stringify({ framework: 'vite', projectId: 'p1' }),
      InstallSource.SKILL_FILE,
    );
    expect(backfilled).not.toBeUndefined();
    expect(JSON.parse(backfilled ?? '{}')).toMatchObject({
      framework: 'vite',
      projectId: 'p1',
      installSource: InstallSource.SKILL_FILE,
    });
  });

  it('leaves a config that already records one alone, so a re-run cannot re-attribute a user', () => {
    // The FIRST channel is the one that brought them in. A later `init` through a different route
    // would otherwise overwrite the acquisition it is not responsible for.
    expect(
      configWithInstallSource(
        JSON.stringify({ installSource: InstallSource.DOCS_SITE }),
        InstallSource.SKILL_FILE,
      ),
    ).toBeUndefined();
  });

  it('does nothing when nothing is declared, and nothing to a config it cannot parse', () => {
    expect(
      configWithInstallSource(JSON.stringify({ framework: 'vite' }), undefined),
    ).toBeUndefined();
    expect(configWithInstallSource('{not json', InstallSource.SKILL_FILE)).toBeUndefined();
  });
});
