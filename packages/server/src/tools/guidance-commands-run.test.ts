/**
 * The commands the PRODUCT tells a stuck user to run are executed against the shipped parser too.
 *
 * `docs-commands-run` already does this for every `.md` in the repo, and stops there. But the most
 * consequential instructions Reticle gives are not in the docs — they are in string constants: the
 * MCP handshake block that opens "no app has ever connected", the no-session diagnosis, the refusal
 * recoveries, the framework recipes `init` prints, the line `doctor` ends on. That text is what
 * somebody reads at the exact moment nothing is working, and it is the text nobody re-reads once it
 * is written.
 *
 * So a renamed flag or a retired subcommand there is worse than the same mistake in a doc. A doc has
 * a reader who can go and look something up; this has a reader who has already established that
 * things are broken, and hands them a command that errors. That is the moment somebody stops.
 *
 * `parseCliArgs` is the real oracle, the same one `cli.ts` calls and the same one the docs guard
 * uses: pure, no daemon, no network, and it returns an error for an unknown command or an unknown
 * argument.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from '../cli/cli-parse.js';
import { isCloudCommand } from '../cli/cloud-cli.js';
import { RETICLE_DEFAULT_PORT } from '@reticlehq/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');
const REPO = join(HERE, '..', '..', '..', '..');

/** How the product spells an invocation of its own CLI in user-facing prose. */
const INVOCATION = /npx @reticlehq\/server ([^`'"\n)]+)/g;

interface Found {
  file: string;
  line: number;
  argv: string[];
  raw: string;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    // Tests describe commands as often as they use them, and a test is not something a user reads.
    if (entry.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

function invocations(): Found[] {
  const out: Found[] = [];
  for (const file of sourceFiles(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      for (const match of line.matchAll(INVOCATION)) {
        const rest = (match[1] ?? '').trim();
        // An interpolated command is assembled at runtime from values this guard cannot know, so
        // running it here would test the placeholder rather than the command.
        if (rest.includes('${') || '' === rest) continue;
        // A USAGE TEMPLATE, not an invocation. `verify <url>` names the shape of the command for a
        // reader to fill in; running it as written is supposed to fail, and reporting that as a
        // broken instruction would make this guard argue with correct documentation. The docs guard
        // draws the same line for the same reason.
        if (
          rest
            .split(/\s+/)
            .slice(0, 4)
            .some((t) => t.startsWith('<'))
        )
          continue;
        // Trailing prose: the sentence usually continues after the command. Keep the leading tokens
        // that look like arguments and stop at the first that plainly is not.
        const argv: string[] = [];
        for (const token of rest.split(/\s+/)) {
          if (/^[a-z][a-z-]*$/.test(token) || token.startsWith('--')) argv.push(token);
          else break;
        }
        if (0 === argv.length) continue;
        out.push({ file: relative(REPO, file), line: i + 1, argv, raw: match[0] });
      }
    }
  }
  return out;
}

const found = invocations();

describe('commands the product itself tells a user to run', () => {
  /**
   * A green over zero matches would mean the regex stopped matching, not that the guidance is sound
   * — and this whole file would then be decoration. The handshake block alone guarantees one.
   */
  it('skips a usage template, which is meant to be filled in rather than run', () => {
    // Pinned because the distinction is the one judgement this guard makes, and getting it wrong in
    // either direction is bad: flagging a template argues with correct docs, and treating a real
    // command as a template stops checking it.
    expect(found.some((f) => f.raw.includes('<'))).toBe(false);
  });

  it('found invocations to check', () => {
    expect(
      found.length,
      `found: ${found.map((f) => f.argv.join(' ')).join(' | ')}`,
    ).toBeGreaterThan(0);
  });

  it('every one is accepted by the shipped parser', () => {
    const broken: string[] = [];
    for (const inv of found) {
      /*
       * Cloud subcommands dispatch BEFORE the typed parser, so the parser alone is not the oracle.
       *
       * `cli.ts` routes `login`, `link`, `sync` and the rest through `isCloudCommand` first and only
       * then reaches `parseCliArgs` — so checking the parser by itself reports a working command as
       * refused. This guard flagged `npx @reticlehq/server login`, which is the command the console's
       * own empty state hands every new customer and which runs correctly; the guidance was right
       * and the check was wrong. Mirroring the real dispatch is what keeps this file an oracle
       * rather than an argument with correct documentation.
       */
      if (isCloudCommand(inv.argv[0])) continue;
      const parsed = parseCliArgs(inv.argv, RETICLE_DEFAULT_PORT);
      if ('error' === parsed.kind) {
        broken.push(`${inv.file}:${String(inv.line)} — \`${inv.raw.trim()}\` → ${parsed.message}`);
      }
    }
    expect(
      broken,
      `guidance that hands somebody a command the CLI refuses:\n${broken.join('\n')}`,
    ).toEqual([]);
  });
});
