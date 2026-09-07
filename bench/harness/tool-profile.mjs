// Tool profile benchmark (Issue #118 harness half):
// Measures latency, error status, protocol errors, timeouts, and output bytes/tokens
// for every advertised Reticle tool on a held-open MCP connection against benchmark fixtures.
//
// Usage:
//   node bench/harness/tool-profile.mjs            # boots fixtures automatically + profiles all tools
//   node bench/harness/tool-profile.mjs --no-boot   # profiles against already running fixtures
//   node bench/harness/tool-profile.mjs --record    # updates bench/TOOL-PROFILE.md
//
import { execFileSync, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpStdioClient, RETICLE_CLI } from './mcp-client.mjs';
import { measure } from './tokenizer.mjs';
import { buildToolProfileOutput } from './tool-profile-output.mjs';
import * as PORTS from './ports.mjs';

const NO_BOOT = process.argv.includes('--no-boot');
const { RETICLE_PORT, API_PORT, DEMO_PORT, BENCH_URL } = PORTS;
const FIXTURE_READY_MS = Number(process.env.BENCH_FIXTURE_READY_MS ?? '30000');
const RETICLE_READY_MS = Number(process.env.BENCH_RETICLE_READY_MS ?? '3500');
const PNPM_CMD = 'win32' === process.platform ? 'pnpm.cmd' : 'pnpm';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tools that should not be called in a standard sweep because they end the session or alter link state.
const SKIP_TOOLS = new Set(['reticle_end_session']);

// ---------------------------------------------------------------------------
// Multi-fixture configuration: adding a new framework stack is a 1-item addition
// ---------------------------------------------------------------------------
const FIXTURES = [
  {
    id: 'bench-app',
    name: 'Vite + React (Bench App)',
    url: BENCH_URL,
    demoPort: DEMO_PORT,
    apiPort: API_PORT,
    bootProcesses: (pairingToken) => [
      { label: 'api', command: 'node', args: ['apps/api/server.mjs'], env: { API_PORT } },
      {
        label: 'bench-app',
        command: PNPM_CMD,
        args: [
          '--filter',
          '@reticlehq/bench-app',
          'exec',
          'vite',
          '--port',
          DEMO_PORT,
          '--strictPort',
        ],
        env: { RETICLE_PORT, VITE_RETICLE_TOKEN: pairingToken },
      },
    ],
    healthUrls: [`http://localhost:${API_PORT}/api/health`, `http://localhost:${DEMO_PORT}/`],
  },
  // Future stacks can be enabled with one entry, e.g.:
  // {
  //   id: 'next-app-router',
  //   name: 'Next.js App Router',
  //   url: 'http://localhost:3100/',
  //   demoPort: '3100',
  //   bootProcesses: (token) => [...],
  //   healthUrls: ['http://localhost:3100/'],
  // },
];

function readOrCreatePairingToken() {
  const dir = process.env.RETICLE_PAIRING_TOKEN_DIR || join(homedir(), '.reticle');
  const path = join(dir, 'pairing-token');
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length > 0) return existing;
  } catch {
    /* missing — create below */
  }
  const token = randomBytes(24).toString('hex');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 });
  return token;
}

const activeFixtures = [];

function spawnFixture(label, command, args, env) {
  const isWindows = 'win32' === process.platform;
  const isNode = 'node' === command;
  let spawnCmd = command;
  let spawnArgs = args;
  let useShell = false;

  if (isWindows) {
    if (isNode) {
      useShell = false;
      spawnArgs = args;
    } else {
      useShell = true;
      spawnCmd = `${command} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;
      spawnArgs = [];
    }
  }

  const child = spawn(spawnCmd, spawnArgs, {
    env: { ...process.env, ...env },
    stdio: 'ignore',
    detached: !isWindows,
    windowsHide: isWindows,
    shell: useShell,
  });
  child.on('error', (error) => console.error(`fixture ${label} failed to spawn: ${error.message}`));
  child.label = label;
  activeFixtures.push(child);
  return child;
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

function teardownFixtures() {
  while (activeFixtures.length > 0) {
    const child = activeFixtures.pop();
    try {
      if ('win32' === process.platform) {
        try {
          execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {
          child.kill('SIGTERM');
        }
      } else {
        process.kill(-child.pid, 'SIGTERM');
      }
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
}

async function bootFixture(fixture) {
  console.log(`tool-profile: booting fixture [${fixture.name}]...`);
  const pairingToken = readOrCreatePairingToken();
  const processes = fixture.bootProcesses(pairingToken);
  for (const p of processes) {
    spawnFixture(p.label, p.command, p.args, p.env);
  }

  const healthChecks = await Promise.all(
    fixture.healthUrls.map((url) => waitForHttp(url, FIXTURE_READY_MS)),
  );

  const dead = activeFixtures.filter((c) => c.exitCode !== null || c.signalCode !== null);
  if (dead.length > 0) {
    teardownFixtures();
    console.error(
      `tool-profile: fixture process(es) exited during boot: ${dead.map((c) => c.label).join(', ')}`,
    );
    process.exit(1);
  }
  if (!healthChecks.every(Boolean)) {
    teardownFixtures();
    console.error(`\n✗ fixture [${fixture.name}] did not come up within ${FIXTURE_READY_MS}ms.`);
    process.exit(1);
  }
  console.log(`✓ fixture [${fixture.name}] ready`);
}

function cleanupDaemon() {
  try {
    execFileSync('node', [RETICLE_CLI, 'stop', '--port', RETICLE_PORT, '--quiet'], {
      stdio: 'ignore',
    });
  } catch {
    /* none running — fine */
  }
}

async function waitForPortFree(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const busy = await new Promise((resolve) => {
      const socket = connect({ port: Number(port), host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (!busy) return true;
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
}

function resolveToolArgs(name, ctx) {
  const ARGS_MAP = {
    reticle_sessions: {},
    reticle_navigate: { url: ctx.url },
    reticle_snapshot: {},
    reticle_query: { by: 'testid', value: 'login-email' },
    reticle_inspect: { ref: 'e1' },
    reticle_act: { target: { by: 'testid', value: 'login-email' }, action: 'focus' },
    reticle_act_and_wait: {
      target: { by: 'testid', value: 'login-email' },
      action: 'focus',
      until: { kind: 'settled', quietMs: 50 },
    },
    reticle_act_sequence: {
      steps: [{ action: 'focus', target: { by: 'testid', value: 'login-email' } }],
    },
    reticle_observe: { window_ms: 2000 },
    reticle_network: {},
    reticle_console: { level: 'error' },
    reticle_wait_for: { until: { kind: 'settled', quietMs: 50 }, timeout_ms: 1000 },
    reticle_assert: { until: { kind: 'settled', quietMs: 50 } },
    reticle_state: {},
    reticle_session: { action: 'tune', idleEndMs: 300000 },
    reticle_feedback: { kind: 'experience', text: 'profile run', rating: 5 },
    reticle_intent: { action: 'list' },
    reticle_capabilities: {},
    reticle_tools: {},
    reticle_run: { tool: 'reticle_sessions', args: {} },
    reticle_storage: {},
    reticle_clock: { reset: true },
    reticle_screenshot: { name: 'profile-test' },
    reticle_visual_diff: { baseline: 'none' },
    reticle_network_mock: { clear: true },
    reticle_verify: { action: 'coverage' },
    reticle_verify_change: { files: [] },
    reticle_flow: { action: 'list' },
    reticle_flow_list: {},
    reticle_flow_load: { flowName: 'temp' },
    reticle_flow_save: { flowName: 'temp' },
    reticle_flow_replay: { flowName: 'temp' },
    reticle_flow_verify: { names: [] },
    reticle_record: { action: 'start', recordingName: 'temp' },
    reticle_baseline: { action: 'list' },
    reticle_baseline_list: {},
    reticle_diff: { baseline: 'default' },
    reticle_crawl: { maxSteps: 1 },
    reticle_scroll_to: { target: { by: 'testid', value: 'login-email' } },
    reticle_viewport: { width: 1280, height: 800 },
    reticle_annotate: { flow: 'temp', kind: 'step-intent' },
    reticle_coverage: {},
    reticle_project: {},
    reticle_reconcile: {},
    reticle_lease: { action: 'status' },
    reticle_lease_acquire: {},
    reticle_lease_release: { leaseId: 'none' },
    reticle_domain: { action: 'status' },
    reticle_contract_save: { contractName: 'temp' },
    reticle_run_export: { runId: 'none' },
    reticle_run_record: { name: 'profile-test', outcome: 'pass' },
    reticle_review: { action: 'list' },
    reticle_messages: {},
    reticle_yield: {},
    reticle_resume: {},
    reticle_wait_ready: { timeoutMs: 1000 },
  };

  return ARGS_MAP[name] ?? {};
}

async function callToolMeasured(client, toolDef, ctx, timeoutMs = 20000) {
  const name = toolDef.name;
  const rawArgs = resolveToolArgs(name, ctx);
  const acceptsSession = Boolean(toolDef.inputSchema?.properties?.sessionId);
  const finalArgs =
    acceptsSession && ctx.sessionId ? { sessionId: ctx.sessionId, ...rawArgs } : { ...rawArgs };

  if ('reticle_inspect' === name && (!finalArgs.ref || 'e1' === finalArgs.ref)) {
    try {
      const qRes = await client.request('tools/call', {
        name: 'reticle_query',
        arguments: {
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          by: 'testid',
          value: 'login-email',
        },
      });
      const qText = (qRes?.content ?? [])
        .filter((c) => 'text' === c.type)
        .map((c) => c.text)
        .join('\n');
      const qObj = JSON.parse(qText || '{}');
      const elements = qObj.elements ?? qObj.matches ?? qObj.results ?? [];
      if (elements[0]?.ref) {
        finalArgs.ref = elements[0].ref;
      }
    } catch {
      /* fallback */
    }
  }

  if ('reticle_flow_save' === name || 'reticle_flow_replay' === name) {
    try {
      await client.request('tools/call', {
        name: 'reticle_record',
        arguments: {
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          action: 'start',
          recordingName: 'temp',
        },
      });
      await client.request('tools/call', {
        name: 'reticle_act',
        arguments: {
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          target: { by: 'testid', value: 'login-email' },
          action: 'focus',
        },
      });
      await client.request('tools/call', {
        name: 'reticle_record',
        arguments: {
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          action: 'stop',
          recordingName: 'temp',
        },
      });
    } catch {
      /* best effort */
    }
  }

  const t0 = process.hrtime.bigint();
  let result = null;
  let isError = false;
  let protocolError = null;
  let timedOut = false;
  let text = '';

  try {
    result = await client.request('tools/call', { name, arguments: finalArgs }, timeoutMs);
    isError = true === result?.isError;
    text = (result?.content ?? [])
      .filter((c) => 'text' === c.type)
      .map((c) => c.text)
      .join('\n');

    if ('reticle_navigate' === name) {
      await sleep(1000);
      try {
        const sRes = await client.request('tools/call', {
          name: 'reticle_sessions',
          arguments: {},
        });
        const sText = (sRes?.content ?? [])
          .filter((c) => 'text' === c.type)
          .map((c) => c.text)
          .join('\n');
        const parsed = JSON.parse(sText || '{}');
        const sessions = parsed.sessions ?? [];
        const mine = sessions.find((s) => 'string' === typeof s.url && s.url.startsWith(ctx.url));
        ctx.sessionId = (mine ?? sessions[sessions.length - 1])?.sessionId ?? null;
      } catch {
        /* best effort */
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/timeout/i.test(msg)) {
      timedOut = true;
    } else {
      protocolError = msg;
    }
  }

  const t1 = process.hrtime.bigint();
  const latencyMs = Number(t1 - t0) / 1e6;
  const m = measure(text);

  return {
    tool: name,
    latency_ms: Math.round(latencyMs),
    is_error: isError,
    protocol_error: protocolError,
    timed_out: timedOut,
    bytes: m.bytes,
    chars: m.chars,
    tokens_o200k: m.tokens_o200k,
    success: !isError && null === protocolError && !timedOut,
    text_preview: text.slice(0, 120),
  };
}

function writeToolProfileMarkdown(allFixtureResults) {
  const mdPath = join('bench', 'TOOL-PROFILE.md');
  const dateStr = new Date().toISOString().slice(0, 10);

  const lines = [
    '# Tool profile',
    '',
    '> Per-tool latency, token cost, payload size, and status under a held-open MCP link across fixtures.',
    '> Generated by `node bench/harness/tool-profile.mjs` — do not edit by hand.',
    '',
  ];

  for (const [fixtureId, fixtureData] of Object.entries(allFixtureResults)) {
    const { results, summary } = fixtureData;
    lines.push(`## Fixture: \`${fixtureId}\``);
    lines.push('');
    lines.push(
      `**${summary.total} tools profiled** · ${summary.passed}/${summary.total} passed · mean latency: ${summary.mean_latency_ms}ms · ${dateStr}`,
    );
    lines.push('');
    lines.push('| Tool | Latency | Tokens | Bytes | Status |');
    lines.push('| --- | ---: | ---: | ---: | :---: |');

    for (const r of results) {
      const statusStr = r.success
        ? '✓ PASS'
        : r.timed_out
          ? '✗ TIMEOUT'
          : r.is_error
            ? '✗ ERROR'
            : '✗ RPC_FAIL';
      const tokenStr =
        null !== r.tokens_o200k && undefined !== r.tokens_o200k ? String(r.tokens_o200k) : '-';
      lines.push(`| \`${r.tool}\` | ${r.latency_ms}ms | ${tokenStr} | ${r.bytes} | ${statusStr} |`);
    }
    lines.push('');
  }

  writeFileSync(mdPath, lines.join('\n'), 'utf8');
  console.log(`Wrote markdown summary to ${mdPath}`);
}

process.on('SIGINT', () => {
  cleanupDaemon();
  teardownFixtures();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanupDaemon();
  teardownFixtures();
  process.exit(143);
});
process.on('exit', () => {
  cleanupDaemon();
  teardownFixtures();
});

// ---------------------------------------------------------------------------
// Main Runner across all configured fixtures
// ---------------------------------------------------------------------------
const multiResults = {};
const toolFailureStacks = new Map(); // toolName -> Set of fixtureIds where it failed
let totalToolsProfiledCount = 0;

for (const fixture of FIXTURES) {
  if (!NO_BOOT) {
    await bootFixture(fixture);
  }

  cleanupDaemon();
  if (!(await waitForPortFree(RETICLE_PORT))) {
    teardownFixtures();
    console.error(`\n✗ daemon port ${RETICLE_PORT} is not free.`);
    process.exit(1);
  }

  console.log(`\ntool-profile: starting Reticle MCP daemon driving ${fixture.url}...`);
  const client = new McpStdioClient(
    'node',
    [RETICLE_CLI, 'mcp', '--port', RETICLE_PORT, '--drive', fixture.url],
    { RETICLE_PORT, RETICLE_ADVERTISE_ALL_TOOLS: '1' },
  );

  await client.start();
  await sleep(RETICLE_READY_MS);

  // 1. Pin the session
  let sessionId = null;
  try {
    const sessRes = await client.request('tools/call', { name: 'reticle_sessions', arguments: {} });
    const sessText = (sessRes?.content ?? [])
      .filter((c) => 'text' === c.type)
      .map((c) => c.text)
      .join('\n');
    const parsed = JSON.parse(sessText || '{}');
    const sessions = parsed.sessions ?? [];
    const mine = sessions.find((s) => 'string' === typeof s.url && s.url.startsWith(fixture.url));
    sessionId = (mine ?? sessions[sessions.length - 1])?.sessionId;
  } catch {
    /* leave unpinned */
  }

  // 2. Warm up context: navigate, query a live ref, compile a 1-step recording
  const ctx = { url: fixture.url, sessionId, ref: null };
  try {
    await client.request('tools/call', {
      name: 'reticle_navigate',
      arguments: { ...(sessionId ? { sessionId } : {}), url: fixture.url },
    });
    await sleep(1000);
    try {
      const sessRes = await client.request('tools/call', {
        name: 'reticle_sessions',
        arguments: {},
      });
      const sessText = (sessRes?.content ?? [])
        .filter((c) => 'text' === c.type)
        .map((c) => c.text)
        .join('\n');
      const parsed = JSON.parse(sessText || '{}');
      const sessions = parsed.sessions ?? [];
      const mine = sessions.find((s) => 'string' === typeof s.url && s.url.startsWith(fixture.url));
      sessionId = (mine ?? sessions[sessions.length - 1])?.sessionId ?? sessionId;
      ctx.sessionId = sessionId;
    } catch {
      /* best effort */
    }

    await client.request('tools/call', {
      name: 'reticle_query',
      arguments: { ...(sessionId ? { sessionId } : {}), by: 'testid', value: 'login-email' },
    });
    // Warm up a compiled recording so reticle_flow_save has a valid flow to persist
    await client.request('tools/call', {
      name: 'reticle_record',
      arguments: { ...(sessionId ? { sessionId } : {}), action: 'start', recordingName: 'temp' },
    });
    await client.request('tools/call', {
      name: 'reticle_act',
      arguments: {
        ...(sessionId ? { sessionId } : {}),
        target: { by: 'testid', value: 'login-email' },
        action: 'focus',
      },
    });
    await client.request('tools/call', {
      name: 'reticle_record',
      arguments: { ...(sessionId ? { sessionId } : {}), action: 'stop', recordingName: 'temp' },
    });
  } catch {
    /* best effort */
  }

  // 3. Discover advertised tools dynamically
  const tools = await client.listTools();
  console.log(
    `Discovered ${tools.length} advertised tools for [${fixture.name}]. Profiling on single MCP connection...\n`,
  );

  const results = [];
  for (const tool of tools) {
    if (SKIP_TOOLS.has(tool.name)) {
      continue;
    }
    const record = await callToolMeasured(client, tool, ctx);
    results.push(record);

    if (!record.success) {
      if (!toolFailureStacks.has(tool.name)) {
        toolFailureStacks.set(tool.name, new Set());
      }
      toolFailureStacks.get(tool.name).add(fixture.id);
    }
  }

  await client.stop();
  cleanupDaemon();
  if (!NO_BOOT) {
    teardownFixtures();
  }

  const passed = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  const failingTools = failed.map((r) => ({
    tool: r.tool,
    reason: r.timed_out ? 'timeout' : r.is_error ? 'isError' : r.protocol_error,
  }));
  const totalMs = results.reduce((acc, r) => acc + r.latency_ms, 0);
  const meanLatency = results.length > 0 ? Math.round(totalMs / results.length) : 0;

  const summary = {
    total: results.length,
    passed: passed.length,
    failed: failed.length,
    mean_latency_ms: meanLatency,
    failing_tools: failingTools,
  };

  multiResults[fixture.id] = {
    fixtureName: fixture.name,
    tools_profiled: results.length,
    results,
    summary,
  };
  totalToolsProfiledCount = results.length;

  // 4. Print formatted summary table for this fixture
  console.log('\n' + '='.repeat(80));
  console.log(` RETICLE TOOL PROFILE — ${fixture.name.toUpperCase()}`);
  console.log('='.repeat(80));
  console.log(
    ' Tool'.padEnd(30) +
      ' | ' +
      'Latency'.padStart(8) +
      ' | ' +
      'Tokens'.padStart(8) +
      ' | ' +
      'Bytes'.padStart(8) +
      ' | ' +
      'Status',
  );
  console.log('-'.repeat(80));

  for (const r of results) {
    const statusStr = r.success
      ? '✓ PASS'
      : r.timed_out
        ? '✗ TIMEOUT'
        : r.is_error
          ? '✗ ERROR'
          : '✗ RPC_FAIL';
    console.log(
      ` ${r.tool.padEnd(28)} | ${(r.latency_ms + 'ms').padStart(8)} | ${String(r.tokens_o200k ?? '-').padStart(8)} | ${String(r.bytes).padStart(8)} | ${statusStr}`,
    );
  }
  console.log('='.repeat(80));
}

// Write JSON output
const output = buildToolProfileOutput(
  multiResults,
  FIXTURES.map((f) => f.id),
  totalToolsProfiledCount,
);

const rawPath = join('bench', 'raw', 'tool-profile.json');
mkdirSync(join('bench', 'raw'), { recursive: true });
writeFileSync(rawPath, JSON.stringify(output, null, 2));
console.log(`\nWrote JSON profile to ${rawPath}`);

// Write Markdown table
writeToolProfileMarkdown(multiResults);

// Final Actionable Human Summary Sentence
const totalStacks = FIXTURES.length;
if (toolFailureStacks.size > 0) {
  console.log('\n' + '!'.repeat(80));
  for (const [toolName, failingStacks] of toolFailureStacks.entries()) {
    const count = failingStacks.size;
    const stackList = Array.from(failingStacks).join(', ');
    console.log(
      `✗ ${toolName} is failing on ${count} of ${totalStacks} stacks (${stackList}) — fix it`,
    );
  }
  console.log('!'.repeat(80));
  process.exit(1);
} else {
  console.log(
    `\n✓ All ${totalToolsProfiledCount} advertised tools passed across all ${totalStacks} stack(s) successfully.`,
  );
  process.exit(0);
}
