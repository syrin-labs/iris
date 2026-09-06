/**
 * Which codex conversation is running in a given directory, read from codex's own transcript.
 *
 * Its own module with its own test, for the same reason pick-session is: getting it wrong resumes
 * the user into SOMEBODY ELSE'S conversation, with no error anywhere to say so — the quietest kind
 * of failure this script can produce, and one that cannot be caught by driving because the codex on
 * the development machine has no vendor binary to drive.
 */

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The codex state directory, honouring the same override codex itself reads. */
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex');

/**
 * How recently a codex transcript must have been written to be THIS sitting.
 *
 * The conversation asking for a restart is alive and writing, so its rollout file was touched
 * seconds ago; anything materially older is a different sitting that happened to run here. The
 * window is generous rather than tight because the cost of the two mistakes is not symmetric:
 * refusing a valid restart prints one command for the user to run, while resuming the wrong
 * conversation drops them into somebody else's context with no error anywhere.
 */
const CODEX_SESSION_FRESH_MS = 30 * 60 * 1000;

/**
 * How much of a rollout to read looking for its first line.
 *
 * A `session_meta` record embeds the model's full base instructions, so the line is kilobytes, not
 * bytes — but a rollout GROWS without bound as the conversation does, and reading a megabyte file
 * to learn its first line would make a restart get slower the more work the user has done. 256 KiB
 * is two orders of magnitude above the largest header observed and still a fixed cost.
 */
const HEAD_BYTES = 256 * 1024;

/** The first line of a file, without reading the rest of it. Undefined if there is no first line. */
function firstLine(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buf, 0, HEAD_BYTES, 0);
    const text = buf.subarray(0, read).toString('utf8');
    const nl = text.indexOf('\n');
    // No newline inside the window means the header is bigger than anything we have seen, and a
    // truncated line is not evidence — say so by returning nothing rather than parsing a fragment.
    return -1 === nl ? undefined : text.slice(0, nl);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing left to close */
      }
    }
  }
}

/**
 * The codex conversation running in THIS directory, identified from codex's own transcript.
 *
 * Codex tells a child process nothing — there is no `CODEX_SESSION_ID` the way Claude Code exports
 * `CLAUDE_CODE_SESSION_ID` — so there is no id to be handed down and none is invented here. What
 * codex does leave behind is the file it is currently writing:
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl`, whose FIRST line is a `session_meta`
 * record carrying both `session_id` and the `cwd` the session was started in.
 *
 * So the id is read from evidence rather than guessed, which is the rule the rest of this file
 * already follows. `codex resume --last` was the obvious alternative and is deliberately not used:
 * "last" is last on the whole MACHINE, so a second codex open in another repo silently steals the
 * restart and the user is resumed into a conversation about a different project.
 *
 * Returns undefined rather than a best guess whenever the evidence is missing or stale — the same
 * refusal the claude path makes when no transcript exists for its id.
 */
export function codexSession(cwd, now = Date.now(), home = CODEX_HOME) {
  const roots = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // codex has never run here, or the directory is not ours to read
    }
    for (const e of entries) {
      if (e.isDirectory() && depth < 3) walk(join(dir, e.name), depth + 1);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        roots.push(join(dir, e.name));
      }
    }
  };
  walk(join(home, 'sessions'), 0);

  let best;
  for (const file of roots) {
    let mtime;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtime > CODEX_SESSION_FRESH_MS) continue;
    if (best !== undefined && mtime <= best.mtime) continue;
    // The session_meta record is always ordinal 0, so only the first line is ever needed.
    const head = firstLine(file);
    if (head === undefined) continue;
    let meta;
    try {
      meta = JSON.parse(head)?.payload;
    } catch {
      continue; // a partially written first line is not evidence
    }
    if (meta?.session_id === undefined) continue;
    if (resolve(String(meta.cwd ?? '')) !== resolve(cwd)) continue;
    best = { id: String(meta.session_id), mtime };
  }
  return best?.id;
}
