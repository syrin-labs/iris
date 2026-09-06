/**
 * The real Playwright adapter behind BrowserPool: wraps `chromium.launch` into the pool's small
 * PooledBrowser/Context/Page interfaces. Kept thin and separate so the pool's lifecycle logic stays
 * unit-tested with a fake while this glue is exercised only by the e2e battery (it needs Chromium).
 *
 * Headless by default — the pool exists for fault-tolerant headless multi-agent testing.
 */

import type { Browser } from 'playwright';
import { BrowserLaunchKind } from '@reticlehq/core';
import { chromiumLaunchOptions } from '../chromium-launch-options.js';
import { getSessionMetrics } from '../telemetry/session-metrics.js';
import { classifyConnectFailure } from '../telemetry/connect-failure.js';
import {
  chromiumInstallCommand,
  chromiumInstallDepsCommand,
  bundledPlaywrightVersion,
} from '../cli/chromium-hint.js';
import type { Launcher, PooledBrowser, PooledContext, PooledPage } from './browser-pool.js';
import { installNetworkMocks } from '../input/network-mock.js';

/**
 * How a leased tab navigates. Pure, and exported, because the decision in it is worth a test while
 * the rest of this file needs a real Chromium.
 *
 * `waitUntil: 'domcontentloaded'` — NOT Playwright's default of `load`. `load` waits for every
 * subresource, so an app with one that never finishes burns the whole nav budget and the lease then
 * reports "is the app running?" about an app that is running. Measured on the sveltekit fixture:
 * 30,501ms and a false diagnosis. The SDK connect is a module script and runs before
 * DOMContentLoaded, and the pool separately waits for the session to register, so the load event was
 * never what proved the page was usable.
 */
export function gotoOptions(timeoutMs: number | undefined): {
  waitUntil: 'domcontentloaded';
  timeout?: number;
} {
  return {
    waitUntil: 'domcontentloaded',
    // Absent, not zero: zero means "no timeout" to Playwright, which would turn a slow page into a
    // lease that never returns.
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  };
}

function wrapBrowser(browser: Browser): PooledBrowser {
  return {
    isConnected: () => browser.isConnected(),
    newContext: async (): Promise<PooledContext> => {
      const context = await browser.newContext();
      return {
        newPage: async (): Promise<PooledPage> => {
          const page = await context.newPage();
          return {
            goto: (url, opts) => page.goto(url, gotoOptions(opts?.timeoutMs)),
            close: () => page.close(),
            // Playwright returns a Buffer; Uint8Array is what the visual store and differ take.
            screenshot: async (opts) =>
              new Uint8Array(await page.screenshot({ fullPage: true === opts?.fullPage })),
            // Three moves, same as performGesture: a single move to the center can be a no-op if
            // the pointer was already there, and CSS :hover needs a native hit-test to apply.
            hover: async (x, y) => {
              await page.mouse.move(x, y);
              await page.mouse.move(x + 1, y);
              await page.mouse.move(x, y);
            },
            installMocks: (rules) => installNetworkMocks(page, [...rules]),
            onCrash: (handler) => page.on('crash', handler),
            onConsole: (handler) => page.on('console', (msg) => handler(msg.text())),
          };
        },
        close: () => context.close(),
      };
    },
    close: () => browser.close(),
    onDisconnected: (handler) => browser.on('disconnected', handler),
  };
}

/**
 * The fix for the most common first-run failure: Chromium isn't installed for Playwright.
 *
 * Pinned to the playwright this process bundles. Unpinned, `npx` fetches the latest playwright and
 * installs ITS browser revision — a build this launcher will never look at — so the user follows the
 * advice, it succeeds, and the next launch fails identically. Shares one builder with `doctor` so the
 * two cannot suggest different commands for the same missing browser.
 */
const CHROMIUM_MISSING_HINT = `Chromium is not installed for Playwright. Run: ${chromiumInstallCommand(bundledPlaywrightVersion())}`;

/**
 * A DIFFERENT first-run failure from the one above: the browser binary is already there, but the
 * host is missing the OS-level shared libraries (e.g. `libnspr4.so`) Playwright's own
 * host-requirement check refuses to launch without. `npx playwright install chromium` does nothing
 * for this — it re-downloads a binary that was never the problem — so this needs its own hint
 * pointing at `install-deps`, pinned the same way and for the same reason as the one above.
 */
const CHROMIUM_MISSING_DEPS_HINT = `Chromium is installed, but the host system is missing shared-library dependencies it needs. Run: ${chromiumInstallDepsCommand(bundledPlaywrightVersion())}`;

/** A Launcher that boots a real headless Chromium and adapts it to the pool's interface. */
export function playwrightLauncher(opts: { headless?: boolean } = {}): Launcher {
  const headless = opts.headless ?? true;
  // `playwright` is an OPTIONAL dependency. A static value-import here would be pulled in by the
  // server's main entry (index.ts re-exports this module) and crash the whole process with
  // ERR_MODULE_NOT_FOUND on any install without Chromium — the CLI, the MCP server, everything.
  // Import it lazily, only when a browser is actually launched, so absence fails at drive-time
  // (where it's meaningful) instead of at import-time (where it kills unrelated features).
  return async () => {
    const { chromium } = await import('playwright');
    // A pooled launch serves N parallel leases, so this counts BROWSERS, not contexts — which is the
    // number that actually costs memory and the one that explains a slow machine.
    const settle = getSessionMetrics().recordConnectAttempt(BrowserLaunchKind.POOLED);
    try {
      const browser = wrapBrowser(await chromium.launch(chromiumLaunchOptions(headless)));
      settle();
      return browser;
    } catch (err) {
      settle(classifyConnectFailure(err));
      // Turn Playwright's raw "Executable doesn't exist" into the one command that fixes it.
      const msg = err instanceof Error ? err.message : String(err);
      // Checked FIRST: Playwright's host-requirement validation error also contains
      // "browserType.launch", so the generic check below would otherwise misdiagnose it as a
      // missing binary and send the user through a fix that changes nothing.
      if (/host system is missing dependencies/i.test(msg)) {
        throw new Error(CHROMIUM_MISSING_DEPS_HINT);
      }
      if (/executable doesn.?t exist|playwright install|browsertype\.launch/i.test(msg)) {
        throw new Error(CHROMIUM_MISSING_HINT);
      }
      throw err;
    }
  };
}

const MAX_CONTEXTS_CEILING = 8;
const MAX_CONTEXTS_FLOOR = 1;
/**
 * Hard backstop for an EXPLICIT RETICLE_MAX_CONTEXTS. The operator override still wins for any
 * realistic value (well above the CPU-derived ceiling), but a typo/abuse like 5000 can't spawn 5000
 * browser contexts and exhaust memory/FDs — the fork-bomb the function's own comment warns about.
 */
const MAX_CONTEXTS_HARD_CEILING = 128;

/**
 * Resolve the pool's concurrency cap. An explicit RETICLE_MAX_CONTEXTS wins (clamped to
 * [1, hard ceiling]); otherwise scale with the machine but never above the CPU-derived ceiling.
 * Pure (env value + cpu count passed in) so it's testable.
 */
export function resolveMaxContexts(envValue: string | undefined, cpuCount: number): number {
  if (envValue !== undefined) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed >= MAX_CONTEXTS_FLOOR) {
      return Math.min(MAX_CONTEXTS_HARD_CEILING, parsed);
    }
  }
  const byCpu = Math.max(MAX_CONTEXTS_FLOOR, cpuCount - 1);
  return Math.min(MAX_CONTEXTS_CEILING, byCpu);
}
