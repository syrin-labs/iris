import { BrowserBrand, BUFFER_EVICTION_WARNING, THROTTLED_WARNING } from '@reticlehq/core';
import type { Session } from './session.js';

/**
 * The health block spliced onto act/assert results. Defined here rather than in session.ts: this is
 * the module that builds it, and session.ts was over the file-size cap.
 */
export interface SessionHealth {
  lastSeenMs: number;
  throttled: boolean;
  focused: boolean;
  /** present only when hidden/throttled — points at the `reticle drive` escape hatch. */
  recommendation?: string;
}

/** The evidence-completeness block spliced onto observe/network/console results. */
interface BufferEnvelope {
  buffer?: { held: number; dropped: number; note: string };
}

/**
 * Buffer-honesty envelope for observe/network/console. When the ring buffer has evicted anything
 * (age/size cap), a "no such event" answer may be a false negative — so we attach the drop count and
 * an actionable note. OMITTED entirely when nothing was dropped: silence means the buffer is intact,
 * so a clean/empty result there is trustworthy and costs zero tokens.
 */
export function bufferEnvelope(session: Session): BufferEnvelope {
  const { total, dropped } = session.bufferHealth();
  if (0 === dropped) return {};
  return { buffer: { held: total, dropped, note: BUFFER_EVICTION_WARNING } };
}

/** The `session` (and optional throttled `warning`) block spliced onto act/assert results. */
interface HealthEnvelope {
  session?: SessionHealth;
  warning?: string;
}

/**
 * Build the health envelope for a tool result. When the session is **nominal** (focused, not
 * throttled, no escape-hatch recommendation) the block is OMITTED entirely — a healthy session
 * conveys nothing actionable, and emitting it on every act/observe/assert call is pure token
 * overhead. The block (and a throttled `warning`) appears only when something is actually wrong,
 * so no health signal is lost — absence means healthy.
 */
export function healthEnvelope(session: Session): HealthEnvelope {
  const health = session.health();
  const nominal = !health.throttled && health.focused && health.recommendation === undefined;
  if (nominal) return {};
  return health.throttled ? { session: health, warning: THROTTLED_WARNING } : { session: health };
}

/**
 * Opt-in hard stop. When `refuseWhenThrottled` is true and the tab is throttled, throw so the
 * agent does not drive a tab where timers/rAF/pointer gestures may silently no-op. Default is
 * warn-only so background testing never breaks.
 */
export function refuseIfThrottled(session: Session, refuse: unknown): void {
  if (true === refuse && session.throttled()) {
    throw new Error(`refusing to act: ${THROTTLED_WARNING}`);
  }
}

/**
 * The sentence appended to a FAILED predicate verdict waited out on a throttled tab.
 *
 * A starved tab and a missing element read identically as a bare near-miss: after a hard reload a
 * backgrounded tab can sit on its loading state forever (hydration starved, nothing painted), and
 * `wait_for { text }` timing out there looks exactly like "the code did not render" (#521). The
 * health envelope already rode alongside saying `throttled:true`, but nothing connected it to the
 * verdict an agent actually gates on. Appended, not replacing: the original diagnosis still leads,
 * and on a healthy tab the failure says exactly what it always said.
 */
const STARVED_WAIT_NOTE =
  ' (the tab was throttled during this wait, so starvation can look exactly like absence: bring it to the front and re-check before concluding this is genuinely missing)';

/**
 * Suffix the starvation note onto a FAILED predicate verdict when the tab is throttled. A pass is
 * returned untouched — starvation is context for a failure, not a reason to doubt a hold. Pure and
 * generic over the verdict shape so assert/wait_for/act_and_wait share one rule.
 */
export function annotateStarvedFailure<V extends { pass?: boolean; failureReason?: string }>(
  session: Session,
  verdict: V,
): V {
  if (true === verdict.pass || verdict.failureReason === undefined) return verdict;
  if (true !== session.throttled()) return verdict;
  return { ...verdict, failureReason: `${verdict.failureReason}${STARVED_WAIT_NOTE}` };
}

/** The page's own visibility/runtime report, narrowed out of an untrusted PAGE_HEALTH payload. */
interface HealthReport {
  hidden: boolean | undefined;
  focused: boolean | undefined;
  runtime: string | undefined;
  /** Coarse rendering engine (blink/gecko/webkit) — context for a feedback report, not a health input. */
  engine: string | undefined;
  /**
   * Which browser the page is. Narrowed to `BrowserBrand` HERE rather than trusted: the SDK already
   * normalises, so anything else is a stale or hand-forged payload and is dropped — the point of the
   * closed list is that an unbounded string can never reach telemetry through it.
   */
  brand: BrowserBrand | undefined;
}

/**
 * Narrow a PAGE_HEALTH payload. Every field is optional on the wire — an older SDK does not report
 * `runtime` at all — so each is returned as undefined rather than defaulted here, letting the caller
 * keep its previous value instead of silently flipping a session to "visible" on a partial report.
 */
export function readHealthEvent(data: Record<string, unknown>): HealthReport {
  return {
    hidden: 'boolean' === typeof data['hidden'] ? data['hidden'] : undefined,
    focused: 'boolean' === typeof data['focused'] ? data['focused'] : undefined,
    runtime: 'string' === typeof data['runtime'] ? data['runtime'] : undefined,
    engine: 'string' === typeof data['engine'] ? data['engine'] : undefined,
    brand: Object.values(BrowserBrand).find((known) => known === data['brand']),
  };
}
