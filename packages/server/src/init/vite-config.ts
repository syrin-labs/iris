/**
 * Pure, conservative patcher for a Vite config: add the `@reticlehq/vite-plugin` import and drop
 * `reticle` into the `plugins` array. Only handles the obvious, common shape — anything ambiguous
 * bails to a `manual` result so we never half-edit a build config (a broken config is worse than a
 * documented manual step).
 */

import { PatchKind, type SourcePatch } from './patch-kind.js';

export const VITE_IMPORT = "import { reticle } from '@reticlehq/vite-plugin';";
const RETICLE_MARKER = '@reticlehq/vite-plugin';

/**
 * The `reticle(...)` call — the bridge port so the injected connect targets it.
 *
 * **`captureNetworkBodies` is OPT-IN.** It was written in by default, and the argument for that was
 * a good one: without a body, a write that answers 2xx grades `unknown / outcome_unread`, because a
 * 200 describes the transport and not the result. Measured on a real payments UI — a refund posted
 * rupees into a paise field, the server answered 200 having refunded a hundredth of it, the page
 * rendered the amount the user had typed, and every DOM-level check passed.
 *
 * That argument justifies the CAPABILITY. It does not justify the default, and the distinction is
 * what #705 is about. A healthcare workspace proxying authenticated API traffic through Vite ran
 * `init`, and on the first drive their login tokens and patient payloads were in the daemon's
 * buffer. The old comment here conceded the exact gap — "the credential classes are redacted ... but
 * an address or an email is not, and nothing here should decide that for someone silently" — and
 * then decided it for them, because writing the line into their config IS deciding. `init` is run
 * unattended by an agent; the person who knows the data is sensitive is not in the room.
 *
 * So the default is off and the ways in are all deliberate:
 *   - `reticle init --capture-bodies` writes the line, for someone who has decided
 *   - `VITE_RETICLE_CAPTURE_BODIES=1` turns it on for ONE dev-server run, no config edit
 *   - adding the option by hand, which is what the tools tell you to do
 *
 * Nothing goes quiet in exchange. Every tool that needs a body already says so when it is missing
 * and names the option — see honesty/uncaptured-bodies.ts, honesty/verified.ts, predicate-eval.ts
 * and reconcile-tools.ts — so the capability is discovered at the moment it is wanted, by the person
 * who wanted it, instead of being switched on before anyone has asked.
 */
function reticlePluginCall(port: number | undefined, captureBodies: boolean): string {
  const options = [
    ...(port === undefined ? [] : [`port: ${String(port)}`]),
    ...(captureBodies ? ['captureNetworkBodies: true'] : []),
  ];
  return 0 === options.length ? 'reticle()' : `reticle({ ${options.join(', ')} })`;
}
/** Matches the start of a `plugins: [` array literal. */
const PLUGINS_ARRAY = /plugins\s*:\s*\[/;
/** Matches an ES import statement (used to place our import after the last one). */
const IMPORT_LINE = /^import\s.+from\s+['"][^'"]+['"];?\s*$/gm;
/**
 * The opening `{` of the exported config object — `defineConfig({`, or a bare `export default {`.
 * Used only when there is no `plugins` array to extend: the object is right there, so adding the
 * key is the same edit as extending the array, and bailing sent a user whose config merely set
 * `server.port` to a manual paste for a change we can make correctly.
 *
 * A config built by a call (`defineConfig(buildOptions())`) has no literal to extend and still
 * bails — the rule stays "only edit a shape we can see whole".
 */
const CONFIG_OBJECT = /(export\s+default\s+(?:defineConfig\s*\(\s*)?)\{/;

/** Alias kept so existing call sites read in Vite terms; the vocabulary is shared (see patch-kind). */
export const VitePatchKind = PatchKind;
export type VitePatchKind = PatchKind;

type VitePatch = SourcePatch;

const NO_PLUGINS_REASON = "couldn't find a `plugins: [...]` array to extend";

function insertImport(source: string): string {
  const matches = [...source.matchAll(IMPORT_LINE)];
  const last = matches[matches.length - 1];
  if (last?.index === undefined) {
    return `${VITE_IMPORT}\n${source}`;
  }
  const end = last.index + last[0].length;
  return `${source.slice(0, end)}\n${VITE_IMPORT}${source.slice(end)}`;
}

/**
 * Insert right after the opening `[` of the plugins array, spaced the way the surrounding line is.
 *
 * A multi-line array puts a newline next, and `[reticle(), \n` leaves trailing whitespace — exactly
 * what a formatter rewrites, turning a one-line install into a diff against the user's own style. A
 * single-line array needs the space, or the result reads `[reticle(),react()]`.
 */
function insertPlugin(source: string, port: number | undefined, captureBodies: boolean): string {
  return source.replace(PLUGINS_ARRAY, (match, _g, offset: number) => {
    const next = source[offset + match.length] ?? '';
    const separator = '' === next || /\s/.test(next) ? '' : ' ';
    return `${match}${reticlePluginCall(port, captureBodies)},${separator}`;
  });
}

/**
 * Add a whole `plugins: [reticle()]` key to a config object that has none, matching the layout of
 * the object it lands in: a multi-line object gets its own indented line, a one-liner stays inline.
 */
function insertPluginsKey(
  source: string,
  port: number | undefined,
  captureBodies: boolean,
): string {
  return source.replace(CONFIG_OBJECT, (_match, prefix: string, offset: number) => {
    const rest = source.slice(offset + _match.length);
    const multiline = /^\s*\n/.test(rest);
    const indent = /^\s*\n(\s*)\S/.exec(rest)?.[1] ?? '  ';
    const key = `plugins: [${reticlePluginCall(port, captureBodies)}],`;
    return multiline ? `${prefix}{\n${indent}${key}` : `${prefix}{ ${key}`;
  });
}

export function patchViteConfig(source: string, port?: number, captureBodies = false): VitePatch {
  if (source.includes(RETICLE_MARKER)) {
    return { kind: VitePatchKind.ALREADY };
  }
  if (PLUGINS_ARRAY.test(source)) {
    return {
      kind: VitePatchKind.APPLY,
      code: insertImport(insertPlugin(source, port, captureBodies)),
    };
  }
  if (CONFIG_OBJECT.test(source)) {
    return {
      kind: VitePatchKind.APPLY,
      code: insertImport(insertPluginsKey(source, port, captureBodies)),
    };
  }
  return { kind: VitePatchKind.MANUAL, reason: NO_PLUGINS_REASON };
}
