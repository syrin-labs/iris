/**
 * What is left to do by hand, from wherever setup stopped.
 *
 * Naming a cause is not the same as being recoverable. Setup can misbehave, and when it does the
 * caller should not have to re-read the whole procedure and work out for itself which parts already
 * worked — it should pick up at the step that did not. Ordered, and only ever the REMAINING steps.
 */

/** How far a run got. Everything here is knowable from the result object setup already builds. */
export interface Progress {
  readonly initDone: boolean;
  readonly devServerUp: boolean;
  readonly sessionConnected: boolean;
  readonly flowSaved: boolean;
  /** Set when the caller supplied a url, so nobody is told to start a server they already run. */
  readonly urlSuppliedByCaller: boolean;
  readonly url?: string | undefined;
  readonly devCommand?: string | undefined;
}

const DOCS_INDEX = 'https://docs.reticle.sh/llms.txt';

export function remainingSteps(p: Progress): string[] {
  const steps: string[] = [];
  if (!p.initDone) {
    steps.push('Run `npx @reticlehq/server@latest init` here, and fix every ⚠ it reports.');
  }
  if (!p.devServerUp && !p.urlSuppliedByCaller) {
    steps.push(
      `Start the dev server yourself: ${p.devCommand ?? 'the dev script in package.json'}, then open the app in a browser.`,
    );
  }
  if (!p.sessionConnected) {
    steps.push(
      'Confirm a session appears with `reticle_sessions`. If the list is empty, read its ' +
        '`next_action`: the usual cause is a dev server that was already running when the build ' +
        'config was edited, so restart it and hard-reload' +
        (undefined === p.url ? '.' : ` ${p.url}.`),
    );
  }
  if (!p.flowSaved) {
    steps.push(
      'Drive one flow and produce a verdict: `reticle_snapshot({mode:"interactive"})` once, ' +
        '`reticle_act_sequence` for the setup steps, then ONE `reticle_act_and_wait({ref,action,until})`. ' +
        'Wrap it in `reticle_record` start/stop and `reticle_flow_save`, and check the grade it ' +
        'returns is `asserted` — anything else only acts, so it passes even when the feature breaks.',
    );
  }
  steps.push(`The whole procedure, if you need it: \`curl ${DOCS_INDEX}\`.`);
  return steps;
}
