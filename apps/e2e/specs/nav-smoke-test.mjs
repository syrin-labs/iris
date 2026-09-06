// HONESTY-CRITICAL: prove nav_smoke runs end-to-end against a real app — it queries links inside
// a nav landmark, clicks internal hrefs (bounded), and returns one table whose rows name
// `renderedWithoutConsoleErrors` rather than "the route works". next-smoke's home page has a
// `<nav>` of App Router links, which is the shape the tool is for.
import { chromium } from 'playwright';
import { start, TOOLS } from '@reticlehq/server';
import { waitForSession } from '../wait-for-session.mjs';
let pass = 0,
  fail = 0;
const chk = (l, o, d = '') => {
  console.log(`   ${o ? '✅' : '❌'} ${l}${d ? '  — ' + d : ''}`);
  o ? pass++ : fail++;
};

const server = await start({ port: 4400, mcp: false });
const deps = {
  sessions: server.bridge.sessions,
  project: { recordRoutes: async () => {} },
};
const T = (n, a = {}) => TOOLS.find((t) => t.name === n).handler(deps, { sessionId: 'next-smoke', ...a });
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto('http://localhost:3100/');
await waitForSession(() => server.bridge.sessions.list(), 'next-smoke');

console.log('\n=== EXPLORE: reticle_verify { action: "nav_smoke" } walks primary nav (real browser) ===');
chk('app SDK connected', server.bridge.sessions.list().some((s) => s.sessionId === 'next-smoke'));

const report = await T('reticle_verify', { action: 'nav_smoke', maxLinks: 2, settleMs: 200 });
chk(
  'nav_smoke found links inside the nav landmark',
  report.linksFound > 0,
  `found=${report.linksFound}`,
);
chk(
  'nav_smoke clicked internal hrefs (bounded) and terminated',
  report.linksVisited > 0 && report.linksVisited <= 2,
  `visited=${report.linksVisited}`,
);
chk(
  'nav_smoke returned a per-route table',
  Array.isArray(report.rows) && report.rows.length >= report.linksVisited,
  `rows=${report.rows?.length}`,
);
chk(
  'every row names renderedWithoutConsoleErrors (not "the route works")',
  Array.isArray(report.rows) &&
    report.rows.every((row) => typeof row.renderedWithoutConsoleErrors === 'boolean'),
);
chk(
  'the honesty note is on the report, not implied by a green table',
  typeof report.note === 'string' && report.note.includes('not that the route or feature works'),
);

console.log(
  `\n${fail === 0 ? '✅ NAV SMOKE VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed) — visited=${report.linksVisited} rows=${report.rows?.length}`,
);
await b.close();
await server.close();
process.exit(fail === 0 ? 0 : 1);
