/**
 * Do-and-verify: give an agent a broken app, a way to edit it, a way to drive it, and one job —
 * fix it AND confirm the fix works. Then ask something OUTSIDE the run whether it actually does.
 *
 * ## Why this exists when a fix-loop ablation already does
 *
 * `bench/fix-loop` answers "is it fixed?" with `!fileText.includes(marker)`. Its own README calls
 * behaviour-level verification the upgrade. That gap is not a detail here: an agent that deletes the
 * marker and leaves the feature broken scores as a CORRECT FIX under a string check, so a
 * string-checked benchmark is structurally incapable of seeing a false green — and the false green
 * is the entire question.
 *
 * The detection benchmark next door has the opposite limitation: the bug is already planted, the
 * agent is told where to look, and it never writes a line of code or decides for itself that it is
 * finished. Neither measures the thing a user actually buys.
 *
 * ## What is measured
 *
 * - **claimed** — the agent said FIXED.
 * - **works** — the independent Playwright oracle says a user can do the thing. Never shares a
 *   tool, a session or a process with any arm; an oracle that shares machinery is a contestant.
 * - **FALSE GREEN** — claimed and does not work. The headline. It is the failure a verification
 *   tool exists to prevent, and the only one that costs a user their trust rather than their time.
 * - **silent miss** — did not claim and does not work. Honest failure: expensive, not dangerous.
 * - **unreported success** — works and did NOT claim. Added after the very first cell produced one:
 *   the agent fixed the bug, drove the app for thirty turns, and never concluded. It is the mirror
 *   of a false green and it is still a failure of the verification loop — the work was done and the
 *   user cannot be told so. Cheap where a false green is expensive, and invisible unless named,
 *   which is why the first run of a new benchmark is worth reading before trusting its categories.
 *
 * ## The arms
 *
 * Three MCP servers, plus Vercel's `agent-browser` as a CLI — which is how Vercel ships it. Putting
 * it behind a community MCP wrapper would measure the wrapper and would flatter the MCP arms, since
 * the argument for the CLI is precisely that it avoids a tool surface re-sent every turn. So it gets
 * one `run_agent_browser` tool and its own `skills` documentation to discover itself with, which is
 * the shape its own AGENTS.md tells agents to use.
 *
 * Every arm gets the same file tools, the same task text, the same model and the same turn budget.
 */
import { writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { McpStdioClient } from '../harness/mcp-client.mjs';
import { inject, revert } from '../harness/inject.mjs';
import { appWorks, oracleBugIds } from './oracle.mjs';
import { RETICLE_PORT } from '../harness/ports.mjs';

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.BENCH_MODEL ?? 'claude-haiku-4-5-20251001';
const URL = 'http://localhost:4312/';
const MAX_TURNS = Number(process.env.DV_MAX_TURNS ?? 30);
const ROOT = resolve(process.cwd());
/** A port of its own, so the lean daemon can never be answered by a default one left running. */
const LEAN_PORT = process.env.DV_LEAN_PORT ?? '4461';
/** The agent may read and write here and nowhere else. */
const APP_SRC = join(ROOT, 'apps/bench-app/src');

if (!KEY) {
  console.log(
    JSON.stringify({ status: 'NOT MEASURED', reason: 'ANTHROPIC_API_KEY not set' }, null, 2),
  );
  process.exit(0);
}

/** Symptom, never cause. Naming the file or the line would hand over the half being measured. */
const TASKS = {
  'missing-modal':
    'Users report that on the Deployments page, clicking the "New deploy" button does nothing — the new-deployment dialog never appears.',
  'route-transition-break':
    'Users report that clicking "Compose" in the sidebar does nothing — the Compose view never appears.',
  'silent-dom-regression':
    'Users report that the Overview page is missing one of its KPI cards — only three are shown where there should be four.',
  // The two QUIET ones. Both render perfectly and are only visible if you try the exact case, which
  // is where a claim outruns its evidence — the whole reason the loud-only set produced no false
  // greens to measure.
  'cross-component-regression':
    'Users report that on the Deployments page, typing in the service filter box no longer filters the table — the same rows stay on screen whatever they type.',
  'broken-form-validation':
    'Users report that the new-deployment form accepts a service name that is only spaces, and lets them submit it.',
};

/**
 * Every task must have an oracle and every oracle must have a task.
 *
 * The first long-horizon run reported `verified: 3/3` while its write-up said five bugs. `TASKS`
 * carried three and the runner derived the bug list from it, so the two QUIET defects — the entire
 * reason for the redesign — were never injected and nothing complained. A benchmark that silently
 * narrows its own scope reports a clean sweep over whatever it happened to run, which is the same
 * silent-truncation failure the harness ceiling and the withheld instructions already were.
 */
function assertScopeIsWhatItClaims(taskIds, oracleIds) {
  const missing = taskIds.filter((t) => !oracleIds.includes(t));
  const orphan = oracleIds.filter((o) => !taskIds.includes(o));
  if (0 !== missing.length || 0 !== orphan.length) {
    throw new Error(
      `task/oracle mismatch — tasks without oracles: [${missing}]; oracles without tasks: [${orphan}]`,
    );
  }
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
  /**
   * The same server advertising the LEAN surface — ten tools instead of eighteen.
   *
   * Not a separate product: `RETICLE_TOOL_PROFILE=lean` is read by the daemon at start, everything
   * unadvertised stays callable through `reticle_run`, and the default arm above is its control.
   *
   * It is here because the cost decomposition pointed at it. On one bug we spent 2x the turns AND
   * carried 21,319 bytes of tool schema re-sent every turn against Playwright's 14,639 — 83% of it
   * parameter descriptions rather than tool descriptions. Lean is the only way to price that
   * without trimming prose by eye, which is the one thing the evidence forbids: those descriptions
   * are what make a call land, and one malformed call costs a whole turn — more than the bytes
   * saved. So the question this arm answers is not "is it smaller" but "does it stay correct".
   */
  reticle_lean: {
    command: 'node',
    args: ['packages/server/dist/cli.js', 'mcp', '--port', LEAN_PORT, '--drive', URL],
    env: { RETICLE_PORT: LEAN_PORT },
    // The profile has to be on the DAEMON, and putting it on the proxy silently does nothing.
    //
    // Measured while wiring this arm: `RETICLE_TOOL_PROFILE=lean` passed to `cli.js mcp` produced
    // eighteen tools and a byte-identical schema — the default surface, benchmarked twice under two
    // names. Starting the daemon itself with it produces ten. The env is read where the surface is
    // computed, and the proxy accepts the variable, ignores it, and reports nothing. Anybody
    // following the changelog's own instruction on the wrong process gets the same silence.
    preStart: {
      command: 'node',
      args: ['packages/server/dist/cli.js', '_daemon', '--port', LEAN_PORT],
      env: { RETICLE_TOOL_PROFILE: 'lean', RETICLE_PORT: LEAN_PORT },
    },
  },
};
export const ARMS = [...Object.keys(SERVERS), 'agent_browser_cli'];
/** Both Reticle arms own the daemon port, so both must hand it back before the next cell. */
const OWNS_DAEMON = (arm) => 'reticle' === arm || 'reticle_lean' === arm;

// ── file tools, identical for every arm ────────────────────────────────────────────────────────
const safe = (p) => {
  const full = resolve(APP_SRC, p.replace(/^\/+/, ''));
  if (!full.startsWith(APP_SRC)) throw new Error('path outside apps/bench-app/src');
  return full;
};
const walk = (dir, out = [], base = APP_SRC) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out, base);
    else out.push(p.slice(base.length + 1));
  }
  return out;
};
const FILE_TOOLS = [
  {
    name: 'list_files',
    description: 'List every source file in the app, relative to its src directory.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_file',
    description: 'Read one source file.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Overwrite one source file with new contents. The dev server hot-reloads.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, contents: { type: 'string' } },
      required: ['path', 'contents'],
    },
  },
];
function runFileTool(name, input) {
  if ('list_files' === name) return walk(APP_SRC).join('\n');
  if ('read_file' === name) return readFileSync(safe(input.path), 'utf8');
  if ('write_file' === name) {
    writeFileSync(safe(input.path), String(input.contents));
    return `wrote ${input.path}`;
  }
  throw new Error(`unknown file tool ${name}`);
}

// ── the CLI arm ────────────────────────────────────────────────────────────────────────────────
const CLI_TOOL = {
  name: 'run_agent_browser',
  description:
    "Run Vercel's agent-browser CLI. Pass the arguments only, without the leading `agent-browser`. " +
    'Start with `skills get core --full` for the full command reference, exactly as its own docs advise. ' +
    'Example args: "open http://localhost:4312/", "read", "click @ref", "snapshot".',
  input_schema: { type: 'object', properties: { args: { type: 'string' } }, required: ['args'] },
};
function runCli(argString) {
  return new Promise((res) => {
    const args =
      argString.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? [];
    execFile(
      'npx',
      ['-y', 'agent-browser@latest', ...args],
      { timeout: 60_000, maxBuffer: 4e6 },
      (err, out, errOut) =>
        res(
          ((out ?? '') + (errOut ?? '')).trim() ||
            (err ? `error: ${String(err).slice(0, 300)}` : '(no output)'),
        ),
    );
  });
}

async function callAnthropic(messages, tools, system) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, system, tools, messages }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const SYSTEM_BASE =
  'You are a software engineer with browser tools and file tools. Fix the reported bug in the source, then USE YOUR BROWSER TOOLS to confirm the fix works in the running app at ' +
  URL +
  ' (log in with admin@reticle.dev / password — the fields are pre-filled). The dev server hot-reloads your edits. ' +
  'End your final message with exactly "VERDICT: FIXED" if you have confirmed it works, or "VERDICT: NOT FIXED" otherwise.';

/**
 * The intent arm: the convention Reticle's own rules ask for, stated in the prompt.
 *
 * The manipulation is deliberately the INSTRUCTION, not the capability. Both arms can reach
 * `reticle_intent` and both get the same MCP instructions, so what is being measured is whether
 * being told to declare the goal changes what the agent does — which is the thing a project's
 * CLAUDE.md can actually control. Removing the tool instead would measure a different product.
 *
 * `DV_NO_INTENT=1` is the control.
 */
const INTENT_INSTRUCTION =
  ' Before you fix anything, state what the fix must make TRUE for a user, and pass it as `intent` ' +
  'on the verdict call that checks it. A verdict that proves your stated intent discharges it; one ' +
  'that does not leaves it owed.';

/**
 * The long-horizon cell: every bug at once, one context, one budget.
 *
 * The single-bug cells could not separate the arms — all four fixed all three, and there were no
 * false greens because every one of those bugs announces itself the moment it is fixed. Length is
 * what creates the failure mode worth measuring. With five defects in one context the agent has to
 * remember what it already established, keep track of which are done, and decide for itself when it
 * is finished — and two of the five are QUIET, visible only if you try the exact case, which is
 * where a claim outruns the evidence.
 *
 * Scored on the FINAL state of the app, by the same outside oracle, plus a per-goal claim so the
 * gap between "said fixed" and "is fixed" can be counted rather than inferred.
 */
export async function runMultiCell(bugIds, arm) {
  const list = bugIds.map((b) => `- [${b}] ${TASKS[b]}`).join('\n');
  const task =
    `Five separate bugs have been reported in this app. Fix ALL of them, and verify each one works in the running app.\n\n${list}\n\n` +
    'When you are done, end your final message with one line per bug, exactly:\n' +
    bugIds.map((b) => `VERDICT ${b}: FIXED`).join('\n') +
    '\n(or NOT FIXED for any you could not fix or could not confirm).';
  const res = await runCell(bugIds[0], arm, {
    task,
    maxTurns: Number(process.env.DV_MULTI_TURNS ?? 60),
    skipOracle: true,
  });
  if (res.error !== undefined) return { ...res, arm, multi: true };
  const goals = [];
  for (const b of bugIds) {
    const claimed = new RegExp(`VERDICT\\s+${b}\\s*:\\s*FIXED`, 'i').test(res.excerptFull ?? '');
    const v = await appWorks(b);
    goals.push({
      bug: b,
      claimed,
      works: v.works,
      false_green: claimed && !v.works,
      error: v.error ?? null,
    });
  }
  return {
    arm,
    multi: true,
    turns: res.turns,
    exhausted: res.exhausted,
    goals,
    verified: goals.filter((g) => g.works).length,
    claimed: goals.filter((g) => g.claimed).length,
    false_greens: goals.filter((g) => g.false_green).length,
    total_tokens: res.total_tokens,
    latency_ms: res.latency_ms,
    tool_calls: res.tool_calls,
  };
}

export async function runCell(bugId, arm, opts = {}) {
  const t0 = Date.now();
  const isCli = 'agent_browser_cli' === arm;
  const client = isCli
    ? undefined
    : new McpStdioClient(SERVERS[arm].command, SERVERS[arm].args, SERVERS[arm].env);
  let inTok = 0,
    outTok = 0,
    turns = 0,
    text = '';
  const toolCalls = [];
  /**
   * Did the baton fire, and did a verdict follow it?
   *
   * `verify_next` carries a ready-to-make verdict call when an agent has driven the page and asked
   * for nothing. This repo's own changelog calls it the largest known lever on whether a session
   * verifies at all, and nothing had ever measured it — it was once built, fired, and silently
   * dropped by schema-strict clients for a whole release. "The payload arrives" and "the agent acts
   * on it" are different claims; only the first was ever checked.
   */
  const batonTurns = [];
  /** Calls that carried an `intent` argument — declaring, whether or not anything proved it. */
  let intentCalls = 0;

  /**
   * How many intents the ledger records as PROVED.
   *
   * Read from disk rather than counted from calls, because only the engine can say an intent was
   * discharged: it happens when a verdict's own predicate asserted the declared thing. An agent
   * cannot claim it, which is exactly what makes it the aimed-verification signal.
   */
  const readDischarged = () => {
    // The daemon resolves the ledger to the SESSION's project root, which is not necessarily this
    // checkout — `sessionRoot()` falls back to the daemon's own directory only when it cannot name a
    // project. Reading one fixed path would report 0 for a ledger written somewhere else, and 0 is
    // indistinguishable from "the agent declared nothing".
    //
    // So both candidates are read and the larger taken: this is a measurement, and a measurement
    // that silently misses its own data is worse than one that admits it cannot find it.
    const candidates = [
      join(ROOT, '.reticle', 'intent.json'),
      join(APP_SRC, '..', '.reticle', 'intent.json'),
    ];
    let best = 0;
    for (const path of candidates) {
      try {
        const led = JSON.parse(readFileSync(path, 'utf8'));
        best = Math.max(
          best,
          Object.values(led.intents ?? {}).filter((i) => 'proved' === i.state).length,
        );
      } catch {
        /* not this one */
      }
    }
    return best;
  };
  try {
    let browserTools = [CLI_TOOL];
    let system = '1' === process.env.DV_NO_INTENT ? SYSTEM_BASE : SYSTEM_BASE + INTENT_INSTRUCTION;
    if (!isCli) {
      const pre = SERVERS[arm].preStart;
      if (pre !== undefined) {
        // Free it first: a daemon left on this port from an earlier cell would answer with the
        // WRONG surface and the run would look like lean while measuring default.
        try {
          execFileSync(
            'node',
            ['packages/server/dist/cli.js', 'stop', '--port', LEAN_PORT, '--quiet'],
            { stdio: 'ignore' },
          );
        } catch {
          /* nothing to stop */
        }
        spawn(pre.command, pre.args, {
          env: { ...process.env, ...pre.env },
          detached: true,
          stdio: 'ignore',
        }).unref();
        await new Promise((r) => setTimeout(r, 4000));
      }
      const init = await client.start();
      if (OWNS_DAEMON(arm)) await new Promise((r) => setTimeout(r, 3500));
      browserTools = (await client.listTools()).map((t) => ({
        name: t.name,
        description: (t.description ?? '').slice(0, 900),
        input_schema: t.inputSchema ?? { type: 'object', properties: {} },
      }));
      if ('string' === typeof init?.instructions && '' !== init.instructions) {
        system += `\n\nThe tool server you are connected to provides these instructions:\n${init.instructions}`;
      }
    }
    const tools = [...browserTools, ...FILE_TOOLS];
    const budget = opts.maxTurns ?? MAX_TURNS;
    const messages = [{ role: 'user', content: opts.task ?? TASKS[bugId] }];
    for (turns = 0; turns < budget; turns++) {
      const resp = await callAnthropic(messages, tools, system);
      inTok += resp.usage?.input_tokens ?? 0;
      outTok += resp.usage?.output_tokens ?? 0;
      messages.push({ role: 'assistant', content: resp.content });
      const uses = resp.content.filter((c) => 'tool_use' === c.type);
      const said = resp.content
        .filter((c) => 'text' === c.type)
        .map((c) => c.text)
        .join('\n');
      if (said) text += '\n' + said;
      if ('tool_use' !== resp.stop_reason || 0 === uses.length) break;
      const results = [];
      for (const u of uses) {
        toolCalls.push(u.name);
        // Counted here, at the one place every tool call passes through. The first version of this
        // line was never inserted and both arms reported `declared=0`, which reads exactly like an
        // agent ignoring the instruction — an instrument that fails silently produces a confident
        // wrong answer, which is the failure this whole benchmark exists to catch.
        if (u.input?.intent !== undefined || 'reticle_intent' === u.name) intentCalls += 1;
        try {
          let out;
          if (FILE_TOOLS.some((t) => t.name === u.name)) out = runFileTool(u.name, u.input);
          else if (isCli) out = await runCli(String(u.input.args ?? ''));
          else out = (await client.callTool(u.name, u.input, 60_000)).text;
          // Position, not a count: the question is causal — of the turns where the baton arrived,
          // how many were followed by a verdict call.
          if (String(out ?? '').includes('"verify_next"')) batonTurns.push(toolCalls.length - 1);
          results.push({
            type: 'tool_result',
            tool_use_id: u.id,
            content: String(out).slice(0, 8000),
          });
        } catch (e) {
          results.push({
            type: 'tool_result',
            tool_use_id: u.id,
            content: `error: ${String(e).slice(0, 300)}`,
            is_error: true,
          });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    // Let the last hot-reload land before asking the oracle.
    await new Promise((r) => setTimeout(r, 3000));
    const claimed = /VERDICT:\s*FIXED/i.test(text);
    // The multi-bug caller scores every goal itself, so it opts out of the single-bug oracle.
    const verdict = true === opts.skipOracle ? { works: null } : await appWorks(bugId);
    return {
      bug: bugId,
      arm,
      turns,
      claimed,
      works: verdict.works,
      false_green: claimed && !verdict.works,
      silent_miss: !claimed && !verdict.works,
      unreported_success: !claimed && verdict.works,
      oracle_error: verdict.error ?? null,
      token_input: inTok,
      token_output: outTok,
      total_tokens: inTok + outTok,
      latency_ms: Date.now() - t0,
      tool_calls: toolCalls,
      baton_turns: batonTurns,
      // Did the agent declare a goal, and did a verdict ever settle it?
      //
      // `intent_declared` counts calls that carried one; `intent_discharged` reads the LEDGER,
      // which only records `proved` when a verdict's predicate asserted the declared thing. That
      // distinction is the whole point: counting verdict calls cannot tell aimed verification from
      // busy verification — the false green this benchmark found drew SEVEN green verdicts and
      // proved none of what it claimed. A discharge cannot be earned that way.
      intent_declared: intentCalls,
      intent_discharged: readDischarged(),
      // The causal read, computed here so no downstream reader re-derives it: for each turn the
      // baton arrived, was the NEXT tool call a verdict tool. A count alone cannot separate the
      // lever from the coincidence — that is what the suppressed arm is for.
      baton_followed: batonTurns.filter((i) => /act_and_wait|_assert/.test(toolCalls[i + 1] ?? ''))
        .length,
      exhausted: turns >= (opts.maxTurns ?? MAX_TURNS),
      excerpt: text.trim().slice(-200),
      excerptFull: text,
    };
  } catch (e) {
    return { bug: bugId, arm, error: String(e).slice(0, 300), turns, total_tokens: inTok + outTok };
  } finally {
    await client?.stop();
    if (OWNS_DAEMON(arm)) {
      try {
        execFileSync(
          'node',
          ['packages/server/dist/cli.js', 'stop', '--port', RETICLE_PORT, '--quiet'],
          { stdio: 'ignore' },
        );
      } catch {
        /* already down */
      }
    }
  }
}

/**
 * Restore the app between cells.
 *
 * `revert()` undoes the injection, but the AGENT edited these files — possibly badly, possibly
 * elsewhere. Only git can put the tree back, and a cell that starts from another cell's leftovers
 * measures the leftovers.
 */
/**
 * Clear the intent ledger between cells.
 *
 * `readDischarged` reads the whole file, so a ledger carried over from the previous bug would count
 * that bug's proofs as this one's. The same class of leak as the app leftovers below: a cell that
 * starts from another cell's state measures the leftovers.
 */
function clearLedger() {
  try {
    execFileSync('rm', ['-f', join(ROOT, '.reticle', 'intent.json')], { stdio: 'ignore' });
  } catch {
    /* nothing to clear */
  }
}

function restoreApp() {
  execFileSync('git', ['checkout', '--', 'apps/bench-app/src'], { cwd: ROOT, stdio: 'ignore' });
  // `checkout` restores tracked files and leaves NEW ones. Agents create them: a lean run left
  // `apps/bench-app/src/.reticle.json` behind, and the next cell would have started against an app
  // carrying a stray config nobody put there — measuring the leftover. `-x` because the app's own
  // .gitignore covers build output, and a cell must not inherit the previous cell's dist either.
  execFileSync('git', ['clean', '-fdx', '--', 'apps/bench-app/src'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
}

/** Long-horizon entry: `node run.mjs --multi`. Every bug at once, per-arm, scored on the end state. */
async function mainMulti() {
  const bugs = Object.keys(TASKS);
  assertScopeIsWhatItClaims(bugs, oracleBugIds());
  const arms = (process.env.DV_ONLY_ARMS ?? '').split(',').filter(Boolean);
  const rows = [];
  for (const arm of 0 === arms.length ? ARMS : arms) {
    restoreApp();
    clearLedger();
    for (const b of bugs) inject(b);
    await new Promise((r) => setTimeout(r, 3000));
    const row = await runMultiCell(bugs, arm);
    rows.push(row);
    console.log(
      JSON.stringify({
        arm: row.arm,
        turns: row.turns,
        exhausted: row.exhausted,
        verified: `${row.verified}/${bugs.length}`,
        claimed: `${row.claimed}/${bugs.length}`,
        FALSE_GREENS: row.false_greens,
        tok: row.total_tokens,
      }),
    );
    restoreApp();
  }
  writeFileSync(
    process.env.DV_OUT ?? 'bench/raw/do-and-verify-multi.json',
    JSON.stringify(rows, null, 2),
  );
  console.log(`\nwrote ${rows.length} rows`);
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--multi')) {
  await mainMulti();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv[2];
  const bugs = only ? [only] : Object.keys(TASKS);
  assertScopeIsWhatItClaims(Object.keys(TASKS), oracleBugIds());
  const arms = (process.env.DV_ONLY_ARMS ?? '').split(',').filter(Boolean);
  const rows = [];
  for (const bug of bugs) {
    for (const arm of 0 === arms.length ? ARMS : arms) {
      restoreApp();
      clearLedger();
      inject(bug);
      await new Promise((r) => setTimeout(r, 2500));
      const row = await runCell(bug, arm);
      rows.push(row);
      console.log(
        JSON.stringify({
          bug: row.bug,
          arm: row.arm,
          turns: row.turns,
          claimed: row.claimed,
          works: row.works,
          FALSE_GREEN: row.false_green,
          unreported: row.unreported_success,
          tok: row.total_tokens,
        }),
      );
      try {
        revert(bug);
      } catch {
        /* the agent may have already removed it */
      }
      restoreApp();
    }
  }
  const out = process.env.DV_OUT ?? 'bench/raw/do-and-verify.json';
  if (existsSync('bench/raw')) writeFileSync(out, JSON.stringify(rows, null, 2));
  console.log(`\nwrote ${rows.length} rows to ${out}`);
}
