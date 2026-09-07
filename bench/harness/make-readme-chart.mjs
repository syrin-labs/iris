// Generate the README's benchmark charts FROM the benchmark results.
//
// Hand-drawing a chart is how a README ends up claiming a number the harness stopped producing. This
// reads `bench/pw-vs-reticle/results.json` — the same file `bench/FALSE-GREEN-SCORECARD.md` is built
// from — and `bench/raw/*.json` for cost and time, then emits SVG. The picture and the tables cannot
// disagree, because nothing here is typed by hand. Re-run after `pnpm bench`.
//
// The coverage card plots the categories where the two tools DIFFER, and states the parity ones in
// words rather than hiding them: a chart that showed only the moat would be true and still
// misleading, since most bug classes are a tie. The moat is that the ties are the easy half.
//
// One light theme by choice — the cards render white in both GitHub themes.
//
// Colour: this is the "highlight one, gray the rest" pattern, not a two-hue categorical palette —
// Reticle wears the accent, everything it is measured against wears one de-emphasis gray. Both greys
// are the lightest step that clears 3:1 against their own surface, and every mark is directly
// labelled, which is the relief a low-contrast mark owes the reader.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESULTS = join(ROOT, 'bench', 'pw-vs-reticle', 'results.json');
const OUT_DIR = join(ROOT, 'assets', 'readme');
const raw = (file) => JSON.parse(readFileSync(join(ROOT, 'bench', 'raw', file), 'utf8'));

/** Palette: accent + one de-emphasis gray, both validated against this white surface. */
const T = {
  bg: '#ffffff',
  fg: '#1a1726',
  dim: '#615c7d',
  purple: '#6b4bf0',
  grey: '#7d8494',
  ink: '#000000',
  inkOp: 0.05,
  hairOp: 0.12,
  washOp: 0.1,
};

const RETICLE = 'reticle-script';
const PLAYWRIGHT = 'playwright-script';

/** Not a bug: flagging one would itself be a false positive, so 0/2 is the correct score. */
const NOT_A_BUG = 'false-positive-trap';

function tally() {
  const results = JSON.parse(readFileSync(RESULTS, 'utf8'));
  const buggy = results.rows.filter((row) => row.variant !== 'clean' && row.category !== NOT_A_BUG);
  const byCategory = new Map();
  for (const row of buggy) {
    const entry = byCategory.get(row.category) ?? {
      [RETICLE]: { n: 0, caught: 0 },
      [PLAYWRIGHT]: { n: 0, caught: 0 },
    };
    const side = entry[row.harness];
    if (side !== undefined) {
      side.n += 1;
      if (true === row.caught) side.caught += 1;
    }
    byCategory.set(row.category, entry);
  }
  return byCategory;
}

// ── drawing primitives ───────────────────────────────────────────────────────
const FONT = '-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const text = (x, y, body, { fill, size = 14, weight = 400, anchor = 'start', ls }) =>
  `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}"` +
  `${400 === weight ? '' : ` font-weight="${weight}"`}${'start' === anchor ? '' : ` text-anchor="${anchor}"`}` +
  `${ls === undefined ? '' : ` letter-spacing="${ls}"`}>${esc(body)}</text>`;

const box = (x, y, w, h, fill, rx = 0, op) =>
  `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${h}"${0 === rx ? '' : ` rx="${rx}"`} fill="${fill}"` +
  `${op === undefined ? '' : ` opacity="${op}"`}/>`;

/** A dot carrying a 2px ring in the surface colour, so it stays legible where marks cross. */
const dot = (x, y, fill, t, r = 6) =>
  `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${fill}" stroke="${t.bg}" stroke-width="2"/>`;

const card = (w, h, label, t, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}" role="img" aria-label="${esc(label)}">\n` +
  `${box(0, 0, w, h, t.bg, 14)}\n${body}\n</svg>`;

/** Identity never rides colour alone: two series always get a legend as well as direct labels. */
const legend = (x, y, t, ours, theirs) =>
  dot(x + 6, y + 6, t.purple, t) +
  text(x + 22, y + 11, ours, { fill: t.dim, size: 14 }) +
  dot(x + 100, y + 6, t.grey, t) +
  text(x + 116, y + 11, theirs, { fill: t.dim, size: 14 });

/**
 * The series name written on its own bar. A legend in the corner is the first thing a reader skips,
 * so identity travels with the mark: inside the fill when the fill is long enough to hold the text,
 * otherwise just past its end on the track. Width is estimated, not measured — SVG has no text
 * metrics here, so the threshold is deliberately generous rather than tight.
 */
const barName = (x, y, h, fillWidth, name, t, size = 13) => {
  const width = name.length * size * 0.58;
  const inside = fillWidth >= width + 24;
  return text(inside ? x + 12 : x + fillWidth + 12, y + h / 2 + size * 0.36, name, {
    fill: inside ? '#ffffff' : t.dim,
    size,
    weight: 600,
  });
};

/** The one number the card exists to land, plus the line that says what it means. */
const hero = (t, value, caption, detail, y = 132) => [
  text(28, y, value, { fill: t.fg, size: 104, weight: 800, ls: -4 }),
  text(28, y + 44, caption, { fill: t.dim, size: 22, weight: 600 }),
  ...(detail === undefined ? [] : [text(28, y + 72, detail, { fill: t.dim, size: 15 })]),
];

const short = (n) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`
    : n >= 1e3
      ? `${Math.round(n / 1e3)}k`
      : String(n);

// ── 1. cost: cumulative tokens over N agentic runs ───────────────────────────
/**
 * Deliberately pessimistic: Reticle is charged a FULL LLM drive to author the suite, even though the
 * agent is driving the app anyway while it builds the feature. It still crosses over at run 2. The
 * caveat lives in the README prose beside the image — the card carries the number, not the essay.
 */
function costChart(t) {
  const suite = raw('suite-rre.json').points.find((point) => 4 === point.flows);
  const perRunOurs = suite.reticle_verify_tokens;
  const perRunTheirs = suite.competitor_redrive_tokens;
  const authoring = perRunTheirs;
  const W = 960;
  const H = 452;
  const X0 = 96;
  const X1 = 782;
  const Y0 = 236;
  const Y1 = 388;
  const RUNS = 100;
  const LO = 5; // log10 bounds — both series live between 100k and ~12M
  const HI = 7.3;
  const px = (n) => X0 + (n / RUNS) * (X1 - X0);
  const py = (v) => Y1 - ((Math.log10(v) - LO) / (HI - LO)) * (Y1 - Y0);
  const at = (n, perRun, base = 0) => base + perRun * n;

  const series = (perRun, base, colour) => {
    const pts = Array.from(
      { length: RUNS },
      (_, i) => `${px(i + 1).toFixed(1)},${py(at(i + 1, perRun, base)).toFixed(1)}`,
    );
    return (
      `<path fill="${colour}" opacity="${t.washOp}" d="M${px(1).toFixed(1)},${Y1} L${pts.join(' L')} L${X1},${Y1} Z"/>` +
      `<polyline fill="none" stroke="${colour}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" points="${pts.join(' ')}"/>`
    );
  };

  const endOurs = at(RUNS, perRunOurs, authoring);
  const endTheirs = at(RUNS, perRunTheirs);
  const parts = [
    ...hero(
      t,
      `${suite.suite_rre_ratio.toLocaleString('en-US')}×`,
      'cheaper to re-verify, every run',
    ),
    legend(700, 32, t, 'Reticle', 'Playwright MCP'),
  ];
  for (const decade of [5, 6, 7]) {
    const y = py(10 ** decade);
    parts.push(box(X0, y, X1 - X0, 1, t.ink, 0, t.hairOp));
    parts.push(text(X0 - 14, y + 5, short(10 ** decade), { fill: t.dim, size: 14, anchor: 'end' }));
  }
  parts.push(
    series(perRunTheirs, 0, t.grey),
    series(perRunOurs, authoring, t.purple),
    text(px(0), Y1 + 30, '0', { fill: t.dim, size: 14 }),
    text(px(50), Y1 + 30, '50', { fill: t.dim, size: 14, anchor: 'middle' }),
    text(px(100), Y1 + 30, '100 agentic runs', { fill: t.dim, size: 14, anchor: 'middle' }),
    dot(X1, py(endTheirs), t.grey, t),
    dot(X1, py(endOurs), t.purple, t),
    text(X1 + 16, py(endTheirs) + 1, short(endTheirs), { fill: t.fg, size: 18, weight: 700 }),
    text(X1 + 16, py(endTheirs) + 19, 'Playwright MCP', { fill: t.dim, size: 13 }),
    text(X1 + 16, py(endOurs) + 1, short(endOurs), { fill: t.fg, size: 18, weight: 700 }),
    text(X1 + 16, py(endOurs) + 19, 'Reticle', { fill: t.dim, size: 13 }),
  );

  const label =
    `Cumulative tokens to re-verify a four-flow suite: after 100 agentic runs Reticle has read ${short(endOurs)} tokens ` +
    `versus ${short(endTheirs)} for Playwright MCP — ${suite.suite_rre_ratio} times cheaper per run.`;
  return card(W, H, label, t, parts.join('\n'));
}

// ── 2. time: the two places the wall clock actually moves ────────────────────
/**
 * Only the two rows the harness measures. Reticle does not drive a browser faster than anyone else —
 * both wins are structural (clock control, context pooling), and the README says so beside the image.
 */
function speedChart(t) {
  const clock = raw('clock-timetravel.json');
  const pool = raw('multi-agent-throughput.json');
  const panels = [
    {
      k: 'verify a 2.6s time-gated flow',
      ours: clock.reticle_clock_advanced.wall_ms,
      theirs: clock.real_wait_floor.wall_ms,
      unit: 'ms',
    },
    {
      k: `run a ${pool.flows}-flow batch`,
      ours: pool.pooled_ms,
      theirs: pool.serial_ms,
      unit: 's',
    },
  ];
  const W = 960;
  const H = 320;
  const BAR_W = 290;
  const show = (v, unit) =>
    's' === unit ? `${(v / 1000).toFixed(1)}s` : `${v.toLocaleString('en-US')}ms`;

  const parts = [
    text(28, 52, 'Time to a verdict', { fill: t.fg, size: 24, weight: 700 }),
    legend(700, 34, t, 'Reticle', 'Alternatives'),
    box(478, 96, 1, 168, t.ink, 0, t.hairOp),
  ];
  panels.forEach((panel, i) => {
    const x = 28 + i * 474;
    const max = Math.max(panel.ours, panel.theirs);
    parts.push(
      text(x, 168, `${(panel.theirs / panel.ours).toFixed(1).replace(/\.0$/, '')}×`, {
        fill: t.fg,
        size: 76,
        weight: 800,
        ls: -3,
      }),
      text(x, 198, panel.k, { fill: t.dim, size: 17, weight: 600 }),
    );
    [
      [panel.ours, t.purple, 'Reticle'],
      [panel.theirs, t.grey, 'Alternatives'],
    ].forEach(([value, colour, name], j) => {
      const y = 224 + j * 30;
      parts.push(
        box(x, y, BAR_W, 20, t.ink, 5, t.inkOp),
        box(x, y, (value / max) * BAR_W, 20, colour, 5),
        barName(x, y, 20, (value / max) * BAR_W, name, t),
        text(x + BAR_W + 16, y + 16, show(value, panel.unit), {
          fill: 0 === j ? t.fg : t.dim,
          size: 16,
          weight: 0 === j ? 700 : 400,
        }),
      );
    });
  });

  const label =
    `Time to a verdict: a 2.6 second time-gated flow verified in ${panels[0].ours} ms versus a ` +
    `${panels[0].theirs} ms real wait, and a ${pool.flows}-flow batch in ${(panels[1].ours / 1000).toFixed(1)} seconds ` +
    `versus ${(panels[1].theirs / 1000).toFixed(1)} seconds one at a time.`;
  return card(W, H, label, t, parts.join('\n'));
}

// ── 3. coverage: bugs caught, by category ────────────────────────────────────
function coverageChart(t) {
  const byCategory = tally();
  const all = [...byCategory.entries()].map(([name, e]) => ({
    name,
    ret: e[RETICLE],
    pw: e[PLAYWRIGHT],
  }));
  const differ = all
    .filter((c) => c.ret.caught !== c.pw.caught)
    .sort((a, b) => a.pw.caught / a.pw.n - b.pw.caught / b.pw.n || b.ret.n - a.ret.n);
  const parity = all.filter((c) => c.ret.caught === c.pw.caught);
  const parityBugs = parity.reduce((sum, c) => sum + c.ret.n, 0);
  const totals = all.reduce(
    (acc, c) => ({ ret: acc.ret + c.ret.caught, pw: acc.pw + c.pw.caught, n: acc.n + c.ret.n }),
    { ret: 0, pw: 0, n: 0 },
  );

  // The ratio on the categories where the two DISAGREE — i.e. the bugs that never reach the screen.
  // The overall 85-vs-59 ratio is a dull 1.4x because most categories are a tie; this is the number
  // that actually separates the tools, and the detail line prints both so it cannot be read as more.
  const hidden = differ.reduce(
    (acc, c) => ({ ret: acc.ret + c.ret.caught, pw: acc.pw + c.pw.caught }),
    { ret: 0, pw: 0 },
  );
  const edge = 0 === hidden.pw ? hidden.ret : hidden.ret / hidden.pw;

  const W = 960;
  const HEAD = 244;
  const ROW = 48;
  const BAR_X = 300;
  const BAR_W = 380;
  const BAR_H = 17;
  const H = HEAD + differ.length * ROW + 56;

  const parts = [
    ...hero(
      t,
      `${edge.toFixed(0)}×`,
      'more bugs caught where the screen looks right',
      `${hidden.ret} vs ${hidden.pw} across these categories · ${totals.ret}/${totals.n} vs ${totals.pw}/${totals.n} overall`,
    ),
    legend(722, 32, t, 'Reticle', 'Playwright'),
  ];
  differ.forEach((cat, i) => {
    const y = HEAD + i * ROW;
    const scale = (v) => (v / cat.ret.n) * BAR_W;
    const lower = y + BAR_H + 4;
    parts.push(
      text(28, y + 24, cat.name, { fill: t.fg, size: 17, weight: 600 }),
      box(BAR_X, y, BAR_W, BAR_H, t.ink, 4, t.inkOp),
      box(BAR_X, y, scale(cat.ret.caught), BAR_H, t.purple, 4),
      text(W - 28, y + 14, `${cat.ret.caught}/${cat.ret.n}`, {
        fill: t.fg,
        size: 15,
        weight: 700,
        anchor: 'end',
      }),
      box(BAR_X, lower, BAR_W, BAR_H, t.ink, 4, t.inkOp),
      box(BAR_X, lower, scale(cat.pw.caught), BAR_H, t.grey, 4),
      text(W - 28, lower + 14, `${cat.pw.caught}/${cat.pw.n}`, {
        fill: t.dim,
        size: 15,
        anchor: 'end',
      }),
    );
    // Named on the top row only, right under the hero: the stack below is identical, and repeating
    // both words down six rows is noise the reader stops seeing after the first one.
    if (0 === i) {
      parts.push(
        barName(BAR_X, y, BAR_H, scale(cat.ret.caught), 'Reticle', t),
        barName(BAR_X, lower, BAR_H, scale(cat.pw.caught), 'Playwright', t),
      );
    }
  });
  parts.push(
    text(
      28,
      HEAD + differ.length * ROW + 26,
      `${parity.length} other categories, ${parityBugs} bugs: tied`,
      { fill: t.dim, size: 16 },
    ),
  );

  const label =
    `Bugs caught by category: Reticle ${totals.ret} of ${totals.n}, Playwright ${totals.pw} of ${totals.n}. ` +
    `${differ.map((c) => `${c.name} ${c.ret.caught} of ${c.ret.n} versus ${c.pw.caught}`).join('; ')}. ` +
    `On the other ${parity.length} categories both catch everything.`;
  return { svg: card(W, H, label, t, parts.join('\n')), differ, parity, totals };
}

const CHARTS = {
  'benchmark-chart': (t) => coverageChart(t).svg,
  'chart-token-cost': costChart,
  'chart-speed': speedChart,
};
for (const [name, render] of Object.entries(CHARTS)) {
  const file = join(OUT_DIR, `${name}.svg`);
  writeFileSync(file, `${render(T)}\n`);
  console.log(`wrote ${file.replace(`${ROOT}/`, '')}`);
}

const { differ, parity, totals } = coverageChart(T);
console.log(
  `  ${totals.ret}/${totals.n} vs ${totals.pw}/${totals.n} · ${differ.length} differing categories · ${parity.length} at parity`,
);
