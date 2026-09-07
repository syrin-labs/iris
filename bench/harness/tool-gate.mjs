import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(process.cwd(), 'bench', 'raw', 'tool-profile.baseline.json');
const CURRENT_PATH = path.join(process.cwd(), 'bench', 'raw', 'tool-profile.json');
const HARNESS_SCRIPT_PATH = path.join(__dirname, 'tool-profile.mjs');
const BYTES_DELTA_THRESHOLD = 0.2;

/**
 * Load and parse a JSON file from disk.
 *
 * @param {string} filePath
 * @returns {Promise<any>}
 */
async function loadJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if ('ENOENT' === error.code && filePath === BASELINE_PATH) {
      throw new Error(
        'No baseline found. Run: node bench/harness/tool-profile.mjs && cp bench/raw/tool-profile.json bench/raw/tool-profile.baseline.json',
      );
    }
    throw new Error(`Failed to load ${filePath}: ${error.message}`);
  }
}

/**
 * Spawns the tool-profile harness to produce fresh benchmark numbers.
 *
 * @returns {Promise<void>}
 */
function spawnHarness() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HARNESS_SCRIPT_PATH], {
      stdio: 'pipe',
      detached: false,
      windowsHide: true,
      shell: false,
      env: process.env,
    });

    let stderr = '';
    let stdout = '';

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn harness: ${err.message}`));
    });

    child.on('close', (code) => {
      if (0 !== code) {
        reject(
          new Error(
            `Harness exited with code ${code}.${stderr ? ` Stderr: ${stderr.trim()}` : stdout ? ` Stdout: ${stdout.trim()}` : ''}`,
          ),
        );
      } else {
        resolve();
      }
    });
  });
}

/**
 * Ensures current benchmark results exist and are fresh relative to the baseline.
 * If missing or older than the baseline, executes the harness automatically.
 *
 * @returns {Promise<void>}
 */
async function runHarnessIfNeeded() {
  let shouldRun = false;
  try {
    const baselineStat = await fs.stat(BASELINE_PATH);
    try {
      const currentStat = await fs.stat(CURRENT_PATH);
      if (currentStat.mtimeMs < baselineStat.mtimeMs) {
        shouldRun = true;
      }
    } catch {
      shouldRun = true;
    }
  } catch {
    // If baseline is missing, loadJson will report the baseline error.
    return;
  }

  if (shouldRun) {
    await spawnHarness();
  }
}

/**
 * Inverts the fixture matrix structure to a tool-first map:
 * { [toolName]: { [fixtureName]: result } }
 *
 * @param {any} json
 * @returns {Record<string, Record<string, any>>}
 */
function parseToolMatrix(json) {
  const tools = {};
  for (const [fixtureName, fixtureData] of Object.entries(json?.matrix || {})) {
    for (const result of fixtureData?.results || []) {
      if (result && result.tool) {
        if (!tools[result.tool]) {
          tools[result.tool] = {};
        }
        tools[result.tool][fixtureName] = result;
      }
    }
  }
  return tools;
}

const hadError = (r) => true === r?.is_error;
const hadTimeout = (r) => true === r?.timed_out;
const hadProtocolError = (r) => null !== r?.protocol_error && undefined !== r?.protocol_error;

/**
 * Checks whether payload bytes size differed by more than the threshold.
 *
 * @param {any} base
 * @param {any} curr
 * @returns {boolean}
 */
function hadBytesRegression(base, curr) {
  if ('number' === typeof base?.bytes && 'number' === typeof curr?.bytes && base.bytes > 0) {
    return Math.abs(curr.bytes - base.bytes) / base.bytes > BYTES_DELTA_THRESHOLD;
  }
  return false;
}

/**
 * Compares a tool's baseline results vs current results across all baseline fixtures.
 *
 * @param {string} toolName
 * @param {Record<string, any>} baselineFixtures
 * @param {Record<string, any>} currentFixtures
 * @returns {{ failCount: number, totalFixtures: number, latencyDeltas: string[] }}
 */
function compareTool(toolName, baselineFixtures, currentFixtures) {
  const fixtureNames = Object.keys(baselineFixtures || {});
  const totalFixtures = fixtureNames.length;
  let failCount = 0;
  const latencyDeltas = [];

  for (const fixtureName of fixtureNames) {
    const base = baselineFixtures[fixtureName];
    const curr = currentFixtures ? currentFixtures[fixtureName] : undefined;

    if (!curr) {
      failCount++;
      continue;
    }

    let regressed = false;
    if (!hadError(base) && hadError(curr)) {
      regressed = true;
    } else if (!hadTimeout(base) && hadTimeout(curr)) {
      regressed = true;
    } else if (!hadProtocolError(base) && hadProtocolError(curr)) {
      regressed = true;
    } else if (hadBytesRegression(base, curr)) {
      regressed = true;
    }

    if ('number' === typeof base?.latency_ms && 'number' === typeof curr?.latency_ms) {
      if (base.latency_ms > 0) {
        const deltaPercent = Math.round(
          ((curr.latency_ms - base.latency_ms) / base.latency_ms) * 100,
        );
        if (Math.abs(deltaPercent) >= 20) {
          const sign = deltaPercent >= 0 ? '+' : '';
          const fixtureLabel = totalFixtures > 1 ? ` (${fixtureName})` : '';
          latencyDeltas.push(
            `${toolName}${fixtureLabel}: ${base.latency_ms}ms → ${curr.latency_ms}ms (${sign}${deltaPercent}%)`,
          );
        }
      } else if (curr.latency_ms > 0) {
        const fixtureLabel = totalFixtures > 1 ? ` (${fixtureName})` : '';
        latencyDeltas.push(`${toolName}${fixtureLabel}: 0ms → ${curr.latency_ms}ms (+∞%)`);
      }
    }

    if (regressed) {
      failCount++;
    }
  }

  return { failCount, totalFixtures, latencyDeltas };
}

async function main() {
  // 1. Ensure baseline exists or run harness if needed
  await runHarnessIfNeeded();

  // 2. Load both baseline and current JSON profiles
  const baselineJson = await loadJson(BASELINE_PATH);
  const currentJson = await loadJson(CURRENT_PATH);

  // 3. Parse tool matrices
  const baselineTools = parseToolMatrix(baselineJson);
  const currentTools = parseToolMatrix(currentJson);

  // 4. Compare each baseline tool
  const failureSentences = [];
  const allLatencyReports = [];

  for (const [toolName, baselineFixtures] of Object.entries(baselineTools)) {
    const currentFixtures = currentTools[toolName];
    const { failCount, totalFixtures, latencyDeltas } = compareTool(
      toolName,
      baselineFixtures,
      currentFixtures,
    );

    if (latencyDeltas.length > 0) {
      allLatencyReports.push(...latencyDeltas);
    }

    if (failCount > 0) {
      failureSentences.push(
        `${toolName} is failing on ${failCount} of ${totalFixtures} stacks — fix it`,
      );
    }
  }

  // 5. Output advisory latency report
  if (allLatencyReports.length > 0) {
    console.log('Latency Report:');
    for (const report of allLatencyReports) {
      console.log(`  ${report}`);
    }
    console.log();
  }

  // 6. Output gate verdict
  if (failureSentences.length > 0) {
    for (const sentence of failureSentences) {
      console.log(sentence);
    }
    console.log(`${failureSentences.length} tool(s) regressed. Gate failed.`);
    process.exit(1);
  } else {
    console.log('All tools within budget. Gate passed.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Gate error:', err.message);
  process.exit(1);
});
