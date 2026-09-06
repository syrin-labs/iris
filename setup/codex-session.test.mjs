// The smallest thing that reddens if codex identification breaks. No framework: `node codex-session.test.mjs`.
//
// Every case is about the SAME failure: resuming the user into a conversation that is not theirs.
// That failure is silent by construction — `codex resume <id>` on a valid id from another project
// opens a real conversation about real work, just not this work — so nothing downstream can catch
// it, and it cannot be caught by driving either: the codex on the development machine has no
// vendor binary. This file is the only thing standing between a wrong id and a user.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexSession } from './codex-session.mjs';

let fails = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const no = (n, got) => {
  console.log(`  FAIL ${n}\n       ${String(got).slice(0, 300)}`);
  fails += 1;
};
const is = (n, got, want) =>
  got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const home = mkdtempSync(join(tmpdir(), 'reticle-codex-home-'));
const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);

/** A rollout exactly as codex writes one: session_meta on line 0, then whatever the turn produced. */
function rollout({ id, cwd, agoMs = 0, day = '31', head }) {
  const dir = join(home, 'sessions', '2026', '08', day);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-08-${day}T00-00-00-${id}.jsonl`);
  const meta = {
    timestamp: '2026-08-31T00:00:00Z',
    ordinal: 0,
    type: 'session_meta',
    payload: { session_id: id, cwd, originator: 'test' },
  };
  writeFileSync(file, `${head ?? JSON.stringify(meta)}\n{"type":"message"}\n`);
  const when = new Date(NOW - agoMs);
  utimesSync(file, when, when);
  return file;
}

const APP = join(home, 'app');
const OTHER = join(home, 'other-project');

// The whole point: an id is produced only when the transcript says this directory.
rollout({ id: 'aaaa-1111', cwd: APP, agoMs: 5_000 });
is(
  'finds the session whose transcript names this directory',
  codexSession(APP, NOW, home),
  'aaaa-1111',
);
is('finds nothing for a directory no transcript names', codexSession(OTHER, NOW, home), undefined);

// A second codex, in another repo, written MORE recently. `codex resume --last` would take this one
// and silently move the user's restart to the wrong project; matching on cwd is why this does not.
rollout({ id: 'bbbb-2222', cwd: OTHER, agoMs: 0 });
is(
  'is not stolen by a newer session in another project',
  codexSession(APP, NOW, home),
  'aaaa-1111',
);
is(
  'and still answers correctly for that other project',
  codexSession(OTHER, NOW, home),
  'bbbb-2222',
);

// Same directory, two sittings: the live one is the one being written to.
rollout({ id: 'cccc-3333', cwd: APP, agoMs: 1_000, day: '30' });
is(
  'prefers the most recently written sitting for this directory',
  codexSession(APP, NOW, home),
  'cccc-3333',
);

// Stale is a refusal, not a best guess. Resuming a conversation from hours ago looks like it
// worked and drops the user into context they have forgotten.
rmSync(join(home, 'sessions'), { recursive: true, force: true });
rollout({ id: 'dddd-4444', cwd: APP, agoMs: 31 * 60 * 1000 });
is('refuses a sitting older than the freshness window', codexSession(APP, NOW, home), undefined);

// Evidence has to parse. A half-written first line is not a session id.
rmSync(join(home, 'sessions'), { recursive: true, force: true });
rollout({
  id: 'eeee-5555',
  cwd: APP,
  agoMs: 1_000,
  head: '{"type":"session_meta","payload":{"session_id"',
});
is(
  'refuses a truncated session_meta rather than guessing',
  codexSession(APP, NOW, home),
  undefined,
);

// A machine where codex has never run must not throw on the way past.
is(
  'answers for a home with no sessions directory at all',
  codexSession(APP, NOW, join(home, 'nope')),
  undefined,
);

rmSync(home, { recursive: true, force: true });
console.log(fails === 0 ? '\ncodex-session: all passed' : `\ncodex-session: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
