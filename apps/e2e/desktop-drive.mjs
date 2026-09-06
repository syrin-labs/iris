/**
 * Drive a real Electron app through Reticle's own tools, headed, so it can be watched.
 *
 * Not the battery: the battery asserts and exits. This drives the app the way an agent would and
 * prints what each tool actually returned, including the IPC records and the verdict that refuses a
 * false green.
 */
import { spawnElectronSmoke, bootDesktopSession, spawn, ROOT } from './desktop-harness.mjs';
import path from 'node:path';

const smokeDir = path.join(ROOT, 'apps', 'electron-smoke');
/** Headed on purpose: the window IS the deliverable here, unlike in the battery. */
const electronLauncher = (bin) => (env) => spawn(bin, ['.'], { cwd: smokeDir, env });

const PORT = Number(process.argv[2] ?? 4400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (label, value) => {
  const text = 'string' === typeof value ? value : JSON.stringify(value);
  console.log(`\n▸ ${label}\n  ${String(text).slice(0, 600)}`);
};

// The bridge port has to reach VITE, not only Electron: the plugin bakes it into the bundle it
// serves, so a dev server started before the port was decided serves a page that dials the default
// and never finds this bridge. That is what happened on the first run of this script.
const env = { ...process.env, RETICLE_PORT: String(PORT) };
const { vite, electronBin } = await spawnElectronSmoke(env);
let session;
try {
  // No RETICLE_HEADLESS: the window is the point.
  session = await bootDesktopSession({
    spawnApp: electronLauncher(electronBin),
    port: PORT,
    urlIncludes: ':5174',
  });
  const { tool, refOf, sessionId } = session;
  console.log(`\n=== Electron, driven over Reticle's tools (bridge :${String(PORT)}) ===`);
  console.log(`session ${String(sessionId)}`);

  show('reticle_state — the app’s own store, read from outside', await tool('reticle_state', {}));

  // The load-on-mount IPC. This is the call the preload used to DROP when it landed before connect().
  await sleep(1500);
  const boot = await tool('reticle_network', { urlContains: 'ipc://' });
  show('reticle_network — IPC observed with zero frontend wiring', boot.calls ?? boot);

  // A healthy action, with the consequence named BEFORE it fires.
  const draft = await refOf('draft');
  if (draft !== undefined) {
    await tool('reticle_act', { ref: draft, action: 'fill', args: { value: 'driven by reticle' } });
  }
  const add = await refOf('add');
  if (add !== undefined) {
    show(
      'reticle_act_and_wait — click add, declare the consequence first',
      await tool('reticle_act_and_wait', {
        ref: add,
        action: 'click',
        until: { kind: 'signal', name: 'todo:added' },
        timeoutMs: 8000,
      }),
    );
  }

  // The planted trap: the UI advances, the IPC behind it returns Err.
  const archive = await refOf('archive-1');
  if (archive !== undefined) {
    await tool('reticle_act', { ref: archive, action: 'click' });
    for (let i = 0; i < 40; i++) {
      const r = await tool('reticle_network', { urlContains: 'ipc://todos:archive' });
      if ('number' === typeof r.calls?.[0]?.status) break;
      await sleep(200);
    }
    show(
      'reticle_network { ok:false } — only the calls that actually failed',
      (await tool('reticle_network', { ok: false })).calls ?? [],
    );
    show(
      'reticle_assert — passes, and the verdict REFUSES it anyway',
      await tool('reticle_assert', { predicate: { kind: 'net', ok: false } }),
    );
  }

  console.log('\nwindow stays open for 90s — the HUD is live in it');
  await sleep(90_000);
} finally {
  await session?.shutdown?.();
  try {
    process.kill(-vite.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}
process.exit(0);
