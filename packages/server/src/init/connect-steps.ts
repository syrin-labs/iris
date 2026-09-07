/**
 * Which `init` steps decide whether the app can dial the daemon.
 *
 * Lifted out of `plan.ts` when that file reached the size backstop. A cohesive unit on its own
 * terms: one question, asked of a step title, with one consequence — a manual step in this set makes
 * `init` exit non-zero instead of reporting a success over an app that can never connect.
 *
 * Matched on TITLES, which is the fragile part and worth stating: renaming a step in
 * `plan-framework.ts` silently drops it out of this set and nothing goes red. `connect-steps.test.ts`
 * pins the membership for exactly that reason.
 */
/**
 * Titles of the steps WITHOUT which no session ever appears.
 *
 * A ⚠ on one of these is not a warning, it is a guaranteed failure: nothing performs the manual step,
 * so the app will not connect and every Reticle tool will answer "no browser session connected".
 * Reported from a field sweep, where the ⚠ count and "did it connect" were treated as independent
 * signals and are not.
 */
const CONNECT_STEP_TITLES: ReadonlySet<string> = new Set([
  'Connect snippet',
  'Connect snippet (CRA)',
  'Connect snippet (Astro)',
  'Connect snippet (Nuxt)',
  'Connect snippet (React Router)',
  'Reticle client hook',
  'Reticle connect module',
  'ReticleDev component',
  // Writing the component and MOUNTING it are two steps, and only the write was here. A root layout
  // whose shape `init` does not recognise leaves the component on disk and never rendered: the SDK
  // is in the project, nothing imports it, and `init` exited 0 over an app that could not connect.
  'Mount ReticleDev',
  // NOT here, and the reason is worth keeping: 'Pairing token'.
  //
  // It is a genuine connect step — CRA inlines only REACT_APP_*, so without the token in the env
  // file the bridge refuses every connection and the app boots, looks correct, and never pairs. But
  // it goes MANUAL in exactly one situation: no daemon has ever run on this machine, so there is no
  // token to inline. That is the FIRST CRA install on a fresh machine, i.e. the first-time user —
  // and making that exit non-zero reports a broken install to the one person least able to tell
  // that it is not.
  //
  // The real fix is for `init` to mint the token rather than only read it, which is what both the
  // daemon and the Vite plugin already do. `runInit` is synchronous and the existing helpers are
  // not, and `gate:install` scaffolds no CRA app, so that change would ship with no coverage of the
  // path it changes. It is worth doing, and worth doing with a scaffold behind it.
  'Vite plugin',
]);

/** True when this step is what makes the app dial the daemon. */
export function isConnectStep(title: string): boolean {
  return CONNECT_STEP_TITLES.has(title);
}
