import * as http from 'node:http';
import {
  localInitializeResponse,
  degradedInstructions,
  isHandshakeLine,
  drainLines,
  MAX_STDIN_LINE_BYTES,
} from './proxy-handshake.js';
import { isToolCallRequest, isToolsListRequest, ToolCatalogCache } from './tool-catalog-cache.js';
import { rememberEnumerated, rememberProxyStarted, rememberToolCalled } from './attach-memory.js';
import { toolsChangedNotification } from './proxy-handshake.js';
import {
  LOOPBACK_HOST,
  MCP_SSE_PATH,
  MCP_SHUTDOWN_EVENT,
  ReticleEnv,
  CONTRACT_FINGERPRINT,
} from '@reticlehq/core';
import { SseFrameParser } from './sse-frame-parser.js';
export { SseFrameParser, type SseFrame } from './sse-frame-parser.js';
export { probeDaemon, waitForDaemon } from './proxy-daemon-probe.js';
import { probeDaemon } from './proxy-daemon-probe.js';
import { SERVER_VERSION } from '../version/server-version.js';
import { buildServerInstructions } from './server-instructions.js';
import { hasProjectConnectedBefore } from '../session/connection-memory.js';
import { reticleStateHome } from '../daemon/daemon.js';
import { readProjectId } from '../cli/cli-port.js';
import { PEER_VERSION_PARAM, PEER_CONTRACT_PARAM } from '../version/peer-announce.js';
import {
  onStreamDrop,
  onClientRequest,
  onReconnectBudgetSpent,
  onQueueExpired,
  OnDrop,
  OnRequest,
} from './proxy-lifecycle.js';
import { describePresence, probePresence } from '../daemon/port-presence.js';
import { flushProxySessionMetrics } from '../telemetry/proxy-telemetry.js';
/**
 * The same `/status` probe `doctor`, `status` and `kill` ask with. Reused rather than re-written:
 * the whole defect this import closes was the proxy answering a DIFFERENT question from every other
 * surface, and a second copy of the probe is how that comes back.
 */
import { fetchStatus as fetchDaemonStatus } from '../cli/cli-launch.js';
/**
 * Re-exported so every existing caller (and every spec) keeps importing the proxy's log from the
 * proxy. Where the code lives is a file-size decision; where it is imported from is an API.
 */
export {
  accountProxyLogWrite,
  proxyLog,
  proxyLogPath,
  PROXY_LOG_CHECK_BYTES,
  recoverOversizedProxyLog,
  setProxyLogPort,
} from './proxy-log.js';
import { proxyLog } from './proxy-log.js';
import { OutageReason, OutageStage, reportMcpOutage } from './mcp-outage.js';
import { postToSession } from './mcp-post-transport.js';
import { reconnectDelayMs } from './proxy-backoff.js';
export { reconnectDelayMs, RECONNECT_BASE_MS, RECONNECT_CAP_MS } from './proxy-backoff.js';

export {
  MCP_PROXY_HTTP_AGENT_OPTIONS,
  postToSession,
  shouldRetryUnsentPost,
  type PostFailure,
} from './mcp-post-transport.js';

/**
 * How many consecutive failed reconnects before the proxy stops RETRYING. It does not stop serving:
 * the budget ends the retry loop and the proxy goes dormant, where the handshake and `tools/list`
 * are still answered and the next client request starts a daemon. See onReconnectBudgetSpent.
 *
 * At the capped backoff this is a few minutes — long enough to ride out a daemon restart without
 * spinning on a port that is wedged or held by a foreign process.
 */
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 60;
/**
 * Overridable so the survival spec can reach exhaustion in seconds instead of minutes — the same
 * reason the idle windows take an env override. A positive integer only; anything else falls back,
 * so a typo cannot silently disable the retry loop.
 */
export const MAX_RECONNECT_ATTEMPTS = ((): number => {
  const raw = Number(process.env[ReticleEnv.RECONNECT_ATTEMPTS]);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_RECONNECT_ATTEMPTS;
})();

/** JSON-RPC id the proxy uses for its own replayed `initialize` — never one the client could send. */
export const RECONNECT_INITIALIZE_ID = '__reticle_proxy_reinit';

interface JsonRpcLike {
  id?: unknown;
  method?: unknown;
}

function parseJsonRpc(line: string): JsonRpcLike | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return 'object' === typeof parsed && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

const INITIALIZE_METHOD = 'initialize';
/**
 * How long the handshake waits on the daemon before the proxy answers it.
 *
 * Long enough for a cold daemon start (which is seconds), short enough that a client does not sit
 * there. Measured failure: a listener that accepts and never serves SSE left `initialize` unanswered
 * past 25s with nothing on stderr, and the reported client gave up at 60s having run no tools.
 */
const LOCAL_HANDSHAKE_MS = 12_000;
const INITIALIZED_METHOD = 'notifications/initialized';

/**
 * JSON-RPC requests forwarded on behalf of the client that have not been answered yet.
 *
 * Only used at shutdown, where it is the difference between "the client closed stdin" and "the client
 * closed stdin and we dropped its `tools/list` on the floor while reporting exit 0". A request has an
 * id AND a method; a notification has no id and is owed nothing; a response has an id and no method.
 */
export class PendingRequests {
  #ids = new Set<string>();

  observeOutbound(line: string): void {
    const msg = parseJsonRpc(line);
    if (null === msg || msg.id === undefined || msg.method === undefined) return;
    this.#ids.add(JSON.stringify(msg.id));
  }

  observeInbound(line: string): void {
    const msg = parseJsonRpc(line);
    if (null === msg || msg.id === undefined) return;
    this.#ids.delete(JSON.stringify(msg.id));
  }

  get unanswered(): string[] {
    return [...this.#ids];
  }

  /**
   * Claim ONE unanswered id, so exactly one path may answer it. False means somebody already did —
   * a duplicate response to one id is a protocol violation, not a belt-and-braces retry.
   */
  take(id: unknown): boolean {
    return this.#ids.delete(JSON.stringify(id));
  }

  /** Take every unanswered id and forget them, so the same request is failed at most once. */
  drain(): string[] {
    const ids = [...this.#ids];
    this.#ids.clear();
    return ids;
  }
}

/**
 * JSON-RPC errors for every request that was in flight when the stream died.
 *
 * These are unrecoverable BY CONSTRUCTION: the daemon builds a fresh MCP session per SSE
 * connection, so the reconnected session has never seen them. Re-sending them is not an option
 * either — a `reticle_act` that already clicked would click twice, and inventing a second action in
 * somebody's app is worse than reporting a failure.
 *
 * So the proxy answers them itself, under each request's own id. Found by brute force: killing the
 * daemon under a live client left 20 of 20 concurrent calls hanging until the client's own timeout,
 * with the MCP server still perfectly alive. An agent cannot tell that apart from "still working".
 */
export function streamLossReplies(
  pending: PendingRequests,
  reason: string,
  nextStep?: string,
): string[] {
  return pending
    .drain()
    .map((id) => transportLossReply(JSON.parse(id) as unknown, reason, nextStep));
}

/**
 * -32001: a server-defined error. Not -32603 (internal): nothing went wrong INSIDE the call, the
 * transport under it went away, and the distinction is what tells a caller the action may be safe
 * to retry.
 */
const TRANSPORT_LOSS_CODE = -32001;

/**
 * The one shape every "the transport ate your call" answer takes, whichever leg died.
 *
 * `nextStep` is appended when the caller knows one. Without it this reply describes a condition and
 * stops there, which is all a first-run user got out of their first ever tool call.
 */
function transportLossReply(id: unknown, reason: string, nextStep?: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: TRANSPORT_LOSS_CODE,
      message:
        `the daemon connection dropped (${reason}) before this call was answered — it did NOT ` +
        'complete. Reticle is recovering the connection; retry if the action is safe to repeat.' +
        (nextStep === undefined ? '' : ` ${nextStep}`),
    },
  });
}

/**
 * How long stdin closing gives the daemon to answer what is still in flight.
 *
 * A client can write its whole conversation and close in one flush; the daemon is a socket away and
 * answers in milliseconds, so this is generous. Overshooting only delays an exit that is already
 * ending the process.
 */
const SHUTDOWN_DRAIN_MS = 5_000;
/**
 * How long a request may sit in the queue, unsent, before the proxy answers it itself.
 *
 * The second population the stress test found. A request that was FORWARDED and lost is failed when
 * the stream drops; one that never got forwarded — queued while dormant or reconnecting — was
 * waiting for a session that, with a squatter holding the port, never arrives. It then hung until
 * the client's own timeout, or forever if the client has none.
 *
 * Comfortably longer than a daemon restart (~1-2s) so a normal blip still flushes and succeeds, and
 * well under the 60s an MCP client typically allows, so the answer comes from us with a reason
 * rather than from their timer with none.
 */
export const QUEUE_WAIT_MS = 20_000;
const SHUTDOWN_DRAIN_POLL_MS = 25;

/** A port that refuses is a port nothing is listening on YET — not a port that answered badly. */
const CONNECTION_REFUSED = 'ECONNREFUSED';

/**
 * How long the FIRST connect keeps chasing a refused port before calling it a startup failure.
 *
 * It used to get exactly one attempt. Reported from a Windows first bootstrap: the daemon was still
 * booting, the single connect was refused, and nothing tried again — only a fresh CLIENT request
 * re-probes the port, and the client was already blocked on the call that then expired with -32001.
 * The first tool call of somebody's first ever session is the worst place available to lose one.
 *
 * Deliberately longer than QUEUE_WAIT_MS: a retry that stops before the queue does cannot rescue the
 * request it exists for, and a daemon found afterwards at least restores service for the next call.
 */
const FIRST_CONNECT_WINDOW_MS = QUEUE_WAIT_MS + 15_000;

/** Retry a first connect, or report it? Pure, so the window can be held against the queue's. */
export function shouldRetryFirstConnect(error: unknown, elapsedMs: number): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return CONNECTION_REFUSED === code && FIRST_CONNECT_WINDOW_MS > elapsedMs;
}

/**
 * What to do about it, carried on the reply the queue expiry sends.
 *
 * A bare -32001 on the first call after an install says nothing a user can act on: not whether to
 * wait, not whether to retry, not whether the install itself is broken.
 */
export function queueExpiryNextStep(port: number): string {
  return (
    `No Reticle daemon answered on port ${String(port)}. Retry the call — the next request starts ` +
    'one. If it keeps failing, run `reticle doctor` in a terminal: it reports what is holding the ' +
    'port and whether the daemon can start at all.'
  );
}

/**
 * Makes a reconnect invisible to the client.
 *
 * The daemon builds a FRESH `McpServer` per SSE connection, so a reconnected session has never seen
 * the client's `initialize` — every subsequent `tools/call` would hit an uninitialized server. The
 * proxy therefore remembers the handshake the client sent once and replays it into each new session.
 * The replay is re-issued under a reserved id so the daemon's response to it can be dropped rather
 * than reaching the client's stdout, where a duplicate JSON-RPC id would be a protocol violation.
 */
export class HandshakeReplay {
  #initialize: string | null = null;
  #initialized: string | null = null;
  #pendingReplayId: string | null = null;

  /** Record one outbound client line. Cheap enough to call for every stdin message. */
  observeOutbound(line: string): void {
    const msg = parseJsonRpc(line);
    if (null === msg) return;
    // The first initialize is the session's identity; a client re-issuing one does not change it.
    if (msg.method === INITIALIZE_METHOD && null === this.#initialize) this.#initialize = line;
    else if (msg.method === INITIALIZED_METHOD) this.#initialized = line;
  }

  /** Lines to POST into a freshly-established session, before any queued client traffic. */
  replayLines(): string[] {
    if (null === this.#initialize) return [];
    const msg = parseJsonRpc(this.#initialize);
    if (null === msg) return [];
    this.#pendingReplayId = RECONNECT_INITIALIZE_ID;
    const reinit = { ...msg, id: RECONNECT_INITIALIZE_ID };
    return null === this.#initialized
      ? [JSON.stringify(reinit)]
      : [JSON.stringify(reinit), this.#initialized];
  }

  /** True when this inbound daemon line is the echo of our replayed handshake and must not be forwarded. */
  shouldSuppressInbound(line: string): boolean {
    if (null === this.#pendingReplayId) return false;
    const msg = parseJsonRpc(line);
    if (null === msg || msg.id !== this.#pendingReplayId) return false;
    this.#pendingReplayId = null; // one response per replay — anything later is not ours to swallow
    return true;
  }
}

/**
 * Turn an `endpoint` frame's data into a POST target, or null when there is nothing usable in it.
 *
 * An empty (or whitespace) data field is the shape a malformed daemon response takes, and it used to
 * be accepted: `postUrl` became `''`, which is not `null`, so the proxy considered itself CONNECTED
 * and posted every subsequent message to the empty string. Each one failed, the queue never armed
 * its deadline because nothing was ever queued, and the agent held a session that could not carry a
 * single call. Refusing the frame keeps the proxy in its disconnected path, which already knows how
 * to reconnect and how to answer what it cannot send.
 */
export function buildSessionUrl(rawData: string, port: number): string | null {
  const trimmed = rawData.trim();
  if ('' === trimmed) return null;
  return trimmed.startsWith('/') ? `http://${LOOPBACK_HOST}:${port}${trimmed}` : trimmed;
}

/**
 * Bridge stdio ↔ SSE: connects to the running daemon's MCP endpoint and forwards
 * Claude Code's stdin/stdout JSON-RPC through it. Never resolves — runs until stdin closes.
 *
 * A dropped SSE stream used to exit the process, which is what made the agent's `reticle_*` tools
 * vanish mid-session with no message and no way for the agent to get them back — only a human running
 * `/mcp` could. The daemon demonstrably stays up across these drops, so the stream ending is a
 * transport event, not a shutdown: reconnect to it and replay the handshake instead of dying.
 */
/**
 * The instructions this proxy should advertise when it answers the handshake itself.
 *
 * Same inputs the daemon uses, read from the same durable memory, so a client that happens to meet
 * the proxy first is not told something different from one that meets the daemon first. Best-effort:
 * an unreadable state home must never be the reason a handshake fails, so it degrades to the
 * fresh-install wording rather than throwing.
 */
function proxyInstructions(port: number): string {
  try {
    return buildServerInstructions({
      previouslyConnected: hasProjectConnectedBefore(
        reticleStateHome(),
        port,
        readProjectId(process.cwd()),
      ),
    });
  } catch {
    return buildServerInstructions({ previouslyConnected: false });
  }
}

export function startMcpProxy(
  port: number,
  /**
   * Bring a daemon back before reconnecting. Without it the proxy retried a DEAD port until the
   * budget ran out and then killed itself, taking the agent's whole Reticle surface with it — the
   * failure mode for a daemon that crashed, was stopped, or shut itself down as idle.
   */
  ensureDaemon?: () => Promise<void>,
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    // A client just started us, which is the only honest evidence that Reticle is registered with
    // one at all: a config entry proves somebody wrote JSON, not that a client ever read it. Paired
    // with the `tools/list` record below, this is what lets `status` name the state in between
    // "never registered" and "connected" — see attach-memory.ts.
    rememberProxyStarted(reticleStateHome(), port);
    // Declared before the SSE handler that fills it: the handler is a closure created below but
    // invoked on the first daemon frame, and a `const` referenced before its declaration executes is
    // a runtime throw, not a type error.
    const catalog = new ToolCatalogCache();
    let postUrl: string | null = null;
    /**
     * No daemon is listening and the proxy has stopped chasing one.
     *
     * The alternative — respawning the moment the stream drops — turns an idle daemon's own
     * self-shutdown into a permanent spawn loop, because the daemon it brings back is just as idle.
     * Dormant means the next thing the CLIENT asks for is what brings Reticle back.
     */
    let dormant = false;
    /**
     * Deliver the proxy's own answer to a queued `initialize`, now, for a stated reason.
     *
     * Set by `armLocalHandshake` while the client's handshake is unanswered, and cleared once it is.
     * It exists because the 12-second timer down there is a timeout for a question the proxy could
     * not answer — "is a daemon coming?" — and the drop path CAN answer it: a port a stranger holds
     * will never serve SSE, however long anybody waits. Declared up here with the other closure
     * state so the drop path can reach it without a temporal-dead-zone hazard.
     */
    let deliverHandshakeLocally: ((reason: string) => void) | undefined;
    const stdinQueue: string[] = [];
    /**
     * Fail anything still queued after QUEUE_WAIT_MS. Re-armed on every push and cleared on flush,
     * so a queue that drains normally never fires it.
     */
    let queueTimer: ReturnType<typeof setTimeout> | undefined;
    const clearQueueTimer = (): void => {
      if (queueTimer !== undefined) clearTimeout(queueTimer);
      queueTimer = undefined;
    };
    /**
     * Answer everything queued, drop it, and go dormant.
     *
     * `reason` is what goes on the wire. The timer below passes the only thing a timeout can know —
     * that nothing arrived — but a wake that FAILED knows something much better: exactly why it
     * failed. Both used to end here after the same twenty seconds of silence, because only the timer
     * could reach this code.
     */
    const expireQueue = (reason: string): void => {
      clearQueueTimer();
      if (stopped || 0 === stdinQueue.length) return;
      // Drop what we could never send, and answer it, so the caller is never left guessing.
      stdinQueue.splice(0);
      for (const reply of streamLossReplies(pending, reason, queueExpiryNextStep(port))) {
        emit(reply);
      }
      // The expiry is the proof that the reconnect we believed was in flight is not coming — a
      // wedged port accepts the socket and never serves SSE, so `connect` neither resolves nor
      // rejects and `dormant` would otherwise stay false forever. Going dormant is what makes the
      // NEXT request re-probe the port instead of queueing behind a reconnect that will never
      // land, and it is the only path by which a daemon started AFTER we gave up is ever found.
      dormant = onQueueExpired() === OnDrop.DORMANT;
      proxyLog('reticle_mcp_proxy_queue_expired', {
        port,
        dormant,
        reason,
        note: 'answered queued requests and went dormant; the next client request re-probes the port',
      });
    };
    const armQueueTimer = (): void => {
      if (queueTimer !== undefined) return; // the oldest entry owns the deadline
      queueTimer = setTimeout(() => {
        queueTimer = undefined;
        expireQueue('no daemon could be reached');
      }, QUEUE_WAIT_MS);
      queueTimer.unref();
    };
    const replay = new HandshakeReplay();
    const pending = new PendingRequests();
    /** The ONE way a line reaches the client — so nothing can be answered without clearing the debt. */
    const emit = (line: string): void => {
      pending.observeInbound(line);
      process.stdout.write(`${line}\n`);
    };
    let stopped = false;
    let attempts = 0;
    /** The daemon announced a planned shutdown; the next drop is that, not a fault. */
    let daemonRetiring = false;
    /** Why the stream we are currently trying to replace went away — carried onto the recovery. */
    let lastDropReason: string = OutageReason.OTHER;
    /**
     * What the outage had already cost when the proxy went dormant.
     *
     * The wake path clears `attempts` before dialling, and it must: a wake is a fresh retry budget,
     * and sharing the previous outage's spent budget would put the proxy dormant again on its first
     * failure. But the recovery report is guarded on `attempts > 0`, so clearing it also erased the
     * evidence that there was anything to recover FROM — and dormancy is the commonest outage class
     * we have, which made every recovery of that class invisible. Carried across the wake so the
     * budget resets and the accounting does not.
     */
    let attemptsBeforeDormant = 0;
    /**
     * When the proxy started, and how many times the first connect has been refused since.
     *
     * The clock is read at this boundary rather than injected, matching the shutdown drain below:
     * it measures how long a real daemon has had to boot, which is a wall-clock fact about the
     * machine and not a decision the caller could supply.
     */
    const startedAt = Date.now();
    let firstConnectAttempts = 0;

    /**
     * The ONE way a line leaves for the daemon — so a POST that never lands still owes an answer.
     *
     * Only requests we are holding in `pending` get one: a notification is owed nothing, and the
     * proxy's own replayed handshake carries a reserved id the client must never see a reply for.
     */
    const forward = (url: string, line: string): void => {
      void postToSession(url, line).then((failure) => {
        if (null === failure) return;
        const msg = parseJsonRpc(line);
        if (null === msg || msg.id === undefined || !pending.take(msg.id)) return;
        if (failure.transport) {
          reportMcpOutage(OutageStage.FIRST, {
            reason: OutageReason.CONNECT_ERROR,
            attempts: failure.attempts,
            pendingLost: 1,
          });
        }
        proxyLog('reticle_mcp_proxy_post_unanswered', {
          port,
          method: String(msg.method),
          reason: failure.reason,
          note: 'the stream is still up, so nothing else would ever have answered this call',
        });
        emit(transportLossReply(msg.id, failure.reason));
      });
    };

    function onSseEvent(event: string, data: string, p: number): void {
      if ('endpoint' === event) {
        const url = buildSessionUrl(data, p);
        if (null === url) {
          proxyLog('reticle_mcp_proxy_empty_endpoint', {
            port,
            note: 'endpoint frame carried no URL; staying disconnected rather than posting to nowhere',
          });
          return;
        }
        postUrl = url;
        // A stream that reached `endpoint` is a USABLE session — that, not a set of response
        // headers, is what earns a fresh retry budget. Resetting on headers let a daemon that
        // accepts SSE and drops it spin the reconnect loop at the 250ms floor forever, never backing
        // off and never reaching the budget that puts the proxy dormant. Measured: 32 retries in 8s.
        // Report the recovery BEFORE the counter is cleared: `attempts` is what coming back actually
        // cost, and it is the only number that can falsify the drop event. See OutageStage.RECOVERED.
        const cost = attempts + attemptsBeforeDormant;
        if (cost > 0)
          reportMcpOutage(OutageStage.RECOVERED, { reason: lastDropReason, attempts: cost });
        attempts = 0;
        attemptsBeforeDormant = 0;
        // The new session's McpServer has never seen the client's initialize — replay it first, then
        // flush whatever the client sent while we were reconnecting.
        for (const line of replay.replayLines()) forward(url, line);
        clearQueueTimer();
        for (const queued of stdinQueue.splice(0)) forward(url, queued);
        // The client may be holding a tool list we invented. See toolsChangedNotification.
        const relist = toolsChangedNotification(toolsAnnouncedLocally);
        if (relist !== null) {
          toolsAnnouncedLocally = false;
          emit(relist);
          proxyLog('reticle_mcp_proxy_tools_relisted', { port });
        }
        handshakeAnswered = true;
        return;
      }
      // The daemon telling us it is retiring. Not forwarded: it is addressed to this proxy, and the
      // client behind it has no use for a frame it cannot parse.
      if (MCP_SHUTDOWN_EVENT === event) {
        daemonRetiring = true;
        proxyLog('reticle_mcp_proxy_daemon_retiring', {
          port,
          note: 'the daemon announced a planned shutdown; the drop that follows is not an outage',
        });
        return;
      }
      if ('message' === event && !replay.shouldSuppressInbound(data)) {
        // Remember the tool catalog as it goes past: it is what makes a locally-answered handshake
        // useful rather than toolless. See tool-catalog-cache.
        catalog.observe(data);
        emit(data);
      }
    }

    function scheduleReconnect(rawReason: string, detail?: string): void {
      if (stopped) return;
      postUrl = null;
      // A stream the daemon warned us about is a planned shutdown, not a fault. The socket looks
      // identical either way from here, so this flag is the only thing that can tell them apart —
      // and without it every scheduled retirement was counted as an outage the agent suffered.
      const reason = daemonRetiring ? OutageReason.DAEMON_SHUTDOWN : rawReason;
      daemonRetiring = false;
      lastDropReason = reason;
      attempts++;
      // Everything the dead session owed is settled HERE, in the one place every drop funnels
      // through, and not in the response callback that first noticed the socket die. A reset emits
      // on BOTH halves of the request, so whichever handler wins decides what gets paid — the same
      // shape as the reconnect fan-out, and it left the other half paying nothing.
      //
      // Order matters between the two. Drain the queue FIRST: a queued request is tracked in
      // `pending` as well, so answering without draining leaves the next `endpoint` frame free to
      // flush it into the fresh session, where the daemon answers the same id a second time and the
      // client sees two responses for one request. Then answer, because the new session cannot know
      // what the old one owed and silence here is permanent.
      stdinQueue.splice(0);
      const lost = streamLossReplies(pending, reason);
      for (const reply of lost) emit(reply);
      // How many calls this drop actually killed. Zero means the agent could not feel it.
      const pendingLost = lost.length;
      // Once per process: this session has now lost its tools at least once, which is the number
      // that says whether the transport work actually landed for real users. `pendingLost` is the
      // part an agent can FEEL — almost every measured drop killed nothing in flight.
      reportMcpOutage(OutageStage.FIRST, { reason, attempts, pendingLost });
      // The severe stage: we are about to stop retrying. Reported so the share of sessions where
      // MCP never came back on its own is a number rather than an anecdote.
      if (attempts > MAX_RECONNECT_ATTEMPTS) {
        reportMcpOutage(OutageStage.BUDGET_SPENT, { reason, attempts, pendingLost });
        // Stop RETRYING, never stop SERVING. See onReconnectBudgetSpent: exiting here made the
        // client mark the MCP server disconnected and left a human to reconnect it by hand.
        dormant = onReconnectBudgetSpent() === OnDrop.DORMANT;
        proxyLog('reticle_mcp_proxy_dormant_after_budget', {
          port,
          reason,
          attempts,
          note: 'stopped retrying; the next client request will start a daemon',
          ...(detail !== undefined ? { detail } : {}),
        });
        return;
      }
      const wait = reconnectDelayMs(attempts);
      proxyLog('reticle_mcp_proxy_reconnecting', {
        port,
        reason,
        attempt: attempts,
        retryInMs: wait,
        ...(detail !== undefined ? { detail } : {}),
      });
      setTimeout(() => {
        // Reattach to a daemon that is ALREADY there. Deliberately does not spawn one: a daemon that
        // shut itself down as idle would be respawned instantly, sit unused, shut down again, and
        // loop forever — measured at four processes in 200s before this. If nothing is listening the
        // proxy goes DORMANT and the next client request brings a daemon back (see the stdin reader).
        void probePresence(port, { tcpOpen: probeDaemon, status: fetchDaemonStatus }).then(
          (presence) => {
            if (onStreamDrop(presence) === OnDrop.REATTACH) {
              connect(false);
              return;
            }
            dormant = true;
            // The sentence `doctor` has always been able to say, in the log the agent's own process
            // writes. A FOREIGN holder used to be indistinguishable from a free port here, and the
            // proxy spun against it instead of saying which one it was.
            const sentence = describePresence(presence, port);
            proxyLog('reticle_mcp_proxy_dormant', { port, presence, note: sentence });
            // Nothing is coming that could answer the client's handshake through this port, and the
            // proxy now knows that rather than merely suspecting it. Waiting out LOCAL_HANDSHAKE_MS
            // would be waiting for information already in hand — and #125 measured what that costs:
            // a client whose initialize budget is under ~12s loses Reticle for the whole session.
            deliverHandshakeLocally?.(sentence);
          },
        );
      }, wait).unref();
    }

    function connect(first: boolean): void {
      // Announce this process to the daemon on the connect we already make — it is the single judge
      // of version skew, and this is the only moment it learns the agent's MCP server exists.
      const announce = `${MCP_SSE_PATH}?${PEER_VERSION_PARAM}=${encodeURIComponent(SERVER_VERSION)}&${PEER_CONTRACT_PARAM}=${encodeURIComponent(CONTRACT_FINGERPRINT)}`;
      /**
       * ONE reconnect per connect attempt, whoever notices the failure first.
       *
       * A dead socket emits on BOTH halves — `req`'s `error` and the response's `aborted`/`close`
       * for the same TCP death — and this latch used to live inside the response callback, so
       * `req.on('error')` scheduled a SECOND reconnect that the drop path could not see. Two chains
       * came back, both died the same way, and both split again. The retry budget cannot stop that
       * either: any one chain reaching an `endpoint` frame resets `attempts` to zero for all of
       * them. It is the runaway behind a proxy log large enough to fill a disk, and the doubling is
       * visible in the field logs as roughly two `reconnecting` lines per `reconnected` one.
       */
      let settled = false;
      /**
       * Whether this attempt ever got a response, as opposed to never reaching the daemon.
       *
       * `first` alone conflates two different situations, and the `req.on('error')` branch below
       * treats both as a startup failure the caller handles. Before any stream exists that is right:
       * there is no daemon, so rejecting is the honest answer. Once the FIRST stream has connected
       * and is serving, a socket reset is a DROP, and rejecting it kills the proxy outright instead
       * of reconnecting. The agent loses Reticle for the rest of the session, on its first stream,
       * with nothing to retry it.
       *
       * It is also a race rather than a certainty, which is worse: a reset emits on both halves, so
       * whether the proxy reconnects or dies depended on whether `res`'s `close` or `req`'s `error`
       * won. Every later stream recovers correctly; you simply have to survive the first one.
       */
      let responded = false;
      const req = http.get({ host: LOOPBACK_HOST, port, path: announce }, (res) => {
        responded = true;
        if (!first) proxyLog('reticle_mcp_proxy_reconnected', { port });
        res.setEncoding('utf8');
        const drop = (reason: string, detail?: string): void => {
          if (settled) return;
          settled = true;
          // What the dead session owed is settled inside scheduleReconnect, so the other half of the
          // socket's death pays exactly the same debt when it is the one that notices first.
          scheduleReconnect(reason, detail);
        };
        const sse = new SseFrameParser();
        res.on('data', (chunk: string) => {
          for (const frame of sse.push(chunk)) onSseEvent(frame.event, frame.data, port);
        });
        res.on('end', () => drop('sse_ended'));
        res.on('error', (err) => drop('sse_error', err.message));
        // A socket dying under us (daemon killed, network stack reset) emits NEITHER `end` nor
        // `error` — only `aborted`/`close`. Listening for just the first two is why the proxy sat
        // there afterwards holding a dead stream. `settled` keeps the clean case single-fire.
        res.on('aborted', () => drop('sse_aborted'));
        res.on('close', () => drop('sse_closed'));
      });

      // The very first connect failing means there is no daemon to talk to — that is a startup
      // failure the caller handles. Later ones are just the daemon bouncing: keep retrying.
      req.on('error', (err) => {
        if (settled) return;
        settled = true;
        if (first && !responded) {
          // A refused port on the very first connect is a daemon still booting, not a failure. Keep
          // chasing it: nothing else will, because only a fresh client request re-probes the port
          // and the client is already blocked on the call this would rescue.
          if (shouldRetryFirstConnect(err, Date.now() - startedAt)) {
            firstConnectAttempts++;
            const retryInMs = reconnectDelayMs(firstConnectAttempts);
            proxyLog('reticle_mcp_proxy_first_connect_retry', {
              port,
              attempt: firstConnectAttempts,
              retryInMs,
              note: 'the daemon has not finished booting; still waiting for it to accept',
            });
            setTimeout(() => connect(true), retryInMs).unref();
            return;
          }
          reject(err);
          return;
        }
        scheduleReconnect('connect_error', err.message);
      });
    }

    connect(true);

    // ── stdin reader ─────────────────────────────────────────────────────────
    process.stdin.setEncoding('utf8');
    let handshakeAnswered = false;
    /**
     * True while the client is holding a tool list WE made up rather than one the daemon sent.
     *
     * Set when we answer `initialize` locally, cleared the moment we tell the client to re-list. It
     * is not the same question as `handshakeAnswered`, which is also true after a real daemon
     * handshake — and a client that already has the daemon's catalog must not be sent chasing it.
     */
    let toolsAnnouncedLocally = false;
    /**
     * Answer a queued `initialize` locally if the daemon has not produced an endpoint in time.
     *
     * Bounded because a hang is the worst outcome available here: no tools, no diagnosis, nothing to
     * retry. Cancelled implicitly — once `postUrl` exists the queue flushes and the daemon answers,
     * and `handshakeAnswered` keeps us from answering twice.
     */
    const armLocalHandshake = (line: string): void => {
      if (handshakeAnswered) return;
      // Only an `initialize` REQUEST is ours to answer. Asked with no instructions because the ones
      // we will actually send name the reason the daemon failed, and the reason is not known until
      // the deliver closure runs — see degradedInstructions.
      if (null === localInitializeResponse(line, '')) return;
      // Take the debt NOW, not when the timer fires.
      //
      // Three paths can answer this id — the daemon, the stream-loss drain, and the timer below —
      // and `take` is the coordination between them. This was the one answerer that never claimed,
      // so a drop before the timer fired paid the handshake a -32001 and the timer then paid it a
      // result, under the same id. Both halves are fatal: a client that gets an error for
      // `initialize` marks the whole MCP server failed, and one that survives that sees two
      // responses for one request. Claiming it here says out loud what has always been true — the
      // proxy owns this answer and will deliver it — so the drain stops owing it. If a session is
      // established first, the `endpoint` handler sets `handshakeAnswered` before the queue is
      // flushed, which disarms the timer and leaves the daemon's own reply the only one.
      const claimed = parseJsonRpc(line);
      if (claimed?.id !== undefined) pending.take(claimed.id);
      deliverHandshakeLocally = (reason: string): void => {
        if (handshakeAnswered || postUrl !== null) return;
        // Built here, not at arm time, so the notice can name WHY no daemon answered. The client
        // reads `instructions` exactly once, at initialize, and this response is the only one it
        // will ever get — so a handshake that does not say it is unbacked never says it at all.
        // See degradedInstructions for the field report this closes.
        const response = localInitializeResponse(
          line,
          degradedInstructions(proxyInstructions(port), port, reason),
        );
        if (null === response) return;
        handshakeAnswered = true;
        deliverHandshakeLocally = undefined;
        // The catalog we are about to serve is ours, not the daemon's, so it has to be corrected
        // the moment a real one exists. See the endpoint handler.
        toolsAnnouncedLocally = true;
        // Drop the handshake from the queue. Otherwise the daemon, whenever it finally arrives,
        // answers the SAME id a second time and the client sees two responses to one request — a
        // corrupted stream, which is worse than the hang this replaces. The daemon still gets its own
        // handshake: `replayLines` re-issues it under a distinct id and suppresses the echo.
        for (let i = stdinQueue.length - 1; i >= 0; i--) {
          const queued = stdinQueue[i];
          if (queued !== undefined && isHandshakeLine(queued)) stdinQueue.splice(i, 1);
        }
        proxyLog('reticle_mcp_local_handshake', { port, reason });
        emit(response);
      };
      setTimeout(
        () => deliverHandshakeLocally?.('daemon did not answer in time'),
        LOCAL_HANDSHAKE_MS,
      ).unref();
    };

    let stdinBuffer = '';
    let stdinDiscarding = false;

    process.stdin.on('data', (chunk: string) => {
      // Not `(buffer + chunk).split()` inline — that rescans everything held on every chunk, so one
      // large line cost O(n²) in its own size and pinned the event loop for tens of seconds, during
      // which every other tool call on this link hung with no response and no error. See drainLines.
      const drained = drainLines(stdinBuffer, chunk, MAX_STDIN_LINE_BYTES, stdinDiscarding);
      stdinBuffer = drained.rest;
      // Carried across chunks: an oversized line is dropped, and the REST of it is still arriving.
      // Without this its tail reads as a complete line and gets forwarded as a message nobody sent.
      stdinDiscarding = drained.discarding;
      if (drained.overflowed) {
        // Logged rather than answered: an unparsed line has no id to answer against, and inventing
        // one would put a reply on the wire that no request is waiting for.
        proxyLog('mcp_stdin_line_too_large', { limitBytes: MAX_STDIN_LINE_BYTES });
      }
      for (const line of drained.lines) {
        const trimmed = line.trim();
        if ('' === trimmed) continue;
        replay.observeOutbound(trimmed);
        pending.observeOutbound(trimmed);
        // The ARRIVAL of the request, not the delivery of an answer: "this client asked for the tool
        // list" is the fact `status` reports on, and a request that arrived and then failed is a
        // different problem with its own diagnosis. Recording the answer instead would let a host
        // that never asks look identical to one that asked and was refused.
        if (isToolsListRequest(trimmed)) rememberEnumerated(reticleStateHome(), port);
        // The hop every other check misses. Recorded on the REQUEST rather than a reply, because
        // the question is whether anything ever left the agent — a call that leaves and gets no
        // answer is a different fault from one that was never made, and only this side sees it.
        if (isToolCallRequest(trimmed)) rememberToolCalled(reticleStateHome(), port);
        const action = onClientRequest(postUrl !== null, dormant);
        if (action === OnRequest.SEND && postUrl !== null) {
          forward(postUrl, trimmed);
          continue;
        }
        // A queued `tools/list` with no daemon is the state that leaves an agent "connected with no
        // tools" — the one a human has to fix by hand. If the catalog has been seen, answer it.
        if (handshakeAnswered) {
          const cached = catalog.answer(trimmed);
          if (cached !== null) {
            emit(cached);
            continue;
          }
        }
        stdinQueue.push(trimmed);
        armQueueTimer();
        // A queued `initialize` is the one message that must not wait indefinitely. If the daemon
        // port is held by something that never serves SSE — wedged, foreign, or leaked by another
        // project — the handshake never completes and the agent gets NO tools and no diagnosis.
        // Answer it ourselves after a bounded wait; the daemon still receives the client's own
        // initialize when a session is finally established (replayLines).
        armLocalHandshake(trimmed);
        // WAKE is the ONLY path allowed to start a daemon — see proxy-lifecycle.ts. The queue is
        // flushed once the new session's `endpoint` frame arrives.
        if (action === OnRequest.WAKE) {
          dormant = false;
          // Budget reset, accounting preserved. See attemptsBeforeDormant.
          attemptsBeforeDormant += attempts;
          attempts = 0;
          void (ensureDaemon?.() ?? Promise.resolve())
            .then(() => connect(false))
            .catch((err: unknown) => {
              dormant = true;
              const reason = err instanceof Error ? err.message : String(err);
              proxyLog('reticle_mcp_proxy_wake_failed', { port, error: reason });
              // The wake is the only thing that can start a daemon, so its failure IS the answer to
              // everything it was woken for. It used to be logged and nothing else: the request sat
              // out the full QUEUE_WAIT_MS and was then refused by a timer that could only say "no
              // daemon could be reached" — twenty seconds later, and less true, than the sentence
              // already in hand.
              expireQueue(reason);
            });
        }
      }
    });

    // The client going away is the one clean shutdown — stop reconnecting and exit.
    //
    // Exiting the INSTANT stdin ends drops whatever is still in flight and reports success for it: a
    // client that wrote `initialize` + `tools/list` and closed in the same flush got the handshake
    // answered, `tools/list` never, and exit 0 — so nothing supervising it could tell. A 4-second gap
    // between the writes made it "work", which is the signature of a teardown race, not of a client
    // that asked for too much. Drain first, and let the exit status carry the truth if it fails.
    process.stdin.on('end', () => {
      const quit = (code: number): void => {
        stopped = true;
        // Await: fire-and-forget here is how daemon_stopped never arrived.
        void flushProxySessionMetrics().finally(() => process.exit(code));
      };
      if (0 === pending.unanswered.length) {
        quit(0);
        return;
      }
      const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
      const poll = setInterval(() => {
        const stuck = pending.unanswered;
        if (0 === stuck.length) {
          clearInterval(poll);
          quit(0);
          return;
        }
        if (Date.now() < deadline) return;
        clearInterval(poll);
        proxyLog('reticle_mcp_proxy_unanswered_at_exit', { port, ids: stuck });
        quit(1);
      }, SHUTDOWN_DRAIN_POLL_MS);
    });
  });
}
