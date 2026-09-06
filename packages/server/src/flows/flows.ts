import { asFlowName, type FlowName } from '@reticlehq/core';
import {
  AnchorKind,
  DEGRADED_ANCHOR_ROLE,
  FLOW_FILE_VERSION,
  FlowErrorCode,
  FlowFileSchema,
  QueryBy,
  defaultIsSensitiveKey,
} from '@reticlehq/core';
import type {
  ActionType,
  FlowAnchor,
  FlowExpect,
  FlowFile,
  FlowStep,
  HealChange,
  InstrumentationGap,
} from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { asString, asRecord } from '../tools/tools-helpers.js';
import { applyHealChanges } from './heal.js';
import { flowIntentGap, linkFlowIntent } from './flow-intent.js';
import { IntentStore } from '../intent/intent-store.js';
import type { CompiledProgram, RecordedStep } from './recordings.js';
import type { FileSystemPort } from '../project/fs-port.js';
import { flowDir, flowPath, reticleDirPaths, isValidFlowName } from '../project/reticle-dir.js';
import { describeFlowZodFailure, parseFlowFileText } from './flow-expect-grammar.js';

/**
 * A projectId only scopes storage when it's a safe single path segment (it's stamped from the
 * session's HELLO, but the store defends the disk boundary itself). An unsafe/absent value collapses
 * to `undefined` — the flat, global store — so a malformed id can never escape `.reticle/flows/`.
 */
const safeProjectId = (projectId?: string): string | undefined =>
  projectId !== undefined && isValidFlowName(projectId) ? projectId : undefined;

/** A monotonic clock injected for createdAt — never call Date.now inside the store (rule 7). */
export interface Clock {
  now(): number;
}

/** Discriminated result so callers never branch on free strings. */
export type FlowResult<T> =
  { ok: true; value: T } | { ok: false; code: FlowErrorCode; detail?: string };

/**
 * The anchor for a DEGRADED step (no resolvable testid). A volatile eXX ref is NEVER persisted —
 * the on-disk flow carries a placeholder ROLE anchor + degraded:true instead, so a ref can never
 * leak into a git-checked file and the step still round-trips (the ROLE anchor satisfies min(1)).
 */
function degradedAnchor(): FlowAnchor {
  return { kind: AnchorKind.ROLE, role: DEGRADED_ANCHOR_ROLE };
}

/**
 * Build a stable `component` auto-anchor from a normalized step's component/source args. Returns
 * null when neither is present (caller falls back to degraded). The on-disk anchor carries the
 * component name + source location — re-resolvable by `reticle_query by:'component'` at replay.
 */
/** The `source` location carried on a normalized step's args, or undefined if absent/malformed. */
function sourceArg(
  src: Record<string, unknown>,
): { file: string; line: number; column?: number } | undefined {
  const source = asRecord(src['source']);
  const file = source['file'];
  const line = source['line'];
  if (typeof file !== 'string' || 0 === file.length || typeof line !== 'number') return undefined;
  const out: { file: string; line: number; column?: number } = { file, line };
  if ('number' === typeof source['column']) out.column = source['column'];
  return out;
}

function componentAnchor(src: Record<string, unknown>): FlowAnchor | null {
  const component = asString(src['component']);
  const source = sourceArg(src);
  if (component === undefined && source === undefined) return null;
  const anchor: Extract<FlowAnchor, { kind: typeof AnchorKind.COMPONENT }> = {
    kind: AnchorKind.COMPONENT,
  };
  if (component !== undefined) anchor.component = component;
  if (source !== undefined) anchor.source = source;
  return anchor;
}

/** Pick the on-disk anchor for a normalized step: testid > component(auto) > degraded role. */
export function anchorForStep(args: Record<string, unknown>): {
  anchor: FlowAnchor;
  degraded: boolean;
} {
  const by = asString(args['by']);
  const value = asString(args['value']);
  if (by === QueryBy.TESTID && value !== undefined) {
    const anchor: Extract<FlowAnchor, { kind: typeof AnchorKind.TESTID }> = {
      kind: AnchorKind.TESTID,
      value,
    };
    const source = sourceArg(args);
    if (source !== undefined) anchor.source = source;
    return { anchor, degraded: false };
  }
  // Role + NAME is a real anchor, not a degraded placeholder.
  //
  // The vocabulary has always described `{ kind:'role', role, name }` as an addressable anchor, and
  // nothing ever produced one — the only ROLE anchor written to disk was the degraded placeholder
  // that means "add a data-testid". So a step the recorder anchored by accessible name arrived here
  // and had that name thrown away, which is precisely the anchor that distinguishes one row's
  // control from another's when a shared JSX source location cannot.
  if (by === QueryBy.ROLE && value !== undefined) {
    const name = asString(args['name']);
    if (name !== undefined && name.length > 0) {
      // The schema carries role + name only; provenance lives on the step, not the anchor.
      return { anchor: { kind: AnchorKind.ROLE, role: value, name }, degraded: false };
    }
  }
  if (by === QueryBy.COMPONENT) {
    const anchor = componentAnchor(args);
    if (anchor !== null) return { anchor, degraded: false };
  }
  return { anchor: degradedAnchor(), degraded: true };
}

/** Convert one normalized sub-step (act_sequence child) into an anchored FlowStep. */
function subStepToFlowStep(raw: unknown): FlowStep {
  const sub = asRecord(raw);
  const action = asString(sub['action']) as ActionType | undefined;
  const args = asRecord(sub['args']);
  const { anchor, degraded } = anchorForStep(sub);
  return buildStep(ReticleTool.ACT, anchor, action, args, degraded);
}

/**
 * What a redacted fill value is replaced WITH.
 *
 * Replaced, never dropped. Replay still needs a step there, and a flow that silently loses its
 * password step drifts at sign-in forever with no explanation of why. The placeholder also tells a
 * reader what to do: the value belongs in the environment, not in a file they are about to commit.
 */
export const REDACTED_FILL = '<redacted: supply at replay>';

/**
 * Strip credentials from what gets written to disk.
 *
 *  is the GIT-CHECKED flow store — that is its whole purpose, and this file's own
 * header already insists a volatile ref must never "leak into a git-checked file". A password did:
 * recording a sign-in captures the fill VALUE verbatim, so the first flow anybody records on an
 * authenticated app writes their password into a file they then commit. Found by driving a fresh
 * workspace, where .claude/scheduled_tasks.lock
.claude/skills/reticle-ui/SKILL.md
.env.example
.gcloudignore
.gitattributes
.github/workflows/ci.yml
.gitignore
.prettierignore
.prettierrc
.reticle/flows/console-4734c2f0/sign-in.json
.reticle/flows/console-4734c2f0/triage-filter-link.json
.reticle/flows/console-4734c2f0/triage-queue.json
CLAUDE.md
LICENSE
README.md
apps/api/.env.example
apps/api/.gitignore
apps/api/.prettierrc.json
apps/api/certs/supabase-prod-ca.crt
apps/api/eslint.config.mjs
apps/api/package.json
apps/api/pnpm-lock.yaml
apps/api/scripts/gen-license-keypair.mjs
apps/api/scripts/purge-test-user.mjs
apps/api/scripts/setup-razorpay-plans.mjs
apps/api/src/constants/auth.constants.ts
apps/api/src/constants/billing.constants.ts
apps/api/src/constants/corpus.constants.ts
apps/api/src/constants/http.constants.ts
apps/api/src/constants/identity.constants.ts
apps/api/src/constants/issues.constants.ts
apps/api/src/constants/overview.constants.ts
apps/api/src/constants/project.constants.ts
apps/api/src/constants/review.constants.ts
apps/api/src/constants/runs.constants.ts
apps/api/src/constants/verification.constants.ts
apps/api/src/domain/admin/admin-gate.test.ts
apps/api/src/domain/admin/admin.routes.test.ts
apps/api/src/domain/admin/admin.routes.ts
apps/api/src/domain/admin/admin.service.ts
apps/api/src/domain/billing/billing.routes.ts
apps/api/src/domain/billing/coupon.routes.test.ts
apps/api/src/domain/billing/coupons.service.ts
apps/api/src/domain/billing/entitlements.test.ts
apps/api/src/domain/billing/entitlements.ts
apps/api/src/domain/billing/plans.routes.test.ts
apps/api/src/domain/billing/subscription.routes.test.ts
apps/api/src/domain/corpus/corpus.service.test.ts
apps/api/src/domain/corpus/corpus.service.ts
apps/api/src/domain/flows/flows.routes.ts
apps/api/src/domain/flows/flows.service.test.ts
apps/api/src/domain/flows/flows.service.ts
apps/api/src/domain/identity/access-control.routes.test.ts
apps/api/src/domain/identity/api-key.test.ts
apps/api/src/domain/identity/api-key.ts
apps/api/src/domain/identity/auth-audit.service.ts
apps/api/src/domain/identity/create-org.routes.test.ts
apps/api/src/domain/identity/device-auth.service.ts
apps/api/src/domain/identity/identity.routes.ts
apps/api/src/domain/identity/identity.service.test.ts
apps/api/src/domain/identity/identity.service.ts
apps/api/src/domain/identity/identity.types.test.ts
apps/api/src/domain/identity/identity.types.ts
apps/api/src/domain/identity/invites.test.ts
apps/api/src/domain/identity/join-workspace.test.ts
apps/api/src/domain/identity/login-code.ts
apps/api/src/domain/identity/members.routes.test.ts
apps/api/src/domain/identity/members.routes.ts
apps/api/src/domain/identity/oauth.routes.test.ts
apps/api/src/domain/identity/oauth.routes.ts
apps/api/src/domain/identity/password-auth.test.ts
apps/api/src/domain/identity/password-routes.test.ts
apps/api/src/domain/identity/password.test.ts
apps/api/src/domain/identity/password.ts
apps/api/src/domain/identity/permissions.test.ts
apps/api/src/domain/identity/permissions.ts
apps/api/src/domain/identity/project-scope.routes.test.ts
apps/api/src/domain/identity/team-scenarios.test.ts
apps/api/src/domain/ingest/agent-attribution.test.ts
apps/api/src/domain/ingest/ingest.service.ts
apps/api/src/domain/insights/insights.routes.test.ts
apps/api/src/domain/insights/insights.routes.ts
apps/api/src/domain/insights/insights.service.ts
apps/api/src/domain/issues/attribution-filter.test.ts
apps/api/src/domain/issues/issue-extract.test.ts
apps/api/src/domain/issues/issue-extract.ts
apps/api/src/domain/issues/issue-owner.test.ts
apps/api/src/domain/issues/issue-repair.test.ts
apps/api/src/domain/issues/issues.routes.test.ts
apps/api/src/domain/issues/issues.routes.ts
apps/api/src/domain/issues/issues.service.test.ts
apps/api/src/domain/issues/issues.service.ts
apps/api/src/domain/licensing/licensing.service.test.ts
apps/api/src/domain/licensing/licensing.service.ts
apps/api/src/domain/licensing/subscription.service.test.ts
apps/api/src/domain/licensing/subscription.service.ts
apps/api/src/domain/memory/memory-constants.ts
apps/api/src/domain/memory/memory-from-intent.test.ts
apps/api/src/domain/memory/memory-from-intent.ts
apps/api/src/domain/memory/memory-merge.test.ts
apps/api/src/domain/memory/memory-merge.ts
apps/api/src/domain/memory/memory.routes.test.ts
apps/api/src/domain/memory/memory.routes.ts
apps/api/src/domain/memory/memory.service.ts
apps/api/src/domain/overview/honesty.test.ts
apps/api/src/domain/overview/overview.routes.ts
apps/api/src/domain/overview/overview.service.test.ts
apps/api/src/domain/overview/overview.service.ts
apps/api/src/domain/project/project-access.routes.ts
apps/api/src/domain/project/project-access.test.ts
apps/api/src/domain/project/project-cascade.test.ts
apps/api/src/domain/project/project-name.test.ts
apps/api/src/domain/project/project.routes.ts
apps/api/src/domain/project/project.service.test.ts
apps/api/src/domain/project/project.service.ts
apps/api/src/domain/reviews/review.service.test.ts
apps/api/src/domain/reviews/review.service.ts
apps/api/src/domain/runs/regrade-backfill.test.ts
apps/api/src/domain/runs/regrade-backfill.ts
apps/api/src/domain/runs/run-grade.test.ts
apps/api/src/domain/runs/run-grade.ts
apps/api/src/domain/runs/runs.routes.ts
apps/api/src/domain/runs/runs.service.test.ts
apps/api/src/domain/runs/runs.service.ts
apps/api/src/domain/sync/permutations.test.ts
apps/api/src/domain/sync/sync.routes.test.ts
apps/api/src/domain/sync/sync.routes.ts
apps/api/src/domain/sync/sync.service.ts
apps/api/src/domain/verifications/verifications.routes.ts
apps/api/src/domain/verifications/verifications.service.test.ts
apps/api/src/domain/verifications/verifications.service.ts
apps/api/src/http/app-context.ts
apps/api/src/http/app.test.ts
apps/api/src/http/app.ts
apps/api/src/http/cookies.ts
apps/api/src/http/guards.ts
apps/api/src/http/http-kit.ts
apps/api/src/http/malformed-body.test.ts
apps/api/src/http/server.ts
apps/api/src/http/spa.test.ts
apps/api/src/platform/auth/session.test.ts
apps/api/src/platform/auth/session.ts
apps/api/src/platform/clock.ts
apps/api/src/platform/config.test.ts
apps/api/src/platform/config.ts
apps/api/src/platform/db/database.test.ts
apps/api/src/platform/db/database.ts
apps/api/src/platform/db/schema.ts
apps/api/src/platform/google-id-token.test.ts
apps/api/src/platform/google-id-token.ts
apps/api/src/platform/id.ts
apps/api/src/platform/license-signer.ts
apps/api/src/platform/mailer.test.ts
apps/api/src/platform/mailer.ts
apps/api/src/platform/oauth.test.ts
apps/api/src/platform/oauth.ts
apps/api/src/platform/payment.ts
apps/api/src/platform/rate-limit.test.ts
apps/api/src/platform/rate-limit.ts
apps/api/src/platform/razorpay.test.ts
apps/api/src/platform/razorpay.ts
apps/api/src/platform/reticle-runner.test.ts
apps/api/src/platform/reticle-runner.ts
apps/api/src/platform/runner.ts
apps/api/src/platform/verification-worker.ts
apps/api/src/test-support/flow-fixture.ts
apps/api/src/test-support/run-fixture.ts
apps/api/src/types/brand.ts
apps/api/src/types/fastify.d.ts
apps/api/tsconfig.json
apps/api/vitest.config.ts
apps/console/.env.example
apps/console/.gitignore
apps/console/.prettierrc.json
apps/console/.reticle/cloud.json
apps/console/components.json
apps/console/eslint.config.mjs
apps/console/index.html
apps/console/package.json
apps/console/pnpm-lock.yaml
apps/console/scripts/selfcheck.mjs
apps/console/src/App.tsx
apps/console/src/api/client.ts
apps/console/src/api/endpoints.ts
apps/console/src/api/types.ts
apps/console/src/app/app-shell.tsx
apps/console/src/app/auth-context.tsx
apps/console/src/app/live.ts
apps/console/src/app/new-workspace.tsx
apps/console/src/app/org-switcher.tsx
apps/console/src/app/project-context.test.tsx
apps/console/src/app/project-context.tsx
apps/console/src/app/project-switcher.tsx
apps/console/src/app/scope-notice.tsx
apps/console/src/app/theme.ts
apps/console/src/app/toast.tsx
apps/console/src/components/ui.tsx
apps/console/src/constants/api.constants.ts
apps/console/src/design/tailwind.css
apps/console/src/design/theme.css
apps/console/src/design/tokens.ts
apps/console/src/features/auth/device-view.tsx
apps/console/src/features/auth/login-view.tsx
apps/console/src/features/billing/billing-view.tsx
apps/console/src/features/billing/redeem-panel.tsx
apps/console/src/features/connect/connect-view.test.tsx
apps/console/src/features/connect/connect-view.tsx
apps/console/src/features/connect/copy-button.tsx
apps/console/src/features/issues/assignee.tsx
apps/console/src/features/issues/expected-actual.tsx
apps/console/src/features/issues/fix-prompt.tsx
apps/console/src/features/issues/issues-view.test.tsx
apps/console/src/features/issues/issues-view.tsx
apps/console/src/features/issues/source-link.tsx
apps/console/src/features/keys/keys-view.test.tsx
apps/console/src/features/keys/keys-view.tsx
apps/console/src/features/memory/memory-view.tsx
apps/console/src/features/overview/getting-started.test.tsx
apps/console/src/features/overview/getting-started.tsx
apps/console/src/features/overview/impact-board.test.tsx
apps/console/src/features/overview/impact-board.tsx
apps/console/src/features/overview/impact-format.ts
apps/console/src/features/overview/overview-view.test.tsx
apps/console/src/features/overview/overview-view.tsx
apps/console/src/features/overview/people-panel.tsx
apps/console/src/features/overview/trust-panels.test.tsx
apps/console/src/features/overview/trust-panels.tsx
apps/console/src/features/runs/runs-view.tsx
apps/console/src/features/settings/members-panel.test.tsx
apps/console/src/features/settings/members-panel.tsx
apps/console/src/features/settings/plan-panel.tsx
apps/console/src/features/settings/project-access-panel.test.tsx
apps/console/src/features/settings/project-access-panel.tsx
apps/console/src/features/settings/settings-view.test.tsx
apps/console/src/features/settings/settings-view.tsx
apps/console/src/lib/utils.ts
apps/console/src/main.tsx
apps/console/src/test-setup.ts
apps/console/src/test-support.ts
apps/console/src/ui/alert-dialog.tsx
apps/console/src/ui/avatar.tsx
apps/console/src/ui/badge.tsx
apps/console/src/ui/button.tsx
apps/console/src/ui/card.tsx
apps/console/src/ui/checkbox.tsx
apps/console/src/ui/command.tsx
apps/console/src/ui/dialog.tsx
apps/console/src/ui/dropdown-menu.tsx
apps/console/src/ui/index.ts
apps/console/src/ui/input.tsx
apps/console/src/ui/label.tsx
apps/console/src/ui/popover.tsx
apps/console/src/ui/scroll-area.tsx
apps/console/src/ui/select.tsx
apps/console/src/ui/separator.tsx
apps/console/src/ui/sheet.tsx
apps/console/src/ui/skeleton.tsx
apps/console/src/ui/sonner.tsx
apps/console/src/ui/switch.tsx
apps/console/src/ui/table.tsx
apps/console/src/ui/tabs.tsx
apps/console/src/ui/textarea.tsx
apps/console/src/ui/tooltip.tsx
apps/console/tsconfig.json
apps/console/vite.config.ts
apps/console/vitest.config.ts
apps/verifier/package.json
apps/verifier/src/anthropic-driver.test.ts
apps/verifier/src/anthropic-driver.ts
apps/verifier/src/bench.ts
apps/verifier/src/best-effort.ts
apps/verifier/src/call-tool.test.ts
apps/verifier/src/call-tool.ts
apps/verifier/src/capability.ts
apps/verifier/src/cli.ts
apps/verifier/src/coverage.test.ts
apps/verifier/src/coverage.ts
apps/verifier/src/differential.test.ts
apps/verifier/src/differential.ts
apps/verifier/src/explore/routes-memory.test.ts
apps/verifier/src/explore/routes.test.ts
apps/verifier/src/explore/routes.ts
apps/verifier/src/explore/scope.test.ts
apps/verifier/src/explore/scope.ts
apps/verifier/src/explore/verify-routes-live.test.ts
apps/verifier/src/explore/verify-routes.test.ts
apps/verifier/src/explore/verify-routes.ts
apps/verifier/src/gateway-live.test.ts
apps/verifier/src/gateway.test.ts
apps/verifier/src/gateway.ts
apps/verifier/src/grade-reconcile.test.ts
apps/verifier/src/grade.ts
apps/verifier/src/harness.test.ts
apps/verifier/src/harness.ts
apps/verifier/src/index.ts
apps/verifier/src/inject/inject-live.test.ts
apps/verifier/src/inject/inject-run.test.ts
apps/verifier/src/inject/injecting-launcher.test.ts
apps/verifier/src/inject/injecting-launcher.ts
apps/verifier/src/inject/origin-bridges.test.ts
apps/verifier/src/inject/origin-bridges.ts
apps/verifier/src/inject/sdk-bundle.test.ts
apps/verifier/src/inject/sdk-bundle.ts
apps/verifier/src/memory/knowledge-store.test.ts
apps/verifier/src/memory/knowledge-store.ts
apps/verifier/src/model/app-model-starting-route.test.ts
apps/verifier/src/model/app-model.test.ts
apps/verifier/src/model/app-model.ts
apps/verifier/src/oracles/crawl-artifact.test.ts
apps/verifier/src/oracles/crawl-artifact.ts
apps/verifier/src/oracles/finding.ts
apps/verifier/src/oracles/history.test.ts
apps/verifier/src/oracles/history.ts
apps/verifier/src/oracles/index.ts
apps/verifier/src/oracles/metamorphic.test.ts
apps/verifier/src/oracles/metamorphic.ts
apps/verifier/src/oracles/state-write-drift.test.ts
apps/verifier/src/oracles/state-write-drift.ts
apps/verifier/src/parallel/fanout.test.ts
apps/verifier/src/parallel/fanout.ts
apps/verifier/src/path-segment.test.ts
apps/verifier/src/path-segment.ts
apps/verifier/src/precision.test.ts
apps/verifier/src/precision.ts
apps/verifier/src/preview/readiness-run.test.ts
apps/verifier/src/preview/readiness.test.ts
apps/verifier/src/preview/readiness.ts
apps/verifier/src/promote.test.ts
apps/verifier/src/promote.ts
apps/verifier/src/regression.test.ts
apps/verifier/src/regression.ts
apps/verifier/src/report-gaps.test.ts
apps/verifier/src/report-routes.test.ts
apps/verifier/src/report.test.ts
apps/verifier/src/report.ts
apps/verifier/src/reticle-toolset.test.ts
apps/verifier/src/reticle-toolset.ts
apps/verifier/src/runner.test.ts
apps/verifier/src/runner.ts
apps/verifier/src/serve.ts
apps/verifier/src/store-fs.test.ts
apps/verifier/src/store-fs.ts
apps/verifier/src/suite/derive-expect.test.ts
apps/verifier/src/suite/derive-expect.ts
apps/verifier/src/suite/domains.test.ts
apps/verifier/src/suite/domains.ts
apps/verifier/src/suite/flow-health.test.ts
apps/verifier/src/suite/flow-health.ts
apps/verifier/src/suite/flow-identity.test.ts
apps/verifier/src/suite/flow-identity.ts
apps/verifier/src/suite/replay-live.test.ts
apps/verifier/src/suite/replay.test.ts
apps/verifier/src/suite/replay.ts
apps/verifier/src/suite/route-set.test.ts
apps/verifier/src/suite/route-set.ts
apps/verifier/src/suite/route-tagging.test.ts
apps/verifier/src/suite/segment.test.ts
apps/verifier/src/suite/segment.ts
apps/verifier/src/suite/suite-store.test.ts
apps/verifier/src/suite/suite-store.ts
apps/verifier/src/suite/unproven.test.ts
apps/verifier/src/suite/unproven.ts
apps/verifier/src/suite/write-set.ts
apps/verifier/src/tool-contract.test.ts
apps/verifier/src/transport.test.ts
apps/verifier/src/transport.ts
apps/verifier/src/with-timeout.test.ts
apps/verifier/src/with-timeout.ts
apps/verifier/tsconfig.json
deploy/README.md
deploy/api.Dockerfile
deploy/deploy.sh
deploy/secrets.env.example
deploy/verifier.Dockerfile
docs/fixtures.md
docs/gates.md
docs/persona.md
docs/service-api.md
eslint.config.mjs
eval/fixtures/index.html
eval/fixtures/package.json
eval/fixtures/src/main.ts
eval/fixtures/src/manifest.ts
eval/fixtures/src/scenario.ts
eval/fixtures/src/scenarios/canvas.ts
eval/fixtures/src/scenarios/checkout.ts
eval/fixtures/src/scenarios/dashboard.ts
eval/fixtures/src/scenarios/game.ts
eval/fixtures/src/scenarios/index.ts
eval/fixtures/src/scenarios/landing.ts
eval/fixtures/src/scenarios/realtime.ts
eval/fixtures/src/scenarios/trading.ts
eval/fixtures/src/scenarios/video.ts
eval/fixtures/src/scenarios/workspace.ts
eval/fixtures/src/styles.css
eval/fixtures/tsconfig.json
eval/fixtures/vite.config.ts
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
pre-commit.sh
scripts/capacity.mjs
scripts/eval-env.sh
scripts/token-cost.mjs
tsconfig.base.json
tsconfig.json
turbo.json confirmed a tracked flow holding a plaintext password.
 *
 * The decision keys off the ANCHOR, not the value. The anchor names the field — ,
 *  — so a credential is recognised by WHERE it was typed rather than by guessing whether
 * the characters look secret, which is the guess that both over-redacts a search box and misses a
 * password that happens to be a dictionary word.
 *
 *  is the same rule the network channel already redacts by. One rule, so a
 * field considered sensitive on the wire cannot be considered safe on disk.
 */
function redactSecretFill(
  anchor: FlowAnchor,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof args['value'] !== 'string') return args;
  const field = anchorFieldName(anchor);
  if (field === undefined || !defaultIsSensitiveKey(field)) return args;
  return { ...args, value: REDACTED_FILL };
}

/**
 * What the anchor CALLS the field it points at.
 *
 * Every anchor kind names its target differently and all of them can name a password: a testid
 * (auth-password), an accessible name (role=textbox, name="Password"), a signal. Checking only the
 * testid variant would redact the app that uses test ids and quietly leak the one that does not —
 * and an app without test ids is exactly the app whose flows were recorded by role.
 */
function anchorFieldName(anchor: FlowAnchor): string | undefined {
  if (AnchorKind.TESTID === anchor.kind) return anchor.value;
  if (AnchorKind.ROLE === anchor.kind) return anchor.name;
  if (AnchorKind.SIGNAL === anchor.kind) return anchor.name;
  return undefined;
}

function buildStep(
  tool: string,
  anchor: FlowAnchor,
  action: ActionType | undefined,
  args: Record<string, unknown>,
  degraded: boolean,
): FlowStep {
  const step: FlowStep = { tool, anchor, args: redactSecretFill(anchor, args) };
  if (action !== undefined) step.action = action;
  if (degraded) step.degraded = true;
  return step;
}

/**
 * Pure: map one normalized RecordedStep → FlowStep with a semantic anchor (+ degraded marker).
 * A ref-only (stable:false) step is recorded with a best-effort anchor and degraded:true —
 * NEVER silently dropped. ACT_SEQUENCE recurses over its sub-steps.
 */
export function recordedStepToFlowStep(step: RecordedStep): FlowStep {
  if (step.tool === ReticleTool.ACT_SEQUENCE) {
    const rawSubs = Array.isArray(step.args['steps']) ? step.args['steps'] : [];
    const subs = rawSubs.map(subStepToFlowStep);
    const degraded = subs.some((s) => true === s.degraded);
    // The first sub-step that HAS an anchor, not blindly the first. Taking subs[0] handed the whole
    // sequence the degraded sentinel whenever sub-step 0 lacked a testid — even with every later
    // sub-step perfectly anchored — and replay then queried the DOM for a testid literally named
    // "unresolved", so the step drifted on all 5 apps, every replay.
    const anchor: FlowAnchor =
      subs.find((s) => s.degraded !== true)?.anchor ?? subs[0]?.anchor ?? degradedAnchor();
    const out: FlowStep = { tool: ReticleTool.ACT_SEQUENCE, anchor, steps: subs };
    if (degraded) out.degraded = true;
    if (step.expect !== undefined) out.expect = step.expect;
    return out;
  }

  const action = asString(step.args['action']) as ActionType | undefined;
  const args = asRecord(step.args['args']);
  const { anchor, degraded } = anchorForStep(step.args);
  const out = buildStep(step.tool, anchor, action, args, degraded);
  if (step.expect !== undefined) out.expect = step.expect;
  return out;
}

interface SaveSummary {
  name: string;
  stepCount: number;
  degraded: number;
  empty: boolean;
  /**
   * Present only when the flow was saved with nothing saying what it is for. Never blocks the save,
   * and absent the moment the flow carries prose or an `intentId`. See `flowIntentGap`.
   */
  intentGap?: InstrumentationGap;
}

/**
 * The structured annotations folded onto a flow at save time: per-step
 * expect predicates (assert-*), dynamic testids (mark-dynamic → flow.dynamic[]), and the flow's
 * success end-condition (success-state). All optional — a save with no annotations writes
 * the same bytes as before.
 */
export interface FlowAnnotations {
  stepExpect: Map<number, FlowExpect>;
  dynamic: string[];
  success?: FlowExpect;
  /** The flow's declared business goal (intent annotation). */
  intent?: string;
}

/** Apply folded annotations onto an anchored flow (pure): per-step expect, dynamic[], success, intent. */
function withAnnotations(flow: FlowFile, ann: FlowAnnotations | undefined): FlowFile {
  if (ann === undefined) return flow;
  const steps = flow.steps.map((step, i) => {
    const expect = ann.stepExpect.get(i);
    return expect === undefined ? step : { ...step, expect };
  });
  const out: FlowFile = { ...flow, steps };
  if (ann.dynamic.length > 0) {
    out.dynamic = ann.dynamic.map((value) => ({ kind: AnchorKind.TESTID, value }));
  }
  if (ann.success !== undefined) out.success = ann.success;
  if (ann.intent !== undefined) out.intent = ann.intent;
  return out;
}

const JSON_INDENT = 2;
const FLOW_SUFFIX = '.json';

/** Persists anchored flows to .reticle/flows/<name>.json. Filesystem + clock are injected. */
export class FlowStore {
  readonly #fs: FileSystemPort;
  readonly #root: string;
  readonly #clock: Clock;

  constructor(fs: FileSystemPort, root: string, clock: Clock) {
    this.#fs = fs;
    this.#root = root;
    this.#clock = clock;
  }

  /**
   * The single byte-stable flow serializer: 2-space indent + one trailing newline. save,
   * saveFlow and heal all route through it so an unchanged flow that round-trips through any
   * of them produces byte-identical on-disk content (locked by the byte-stability tests).
   */
  #serialize(flow: FlowFile): string {
    return `${JSON.stringify(flow, null, JSON_INDENT)}\n`;
  }

  /**
   * Register the flow's business goal in the intent ledger and stamp the row's id onto the flow.
   *
   * Both save paths route through here — the compiled-recording one and the in-page recorder one —
   * because a flow's goal must land in the ledger whichever way the flow arrived. A flow with no
   * goal is returned untouched and nothing is written, so an older flow keeps its exact bytes.
   */
  #linkIntent(flow: FlowFile): Promise<FlowFile> {
    return linkFlowIntent(new IntentStore(this.#fs, this.#root, this.#clock), flow);
  }

  /**
   * What a caller is told about a flow that just landed on disk.
   *
   * Both save paths build it here rather than each assembling their own object, because the two used
   * to be duplicates and the intent nudge is exactly the kind of field that gets added to one of a
   * pair. A flow saved by the recorder and a flow saved from a compiled recording are the same
   * regression test, and must not report differently for having arrived by a different door.
   */
  #summary(flow: FlowFile): SaveSummary {
    const gap = flowIntentGap(flow);
    return {
      name: flow.name,
      stepCount: flow.steps.length,
      degraded: flow.steps.filter((s) => true === s.degraded).length,
      empty: 0 === flow.steps.length,
      ...(gap === undefined ? {} : { intentGap: gap }),
    };
  }

  /**
   * Convert a CompiledProgram (testid-normalized) into an anchored, on-disk flow + write it.
   * Optionally fold structured annotations (per-step expect, dynamic[], success) onto
   * the flow before writing. Omitting `annotations` reproduces the same bytes.
   */
  async save(
    program: CompiledProgram,
    annotations?: FlowAnnotations,
    projectId?: string,
  ): Promise<FlowResult<SaveSummary>> {
    if (!isValidFlowName(program.name)) {
      return { ok: false, code: FlowErrorCode.INVALID_NAME };
    }
    const pid = safeProjectId(projectId);
    const steps = program.steps.map(recordedStepToFlowStep);
    const base: FlowFile = {
      version: FLOW_FILE_VERSION,
      name: program.name,
      ...(pid === undefined ? {} : { projectId: pid }),
      createdAt: this.#clock.now(),
      steps,
      /*
       * The route the journey started on, when the recording captured one.
       *
       * The in-page recorder has always written this; the agent's recording had nowhere to put it,
       * so a flow an agent recorded replayed from wherever the tab happened to be. A first step
       * whose whole consequence is "this navigation fetches" fetches nothing when replay already
       * sits on the destination, and the flow then drifts for a reason that has nothing to do with
       * the app. Observed doing exactly that.
       */
      ...(program.startPath === undefined ? {} : { startPath: program.startPath }),
    };
    const flow = await this.#linkIntent(withAnnotations(base, annotations));
    await this.#fs.mkdir(flowDir(this.#root, pid));
    await this.#fs.writeFile(flowPath(this.#root, program.name, pid), this.#serialize(flow));
    return { ok: true, value: this.#summary(flow) };
  }

  /**
   * Persist an already-anchored FlowFile captured in-page (no recompilation). The
   * browser resolved every semantic anchor at capture time; here we only validate the name +
   * re-run FlowFileSchema before writing. save is left untouched.
   */
  async saveFlow(flow: FlowFile, projectId?: string): Promise<FlowResult<SaveSummary>> {
    if (!isValidFlowName(flow.name)) return { ok: false, code: FlowErrorCode.INVALID_NAME };
    const pid = safeProjectId(projectId);
    // Stamp the project INTO the file (so a flow carries its own scope) and route it to the matching
    // per-project subdir. Both come from the same `pid`, so on-disk location and content always agree.
    const stamped = pid === undefined ? flow : { ...flow, projectId: pid };
    const parsed = FlowFileSchema.safeParse(stamped);
    if (!parsed.success) {
      // Named, not bare: the load path already says which step and key it choked on, and a save
      // that refuses in silence sends the caller to the file to guess at what a load would tell it.
      return {
        ok: false,
        code: FlowErrorCode.PARSE_FAILED,
        detail: describeFlowZodFailure(parsed.error),
      };
    }
    const valid = await this.#linkIntent(parsed.data);
    await this.#fs.mkdir(flowDir(this.#root, pid));
    await this.#fs.writeFile(
      flowPath(this.#root, asFlowName(valid.name), pid),
      this.#serialize(valid),
    );
    return { ok: true, value: this.#summary(valid) };
  }

  /**
   * Apply confident testid rebinds to an on-disk flow (the reticle_flow_heal
   * apply path). Loads + validates the flow (so it gets NOT_FOUND / PARSE_FAILED for free), then
   * rewrites ONLY the named steps' testid anchors — preserving createdAt + every other field — and
   * re-serializes byte-stably via the same #serialize that save uses. The name guard runs
   * FIRST, before any path is joined, so a traversal name never reaches the disk.
   *
   * This writer is PURE of the confidence policy: it trusts the changes it is handed (the tool only
   * calls it with proposals that already cleared HEAL_CONFIDENCE_MIN). A change whose `from` no
   * longer matches the step's testid anchor is skipped (idempotent / defensive), never throwing.
   */
  async heal(
    name: string,
    changes: HealChange[],
    projectId?: string,
  ): Promise<FlowResult<{ name: string; changed: HealChange[] }>> {
    if (!isValidFlowName(name)) return { ok: false, code: FlowErrorCode.INVALID_NAME };
    const pid = safeProjectId(projectId);
    const loaded = await this.load(name, pid);
    if (!loaded.ok) return { ok: false, code: loaded.code };
    const flow = loaded.value;

    // Write back to the SAME file load resolved (nested if it lives there, else legacy flat), so a
    // heal never forks a second copy and byte-stability holds regardless of where the flow lives.
    const path = await this.#resolveReadPath(name, pid);
    if (null === path) return { ok: false, code: FlowErrorCode.NOT_FOUND };
    const { flow: next, applied } = applyHealChanges(flow, changes);
    await this.#fs.writeFile(path, this.#serialize(next));
    return { ok: true, value: { name, changed: applied } };
  }

  /** The `.json` basenames (no extension) directly inside `dir`. [] if the dir is absent/unreadable. */
  async #namesIn(dir: string): Promise<string[]> {
    if (!(await this.#fs.exists(dir))) return [];
    let entries: string[];
    try {
      entries = await this.#fs.readdir(dir);
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.endsWith(FLOW_SUFFIX))
      .map((e) => e.slice(0, -FLOW_SUFFIX.length));
  }

  /**
   * List flow names visible to a caller, sorted + deduped. With a `projectId`: that project's own
   * flows PLUS legacy flat (untagged/global) ones. Without one (CLI/CI/contract callers): EVERY flow
   * in the store — flat plus every per-project subdir — so a repo-wide replay/audit misses nothing.
   */
  /**
   * All flow names on disk, INCLUDING any that fail the path-segment guard — an invalid name must reach
   * the caller as a reportable error, never be silently filtered away. Callers that build a path from a
   * name must validate first; `flowPath` takes a branded FlowName precisely so the compiler insists.
   */
  async list(projectId?: string): Promise<string[]> {
    const flowsDir = reticleDirPaths(this.#root).flows;
    const pid = safeProjectId(projectId);
    const legacy = await this.#namesIn(flowsDir);
    if (pid !== undefined) {
      const own = await this.#namesIn(flowDir(this.#root, pid));
      return [...new Set([...own, ...legacy])].sort();
    }
    if (!(await this.#fs.exists(flowsDir))) return [];
    let entries: string[];
    try {
      entries = await this.#fs.readdir(flowsDir);
    } catch {
      return legacy.sort();
    }
    const subdirs = entries.filter((e) => !e.endsWith(FLOW_SUFFIX));
    const nested = (
      await Promise.all(subdirs.map((d) => this.#namesIn(flowDir(this.#root, d))))
    ).flat();
    return [...new Set([...legacy, ...nested])].sort();
  }

  /** The path a flow actually lives at: nested (per-project) if present, else legacy flat, else null. */
  async #resolveReadPath(name: FlowName, pid: string | undefined): Promise<string | null> {
    if (pid !== undefined) {
      const nested = flowPath(this.#root, name, pid);
      if (await this.#fs.exists(nested)) return nested;
    }
    const flat = flowPath(this.#root, name);
    if (await this.#fs.exists(flat)) return flat;
    // No projectId (CLI/CI/contract callers, e.g. reticle_domain): mirror list's subdir union on
    // the read side too — a flow saved under .reticle/flows/<projectId>/ must still load, else it is
    // listed and then silently dropped by `if (loaded.ok)` (reticle_domain reports flowCount:0).
    if (pid === undefined) return this.#resolveNestedPath(name);
    return null;
  }

  /** Scan the per-project subdirs for a flow by name — the read-side of list's no-pid union. */
  async #resolveNestedPath(name: FlowName): Promise<string | null> {
    const flowsDir = reticleDirPaths(this.#root).flows;
    if (!(await this.#fs.exists(flowsDir))) return null;
    let entries: string[];
    try {
      entries = await this.#fs.readdir(flowsDir);
    } catch {
      return null;
    }
    for (const dir of entries.filter((e) => !e.endsWith(FLOW_SUFFIX))) {
      const nested = flowPath(this.#root, name, dir);
      if (await this.#fs.exists(nested)) return nested;
    }
    return null;
  }

  /**
   * Read + zod-validate a flow by name. With a `projectId`, prefers the per-project copy and falls
   * back to a legacy flat (untagged) flow of the same name — so pre-existing flows keep loading.
   */
  async load(name: string, projectId?: string): Promise<FlowResult<FlowFile>> {
    if (!isValidFlowName(name)) return { ok: false, code: FlowErrorCode.INVALID_NAME };
    const path = await this.#resolveReadPath(name, safeProjectId(projectId));
    if (null === path) return { ok: false, code: FlowErrorCode.NOT_FOUND };

    let text: string;
    try {
      text = await this.#fs.readFile(path);
    } catch (error) {
      return {
        ok: false,
        code: this.#fs.isNotFound(error) ? FlowErrorCode.NOT_FOUND : FlowErrorCode.PARSE_FAILED,
      };
    }

    return parseFlowFileText(text);
  }

  /**
   * Delete a flow's file so a renamed/obsolete flow stops lingering in the replay list. Resolves the
   * same path `load` would (per-project copy, else legacy flat, else a subdir scan for the no-pid
   * caller), then removes it. NOT_FOUND when nothing resolves — deleting an absent flow is an error,
   * not a silent no-op, so a typo doesn't read as success.
   */
  async remove(name: string, projectId?: string): Promise<FlowResult<void>> {
    if (!isValidFlowName(name)) return { ok: false, code: FlowErrorCode.INVALID_NAME };
    const path = await this.#resolveReadPath(name, safeProjectId(projectId));
    if (null === path) return { ok: false, code: FlowErrorCode.NOT_FOUND };
    await this.#fs.rm(path);
    return { ok: true, value: undefined };
  }
}
