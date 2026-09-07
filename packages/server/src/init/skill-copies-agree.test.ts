import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Three copies of the skill file ship, and only one of them cannot drift.
 *
 *   SKILL.md                  the canonical one, and the paste-URL agents fetch from raw.githubusercontent
 *   packages/server/SKILL.md  GENERATED — scripts/pack-docs.mjs copies the root in at prepack, gitignored
 *   plugin/SKILL.md           hand-maintained, shipped to Claude Code via .claude-plugin/marketplace.json
 *
 * The third is the problem this pins. It is a deliberate restructure — its own frontmatter, its own
 * ordering, shorter — so it cannot be generated and byte-equality would be the wrong rule. What it
 * must not do is disagree with the canonical file about the RULES, and it silently did: the root
 * gained a clarification that `init` writing a pre-approval for the `reticle` server is not the same
 * as bypassing a host's permission prompt, and the plugin copy kept the older sentence. An agent
 * loading the plugin then has strictly worse guidance about the one thing where being wrong means
 * touching a permissions file it should not.
 *
 * So: the normative sentences are shared verbatim, and the version is the one being shipped.
 */
const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** Every skill under `skills/`, as repo-relative paths — read from disk so a new one is covered. */
const allSkillFiles = (): string[] =>
  readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `skills/${e.name}/SKILL.md`)
    .filter((rel) => existsSync(join(ROOT, rel)));

/**
 * Sentences both copies must carry, verbatim.
 *
 * Deliberately only the NORMATIVE ones — what an agent must not do, and the one exception. Prose that
 * is merely explanatory is free to differ, because the plugin file is a restructure and pinning its
 * wording would make every edit a two-file chore for no safety gain.
 */
const SHARED_RULES = [
  'Your host asks the human to approve a command.',
  'That prompt belongs to the host. Never bypass or suppress it, and take a refusal as the answer.',
  '`init` writing a pre-approval rule for the `reticle` server is not that: it is a scoped, announced config change the human asked for by running the command, and it covers only Reticle',
  'No recognisable dev script in `package.json`.',
];

/**
 * Every hand-maintained copy, not just the plugin.
 *
 * Watching `plugin/SKILL.md` alone found one of three: `skills/install-and-verify/SKILL.md` carried
 * the same stale sentence and was missed, because "it is a task skill, not a copy of the root" was
 * an assumption rather than a grep. A guard that covers one of the places a rule lives will keep
 * being true while the rule rots everywhere else.
 *
 * A copy is INCLUDED here only if it already states the rule — the other eleven skills are about
 * verifying, not installing, and have no business repeating install guidance. That is what makes
 * this a drift check rather than a demand that every file say everything.
 */
const HAND_MAINTAINED = ['SKILL.md', 'plugin/SKILL.md', 'skills/install-and-verify/SKILL.md'];

describe('the skill copies agree about the rules', () => {
  it('carries every normative sentence in every hand-maintained copy', () => {
    for (const file of HAND_MAINTAINED) {
      const text = read(file);
      for (const rule of SHARED_RULES) {
        expect(text, `${file} is missing: ${rule}`).toContain(rule);
      }
    }
  });

  /**
   * The anchor sentence is what makes the list above self-maintaining: any copy that talks about the
   * host's permission prompt must carry the whole rule, so a NEW copy cannot quietly restate half of
   * it. Without this, adding a fourth file re-creates exactly the drift this test was written for.
   */
  it('finds no copy outside the list restating the rule in part', () => {
    const anchor = 'That prompt belongs to the host.';
    const strays = allSkillFiles()
      .filter((f) => !HAND_MAINTAINED.includes(f) && read(f).includes(anchor))
      .filter((f) => !SHARED_RULES.every((r) => read(f).includes(r)));
    expect(strays, `these state the rule but not all of it: ${strays.join(', ')}`).toEqual([]);
  });

  /**
   * The plugin's frontmatter version is what a host displays and what a user reports a bug against.
   * Stale, it names a release whose behaviour the file no longer describes — it said 2.10.0 while
   * 2.13.0 was shipping, three minor versions of install changes later.
   */
  it('declares the version actually being shipped, in every copy that declares one', () => {
    const shipped = (JSON.parse(read('packages/server/package.json')) as { version: string })
      .version;
    for (const file of [...HAND_MAINTAINED, ...allSkillFiles()]) {
      const declared = /^\s*version:\s*(.+)$/m.exec(read(file))?.[1]?.trim();
      // Not every copy has frontmatter — the canonical one has none at all.
      if (declared === undefined) continue;
      expect(declared, `${file} declares ${declared}, shipping ${shipped}`).toBe(shipped);
    }
  });

  /**
   * Each published channel must carry its OWN marker, or it is invisible.
   *
   * `resolveInstallSource` narrows one env var against a closed list, and install-source.ts states
   * the consequence plainly: these channels are "real ONLY where that channel's own copy of the
   * install command carries the marker… a copy that has not been updated is indistinguishable from
   * no channel at all". So a missing marker does not degrade the number, it silently moves a whole
   * distribution route into `unknown` — and `unknown` is already expected to be the largest bucket,
   * which is exactly what makes the loss unnoticeable.
   *
   * `npx_skill` shipped without one. The command in skills/install-and-verify was correct and the
   * channel still reported nothing, because correctness of the COMMAND and attribution of the
   * CHANNEL are different properties and only one of them was being checked by anybody.
   *
   * The plugin is deliberately absent: it sets the marker in the `env` of the MCP server it
   * registers (plugin/.claude-plugin/plugin.json), not in prose an agent types.
   */
  it('carries the install-source marker in every channel that ships a command', () => {
    const channels = [
      ['SKILL.md', 'skill_file'],
      ['README.md', 'readme'],
      ['skills/install-and-verify/SKILL.md', 'npx_skill'],
    ] as const;
    for (const [file, source] of channels) {
      expect(read(file), `${file} must attribute itself as ${source}`).toContain(
        `RETICLE_INSTALL_SOURCE=${source}`,
      );
    }
  });

  it('registers the plugin channel where the plugin actually declares it', () => {
    const manifest = read('plugin/.claude-plugin/plugin.json');
    expect(manifest).toContain('"RETICLE_INSTALL_SOURCE": "plugin"');
  });

  /**
   * EVERY skill that ships an install command, not the one somebody happened to open.
   *
   * `install-and-verify` was found missing its marker by inspection; `verify-unattended` was missing
   * it too and would have stayed missing, because a check written against a single file is a check
   * of that file. The list is read from disk so a skill added tomorrow is covered on the day it
   * lands rather than the day someone remembers.
   *
   * Both spellings count. Most skills carry it inline as an aside; `verify-unattended` exports it on
   * its own line, because that skill runs against a prefix allowlist and
   * `RETICLE_INSTALL_SOURCE=… npx …` no longer starts with `npx` — the marker must not cost a skill
   * the rule it tells the reader to depend on.
   */
  it('attributes the channel in every skill that tells a reader to install', () => {
    const installs = allSkillFiles().filter((f) =>
      /@reticlehq\/server(@latest)? init/.test(read(f)),
    );
    expect(
      installs.length,
      'no skill ships an install command — the filter is wrong',
    ).toBeGreaterThan(0);
    const unattributed = installs.filter(
      (f) => !read(f).includes('RETICLE_INSTALL_SOURCE=npx_skill'),
    );
    expect(
      unattributed,
      `these ship an install with no channel: ${unattributed.join(', ')}`,
    ).toEqual([]);
  });
});
