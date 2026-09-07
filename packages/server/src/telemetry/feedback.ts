/**
 * The feedback channel — the one place in Reticle that sends words someone wrote.
 *
 * Reticle is built for agents, and until now nothing closed the loop: when a tool misbehaved, or a
 * verification came back undecidable, or an observer simply could not see the thing that mattered,
 * that knowledge died in the agent's context window. This module is the return path. An agent files a
 * report through `reticle_feedback` when a tool fails it; a human files one through `reticle
 * feedback` with a rating and their own words.
 *
 * Three properties are non-negotiable here, because free text is a different privacy class from the
 * event counters the rest of telemetry sends:
 *
 *   1. NEVER PASSIVE. There is no code path that emits feedback on its own. Every event is the direct
 *      result of an explicit call someone made carrying content they authored. Nothing is scraped
 *      from the app, the DOM, the network log, or the repo.
 *   2. REDACTED BEFORE THE WIRE. `redactFeedbackText` strips the credential/PII shapes that leak into
 *      a pasted trace even when the author meant no harm. It runs client-side, so the redaction is
 *      auditable in this repo rather than promised in a policy.
 *   3. INDEPENDENTLY DISABLE-ABLE. `RETICLE_FEEDBACK=0` kills the channel while leaving anonymous
 *      adoption metrics on — the setting an org wants when counters are fine but prose is not. Every
 *      existing switch (`RETICLE_TELEMETRY=0`, `DO_NOT_TRACK`, `reticle telemetry disable`) still
 *      disables it too, since it rides the same emitter.
 */
import {
  FeedbackSchema,
  FEEDBACK_TEXT_MAX,
  FEEDBACK_TRACE_MAX,
  FEEDBACK_FIELD_MAX,
  TelemetryEventKind,
  type Feedback,
} from '@reticlehq/core';
import { platform } from 'node:os';
import { getTelemetry } from './telemetry.js';
import { noteFeedbackUndelivered } from './feedback-delivery.js';
import { isReticleSourceCheckout } from './dev-repo.js';
import { saveFeedbackLocally } from './feedback-local.js';
import { SERVER_VERSION } from '../version/server-version.js';
import { feedbackContext, type SessionFacts } from './feedback-context.js';
import { markDelivered, outboxPath, queueFeedback } from './feedback-outbox.js';

/** Kills the feedback channel ONLY — adoption counters keep flowing. */
export const FEEDBACK_ENV = 'RETICLE_FEEDBACK';

/** What replaces a redacted match. Visible on purpose: a reader must see that something was removed. */
export const REDACTED = '[redacted]';

/**
 * The shapes that leak. Ordered most-specific first — a URL carrying inline credentials must be
 * caught as a URL before the bare-token rule chews the middle out of it.
 *
 * This is a net, not a proof. It cannot catch a secret that looks like an ordinary word, which is
 * exactly why the tool description tells the agent not to paste app source or user data in the first
 * place. Defense in depth: instruct first, redact second, cap third.
 */
const REDACTIONS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  // scheme://user:pass@host — the credential is in the authority section.
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, label: 'url-credentials' },
  { pattern: /\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi, label: 'email' },
  // Credential assignments: the KEY stays (it is the useful part), the VALUE goes. The auth SCHEME
  // (`Bearer`, `Basic`, `Token`) is consumed as part of the value, not left as the value — matching
  // only `\S+` after the separator ate the word "Bearer" and published the secret right behind it.
  {
    pattern:
      /\b(authorization|api[-_]?key|secret|token|password|passwd|pwd)\b(?:\s*[:=]\s*|\s+)(?:(?:bearer|basic|token|digest)\s+)?\S+/gi,
    label: 'credential-assignment',
  },
  // Vendor key formats that are self-identifying (sk-…, ghp_…, AKIA…, xoxb-…, eyJ… JWTs).
  { pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, label: 'vendor-key' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, label: 'github-token' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: 'aws-key' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: 'slack-token' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: 'jwt' },
  // Home directories carry the account name, and a trace is full of them.
  { pattern: /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s/\\:"']+/g, label: 'home-path' },
];

export interface Redaction {
  text: string;
  /** Which rules fired, deduped. Surfaced back to the author so a redaction is never silent. */
  removed: string[];
}

/** Strip credential/PII shapes and cap the length. Pure — the tests read like a spec of what leaks. */
export function redactFeedbackText(input: string, max: number): Redaction {
  const removed = new Set<string>();
  let text = input;
  for (const { pattern, label } of REDACTIONS) {
    text = text.replace(pattern, (_match, ...groups) => {
      removed.add(label);
      // A rule with a leading capture keeps it (the scheme, the `api_key=` key) so the reader still
      // sees WHAT was removed, not just that something was.
      const prefix = 'string' === typeof groups[0] ? groups[0] : '';
      return `${prefix}${REDACTED}`;
    });
  }
  return { text: text.slice(0, max), removed: [...removed] };
}

/** True when the feedback channel is switched off on its own (the emitter's switches apply as well). */
export function feedbackDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env[FEEDBACK_ENV] ?? '').toLowerCase();
  return '0' === value || 'false' === value || 'off' === value || 'no' === value;
}

/**
 * The fields an author writes, and therefore the fields that must be redacted. ONE list, used both to
 * redact and to assemble — so a new field cannot be added to one and missed by the other.
 *
 * `model` is deliberately included: it is agent-supplied text like the rest, and while a model name
 * is not sensitive, exempting it would re-introduce the "which fields are safe?" judgement call that
 * caused the original gap.
 */
const AUTHOR_WRITTEN_FIELDS: ReadonlySet<string> = new Set([
  'text',
  'trace',
  'need',
  'impact',
  'currentApproach',
  'model',
]);

/** Per-field caps; anything unlisted uses the standard field cap. */
const FIELD_CAPS: Record<string, number> = {
  text: FEEDBACK_TEXT_MAX,
  trace: FEEDBACK_TRACE_MAX,
  model: 64,
};

/** What the author supplies; the environment context is detected, never asked for. */
type FeedbackInput = Pick<
  Feedback,
  'source' | 'kind' | 'text' | 'trace' | 'rating' | 'need' | 'impact' | 'currentApproach' | 'model'
>;

interface FeedbackReceipt {
  /**
   * DELIVERY confirmed. Only ever true when the send was awaited and the endpoint accepted it —
   * never as an optimistic stand-in for "we handed it to the emitter". That distinction is the whole
   * value of this field: it was once unconditional, so a DNS miss and a 4xx both reported "filed".
   *
   * A backgrounded send (the agent tool) therefore returns `sent: false` with `accepted: true` —
   * see below. It is not a failure, and the note says so.
   */
  sent: boolean;
  /**
   * Validated, redacted and handed to the emitter. TRUE says the report is well-formed and on its
   * way; it does NOT say it arrived. If a backgrounded send then fails, the reporter is told on its
   * next tool result — see feedback-delivery.ts.
   */
  accepted: boolean;
  reason?: string;
  /**
   * Where the report was written when it could not be SENT.
   *
   * A refusal used to be the end of the road: the report was already written by then, and throwing
   * it away punished exactly the behaviour this channel exists to encourage. Worse, the commonest
   * refusal is a Reticle SOURCE CHECKOUT — so the reporter best placed to name a file and a line was
   * the only one who could not file at all.
   */
  savedTo?: string;
  /** A ready-to-run command that turns the saved file into an issue. */
  fileWith?: string;
  /** Which redaction rules fired. Empty when nothing needed removing. */
  redacted: string[];
  /** The exact context that went with it, echoed back so the send is never a black box. */
  context: Partial<Feedback>;
}

/**
 * Redact, validate, and emit one feedback report. Returns a receipt rather than throwing: a feedback
 * send that fails must never take down the tool call that reported the failure — that would punish
 * the exact behaviour we are trying to encourage.
 */
export async function submitFeedback(
  input: FeedbackInput,
  opts: {
    cwd?: string;
    session?: SessionFacts;
    env?: NodeJS.ProcessEnv;
    /**
     * Return as soon as the report is validated and queued, instead of waiting out the POST.
     *
     * Used by the AGENT tool: ~340ms of network on a call made mid-task is the product blocking the
     * user's work to talk about itself. NOT used by `reticle feedback`, where a human typed the
     * command and is waiting for an answer — there, confirmed delivery is the answer.
     */
    background?: boolean;
  } = {},
): Promise<FeedbackReceipt> {
  const env = opts.env ?? process.env;
  const context = feedbackContext(opts.cwd ?? process.cwd(), opts.session);
  // Redact EVERY author-written field, derived from the input rather than listed.
  //
  // The first version named `text` and `trace` explicitly. When `need`, `impact` and
  // `currentApproach` were added later they silently bypassed redaction entirely — three new
  // free-text fields going to the wire raw, and a `currentApproach` reading "hardcoding the token
  // sk-…" would have shipped the token. Enumerating the fields to protect is the same class of
  // mistake as hand-copying an enum: correct on the day it is written, quietly wrong at the next
  // addition. Deriving the set means a sixth field is covered the moment it exists.
  const redactions = new Map<string, Redaction>();
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string' || '' === value) continue;
    if (!AUTHOR_WRITTEN_FIELDS.has(key)) continue;
    redactions.set(key, redactFeedbackText(value, FIELD_CAPS[key] ?? FEEDBACK_FIELD_MAX));
  }
  const body = redactions.get('text') ?? { text: '', removed: [] };
  const redacted = [...new Set([...redactions.values()].flatMap((r) => r.removed))];

  if (feedbackDisabled(env)) {
    return {
      sent: false,
      accepted: false,
      reason: `feedback is disabled by ${FEEDBACK_ENV}`,
      redacted,
      context,
    };
  }
  const telemetry = getTelemetry();
  if (!telemetry.enabled) {
    /*
     * Cannot SEND is not the same as cannot FILE.
     *
     * The report is fully written and redacted by this point. Discarding it punishes the exact
     * behaviour this channel exists to encourage, and it hits hardest where the reports are best: a
     * Reticle source checkout disables telemetry by cwd, so a contributor who can name the file and
     * the line was the one person who could not file at all.
     *
     * So it goes to disk and the receipt says where, plus a command that turns it into an issue.
     * Nothing is lost, and the human is handed one thing to run rather than asked to retype it.
     */
    const cwd = opts.cwd ?? process.cwd();
    const saved = saveFeedbackLocally(cwd, input, body.text, context);
    return {
      sent: false,
      accepted: false,
      // Named precisely, because the commonest cause is not what the old wording suggested.
      reason: isReticleSourceCheckout(cwd)
        ? 'this is a Reticle source checkout, where telemetry is disabled by design, so this could not be sent — it has been written to disk instead, and nothing was lost.'
        : `telemetry is disabled on this machine, so this could not be sent — it has been written to disk instead. Re-enable with \`reticle telemetry enable\` to send directly.`,
      ...(saved === undefined ? {} : { savedTo: saved.path, fileWith: saved.command }),
      redacted,
      context,
    };
  }

  const parsed = FeedbackSchema.safeParse({
    source: input.source,
    kind: input.kind,
    // Every author-written field, redacted. Built from the map so nothing can be forgotten here
    // either — the field list exists in exactly one place.
    ...Object.fromEntries(
      [...redactions].filter(([, r]) => r.text !== '').map(([key, r]) => [key, r.text]),
    ),
    text: body.text,
    ...(input.rating !== undefined ? { rating: input.rating } : {}),
    ...context,
  });
  if (!parsed.success) {
    return {
      sent: false,
      accepted: false,
      reason: parsed.error.issues[0]?.message ?? 'invalid feedback',
      redacted,
      context,
    };
  }
  // BACKGROUND: return now, deliver after. The agent calls this mid-task and a ~340ms POST is the
  // product blocking the user's work to talk about itself. The honesty that the awaited version was
  // written for is kept elsewhere: `sent` stays false (nothing is confirmed yet), `accepted` says
  // the report is well-formed and queued, and a send that then fails reaches the reporter on its
  // next tool result instead of vanishing.
  // Written down BEFORE the network is touched, on both paths. A failed send is then a queued report
  // rather than a lost one — see feedback-outbox. Reported from the field: a 1.3s hiccup destroyed a
  // root-cause analysis that took an hour of driving to produce, and it survived only because the
  // reporter happened to have written the markdown by hand first.
  const queued = queueFeedback(parsed.data);

  if (true === opts.background) {
    void telemetry
      .emit(TelemetryEventKind.FEEDBACK_SUBMITTED, { feedback: parsed.data })
      .then((ok) => {
        if (ok) markDelivered(queued);
        else noteFeedbackUndelivered('the telemetry endpoint did not accept it');
      })
      .catch((error: unknown) => {
        noteFeedbackUndelivered(error instanceof Error ? error.message : String(error));
      });
    return { sent: false, accepted: true, redacted, context };
  }

  // `sent` reflects DELIVERY, not handing the payload to the emitter. It was unconditional, so a DNS
  // miss or a 4xx both reported "filed" — and this is the only qualitative channel the product has,
  // so a silent failure here loses the report AND tells the reporter it worked.
  const delivered = await telemetry.emit(TelemetryEventKind.FEEDBACK_SUBMITTED, {
    feedback: parsed.data,
  });
  if (delivered) {
    markDelivered(queued);
    return { sent: true, accepted: true, redacted, context };
  }
  // Undelivered, but no longer lost. `accepted` is true when it reached the outbox: the report is
  // well-formed and on disk, which is a materially different situation from "it is gone".
  return {
    sent: false,
    accepted: queued !== null,
    reason:
      queued !== null
        ? `the report could not be delivered (the network call failed or was rejected), but it is SAVED at ${outboxPath()} and nothing was lost. It will be retried; you can also open an issue at https://github.com/reticlehq/reticle/issues with the same detail.`
        : 'the report could not be delivered and could not be saved locally either — it was NOT filed. Retry, or open an issue at https://github.com/reticlehq/reticle/issues with the same detail.',
    redacted,
    context,
  };
}

/**
 * The receipt's context PLUS the fields the emitter stamps on every event regardless of kind — the
 * reticle version, the OS, and whether this is CI. They are the single most-asked question of any bug
 * report ("what version?"), so they are echoed here rather than left as an invisible claim: what the
 * CLI prints is then genuinely everything that goes.
 */
export function describeFeedbackPayload(context: Partial<Feedback>): Record<string, unknown> {
  return {
    ...context,
    version: SERVER_VERSION,
    os: platform(),
    ci: process.env['CI'] !== undefined,
  };
}
