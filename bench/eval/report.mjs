/**
 * Read a do-and-verify result set PER LOUDNESS CLASS, because the average is the lie.
 *
 * Measured over a full session: every arm caught every loud defect, and the entire signal came from
 * the quiet ones. A single "4/5 correct" headline over that mix reports mostly the easy case and
 * reads as a product claim. The same run split by class says something true and much less flattering.
 *
 * Deliberately a reader, not a runner: it takes the JSON any arm already writes. A reporter that also
 * ran things would be a second place for scope to drift, and this suite has produced five defects of
 * exactly that shape already.
 *
 *   node bench/eval/report.mjs bench/raw/intent-on.json bench/raw/intent-off.json
 */
import { readFileSync } from 'node:fs';
import { Loudness, loudnessOf, byClass, LOUDNESS } from './loudness.mjs';

const CLASSES = [Loudness.LOUD, Loudness.CROSS_CHANNEL, Loudness.QUIET];

/** One arm's numbers, per class. `works` and `false green` are the two that decide anything. */
export function summarise(rows) {
  return {
    works: byClass(rows, (r) => true === r.works),
    falseGreen: byClass(rows, (r) => true === r.false_green),
    claimed: byClass(rows, (r) => true === r.claimed),
    ungradedRows: rows.filter((r) => loudnessOf(r.bug) === undefined).map((r) => r.bug),
  };
}

const pad = (s, n) => String(s).padEnd(n);
const cell = (c) => `${String(c.hit)}/${String(c.n)}`;

export function render(name, rows) {
  const s = summarise(rows);
  const lines = [`── ${name} (${String(rows.length)} cells)`];
  lines.push(pad('  metric', 16) + CLASSES.map((c) => pad(c, 16)).join(''));
  for (const [label, m] of [
    ['works', s.works],
    ['claimed', s.claimed],
    ['FALSE GREEN', s.falseGreen],
  ]) {
    lines.push(pad(`  ${label}`, 16) + CLASSES.map((c) => pad(cell(m[c]), 16)).join(''));
  }
  // Never silently: an ungraded row is counted nowhere, which is how a suite re-weights itself.
  if (0 < s.ungradedRows.length) {
    lines.push(`  UNGRADED (counted in no class): ${s.ungradedRows.join(', ')}`);
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (0 === files.length) {
    console.log('usage: node bench/eval/report.mjs <result.json> [more.json ...]');
    process.exit(1);
  }
  for (const f of files) {
    console.log(render(f.split('/').pop(), JSON.parse(readFileSync(f, 'utf8'))));
    console.log('');
  }
  // The suite's own weakness, printed with every report rather than kept in a document nobody opens.
  const quiet = Object.values(LOUDNESS).filter((e) => e.grade === Loudness.QUIET).length;
  console.log(
    `NOTE: ${String(quiet)} quiet scenario(s) in the suite. A false green is only possible in that ` +
      'class — a loud defect cannot be both unfixed and seen to succeed — so the quiet column is the ' +
      'product claim and everything else is a control.',
  );
}
