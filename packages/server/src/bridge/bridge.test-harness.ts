import { WebSocket } from 'ws';
import {
  RETICLE_WS_PATH,
  ReticleCommand,
  LOOPBACK_HOST,
  MessageKind,
  type ElementQuery,
} from '@reticlehq/core';
import type { Bridge } from './bridge.js';
import { BaselineStore } from '../project/baselines.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import { TOOLS, type ToolDeps } from '../tools/tools.js';

/** The app-advertised testable surface a FakeBrowser reports for an reticle_capabilities round-trip. */
const FAKE_CAPABILITIES = {
  testids: ['toast'],
  signals: ['webhook:received'],
  stores: ['cart'],
  flows: [{ name: 'pay', steps: ['fill', 'click'] }],
};

/** A stand-in for the real @reticlehq/browser SDK: replies to commands and emits events. */
export class FakeBrowser {
  readonly #ws: WebSocket;
  matcher: (query: ElementQuery) => boolean = () => false;
  /** When false, the browser pretends it has no CAPABILITIES handler (older build). */
  handlesCapabilities = true;
  /** When false, ACT results omit a testid (element has no data-testid → unstable step). */
  actHasTestid = true;
  /** Provenance the real browser captures alongside the anchor; undefined = app built without it. */
  actSource: { file: string; line: number } | undefined = undefined;
  /** DOM mutations the browser counted inside the acted element; undefined = it counted none. */
  actMutatedWithin: number | undefined = undefined;
  /** when false, ACT reports settled:false + settleReason:'timeout' (throttled-tab path). */
  actSettled = true;
  /** When false, QUERY by testid returns no match (testid not in current DOM at replay). */
  queryResolves = true;
  /** Records every command the bridge sent (for replay assertions). */
  readonly received: { name: string; args: Record<string, unknown> }[] = [];
  /**
   * The snapshot tree to return. Mutable so tests can vary the page between calls.
   *
   * The counters are optional because the fields they stand for are: the browser omits `nodes`-
   * adjacent diagnostics on a page that has nothing to report, and a test asserting on one has to be
   * able to send a payload shaped like the real thing.
   */
  snapshotResult: {
    tree: string;
    status: Record<string, unknown>;
    nodes?: number;
    hiddenSkipped?: number;
    leanSkipped?: number;
  } = {
    tree: '- button "Pay" (ref=e7)\n- dialog "Order confirmed" (ref=e12)',
    status: { route: '/checkout' },
  };

  constructor(
    port: number,
    private readonly sessionId: string,
    private readonly hasCapabilities = false,
  ) {
    // Real browsers always send an Origin on the WS handshake; simulate a loopback app page.
    this.#ws = new WebSocket(`ws://${LOOPBACK_HOST}:${String(port)}${RETICLE_WS_PATH}`, {
      origin: 'http://localhost',
    });
  }

  open(): Promise<void> {
    return new Promise((resolve) => {
      this.#ws.on('open', () => {
        this.#send({
          kind: MessageKind.HELLO,
          protocolVersion: 1,
          sessionId: this.sessionId,
          url: 'http://localhost:3000/checkout',
          title: 'Checkout',
          adapters: [],
          hasCapabilities: this.hasCapabilities,
        });
        this.#ws.on('message', (raw) => {
          this.#onMessage(JSON.parse((raw as Buffer).toString('utf8')) as Record<string, unknown>);
        });
        resolve();
      });
    });
  }

  /** Re-send the HELLO on the live socket, the way the SDK does when capabilities register late. */
  reannounce(overrides: { sessionId?: string; hasCapabilities?: boolean } = {}): void {
    this.#send({
      kind: MessageKind.HELLO,
      protocolVersion: 1,
      sessionId: overrides.sessionId ?? this.sessionId,
      url: 'http://localhost:3000/checkout',
      title: 'Checkout',
      adapters: [],
      hasCapabilities: overrides.hasCapabilities ?? this.hasCapabilities,
    });
  }

  emit(type: string, data: Record<string, unknown>, ref?: string): void {
    this.#send({
      kind: MessageKind.EVENT,
      event: { t: 0, type, sessionId: this.sessionId, ref, data },
    });
  }

  close(): void {
    this.#ws.close();
  }

  #onMessage(msg: Record<string, unknown>): void {
    if (msg['kind'] !== MessageKind.COMMAND) return;
    const id = msg['id'] as string;
    const name = msg['name'] as string;
    const args = (msg['args'] ?? {}) as Record<string, unknown>;
    this.received.push({ name, args });
    let result: unknown = { ok: true };
    if (name === ReticleCommand.ACT) {
      result = {
        ok: true,
        ref: args['ref'],
        action: args['action'],
        dispatched: true,
        settled: this.actSettled,
        settleReason: this.actSettled ? null : 'timeout',
        effect: {
          dispatched: true,
          ...(this.actMutatedWithin === undefined
            ? {}
            : { domMutatedWithin: this.actMutatedWithin }),
        },
        ...(this.actHasTestid ? { testid: 'pay-btn' } : {}),
        ...(this.actSource === undefined ? {} : { source: this.actSource }),
      };
    } else if (name === ReticleCommand.ACT_SEQUENCE) {
      const steps = (Array.isArray(args['steps']) ? args['steps'] : []) as Record<
        string,
        unknown
      >[];
      result = {
        count: steps.length,
        steps: steps.map((s) => ({
          ref: s['ref'],
          action: s['action'],
          ...(this.actHasTestid ? { testid: 'pay-btn' } : {}),
          ...(this.actSource === undefined ? {} : { source: this.actSource }),
        })),
      };
    } else if (name === ReticleCommand.QUERY) {
      result = {
        elements: this.queryResolves
          ? [{ ref: 'e7', role: 'button', name: 'Pay', states: [], visible: true }]
          : [],
      };
    } else if (name === ReticleCommand.MATCH) {
      const query = (args['query'] ?? {}) as ElementQuery;
      const matched = this.matcher(query);
      result = {
        matched,
        count: matched ? 1 : 0,
        elements: matched
          ? [
              {
                ref: 'e12',
                role: 'dialog',
                name: 'Order confirmed',
                states: ['visible'],
                visible: true,
              },
            ]
          : [],
      };
    } else if (name === ReticleCommand.STATE_READ) {
      result = {
        stores: { workspace: { tab: 'workspace' === args['store'] ? 'open' : 'all' } },
        storeNames: ['workspace'],
        component: args['ref'] !== undefined ? { component: 'PayButton', hooks: [0] } : undefined,
      };
    } else if (name === ReticleCommand.SNAPSHOT) {
      result = this.snapshotResult;
    } else if (name === ReticleCommand.CAPABILITIES) {
      if (!this.handlesCapabilities) {
        this.#send({
          kind: MessageKind.COMMAND_RESULT,
          id,
          ok: false,
          error: `unknown command '${name}'`,
        });
        return;
      }
      result = FAKE_CAPABILITIES;
    }
    this.#send({ kind: MessageKind.COMMAND_RESULT, id, ok: true, result });
  }

  #send(obj: unknown): void {
    this.#ws.send(JSON.stringify(obj));
  }
}

/**
 * Poll until `cond` holds.
 *
 * The default was 2000ms and the fifty-browser test blew it on the Windows runner at 5155ms — a
 * statement about the machine, not about the bridge. Raising it is safe in a way that raising a
 * fixed sleep would not be: this POLLS every 10ms and resolves the instant the condition holds, so
 * a passing test is not slowed by one millisecond and only a genuinely failing one waits longer.
 */
export function waitUntil(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitUntil timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

export const callTool = (
  deps: ToolDeps,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> => {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.handler(deps, args);
};

/** Builds the ToolDeps wired to a running bridge, with a frozen clock for deterministic tests. */
export function makeDeps(bridge: Bridge): ToolDeps {
  return {
    sessions: bridge.sessions,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(createNodeFileSystem(), '/tmp/reticle-test/.reticle', { now: () => 0 }),
    project: new ProjectStore(createNodeFileSystem(), '/tmp/reticle-test/.reticle', {
      now: () => 0,
    }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    reticleRoot: '/tmp/reticle-test/.reticle',
    now: () => 0,
  };
}
