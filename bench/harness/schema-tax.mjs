// The per-request MCP tool-schema tax: tokens an agent pays on EVERY request just to have the tools
// available, before it does any work.
//
// This is the cost the field is currently organised around. Microsoft's own playwright-mcp README now
// steers coding agents to the CLI over MCP explicitly because "CLI invocations are more token-efficient:
// they avoid loading large tool schemas"; a filed issue measures the default Playwright MCP tool list at
// 14.4k tokens = 7.2% of a Claude Code context window
// (https://github.com/microsoft/playwright-mcp/issues/1290), and chrome-devtools-mcp is reported near
// 17k. Users respond by turning the servers off — "there is absolutely no reason I'd keep it enabled".
//
// The previous artifact for this metric was measured once, under the project's OLD name, against the
// then-57-tool FULL surface, and was never re-run. It has been quoted since as though it described the
// shipping default. It did not: the default is `hybrid`. Every number below is measured live, in one
// run, through the same client and the same counter, so the comparison is arithmetic rather than
// archaeology.
//
//   node bench/harness/schema-tax.mjs            # all servers
//   node bench/harness/schema-tax.mjs reticle    # ours only (no network install)
import { writeFileSync } from 'node:fs';
import { McpStdioClient, RETICLE_CLI as CLI } from './mcp-client.mjs';
import { measure } from './tokenizer.mjs';

/** Ours, one entry per advertised profile — the whole point is that the DEFAULT is what gets paid. */
// There is one tool surface plus the ALL verification switch — `dynamic`, `core`, `hybrid` and
// `standard` were retired (see packages/server/src/tools/tool-surface.ts). Measured per surface here.
const RETICLE_SURFACES = [
  { label: 'default', env: {} },
  { label: 'all', env: { RETICLE_ADVERTISE_ALL_TOOLS: '1' } },
  // The two trimmed surfaces. Measured here rather than reasoned about, because the whole claim being
  // tested is that the MENU is most of the bill — and that claim is only checkable off the wire.
  { label: 'verify', env: { RETICLE_VERIFY_SURFACE: '1' } },
  { label: 'lean', env: { RETICLE_TOOL_PROFILE: 'lean' } },
];

const COMPETITORS = {
  playwright_mcp: {
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.76', '--headless', '--isolated'],
    env: {},
  },
  chrome_devtools_mcp: {
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@1.3.0', '--headless', '--isolated'],
    env: {},
  },
};

async function taxOf(command, args, env) {
  const client = new McpStdioClient(command, args, env);
  await client.start();
  try {
    const tools = await client.listTools();
    // Count the exact bytes the server puts on the wire for tools/list — not a re-serialization of an
    // internal structure, which is how the stale artifact ended up describing a surface nobody ships.
    const text = JSON.stringify(tools);
    const m = measure(text);
    return { tool_count: tools.length, schema_chars: m.chars, schema_tokens: m.tokens_o200k };
  } finally {
    await client.stop();
  }
}

const only = process.argv[2];
const results = {};

let port = 4480;
for (const surface of RETICLE_SURFACES) {
  const p = String(port++);
  results[`reticle_${surface.label}`] = await taxOf('node', [CLI, 'mcp', '--port', p], {
    RETICLE_PORT: p,
    ...surface.env,
  });
  console.log(`reticle:${surface.label}`, JSON.stringify(results[`reticle_${surface.label}`]));
}

if (only !== 'reticle') {
  for (const [name, cfg] of Object.entries(COMPETITORS)) {
    try {
      results[name] = await taxOf(cfg.command, cfg.args, cfg.env);
      console.log(name, JSON.stringify(results[name]));
    } catch (e) {
      // A network-install failure must not be recorded as a zero — a missing measurement and a free
      // competitor are opposite claims.
      results[name] = { error: String(e).slice(0, 160) };
      console.log(name, 'NOT MEASURED:', results[name].error);
    }
  }
}

const def = results['reticle_hybrid'];
const pw = results['playwright_mcp'];
const summary = {
  metric: 'per-request MCP tool-schema tax (tokens paid on every request before any work)',
  measured_at_utc: process.env.BENCH_STAMP ?? null,
  results,
  finding:
    def && pw && 'number' === typeof pw.schema_tokens
      ? `reticle default (hybrid) = ${def.schema_tokens} tok vs playwright_mcp = ${pw.schema_tokens} tok ` +
        `(ratio ${(def.schema_tokens / pw.schema_tokens).toFixed(2)}x). reticle dynamic = ` +
        `${results['reticle_dynamic']?.schema_tokens} tok.`
      : 'competitor not measured in this run — no ratio claimed',
};
writeFileSync('bench/raw/schema-tax.json', JSON.stringify(summary, null, 2));
console.log('\n' + summary.finding);
process.exit(0);
