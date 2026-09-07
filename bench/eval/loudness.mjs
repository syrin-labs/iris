/**
 * How LOUD is a defect — and why that is the axis this product must be graded on.
 *
 * Reticle's claim is not "it finds bugs". Playwright finds bugs. The claim is that it catches what
 * LOOKS FINE: a write that fails while the UI advances, a signal fired from the value the app was
 * asked for rather than the one it committed, a guard that silently stops guarding.
 *
 * A suite of loud defects cannot test that claim. Measured across a full session of benchmarking:
 * four of five scenarios announced themselves the moment they were fixed, every arm caught every one
 * of them, and the entire signal — every false green, every budget exhaustion, every disagreement
 * between arms — came from the ONE quiet scenario. Reporting a headline over that mix says almost
 * nothing, and flatters whoever runs it.
 *
 * So loudness is a first-class field, assigned per scenario, and every result is reported PER CLASS.
 * A tool that scores 5/5 on loud and 1/6 on quiet is a different product from one that scores 3/3
 * and 3/3, and a single averaged number hides exactly that difference.
 *
 * ## The grades
 *
 * Assigned by what a competent agent would SEE after applying a fix, never by how hard the bug was
 * to write. That is the only definition that predicts whether verification is needed at all.
 */
export const Loudness = {
  /**
   * The failure is visible in the DOM the moment you look. A missing element, a dead control, a view
   * that never renders.
   *
   * Anything can catch these, including a screenshot. They belong in the suite as a CONTROL: a tool
   * that misses a loud defect is broken, and a tool that catches one has proved nothing about the
   * quiet ones.
   */
  LOUD: 'loud',
  /**
   * The page looks right and one channel disagrees — a console error, a failed request, a signal
   * that contradicts the DOM. Visible if you look at the right channel, invisible if you look at the
   * page.
   *
   * This is where cross-channel verification starts to earn its keep, and where a screenshot stops.
   */
  CROSS_CHANNEL: 'cross-channel',
  /**
   * Nothing looks wrong and no channel complains. The defect is a guard that stopped guarding, a
   * filter that stopped filtering, a value committed differently from the one announced. You see it
   * only by driving the exact case and asserting the exact consequence.
   *
   * **This is the product's whole claim, and it is the class the current fixture set has exactly one
   * of.** A false green is only possible here: on a loud defect the agent cannot both fix nothing
   * and see success.
   */
  QUIET: 'quiet',
};

/**
 * Loudness per injection, with the reason — because an unargued grade drifts into whatever makes the
 * numbers look best, and this axis decides the headline.
 */
export const LOUDNESS = {
  'silent-dom-regression': {
    grade: Loudness.LOUD,
    why: 'a KPI card is missing from the page; counting the rendered cards finds it',
  },
  'route-transition-break': {
    grade: Loudness.LOUD,
    why: 'the Compose view never renders — the destination is visibly empty',
  },
  'missing-modal': {
    grade: Loudness.LOUD,
    why: 'the dialog never appears, though the app DOES fire modal:opened — loud in the DOM, quiet in the signal',
  },
  'network-timeout': {
    grade: Loudness.CROSS_CHANNEL,
    why: 'the UI carries on; only the network channel shows the request never came back',
  },
  'signal-contract-violation': {
    grade: Loudness.CROSS_CHANNEL,
    why: 'the view switches correctly and A signal fires — only the WRONG one. DOM and console agree the app is fine',
  },
  'layout-shift': {
    grade: Loudness.CROSS_CHANNEL,
    why: 'the accessibility tree is unchanged; only the layout-shift measure moves',
  },
  'cross-component-regression': {
    grade: Loudness.QUIET,
    why: 'every screen renders perfectly; the filter simply stops affecting the table unless you type and compare counts',
  },
  'broken-form-validation': {
    grade: Loudness.QUIET,
    why: 'a guard stops guarding. Nothing renders wrong, nothing errors, and submit is enabled for a whitespace-only name',
  },
};

/** The grade for an injection, or undefined when it has none — never a default. */
export function loudnessOf(bugId) {
  return LOUDNESS[bugId]?.grade;
}

/**
 * `{ loud, 'cross-channel', quiet }` — counts of a result set per class.
 *
 * Exported so every report goes through one place. A caller that averaged across classes would
 * produce the number this file exists to prevent.
 */
export function byClass(rows, predicate) {
  const out = {};
  for (const g of Object.values(Loudness)) {
    const inClass = rows.filter((r) => loudnessOf(r.bug) === g);
    out[g] = { n: inClass.length, hit: inClass.filter(predicate).length };
  }
  return out;
}

/** Ungraded scenarios, so a new injection cannot join the suite by being silently uncounted. */
export function ungraded(bugIds) {
  return bugIds.filter((b) => LOUDNESS[b] === undefined);
}
