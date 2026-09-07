/**
 * A durable outbox for feedback, written BEFORE the network is touched.
 *
 * Feedback is the only qualitative channel this product has, and it carries an agent's whole
 * root-cause analysis — often an hour of driving distilled into one payload. It was sent with the
 * same 2-second fire-and-forget budget as a usage counter, with no retry and no persistence, so a
 * 1.3-second network hiccup destroyed the report outright. Measured to the collector from one
 * machine with a WARM DNS cache: dns 0.003s, connect 0.233s, tls 0.467s, total 0.694s — roughly a
 * third of the entire budget spent before a byte of payload moves, and that is the good case. A
 * fresh short-lived CLI process pays cold DNS and a cold route on top.
 *
 * So the order is inverted: write it down first, then try to send. A failed send is then a queued
 * report rather than a lost one, and `sent: false` becomes a statement about the network instead of
 * an epitaph.
 *
 * JSONL, appended, one payload per line. Append-only is the point — a crash mid-write costs at most
 * the line being written, never the ones already there.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReticleDir } from '@reticlehq/core';

/** One queued report: the payload, plus what is needed to find and remove it again. */
interface OutboxEntry {
  id: string;
  t: string;
  payload: unknown;
}

export function outboxPath(home: string = homedir()): string {
  return join(home, ReticleDir.ROOT, 'feedback-outbox.jsonl');
}

/**
 * Persist a report and return its id. Never throws: failing to queue must not also fail the send
 * that was about to happen anyway.
 */
export function queueFeedback(
  payload: unknown,
  now: () => Date = () => new Date(),
  home: string = homedir(),
): string | null {
  const id = randomUUID();
  try {
    mkdirSync(join(home, ReticleDir.ROOT), { recursive: true });
    const entry: OutboxEntry = { id, t: now().toISOString(), payload };
    appendFileSync(outboxPath(home), `${JSON.stringify(entry)}\n`, 'utf8');
    return id;
  } catch {
    return null;
  }
}

/** Read every queued report. A malformed line is skipped, never fatal — the rest still matter. */
export function readOutbox(home: string = homedir()): OutboxEntry[] {
  try {
    const path = outboxPath(home);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => 0 < line.trim().length)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as OutboxEntry];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * Drop a report that was delivered. Rewrites the file without it.
 *
 * A rewrite rather than a tombstone because the file's whole purpose is "what still needs sending" —
 * a reader should be able to `cat` it and see exactly the backlog, with no filtering rule to learn.
 * Volume is a handful of lines a week, so the cost is irrelevant.
 */
export function markDelivered(id: string | null, home: string = homedir()): void {
  if (null === id) return;
  try {
    const remaining = readOutbox(home).filter((entry) => entry.id !== id);
    const path = outboxPath(home);
    if (0 === remaining.length) {
      writeFileSync(path, '', 'utf8');
      return;
    }
    writeFileSync(path, `${remaining.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  } catch {
    // A report that stays queued after a successful send is a duplicate at worst. Losing one is not.
  }
}
