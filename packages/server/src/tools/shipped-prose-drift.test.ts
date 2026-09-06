/**
 * A tool name that reaches a USER has to be a tool that exists.
 *
 * `e2e-surface-drift.test.ts` already guards the specs, the bench harnesses and the demo harnesses
 * against exactly this, and its own notes say why it kept having to grow: it was "written to the
 * shape of the first incident instead of the shape of the failure", and "guarding one directory
 * against a repo-wide failure mode is what let it happen twice".
 *
 * It happened a fourth time, in the one place with the widest blast radius. `NO_SESSION_CONNECTED_ERROR`
 * — the most-thrown string in the product, raised by `resolve` on every tool call while nothing is
 * connected — ended by telling the reader to call `reticle_wait_ready`, which has been retired since
 * the consolidation and answers `unknown tool`. The sentence carrying the ACTION named a tool that
 * does not exist, at the moment the reader had least idea what to do next.
 *
 * A harness that calls a dead name dies loudly. A shipped STRING that names one is worse: nothing
 * fails, and the cost is paid by whoever follows it.
 *
 * Scope: strings a user can actually receive, so a stale name in a code comment is out of scope
 * (annoying, harmless) and a name inside a redirect table is the point of the table. The guard reads
 * the declared tool surface rather than a hand-kept list, for the same reason every other check in
 * this repo does: a list that has to be told about the next merge will not be.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './tools.js';
import { ReticleTool } from './tool-names.js';
import { mergedNameRedirect } from './merged-name-redirect.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');

/**
 * The shipped user-facing prose: the notices `@reticlehq/core` hands out, and nothing else yet.
 *
 * Deliberately narrow rather than "all of packages/". A repo-wide sweep flags telemetry event codes
 * (`reticle_crawl` as an event name), CLI command names (`reticle affected` logging
 * `"event": "reticle_affected"`), and the redirect table whose whole job is naming dead tools — all
 * of which the sibling guard already had to carve exemptions for, with a note that a guard which is
 * confidently wrong is worse than one that is silent, because the fix it demands is impossible.
 *
 * This file is where the notices live, it is 100% user-facing prose, and it is where the miss
 * happened. Widening is a follow-up that needs the exemption list built first.
 */
const PROSE_FILES = [join(REPO, 'packages', 'core', 'src', 'notices.ts')];

/** Every `reticle_*` token inside a string literal — not comments, which nobody receives. */
const STRING_LITERAL =
  /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
const TOOL_TOKEN = /\breticle_[a-z0-9_]+\b/g;
const COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/** Only a name that WAS a tool is evidence of drift — the sibling guard's rule, for its reasons. */
const DECLARED_TOOLS = new Set<string>(Object.values(ReticleTool));

/** Callable, just not advertised under the default profile, so naming them in prose is correct. */
const PROFILE_GATED = new Set<string>([ReticleTool.RUN, ReticleTool.TOOLS]);

function toolNamesInStrings(source: string): string[] {
  const found = new Set<string>();
  // Comments first: a doc comment EXPLAINING that a name is dead is the opposite of shipping it,
  // and this note is itself the case — the paragraph above names `reticle_wait_ready` on purpose.
  // (Backticked prose inside a block comment otherwise reads as a template literal.)
  for (const literal of source.replace(COMMENT, '').matchAll(STRING_LITERAL)) {
    const text = literal[1] ?? literal[2] ?? literal[3] ?? '';
    for (const token of text.matchAll(TOOL_TOKEN)) found.add(token[0]);
  }
  return [...found];
}

describe('user-facing prose names only tools that exist', () => {
  const advertised = new Set(TOOLS.map((t) => t.name));

  it('finds prose to check (a passing test over zero files proves nothing)', () => {
    for (const file of PROSE_FILES) expect(statSync(file).isFile()).toBe(true);
    const named = PROSE_FILES.flatMap((f) => toolNamesInStrings(readFileSync(f, 'utf8')));
    expect(named.length).toBeGreaterThan(0);
  });

  for (const file of PROSE_FILES) {
    it(`${file.slice(REPO.length + 1)} names only live tools`, () => {
      const named = toolNamesInStrings(readFileSync(file, 'utf8'));
      const dead = named.filter(
        (name) => DECLARED_TOOLS.has(name) && !advertised.has(name) && !PROFILE_GATED.has(name),
      );
      expect(
        dead,
        `${file} tells a user to call ${dead.join(', ')}, which ${1 === dead.length ? 'is' : 'are'} ` +
          `no longer on the surface. ${dead
            .map((name) => {
              const moved = mergedNameRedirect(name);
              return moved === undefined
                ? `${name}: no recorded replacement`
                : `${name} -> ${moved.tool}${moved.action === undefined ? '' : ` { action: "${moved.action}" }`}`;
            })
            .join('; ')}`,
      ).toEqual([]);
    });
  }
});
