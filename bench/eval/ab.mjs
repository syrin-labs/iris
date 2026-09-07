/**
 * A/B any feature in one command:
 *
 *   node bench/eval/ab.mjs verify-next-baton
 *   node bench/eval/ab.mjs intent-instruction --arm reticle
 *
 * Runs the do-and-verify suite twice — feature ON, then suppressed via the flag registry — and
 * reports PER LOUDNESS CLASS, because the average hides the only column that tests the product's
 * claim.
 *
 * This exists because measuring a feature used to mean finding its seam, remembering its env var and
 * writing a bespoke two-arm script. That friction is why features shipped unmeasured. The whole
 * value here is that the cost of asking "does this actually do anything" drops to one line.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { FEATURES, suppressEnv, featureIds } from './features.mjs';
import { render } from './report.mjs';

const id = process.argv[2];
if (id === undefined || FEATURES[id] === undefined) {
  console.log(
    `usage: node bench/eval/ab.mjs <feature> [--arm <name>]\n  features: ${featureIds().join(', ')}`,
  );
  process.exit(1);
}
const armIdx = process.argv.indexOf('--arm');
const arm = -1 === armIdx ? 'reticle' : (process.argv[armIdx + 1] ?? 'reticle');
const feature = FEATURES[id];

function runArm(label, extraEnv) {
  const out = `bench/raw/ab-${id}-${label}.json`;
  console.log(`\n── ${label} ─────────────────────────────`);
  spawnSync('node', ['bench/do-and-verify/run.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv, DV_OUT: out, DV_ONLY_ARMS: arm },
  });
  return out;
}

console.log(`A/B: ${id}\n  what: ${feature.what}\n  hypothesis: ${feature.hypothesis}`);
// The hypothesis is printed BEFORE the run, so it cannot be adjusted to fit what comes back. Every
// direction looks like a win in hindsight; this is the cheapest possible pre-registration.

const onFile = runArm('on', {});
const offFile = runArm('off', suppressEnv(id));

console.log('\n════════ RESULT ════════');
for (const [label, f] of [
  ['FEATURE ON', onFile],
  ['SUPPRESSED', offFile],
]) {
  if (!existsSync(f)) {
    console.log(
      `${label}: no rows written — the run did not complete, so this arm measured NOTHING`,
    );
    continue;
  }
  const rows = JSON.parse(readFileSync(f, 'utf8'));
  console.log(render(label, rows));
  // The fields this feature claims to move, printed beside the class table so the hypothesis is
  // checked against its own stated measure rather than against whatever looks best.
  const sums = {};
  for (const k of feature.measure) {
    sums[k] = rows.reduce((n, r) => n + (Array.isArray(r[k]) ? r[k].length : Number(r[k] ?? 0)), 0);
  }
  console.log(`  measures: ${JSON.stringify(sums)}`);
  console.log(
    `  turns=${String(rows.reduce((n, r) => n + (r.turns ?? 0), 0))} tokens=${String(rows.reduce((n, r) => n + (r.total_tokens ?? 0), 0))}\n`,
  );
}
console.log(`prior status: ${feature.status ?? '(never measured)'}`);
