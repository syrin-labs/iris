import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { RETICLE_CAPTURE_CHANNEL, RETICLE_IPC_GLOBAL } from '@reticlehq/core';

const require = createRequire(import.meta.url);

/**
 * The record the preload pushes to the renderer. Same fields as `PreloadRecord` in
 * `packages/browser/src/observers/ipc.ts` — that is the contract the SDK consumes. Core owns the
 * global name and the capture channel (`desktop-contract`); the record shape is what this file
 * must keep honest so a payload-based check is not silently web-only.
 */
const RECORD_PHASES = new Set(['start', 'end']);

function assertPreloadRecord(record) {
  expect(RECORD_PHASES.has(record.phase)).toBe(true);
  expect(typeof record.id).toBe('string');
  expect(record.id).toMatch(/^i\d+$/);
  expect(typeof record.channel).toBe('string');
  expect(record.channel.length).toBeGreaterThan(0);
  if (record.ok !== undefined) expect(typeof record.ok).toBe('boolean');
  if (record.durationMs !== undefined) expect(typeof record.durationMs).toBe('number');
  if (record.error !== undefined) expect(typeof record.error).toBe('string');
  if (record.oneWay !== undefined) expect(record.oneWay).toBe(true);
  if (record.requestBody !== undefined) expect(typeof record.requestBody).toBe('string');
  if (record.requestSize !== undefined) expect(typeof record.requestSize).toBe('number');
  if (record.responseBody !== undefined) expect(typeof record.responseBody).toBe('string');
  if (record.responseSize !== undefined) expect(typeof record.responseSize).toBe('number');
  if (record.responseBodyTruncated !== undefined) expect(record.responseBodyTruncated).toBe(true);
}

/**
 * Load the CJS preload against a fake `electron`. The real package is a peer and must not boot.
 * @param {{
 *   invoke?: (...args: unknown[]) => unknown,
 *   sendSync?: (...args: unknown[]) => unknown,
 *   send?: (...args: unknown[]) => unknown,
 * }} impl
 */
function loadPreload(impl = {}) {
  const ipcRenderer = {
    invoke: impl.invoke ?? (async (_channel, payload) => ({ ok: true, echo: payload })),
    sendSync: impl.sendSync ?? ((_channel, payload) => ({ sync: true, echo: payload })),
    send: impl.send ?? ((_channel, _payload) => undefined),
  };
  /** @type {{ name: string | null, api: Record<string, Function> | null }} */
  const exposed = { name: null, api: null };
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        exposed.name = name;
        exposed.api = api;
      },
    },
    ipcRenderer,
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  const preloadId = require.resolve('./preload.cjs');
  delete require.cache[preloadId];
  try {
    require('./preload.cjs');
  } finally {
    Module._load = originalLoad;
  }
  return { exposed, ipcRenderer };
}

describe('electron preload IPC records', () => {
  afterEach(() => {
    const preloadId = require.resolve('./preload.cjs');
    delete require.cache[preloadId];
  });

  it('exposes the SDK channel under the core contract name', () => {
    const { exposed } = loadPreload();
    expect(exposed.name).toBe(RETICLE_IPC_GLOBAL);
    expect(typeof exposed.api?.subscribe).toBe('function');
    expect(typeof exposed.api?.unsubscribe).toBe('function');
  });

  it('drops records until a renderer subscribes — the SDK only wants activity it is watching', () => {
    const { exposed, ipcRenderer } = loadPreload();
    const records = [];
    return Promise.resolve(ipcRenderer.invoke('todos:load', { page: 1 }))
      .then(() => {
        expect(records).toEqual([]);
        exposed.api.subscribe((record) => records.push(record));
        return ipcRenderer.invoke('todos:load', { page: 1 });
      })
      .then(() => {
        expect(records.length).toBeGreaterThan(0);
      });
  });

  it('reports invoke as a start/end pair with request and response bodies', async () => {
    const { exposed, ipcRenderer } = loadPreload({
      invoke: async (_channel, payload) => ({ saved: true, title: payload.title }),
    });
    const records = [];
    exposed.api.subscribe((record) => {
      assertPreloadRecord(record);
      records.push(record);
    });

    const result = await ipcRenderer.invoke('todos:save', { title: 'buy milk' });
    expect(result).toEqual({ saved: true, title: 'buy milk' });

    expect(records.map((r) => r.phase)).toEqual(['start', 'end']);
    expect(records[0].channel).toBe('todos:save');
    expect(records[0].id).toBe(records[1].id);
    expect(records[1].ok).toBe(true);
    expect(records[1].requestBody).toBe(JSON.stringify([{ title: 'buy milk' }]));
    expect(records[1].responseBody).toBe(JSON.stringify({ saved: true, title: 'buy milk' }));
    expect(records[1].oneWay).toBeUndefined();
  });

  it('reports a thrown invoke as ok:false with the message, and still throws', async () => {
    const { exposed, ipcRenderer } = loadPreload({
      invoke: async () => {
        throw new Error('archive is not implemented in the backend');
      },
    });
    const records = [];
    exposed.api.subscribe((record) => {
      assertPreloadRecord(record);
      records.push(record);
    });

    await expect(ipcRenderer.invoke('todos:archive')).rejects.toThrow(
      'archive is not implemented in the backend',
    );
    const end = records.find((r) => r.phase === 'end');
    expect(end.ok).toBe(false);
    expect(end.error).toBe('archive is not implemented in the backend');
  });

  it('records send as one-way: dispatched, no ok, no manufactured verdict', () => {
    const { exposed, ipcRenderer } = loadPreload();
    const records = [];
    exposed.api.subscribe((record) => {
      assertPreloadRecord(record);
      records.push(record);
    });

    ipcRenderer.send('window:minimize');
    expect(records).toHaveLength(1);
    expect(records[0].phase).toBe('end');
    expect(records[0].channel).toBe('window:minimize');
    expect(records[0].oneWay).toBe(true);
    expect(records[0]).not.toHaveProperty('ok');
    expect(records[0]).not.toHaveProperty('status');
  });

  it('still reports a one-way send that threw at the call site as a real failure', () => {
    const { exposed, ipcRenderer } = loadPreload({
      send: () => {
        throw new Error('port closed');
      },
    });
    const records = [];
    exposed.api.subscribe((record) => {
      assertPreloadRecord(record);
      records.push(record);
    });

    expect(() => ipcRenderer.send('window:minimize')).toThrow('port closed');
    expect(records[0].oneWay).toBe(true);
    expect(records[0].ok).toBe(false);
    expect(records[0].error).toBe('port closed');
  });

  it('observes sendSync like invoke — it really returns a result', () => {
    const { exposed, ipcRenderer } = loadPreload({
      sendSync: (_channel, payload) => ({ n: payload.n + 1 }),
    });
    const records = [];
    exposed.api.subscribe((record) => {
      assertPreloadRecord(record);
      records.push(record);
    });

    expect(ipcRenderer.sendSync('counter:inc', { n: 1 })).toEqual({ n: 2 });
    expect(records.map((r) => r.phase)).toEqual(['start', 'end']);
    expect(records[1].ok).toBe(true);
    expect(records[1].requestBody).toBe(JSON.stringify([{ n: 1 }]));
    expect(records[1].responseBody).toBe(JSON.stringify({ n: 2 }));
  });

  it('omits a circular payload rather than breaking the app call', async () => {
    const circular = {};
    circular.self = circular;
    const { exposed, ipcRenderer } = loadPreload({
      invoke: async () => circular,
    });
    const records = [];
    exposed.api.subscribe((record) => {
      assertPreloadRecord(record);
      records.push(record);
    });

    await expect(ipcRenderer.invoke('graph:get')).resolves.toBe(circular);
    const end = records.find((r) => r.phase === 'end');
    expect(end.ok).toBe(true);
    expect(end.responseBody).toBeUndefined();
  });

  it('cuts a body at 8192 and marks it truncated, matching the HTTP cap', async () => {
    const big = { blob: 'x'.repeat(9000) };
    const full = JSON.stringify(big);
    expect(full.length).toBeGreaterThan(8192);
    const { exposed, ipcRenderer } = loadPreload({
      invoke: async () => big,
    });
    const records = [];
    exposed.api.subscribe((record) => {
      assertPreloadRecord(record);
      records.push(record);
    });

    await ipcRenderer.invoke('dump:get');
    const end = records.find((r) => r.phase === 'end');
    expect(end.responseBody).toBe(full.slice(0, 8192));
    expect(end.responseSize).toBe(full.length);
    expect(end.responseBodyTruncated).toBe(true);
  });

  it('does not record Reticle capture as an app IPC call', async () => {
    const { exposed } = loadPreload({
      invoke: async (channel) => {
        expect(channel).toBe(RETICLE_CAPTURE_CHANNEL);
        return 'png-bytes';
      },
    });
    const records = [];
    exposed.api.subscribe((record) => records.push(record));

    await expect(exposed.api.capture(false)).resolves.toBe('png-bytes');
    expect(records, 'capture uses the original invoke so it stays out of network evidence').toEqual(
      [],
    );
  });

  it('unsubscribe is a real removal, so teardown leaves the other subscriber reporting', async () => {
    const { exposed, ipcRenderer } = loadPreload();
    const first = [];
    const second = [];
    const token = exposed.api.subscribe((record) => first.push(record));
    exposed.api.subscribe((record) => second.push(record));

    await ipcRenderer.invoke('todos:load');
    expect(first.length).toBe(2);
    expect(second.length).toBe(2);

    exposed.api.unsubscribe(token);
    await ipcRenderer.invoke('todos:load');
    expect(first.length).toBe(2);
    expect(second.length).toBe(4);
  });
});

describe('IPC that happened before the SDK was watching', () => {
  it('replays the calls an app made on mount, which is where its data comes from', async () => {
    const { exposed, ipcRenderer } = loadPreload();
    // The app loads its todos before connect() has finished. This is the ordinary case on desktop,
    // not an edge one: connect() is injected and asynchronous, React mounts immediately.
    await ipcRenderer.invoke('todos:load');

    const records = [];
    exposed.api.subscribe((record) => records.push(record));
    expect(records.map((r) => `${r.phase}:${r.channel}`)).toEqual([
      'start:todos:load',
      'end:todos:load',
    ]);
    for (const record of records) assertPreloadRecord(record);
  });

  it('delivers the backlog once, so a call is not counted twice', async () => {
    const { exposed, ipcRenderer } = loadPreload();
    await ipcRenderer.invoke('todos:load');
    exposed.api.subscribe(() => undefined);
    const second = [];
    exposed.api.subscribe((record) => second.push(record));
    expect(second).toEqual([]);
  });

  it('keeps delivering live once someone is listening', async () => {
    const { exposed, ipcRenderer } = loadPreload();
    await ipcRenderer.invoke('todos:load');
    const records = [];
    exposed.api.subscribe((record) => records.push(record));
    await ipcRenderer.invoke('todos:add');
    expect(records.filter((r) => r.channel === 'todos:add')).toHaveLength(2);
  });

  it('does not grow without bound when no SDK ever attaches', async () => {
    const { exposed, ipcRenderer } = loadPreload();
    for (let i = 0; i < 400; i++) await ipcRenderer.invoke(`ch:${String(i)}`);
    const records = [];
    exposed.api.subscribe((record) => records.push(record));
    expect(records.length).toBeLessThanOrEqual(200);
    expect(records.length).toBeGreaterThan(0);
  });
});
