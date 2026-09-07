import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The published skills and the Claude Code plugin are shipped artifacts nothing else checks.
 *
 * Two failures, both silent, both already shipped:
 *
 * A skill with no frontmatter is not a skill. `npx skills add reticlehq/reticle` answered "No valid
 * skills found. Skills require a SKILL.md with name and description" for as long as the only
 * SKILL.md in the repo was the paste-URL copy at root — the registry route was dead on arrival and
 * nothing said so, because no gate has an opinion about a markdown file's first ten lines.
 *
 * And `.claude-plugin` sat at 2.7.0 through the 2.8.0 release. A plugin version is what a user's
 * `/plugin` UI shows and what decides whether an update is offered, so a stale one silently pins
 * everybody who installed it. Release tooling does not know the file exists.
 *
 * Both are one-line mistakes that survive every other gate in this repo, which is the whole argument
 * for checking them here.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const SKILLS = join(REPO, 'skills');
/**
 * The Claude Code plugin lives in its OWN root, `plugin/`, and not at the repo root.
 *
 * Plugin components are namespaced by plugin name, so every skill the plugin ships shows up as
 * `/reticle:<skill>`. With the plugin rooted at the repo root it auto-discovered all twelve skills
 * under `skills/`, and typing `/reticle` answered with a twelve-item menu instead of doing anything
 * — the opposite of the one-command install the docs promise. `skills/` is the skills-CLI channel
 * and nothing else; the plugin ships exactly one skill, its root `SKILL.md`.
 */
const PLUGIN_ROOT = join(REPO, 'plugin');
/** Where each manifest actually lives now that the two roots differ. */
const MANIFEST: Record<string, string> = {
  'plugin.json': join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'),
  'marketplace.json': join(REPO, '.claude-plugin', 'marketplace.json'),
};

/**
 * The skills CLI's OWN reading of a SKILL.md's frontmatter, or null when there is none.
 *
 * This used to pull `name:` and `description:` out with a regex, and that is precisely how two
 * skills shipped uninstallable through a whole release with every gate green. A regex returns a
 * description happily; the CLI runs `parse()` from the `yaml` package over the same block, and an
 * unquoted `description: … false greens: a green suite …` is not valid YAML — the colon opens a
 * nested mapping. `YAMLParseError: Nested mappings are not allowed in compact mappings` is what the
 * CLI hits, and its failure mode is to drop the skill and carry on, so the listing is simply two
 * skills shorter and nothing says which.
 *
 * A guard that validates with a DIFFERENT parser than the tool it protects against cannot see the
 * one failure it exists for. So this uses the same regex and the same parser the CLI does; `yaml` is
 * a devDependency for exactly that reason, and writing our own would recreate the bug.
 *
 * The line-ending note that used to live here still applies: git on Windows checks text out as CRLF,
 * which once made EVERY skill read as having no frontmatter — green on macOS and Linux, red on
 * Windows only, accusing the skills rather than the parser. The CLI's regex tolerates `\r\n`, so
 * matching it exactly keeps that fixed too.
 */
function frontmatter(
  file: string,
): { name: string | undefined; description: string | undefined } | null {
  // The CLI's own expression, character for character — see parseFrontmatter in its bundle.
  const match = readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (null === match) return null;
  const block = match[1] ?? '';
  let data: unknown;
  try {
    data = parseYaml(block);
  } catch {
    // What the CLI sees: unparseable frontmatter is no frontmatter, and the skill is dropped. Null
    // rather than a throw so the caller reports WHICH skill, not merely that something failed.
    return null;
  }
  if ('object' !== typeof data || null === data) return null;
  const read = (key: string): string | undefined => {
    const value = (data as Record<string, unknown>)[key];
    return 'string' === typeof value ? value : undefined;
  };
  return { name: read('name'), description: read('description') };
}

function publishedSkills(): string[] {
  return readdirSync(SKILLS).filter((entry) => statSync(join(SKILLS, entry)).isDirectory());
}

describe('every published skill is one the registry can actually install', () => {
  it('finds skills to check', () => {
    expect(publishedSkills().length).toBeGreaterThan(0);
  });

  for (const skill of publishedSkills()) {
    it(`${skill} declares the name and description the skills CLI requires`, () => {
      const meta = frontmatter(join(SKILLS, skill, 'SKILL.md'));
      expect(
        meta,
        `skills/${skill}/SKILL.md has no YAML frontmatter — the CLI will skip it`,
      ).not.toBe(null);
      expect(meta?.name, `skills/${skill} declares no name`).toBeTruthy();
      expect(meta?.description, `skills/${skill} declares no description`).toBeTruthy();
      // The directory is the install path and the name is what a user types. Disagreeing means
      // `--skill <name>` misses a skill that is plainly there.
      expect(meta?.name, `skills/${skill} declares name "${meta?.name ?? ''}"`).toBe(skill);
    });
  }

  /**
   * A description is this channel's entire shopfront: registry search is semantic over this field,
   * and it is the only text an agent reads before deciding whether the skill fits the task. The
   * top of the leaderboard is uniformly a sentence about WHEN to use the skill, not a product name.
   */
  it('every description says when to use the skill, not just what it is', () => {
    const thin: string[] = [];
    for (const skill of publishedSkills()) {
      const description = frontmatter(join(SKILLS, skill, 'SKILL.md'))?.description ?? '';
      if (description.length < 120 || !/\buse\b/i.test(description)) thin.push(skill);
    }
    expect(
      thin,
      `these descriptions are too thin to match a search — name the situations that should trigger them:\n${thin.join('\n')}`,
    ).toEqual([]);
  });
});

/**
 * The root `SKILL.md` must NOT have frontmatter, and that is the opposite of the rule above.
 *
 * The skills CLI (`vercel-labs/skills`) documents `--full-depth` as "search all subdirectories EVEN
 * WHEN a root SKILL.md exists". So a valid root SKILL.md is not an extra skill, it is a stop sign:
 * the CLI takes the root and never descends. Measured against this repo's shape on 1.5.22 — with a
 * frontmatter-less root it reports "Found 11 skills"; add `name` and `description` to that same root
 * and it reports "Found 1 skill" and every other published skill silently disappears from
 * `npx skills add reticlehq/reticle`.
 *
 * The root file is the paste-URL artifact and cannot move without breaking the canonical URL, so the
 * only thing holding the registry route open is that it stays unparseable as a skill. The comment at
 * the top of this file teaches the opposite lesson ("a skill with no frontmatter is not a skill"),
 * which is precisely the one-line "fix" that would take the other ten skills off the registry with a
 * green suite. This test is the sign on the wire.
 */
describe('the root SKILL.md stays the paste-URL artifact, not a skill', () => {
  it('has no frontmatter, so the skills CLI descends into skills/ instead of stopping at root', () => {
    expect(
      frontmatter(join(REPO, 'SKILL.md')),
      'root SKILL.md now parses as a skill — the skills CLI will install ONLY it and drop every skill under skills/. Put the frontmatter on a copy under skills/ instead.',
    ).toBe(null);
  });
});

/** The release version out of the root `package.json`, narrowed rather than trusted. */
function releaseVersion(): string | null {
  const parsed: unknown = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  if ('object' !== typeof parsed || null === parsed || !('version' in parsed)) return null;
  return 'string' === typeof parsed.version ? parsed.version : null;
}

/**
 * A skill's reference files are shipped guidance too, and a link into them is load-bearing.
 *
 * `install-and-verify` delegates its detail to `references/*.md` and names each one, which is the
 * whole progressive-disclosure design: the always-loaded body stays short because the depth is one
 * hop away. A link that does not resolve turns that hop into a dead end, and it fails silently:
 * the skill still installs, still reads sensibly, and simply cannot answer the question it promised
 * to. The same shape as the RETICLE.md pointer, and checked for the same reason.
 */
describe('every reference a skill links to actually ships with it', () => {
  const LINK = /\]\((references\/[^)]+)\)/g;

  for (const skill of publishedSkills()) {
    const body = readFileSync(join(SKILLS, skill, 'SKILL.md'), 'utf8');
    const links = [...new Set([...body.matchAll(LINK)].map((m) => m[1]))];
    if (0 === links.length) continue;
    it(`${skill} links only to reference files that exist`, () => {
      const missing = links.filter((rel) => !existsSync(join(SKILLS, skill, rel ?? '')));
      expect(missing, `${skill} links to files that are not there: ${missing.join(', ')}`).toEqual(
        [],
      );
    });
  }

  /**
   * And the other direction: a reference nothing links to is one no agent will ever open. Cheaper to
   * catch here than to discover as a file that has been silently dead since a rewrite.
   */
  it('ships no orphaned reference file', () => {
    const orphans: string[] = [];
    for (const skill of publishedSkills()) {
      const dir = join(SKILLS, skill, 'references');
      if (!existsSync(dir)) continue;
      const body = readFileSync(join(SKILLS, skill, 'SKILL.md'), 'utf8');
      for (const file of readdirSync(dir))
        if (!body.includes(`references/${file}`)) orphans.push(`${skill}/references/${file}`);
    }
    expect(orphans, `nothing links to these:\n${orphans.join('\n')}`).toEqual([]);
  });
});

/**
 * The plugin manifests, beyond the version.
 *
 * `claude plugin validate` is the authority and it is not available in CI, so the checks here are the
 * ones that would make a submission bounce or an install resolve to nothing: the identity fields a
 * reviewer reads, the two manifests agreeing on the immutable slug, a marketplace `source` that
 * exists, and the documented common mistake of putting component directories inside `.claude-plugin/`
 * where the loader will never look for them.
 */
describe('the Claude Code plugin manifests are ones the loader can resolve', () => {
  const DIR = join(REPO, '.claude-plugin');
  const readJson = (file: string): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(readFileSync(MANIFEST[file] ?? join(DIR, file), 'utf8'));
    if ('object' !== typeof parsed || null === parsed) throw new Error(`${file} is not an object`);
    return parsed as Record<string, unknown>;
  };

  it('plugin.json carries the identity a directory listing shows', () => {
    const manifest = readJson('plugin.json');
    for (const field of ['name', 'description', 'version', 'author'])
      expect(manifest[field], `plugin.json is missing ${field}`).toBeTruthy();
  });

  it('both manifests agree on the plugin slug, which is immutable once published', () => {
    const plugin = readJson('plugin.json');
    const entries = readJson('marketplace.json')['plugins'];
    expect(Array.isArray(entries), 'marketplace.json lists no plugins').toBe(true);
    const first = Array.isArray(entries) ? (entries[0] as Record<string, unknown>) : {};
    expect(first['name'], 'the marketplace entry and plugin.json disagree on the name').toBe(
      plugin['name'],
    );
  });

  it('every marketplace entry points at a source that exists', () => {
    const entries = readJson('marketplace.json')['plugins'];
    const missing: string[] = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const source = (entry as Record<string, unknown>)['source'];
      if ('string' !== typeof source) continue;
      if (!existsSync(join(REPO, source))) missing.push(source);
    }
    expect(
      missing,
      `marketplace.json points at paths that are not there: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * The documented common mistake: only `plugin.json` belongs inside `.claude-plugin/`. Component
   * directories placed there are never loaded, and nothing reports it — the plugin simply ships with
   * no skills, agents or hooks and installs perfectly.
   */
  it('keeps component directories out of .claude-plugin/', () => {
    for (const dir of [DIR, join(PLUGIN_ROOT, '.claude-plugin')]) {
      const stray = readdirSync(dir).filter((e) => statSync(join(dir, e)).isDirectory());
      expect(stray, `${dir} must hold manifests only, found: ${stray.join(', ')}`).toEqual([]);
    }
  });

  /**
   * The whole reason `plugin/` exists as a separate root, pinned so a well-meaning tidy-up cannot
   * merge it back. A plugin with a `skills/` directory ships one `/reticle:<name>` entry per skill;
   * a plugin whose root holds a single `SKILL.md` and no `skills/` ships one command, `/reticle`.
   * The twelve skills under the repo's own `skills/` are the skills-CLI channel and must stay out of
   * the plugin's reach — they are not wrong, they are simply not what `/reticle` means.
   */
  it('ships exactly one skill, so /reticle is a command and not a menu', () => {
    expect(
      existsSync(join(PLUGIN_ROOT, 'SKILL.md')),
      'the plugin root has no SKILL.md — with no skills/ either, the plugin ships no skill at all',
    ).toBe(true);
    expect(
      existsSync(join(PLUGIN_ROOT, 'skills')),
      'plugin/skills/ exists — every entry in it becomes a separate /reticle:<name>, which is the ' +
        'menu this layout was split apart to remove. Publish extra skills under the repo-root ' +
        'skills/ for the skills CLI instead.',
    ).toBe(false);
    const meta = frontmatter(join(PLUGIN_ROOT, 'SKILL.md'));
    expect(
      meta?.name,
      'the plugin skill must be named for the plugin to be invokable as /reticle',
    ).toBe('reticle');
    expect(meta?.description, 'the plugin skill declares no description').toBeTruthy();
  });

  /**
   * A marketplace source that no longer matches where `plugin.json` sits resolves to a plugin with
   * no manifest, which installs as an empty shell rather than failing.
   */
  it('points the marketplace entry at the directory that holds plugin.json', () => {
    const entries = readJson('marketplace.json')['plugins'];
    const first = Array.isArray(entries) ? (entries[0] as Record<string, unknown>) : {};
    const source = 'string' === typeof first['source'] ? first['source'] : '';
    expect(
      existsSync(join(REPO, source, '.claude-plugin', 'plugin.json')),
      `marketplace source "${source}" has no .claude-plugin/plugin.json under it`,
    ).toBe(true);
  });
});

describe('the Claude Code plugin ships the version everything else ships', () => {
  const release = releaseVersion();

  it('reads a release version to compare against', () => {
    expect(release, 'root package.json declares no version').not.toBe(null);
  });

  for (const file of ['plugin.json', 'marketplace.json']) {
    it(`${file} is on the release version`, () => {
      const text = readFileSync(MANIFEST[file] ?? '', 'utf8');
      const versions = [...text.matchAll(/"version":\s*"([^"]+)"/g)].map((m) => m[1]);
      expect(versions.length, `${file} declares no version`).toBeGreaterThan(0);
      for (const version of versions) expect(version, `${file} is stale`).toBe(release);
    });
  }
});

/**
 * The frontmatter reader must not depend on which platform checked the file out.
 *
 * Git on Windows checks text out as CRLF, so `---\r\n` failed a `startsWith('---\n')` test and every
 * shipped skill read as having no frontmatter at all. The suite was green on macOS and Linux and red
 * on Windows only, and it accused the skills — "the CLI will skip it" — rather than the parser, so
 * the message pointed at ten innocent files.
 *
 * `.gitattributes` now pins LF in the working tree and is the real fix. This is the second lock: a
 * file can still arrive with CRLF from an editor, a patch, or a copy off a Windows share, and when
 * it does the guard must still read it rather than silently reporting the skill as unpublishable.
 *
 * Written against a temp file rather than the real skills, because the real ones are LF on this
 * machine by construction — a test over them could never have caught this, which is exactly why it
 * was not caught.
 */
describe('frontmatter is read whatever the line endings', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function skillWith(newline: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-skill-eol-'));
    dirs.push(dir);
    const file = join(dir, 'SKILL.md');
    writeFileSync(
      file,
      ['---', 'name: drive-desktop-app', 'description: does a thing', '---', '', '# Body'].join(
        newline,
      ),
    );
    return file;
  }

  it('reads CRLF frontmatter, the shape Windows checks out', () => {
    expect(frontmatter(skillWith('\r\n'))).toEqual({
      name: 'drive-desktop-app',
      description: 'does a thing',
    });
  });

  it('still reads LF frontmatter', () => {
    expect(frontmatter(skillWith('\n'))).toEqual({
      name: 'drive-desktop-app',
      description: 'does a thing',
    });
  });

  it('still returns null for a file with no frontmatter at all', () => {
    // The direction that must not soften: a skill genuinely missing its frontmatter is a real
    // finding, and normalising line endings must not turn it into a pass.
    const dir = mkdtempSync(join(tmpdir(), 'reticle-skill-eol-'));
    dirs.push(dir);
    const file = join(dir, 'SKILL.md');
    writeFileSync(file, '# Just a heading\r\n\r\nno frontmatter here\r\n');
    expect(frontmatter(file)).toBeNull();
  });
});
