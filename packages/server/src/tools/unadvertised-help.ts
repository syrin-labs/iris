/**
 * What to say when an agent calls a real Reticle tool that this profile does not advertise.
 *
 * The default surface is the verify loop plus the two meta-tools; the extended one is larger but
 * still capped. Counts live in `surface-sizes.test.ts` — restating them here is how they drift.
 * Everything omitted stays fully callable through `reticle_run`, which `surface-reachability.test.ts`
 * guards.
 *
 * The gap was in the ERROR. The MCP SDK answers `Tool <name> not found`, which is indistinguishable
 * from "this tool does not exist", so an agent that trusts it stops trying. Reported from a real
 * sweep of a Next app-router project: the first pass scored 25 failures that were nothing of the
 * kind — every one of those tools worked through `reticle_run` seconds later.
 *
 * So: a name Reticle owns never comes back as "not found". It comes back with the call that works
 * and the switch that makes it stop being necessary.
 */
import { ReticleTool } from './tool-names.js';
import { ADVERTISE_ALL_ENV } from './tool-surface.js';
import { mergedNameRedirect, mergedNameMessage } from './merged-name-redirect.js';

/**
 * Guidance for `name`, or undefined when there is nothing useful to add — the tool IS advertised (so
 * any error belongs to the call itself), or the name is not ours to explain.
 */
export function unadvertisedToolHelp(
  name: string,
  advertised: ReadonlySet<string>,
  known: ReadonlySet<string>,
): string | undefined {
  if (advertised.has(name)) return undefined;
  // A name that MOVED gets the move, not a profile lecture — it is not un-advertised, it is gone.
  const moved = mergedNameRedirect(name);
  if (moved !== undefined) return mergedNameMessage(name, moved);
  if (!known.has(name)) return undefined;
  return (
    `${name} exists and works, but is not advertised under this tool profile — the schemas for all ` +
    `tools are re-sent every turn, so the default advertises a subset and keeps the rest one call ` +
    `away. It is NOT missing: invoke it with ` +
    `${ReticleTool.RUN} { tool: "${name}", args: { ... } }. ` +
    `Call ${ReticleTool.TOOLS} { names: ["${name}"] } for its parameters. ` +
    `If you need it repeatedly, start the daemon with ${ADVERTISE_ALL_ENV}=1 for the extended ` +
    `surface. That is read by the DAEMON at startup, so it takes effect on the next daemon, and it ` +
    `advertises MORE tools rather than all of them — editors budget MCP tools as a shared count, so ` +
    `${ReticleTool.RUN} stays the way to reach the rest.`
  );
}
