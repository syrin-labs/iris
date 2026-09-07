/**
 * The flow store a SESSION's flows belong in.
 *
 * `deps.flows` is bound to the daemon's own root at construction, which is right only when the
 * daemon happens to have been started in the project it is driving. A user-scoped MCP registration
 * is the common case and the editor starts it wherever it likes, so "where the daemon was launched"
 * and "which app is being verified" are usually different directories.
 *
 * This used to live inside flow-tools and was applied at exactly ONE of ten call sites. The result
 * is the half-applied state `sessionRoot` warns about in its own comment, reached in practice:
 *
 *   - the HUD listed the daemon repo's flows while driving somebody else's app — Electron and Tauri
 *     flows shown over a React dashboard, none of which existed in the checkout being verified
 *   - `flow_replay` answered `flow_not_found` for a flow sitting on disk, because it looked in the
 *     daemon's root while `reticle verify` (which roots itself at cwd) replayed the same flow fine
 *   - and the two save paths disagreed with each other, so where a flow landed depended on which
 *     tool wrote it
 *
 * Reported as "running the daemon from here but taking the directory from there", which is exactly
 * what it was.
 *
 * Rebinding is cheap — a FlowStore is a filesystem port, a root and a clock — and the common case
 * allocates nothing: when no resolver is wired, or it names the root already in use, `deps.flows` is
 * returned unchanged.
 */
import { FlowStore } from './flows.js';
import type { ToolDeps } from '../tools/tool-kit.js';

export function flowsForSession(
  deps: ToolDeps,
  projectId: string | undefined,
): { flows: FlowStore; root: string } {
  const resolved = deps.artifactRootFor?.(projectId);
  if (resolved === undefined || resolved.root === deps.reticleRoot) {
    return { flows: deps.flows, root: deps.reticleRoot };
  }
  return { flows: new FlowStore(deps.fs, resolved.root, { now: deps.now }), root: resolved.root };
}
