/**
 * @reticlehq/core — the wire contract at the bottom of the Reticle graph (zod its only dependency).
 *
 * API-stability note: the exports below the divider are INTERNAL cross-package plumbing — they are
 * re-exported so the other @reticlehq/* packages can share one implementation, NOT as a stable surface
 * for outside consumers. They can change in a minor release. Depend on the STABLE section for anything
 * outside this monorepo. (A dedicated `@reticlehq/core/internal` entry point is a 3.0 consideration; for
 * now the boundary is documented here.)
 */

// ── STABLE public surface: the wire/domain contract ──────────────────────────────────────────────
export * from './constants.js'; // EventType, ActionType, wire constants, TRANSPORT_LIMITS, …
export * from './source-constants.js'; // DATA_RETICLE_SOURCE_ATTR, RETICLE_ROOT_GLOBAL
export * from './event-classification.js'; // CHURN_TYPES — shared eviction priority for buffer/queue
export * from './verified-constants.js'; // Verified — the one field an agent gates on
export * from './verify-progress.js'; // VerifyPhase — what a run is doing while it is still doing it
export * from './session-constants.js';
export * from './document-identity.js'; // which document an observation belongs to
export * from './edit-epoch.js'; // which round of source edits an observation belongs to
export * from './messages.js'; // ReticleEvent + the message schemas
export * from './event-payloads.js'; // per-event payload schemas + wire vocab
export * from './event-priority.js'; // which events survive the bridge rate cap
export * from './flow-types.js'; // FlowStep, FlowExpect, FlowStepTool, replay result shapes
export * from './verification-run.js'; // run/verdict shapes for the CI surface
export * from './types.js';
export * from './brand.js'; // RunId / SessionId / Ref brands + validators
export * from './net.js'; // NetInitiator / ipc:// scheme — network + desktop-IPC call vocabulary
export * from './findings.js'; // crawl anomalies + cross-channel contradictions
export * from './desktop-contract.js'; // the Electron preload/main/renderer/daemon string contract
export * from './consequence.js';
export * from './project-id.js';
export * from './notices.js';
export * from './journal.js';
// Not an API — three names that exist so importing the BROWSER SDK from here fails with a sentence
// naming @reticlehq/browser, instead of a bare SyntaxError that blanks the app. See the module.
export * from './browser-misdirect.js';

// ── INTERNAL cross-package plumbing (shared impl; not a stable outside API — may change in a minor) ─
export * from './daemon-registry.js'; // daemon discovery, used by the vite plugin + server
export * from './dev-server-registry.js'; // the return leg: dev servers announcing themselves
export * from './project-registry.js'; // projectId -> directory, so a cross-repo daemon can still resolve
export * from './intent.js'; // what a change was supposed to make true, captured while somebody knows
export * from './run-context.js'; // what a run established, folded and capped, for the agent to pull back
export * from './instrumentation-gap.js'; // what Reticle could not see, and the change that would let it
export * from './security.js'; // sanitize/serialize helpers shared by browser + server
export * from './redaction.js'; // isSensitiveKey / scrubKnownSecrets — the shared redaction rules
export * from './state-select.js'; // selectPath / capDepth — shared by browser SDK + server fallback
export * from './toon.js'; // TOON encoding used by the server's result encoder
export * from './upgrade.js'; // self-update policy shared by the CLI
export * from './telemetry.js';
// Split out of telemetry.js at the 1000-line cap; the barrel keeps the import path callers use.
export * from './no-session-reason.js';
export * from './telemetry-refusal.js';
export * from './telemetry-session.js'; // the session/project rollup payloads
export * from './telemetry-license.js'; // LicenseActivation — shared by the licence gate and telemetry
export * from './telemetry-feedback.js'; // the two things a PERSON writes: feedback + a self-declared identity // anonymous adoption telemetry wire contract (DAU/WAU/MAU/installs)
export * from './impact.js'; // the user's own record of what Reticle has done for them (local only)
export * from './impact-savings.js'; // the savings model - one file, so every claim is derivable there
export { CONTRACT_FINGERPRINT, fnv1a, fingerprintOf } from './contract-fingerprint.js';
export { fingerprintFinding, type FindingIdentity } from './finding-fingerprint.js';
export * from './unreachable-notice.js'; // the page's unreachable warning, as a contract the daemon parses
