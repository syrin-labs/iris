// The release smoke: drive the demo apps the way a user's agent does, and check the ANSWERS.
//
// The battery proves the pieces. This proves the product: open a real app, look, act, assert, and —
// most importantly — assert something FALSE and confirm Reticle says no. Every green here is
// worthless without that: a tool that always answers yes scores 100%.
//
// Deliberately small and fast. It is the last thing run before a release, so it has to be readable
// at a glance and finish in a couple of minutes.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from '../../../bench/harness/mcp-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = process.env.RETICLE_PORT ?? '4400';
const APP = process.env.SMOKE_APP ?? 'http://localhost:4310/';

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

console.log('\n=== RELEASE SMOKE: the demo app, driven like a user ===');
process.chdir(ROOT);

const client = new McpStdioClient(
  'node',
  ['packages/server/dist/cli.js', 'mcp', '--port', PORT, '--drive', APP],
  { RETICLE_PORT: PORT, RETICLE_TELEMETRY: '0' },
);
await client.start();

const call = async (name, args = {}) => {
  const raw = await client
    .request('tools/call', { name, arguments: args }, 60_000)
    .catch((error) => ({ content: [{ text: `THREW ${String(error.message)}` }] }));
  const text = (raw?.content ?? []).map((c) => c.text ?? '').join('\n');
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
};

// Wait for OUR driven page, not for "a session" — a developer's own tab satisfies that instantly and
// then every check below runs against somebody else's app.
let sessionId;
for (let i = 0; 60 > i && sessionId === undefined; i += 1) {
  const listed = (await call('reticle_sessions')).sessions ?? [];
  sessionId = listed.find((s) => String(s.url ?? '').startsWith(APP.replace(/\/$/, '')))?.sessionId;
  if (sessionId === undefined) await new Promise((r) => setTimeout(r, 500));
}
chk('the app connects and Reticle can see it', sessionId !== undefined, sessionId ?? 'no session');

const snapshot = await call('reticle_snapshot', { mode: 'interactive', sessionId });
const tree = JSON.stringify(snapshot);
chk('a snapshot comes back with something to drive', /\(ref=/.test(tree), `${tree.length} bytes`);

const ref = /\(ref=([A-Za-z0-9_-]+)\)/.exec(tree)?.[1];
const acted = await call('reticle_act', { ref, action: 'click', sessionId });
chk('an action dispatches', true === acted.dispatched || true === acted.result?.ok, JSON.stringify(acted).slice(0, 70));

// ── The load-bearing half: Reticle must be able to say NO ─────────────────────────────────────
{
  const verdict = await call('reticle_assert', {
    predicate: { kind: 'text', contains: 'this string is definitely not on the page 4f3a9c' },
    timeout_ms: 2000,
    sessionId,
  });
  chk(
    'a FALSE assertion is reported as not verified',
    'no' === verdict.verified || false === verdict.pass,
    `verified=${String(verdict.verified)} pass=${String(verdict.pass)}`,
  );
  chk(
    '  and it says what it looked for and what it saw',
    undefined !== (verdict.failureReason ?? verdict.evidence ?? verdict.observed),
    String(verdict.failureReason ?? '').slice(0, 80),
  );
}

{
  const verdict = await call('reticle_assert', {
    // The element predicate nests its query — verified against PredicateSchema rather than
    // guessed. Two earlier guesses (`{kind:'testid',value}` and a bare `{testid}`) were rejected as
    // an invalid discriminator and read as a product failure, which is its own small lesson: an
    // assertion written from memory tests the author, not the product.
    predicate: { kind: 'element', query: { by: 'testid', value: 'no-such-testid-4f3a9c' } },
    timeout_ms: 2000,
    sessionId,
  });
  chk(
    'a missing element is reported as not verified',
    'no' === verdict.verified || false === verdict.pass,
    `verified=${String(verdict.verified)} ${JSON.stringify(verdict).slice(0, 60)}`,
  );
}

// ── A stale ref must be refused by name, never acted on blind ─────────────────────────────────
{
  await call('reticle_navigate', { url: APP, reload: true, sessionId });
  await new Promise((r) => setTimeout(r, 1500));
  const stale = await call('reticle_act', { ref, action: 'click', sessionId });
  const body = JSON.stringify(stale);
  chk(
    'a stale ref is refused by name, not silently mis-clicked',
    /no longer resolves|stale/i.test(body),
    body.slice(0, 80),
  );
}

// ── A tool that refuses must not blame Reticle for the caller's mistake ───────────────────────
{
  const bad = await call('reticle_query', { by: 'css', value: 'body', sessionId });
  const body = JSON.stringify(bad);
  chk(
    'an unsupported query strategy is refused, not answered with zero matches',
    !/"count":0/.test(body),
    body.slice(0, 80),
  );
  chk('  and the refusal is not blamed on Reticle', !/not one Reticle recognizes/.test(body));
}

// ── THE ONBOARDING SEQUENCE: a drive that ends in a bug report ────────────────────────────────
// The moment the whole funnel is for. A new user watches their agent drive their app and sees a
// finding with a file and a line — not a capability demo, not a green nobody earned.
//
// It was proven by hand on a real defect and nothing gated it, which is how it would quietly stop
// working. `reticle demo` used to be the path and was DELETED: a bespoke demo command proves
// nothing about the workflow somebody is deciding to adopt. So this drives the tools an agent
// actually has, against the app it actually installed into.
//
// The three properties, in the order a user meets them:
//   1. a verdict is REFUSED when the app did not do what was declared — the bug report exists;
//   2. it names WHERE — a source file and line, so the finding is one click from an edit;
//   3. it says WHY in a sentence, so the human reading over the agent's shoulder understands it.
{
  // Driven on the LOGIN button, which is the one control guaranteed present on a freshly reloaded
  // app. The first draft used `nav-deployments`, which only exists after signing in — so the spec
  // failed on its own selector and reported `verified=undefined`, which looks exactly like the
  // product returning nothing. The refusal said so precisely ("the call was valid — the selector
  // matched nothing on the page RIGHT NOW"), which is the message this release fixed.
  const missing = await call('reticle_act_and_wait', {
    sessionId,
    action: 'click',
    target: { testid: 'login-submit' },
    until: { kind: 'state', path: 'view', equals: 'this-view-does-not-exist' },
    timeout_ms: 4000,
  });
  chk(
    'a flow that does not do what was declared produces a REFUSAL, not a pass',
    missing.verified === 'no',
    `verified=${String(missing.verified)}`,
  );
  chk(
    '  and the finding names a source file and line',
    'string' === typeof missing.source && /:\d+/.test(missing.source),
    String(missing.source),
  );
  chk(
    '  and it says why in a sentence a human can read',
    'string' === typeof missing.because && 20 < missing.because.length,
    String(missing.because).slice(0, 70),
  );
}

await client.stop();
console.log(`\n${0 === fail ? '✅' : '❌'} RELEASE SMOKE (${pass} passed, ${fail} failed)`);
process.exit(0 === fail ? 0 : 1);
