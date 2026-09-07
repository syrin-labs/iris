/**
 * Did the app actually end up working? Asked by something none of the arms can influence.
 *
 * The existing fix-loop ablation answers "is it fixed?" with `!fileText.includes(marker)` — the
 * injected string is gone, therefore fixed. Its own README calls behaviour-level verification the
 * upgrade this file is. The gap matters here more than anywhere: an agent that deletes the marker
 * and leaves the feature broken scores as a CORRECT FIX under a string check, which makes a
 * string-checked benchmark structurally unable to see a false green. False greens are the entire
 * question this benchmark exists to ask.
 *
 * So the oracle drives the running app with plain Playwright — no Reticle, no MCP, no arm's tools —
 * and asserts what a user would see. Deliberately dumb and deliberately outside: an oracle that
 * shares machinery with a contestant is a contestant.
 */
import { chromium } from 'playwright';

const APP = process.env.DV_APP_URL ?? 'http://localhost:4312/';
const NAV_MS = 20_000;
const STEP_MS = 8_000;

/** Log in. Every check needs it, and the fixture pre-fills the credentials. */
async function signIn(page) {
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: NAV_MS });
  await page.getByTestId('login-submit').click({ timeout: STEP_MS });
  await page.getByTestId('nav-overview').waitFor({ timeout: STEP_MS });
}

/**
 * One behavioural assertion per bug, phrased as the user-visible consequence rather than the code.
 *
 * `works` is TRUE only on a positive observation. Anything that throws — a timeout, a crash, a page
 * that never loaded — is FALSE with the error kept, because "we could not see it work" must never
 * be recorded as working. That asymmetry is the whole point of an oracle.
 */
const CHECKS = {
  'missing-modal': async (page) => {
    await signIn(page);
    await page.getByTestId('nav-deployments').click({ timeout: STEP_MS });
    await page.getByTestId('new-deploy').click({ timeout: STEP_MS });
    // The modal's own heading, not the button that opens it.
    await page.getByText('New deployment', { exact: false }).waitFor({ timeout: STEP_MS });
  },
  'route-transition-break': async (page) => {
    await signIn(page);
    await page.getByTestId('nav-compose').click({ timeout: STEP_MS });
    // By testid, not by the word "Generate" — the first draft matched three elements and the
    // oracle failed on a HEALTHY app. An oracle that cannot pass the working case is worse than no
    // oracle, because every arm then scores as broken and the benchmark reads as a clean sweep.
    await page.getByTestId('compose-generate').waitFor({ timeout: STEP_MS });
    await page.getByTestId('compose-prompt').waitFor({ timeout: STEP_MS });
  },
  /**
   * Quiet by construction: nothing looks wrong until you type. The filter setter drops the incoming
   * patch, so component A stops affecting component B and every screen still renders perfectly.
   */
  'cross-component-regression': async (page) => {
    await signIn(page);
    await page.getByTestId('nav-deployments').click({ timeout: STEP_MS });
    // The table prints its own "N of M" count. Reading that beats counting DOM rows, which a
    // virtualized or paginated table would make meaningless — the app is asserting its own state.
    const table = page.getByTestId('deploy-table');
    await table.waitFor({ timeout: STEP_MS });
    const shown = async () => {
      const m = (await table.innerText()).match(/(\d+)\s+of\s+(\d+)/);
      if (null === m) throw new Error('no "N of M" count in the table');
      return { n: Number(m[1]), total: Number(m[2]) };
    };
    const before = await shown();
    await page.getByTestId('filter-search').fill('api-gateway', { timeout: STEP_MS });
    await page.waitForTimeout(1200);
    const after = await shown();
    if (after.n >= before.n) {
      throw new Error(
        `filter did not narrow the table (${before.n} -> ${after.n} of ${after.total})`,
      );
    }
  },

  /**
   * DEPENDS ON `missing-modal`. The form lives inside the new-deployment dialog, so while that bug
   * is present this check reads BROKEN for a reason that is not its own. Measured, not assumed: the
   * falsification matrix showed exactly one off-diagonal cell and this is it. In a multi-bug run it
   * means partial credit is coupled — an agent that has not yet opened the modal cannot be scored
   * on the form — and the honest reading is the FINAL state, where all five must hold at once.
   *
   * Quieter still: the form accepts a service that is only whitespace. Nothing renders wrong — the
   * bug is that a guard which should refuse does not, which is invisible unless you try it.
   */
  'broken-form-validation': async (page) => {
    await signIn(page);
    await page.getByTestId('nav-deployments').click({ timeout: STEP_MS });
    await page.getByTestId('new-deploy').click({ timeout: STEP_MS });
    const service = page.getByTestId('deploy-name');
    await service.waitFor({ timeout: STEP_MS });
    await service.fill('   ');
    const submit = page.getByTestId('deploy-submit');
    if (await submit.isEnabled())
      throw new Error('submit is enabled for a whitespace-only service');
  },

  'silent-dom-regression': async (page) => {
    await signIn(page);
    // The count is the assertion: one card is silently dropped and the layout still looks fine.
    const cards = page.locator('[data-testid^="kpi-"]');
    await cards.first().waitFor({ timeout: STEP_MS });
    // Four is the healthy count, confirmed by counting them on the uninjected app rather than by
    // reading the seed function. The injection drops exactly one.
    const n = await cards.count();
    if (n < 4) throw new Error(`only ${n} KPI cards rendered`);
  },
};

export function oracleBugIds() {
  return Object.keys(CHECKS);
}

/** `{ works, error }`. Never throws: a benchmark that dies on one cell reports nothing. */
export async function appWorks(bugId) {
  const check = CHECKS[bugId];
  if (check === undefined) return { works: false, error: `no oracle for ${bugId}` };
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await check(page);
    return { works: true };
  } catch (e) {
    return { works: false, error: String(e).split('\n')[0].slice(0, 200) };
  } finally {
    await browser?.close();
  }
}
