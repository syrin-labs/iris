// Layer B: REAL full agent-loop, authoritative token usage.
//
// For each (scenario, tool): spawn the tool's MCP server, expose its tools to a real
// Claude model via the Messages API tool-use loop, give the canonical NL task, let the
// MODEL choose calls until it emits a verdict, and record usage.input_tokens /
// output_tokens summed across turns (the authoritative Anthropic count) + latency +
// whether the verdict matches expectation.
//
// REQUIRES: ANTHROPIC_API_KEY. Without it this prints a clear NOT MEASURED notice and
// exits 0 — it never fabricates numbers. Run AFTER `inject` wiring is in place; this
// reuses adapters' server spawn config + the same scenario definitions as Layer A.
//
//   ANTHROPIC_API_KEY=sk-... node bench/harness/claude-agent-loop.mjs [scenarioId]
//
import { writeFileSync } from 'node:fs';
import { McpStdioClient } from './mcp-client.mjs';
import { inject, revert, revertAll } from './inject.mjs';
import { RETICLE_PORT } from './ports.mjs';
import { guidanceBytes } from './guidance-share.mjs';

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.BENCH_MODEL ?? 'claude-haiku-4-5-20251001';
const URL = 'http://localhost:4312/';
// Raised from 12 after every unfinished cell in a five-scenario run turned out to be sitting exactly
// on the old ceiling. These tasks log in, navigate, act and then read a channel; twelve turns did not
// reach the answer for ANY of the three tools, so what looked like four scenarios' worth of detection
// data was four scenarios' worth of the same budget running out.
const MAX_TURNS = Number(process.env.BENCH_MAX_TURNS ?? 25);

if (!KEY) {
  console.log(
    JSON.stringify(
      {
        layer: 'B',
        status: 'NOT MEASURED',
        reason:
          'ANTHROPIC_API_KEY not set. Layer B (agent-reasoning token usage) cannot be measured without it. Set the key and re-run; numbers will come straight from the API usage object.',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const SERVERS = {
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
  reticle: {
    command: 'node',
    args: ['packages/server/dist/cli.js', 'mcp', '--port', RETICLE_PORT, '--drive', URL],
    env: { RETICLE_PORT },
  },
};

// Canonical NL task per scenario (verbatim across tools), plus the expected verdict.
const TASKS = {
  'hidden-api-500': {
    regression: null,
    expectIssue: true,
    task: `Open ${URL}, log in with admin@reticle.dev / password, go to the Diagnostics page and click the "500 Server Error" fault button. Then determine whether the app made any failing network request. Report PASS if everything is healthy or FAIL if a request failed, with the status code.`,
  },
  'console-error-intact-ui': {
    regression: null,
    expectIssue: true,
    task: `Open ${URL}, log in with admin@reticle.dev / password, go to Diagnostics and click the buggy chart widget. Determine whether the application logged any error. Report PASS (healthy) or FAIL (error) and quote the error.`,
  },
  'route-transition-break': {
    regression: 'route-transition-break',
    expectIssue: true,
    task: `Open ${URL}, log in (admin@reticle.dev / password), then click the "Compose" navigation item. Verify the Compose view actually renders (it has a prompt box and a Generate button). Report PASS if it renders, FAIL if navigation did nothing.`,
  },
  // The control is labelled "New deploy". The task said "New deployment", which is the modal's
  // heading, not the button — so all three tools spent their whole budget hunting a control that
  // does not exist and the scenario scored three identical exhaustions. A benchmark task that names
  // the wrong control measures the fixture's naming, not the tools.
  'missing-modal': {
    regression: 'missing-modal',
    expectIssue: true,
    task: `Open ${URL}, log in (admin@reticle.dev / password), go to Deployments and click "New deploy". Verify the new-deployment modal opens. Report PASS if it opens, FAIL if no modal appears.`,
  },
  'no-regression-control': {
    regression: null,
    expectIssue: false,
    task: `Open ${URL}, log in (admin@reticle.dev / password), and verify the Overview page is healthy (KPI cards + traffic chart render, no errors). Report PASS if healthy, FAIL if anything is broken.`,
  },
};

function mcpToolsToAnthropic(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: (t.description ?? '').slice(0, 900),
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
  }));
}

async function callAnthropic(messages, tools, system) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, tools, messages }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function runCell(scenarioId, toolKey) {
  const sc = TASKS[scenarioId];
  const cfg = SERVERS[toolKey];
  const client = new McpStdioClient(cfg.command, cfg.args, cfg.env);
  const t0 = Date.now();
  let inTok = 0,
    outTok = 0,
    turns = 0,
    verdictText = '';
  // Measured here rather than argued about later.
  //
  // A competitor's browser tool never tells the agent what to instrument or what to call next, so
  // counting those bytes against us compares the wrong thing. They are summed from the ACTUAL tool
  // results this run fed the model — never estimated — and the classification lives in
  // guidance-share.mjs, where every uncertainty is resolved against us on purpose.
  let resultBytes = 0,
    guideBytes = 0;
  // WHICH tools the model chose, in order.
  //
  // Added after a run nobody could explain: Reticle's agent reported PASS on a modal that never
  // opened, saying in its own words that the app's signal "doesn't negate" what the snapshot showed.
  // Whether the engine's own guard even ran depends entirely on which calls it made — a verdict tool
  // carries the contradiction, a plain read does not — and the rows recorded no way to tell.
  const toolCalls = [];
  try {
    // Pass each server's OWN `instructions` through, exactly as a real MCP client does.
    //
    // The handshake returns them and this harness was throwing them away — for all three servers,
    // so the unfairness is symmetric, but the CONSEQUENCE is not. A browser-driving server's
    // instructions say little; Reticle's carry the rule that only two of its tools produce a
    // verdict at all. Three runs were read as "the agent lives on the read path and never asks for
    // a verdict" before anyone checked whether it had ever been told there was one — which would
    // have been a product conclusion drawn from a harness defect, and a change made on top of it.
    //
    // Discarding them also makes the comparison less like the thing being sold: every real client
    // (Claude Code, Cursor) receives them.
    const init = await client.start();
    if ('reticle' === toolKey) await new Promise((r) => setTimeout(r, 3500));
    const tools = mcpToolsToAnthropic(await client.listTools());
    const serverInstructions =
      'string' === typeof init?.instructions && '' !== init.instructions
        ? `\n\nThe tool server you are connected to provides these instructions:\n${init.instructions}`
        : '';
    const system =
      'You are a verification agent with browser tools. Use them to complete the task, then end your final message with exactly "VERDICT: PASS" or "VERDICT: FAIL".' +
      serverInstructions;
    const messages = [{ role: 'user', content: sc.task }];
    for (turns = 0; turns < MAX_TURNS; turns++) {
      const resp = await callAnthropic(messages, tools, system);
      inTok += resp.usage?.input_tokens ?? 0;
      outTok += resp.usage?.output_tokens ?? 0;
      messages.push({ role: 'assistant', content: resp.content });
      const toolUses = resp.content.filter((c) => 'tool_use' === c.type);
      const textParts = resp.content
        .filter((c) => 'text' === c.type)
        .map((c) => c.text)
        .join('\n');
      if (textParts) verdictText += '\n' + textParts;
      if (resp.stop_reason !== 'tool_use' || 0 === toolUses.length) break;
      const results = [];
      for (const tu of toolUses) {
        try {
          toolCalls.push(tu.name);
          const out = await client.callTool(tu.name, tu.input, 60000);
          const sent = out.text.slice(0, 8000);
          resultBytes += Buffer.byteLength(sent, 'utf8');
          guideBytes += guidanceBytes(sent);
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: sent,
          });
        } catch (e) {
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `error: ${String(e).slice(0, 200)}`,
            is_error: true,
          });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    // A cell that ran out of budget is NOT a cell that failed to decide, and collapsing the two is
    // how this harness reported a ceiling of its own as a property of the tools under test. Eight of
    // twelve cells in one run read "NO VERDICT" and every one of them had simply been cut off.
    const exhausted = turns >= MAX_TURNS;
    const said = /VERDICT:\s*FAIL/i.test(verdictText)
      ? true
      : /VERDICT:\s*PASS/i.test(verdictText)
        ? false
        : null;
    const detected = said; // issue detected == verdict FAIL
    return {
      scenario: scenarioId,
      tool: toolKey,
      layer: 'B',
      token_input: inTok,
      token_output: outTok,
      total_tokens: inTok + outTok,
      // Recorded so a run can never again be read as if the server had spoken when it had not.
      server_instructions_bytes: Buffer.byteLength(serverInstructions, 'utf8'),
      // Exact byte counts, not a token estimate.
      //
      // `total_tokens` is Anthropic's authoritative number for the WHOLE conversation — system
      // prompt, tool schemas and assistant turns included — so no honest per-field token count can
      // be carved out of it. What CAN be measured exactly is how many bytes of guidance this run
      // put in front of the model, and what share of its tool payload that was. A reader can apply
      // that share themselves; the raw total stays the number to quote if they distrust the
      // adjustment, which is why it is reported unmodified beside it.
      tool_calls: toolCalls,
      tool_result_bytes: resultBytes,
      guidance_bytes: guideBytes,
      guidance_share: 0 === resultBytes ? 0 : Number((guideBytes / resultBytes).toFixed(4)),
      latency_ms: Date.now() - t0,
      turns,
      verdict:
        null === said
          ? exhausted
            ? 'BUDGET EXHAUSTED'
            : 'NO VERDICT'
          : said
            ? 'ISSUE DETECTED'
            : 'NO ISSUE FOUND',
      // Explicit, so a summary built from these rows cannot average a ceiling in with a result.
      measured: null !== said,
      detected_issue: detected,
      expected_detect: sc.expectIssue,
      confidence: null === said ? null : detected === sc.expectIssue ? 1 : 0,
      notes: `model=${MODEL}; turns=${turns}; verdict_excerpt=${verdictText.trim().slice(-160)}`,
    };
  } catch (e) {
    return {
      scenario: scenarioId,
      tool: toolKey,
      layer: 'B',
      verdict: 'NOT MEASURED',
      notes: `error: ${String(e).slice(0, 200)}`,
    };
  } finally {
    await client.stop();
    if ('reticle' === toolKey) {
      try {
        const { execFileSync } = await import('node:child_process');
        execFileSync(
          'node',
          ['packages/server/dist/cli.js', 'stop', '--port', RETICLE_PORT, '--quiet'],
          {
            stdio: 'ignore',
          },
        );
      } catch {
        /* */
      }
    }
  }
}

const only = process.argv[2];
const scns = only ? [only] : Object.keys(TASKS);
const rows = [];
for (const s of scns) {
  const reg = TASKS[s].regression;
  if (reg) {
    inject(reg);
    await new Promise((r) => setTimeout(r, 500));
  }
  // One tool at a time when asked. Re-measuring competitors that were already measured spends real
  // API budget to reproduce a number nobody doubts, and a three-tool pass is long enough that a
  // diagnostic re-run of the ONE cell in question kept being cut off before it finished.
  const only = (process.env.BENCH_ONLY_TOOLS ?? '').split(',').filter(Boolean);
  const tools = 0 === only.length ? ['playwright_mcp', 'chrome_devtools_mcp', 'reticle'] : only;
  for (const tool of tools) {
    const row = await runCell(s, tool);
    rows.push(row);
    console.log(
      JSON.stringify({
        s: row.scenario,
        t: row.tool,
        in: row.token_input,
        out: row.token_output,
        ms: row.latency_ms,
        v: row.verdict,
      }),
    );
  }
  if (reg) revert(reg);
}
revertAll();
writeFileSync('bench/raw/agent-loop-results.json', JSON.stringify(rows, null, 2));
console.log(`\nwrote ${rows.length} Layer B rows`);
process.exit(0);
