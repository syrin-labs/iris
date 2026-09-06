import { describe, it, expect, beforeEach, vi } from 'vitest';

type CapModule = typeof import('./capabilities.js');

/** The registry binds the global store at module load, so re-import per test for isolation. */
async function freshModule(): Promise<CapModule> {
  delete (globalThis as { __reticleCapabilities?: unknown }).__reticleCapabilities;
  vi.resetModules();
  return import('./capabilities.js');
}

describe('capability registry', () => {
  beforeEach(() => {
    delete (globalThis as { __reticleCapabilities?: unknown }).__reticleCapabilities;
  });

  it('registers then returns the merged object', async () => {
    const { registerCapabilities, getCapabilities } = await freshModule();
    registerCapabilities({
      testids: ['item-list'],
      signals: ['webhook:received'],
      stores: ['cart'],
      flows: [{ name: 'checkout', steps: ['fill', 'submit'] }],
    });
    const caps = getCapabilities();
    expect(caps.testids).toEqual(['item-list']);
    expect(caps.signals).toEqual(['webhook:received']);
    expect(caps.stores).toEqual(['cart']);
    expect(caps.flows).toEqual([{ name: 'checkout', steps: ['fill', 'submit'] }]);
  });

  it('merges idempotently (no duplicate testids across calls)', async () => {
    const { registerCapabilities, getCapabilities } = await freshModule();
    registerCapabilities({ testids: ['a'] });
    registerCapabilities({ testids: ['a'] });
    expect(getCapabilities().testids).toEqual(['a']);
  });

  it('dedupes flows by name with last-writer-wins on steps', async () => {
    const { registerCapabilities, getCapabilities } = await freshModule();
    registerCapabilities({ flows: [{ name: 'pay', steps: ['one'] }] });
    registerCapabilities({ flows: [{ name: 'pay', steps: ['two', 'three'] }] });
    const flows = getCapabilities().flows;
    expect(flows).toHaveLength(1);
    expect(flows[0]).toEqual({ name: 'pay', steps: ['two', 'three'] });
  });

  it('partial input leaves other arrays empty', async () => {
    const { registerCapabilities, getCapabilities } = await freshModule();
    registerCapabilities({ signals: ['x'] });
    const caps = getCapabilities();
    expect(caps.signals).toEqual(['x']);
    expect(caps.testids).toEqual([]);
    expect(caps.stores).toEqual([]);
    expect(caps.flows).toEqual([]);
  });

  it('hasCapabilities is false on a fresh store and true after registration', async () => {
    const { registerCapabilities, hasCapabilities } = await freshModule();
    expect(hasCapabilities()).toBe(false);
    registerCapabilities({ testids: ['a'] });
    expect(hasCapabilities()).toBe(true);
  });

  it('returns a defensive copy (mutating the result does not affect the store)', async () => {
    const { registerCapabilities, getCapabilities } = await freshModule();
    registerCapabilities({ testids: ['a'] });
    const first = getCapabilities();
    first.testids.push('mutated');
    first.flows.push({ name: 'rogue', steps: [] });
    expect(getCapabilities().testids).toEqual(['a']);
    expect(getCapabilities().flows).toEqual([]);
  });
});

/**
 * The observed half of the surface. Declaring testids and store names used to be the ONLY way to
 * have any, which is what made "finish the capabilities file" a step in every install.
 */
describe('capabilities observed from the running app', () => {
  beforeEach(() => {
    delete (globalThis as { __reticleCapabilities?: unknown }).__reticleCapabilities;
    delete (globalThis as { __reticleStores?: unknown }).__reticleStores;
    delete (globalThis as { __reticleStoreSubs?: unknown }).__reticleStoreSubs;
    document.body.innerHTML = '';
  });

  it('reports testids the app rendered but never declared', async () => {
    document.body.innerHTML = '<button data-testid="pay"></button>';
    const { getCapabilities, hasCapabilities } = await freshModule();
    expect(getCapabilities().testids).toEqual(['pay']);
    expect(hasCapabilities()).toBe(true);
  });

  it('reports a store that was registered rather than declared', async () => {
    const mod = await freshModule();
    const { registerStore } = await import('./stores.js');
    registerStore('cart', { getState: () => ({ items: 1 }), subscribe: () => () => {} });
    expect(mod.getCapabilities().stores).toContain('cart');
    expect(mod.hasCapabilities()).toBe(true);
  });

  it('never advertises Reticle’s own render store as the app’s surface', async () => {
    const mod = await freshModule();
    const { registerStore } = await import('./stores.js');
    registerStore('__reticle_renders', () => ({ commits: 3 }));
    expect(mod.getCapabilities().stores).toEqual([]);
    expect(mod.hasCapabilities()).toBe(false);
  });

  it('keeps a declaration and the observation as one list, without duplicates', async () => {
    document.body.innerHTML = '<i data-testid="pay"></i><i data-testid="cancel"></i>';
    const { registerCapabilities, getCapabilities } = await freshModule();
    registerCapabilities({ testids: ['pay'] });
    expect(getCapabilities().testids).toEqual(['pay', 'cancel']);
  });

  it('says there is no surface when the app has neither declared nor rendered one', async () => {
    const { hasCapabilities } = await freshModule();
    expect(hasCapabilities()).toBe(false);
  });
});

describe('declared and observed stay distinguishable', () => {
  beforeEach(() => {
    delete (globalThis as { __reticleCapabilities?: unknown }).__reticleCapabilities;
    document.body.innerHTML = '';
  });

  /**
   * `knownEmptyState` reads this list to tell "the app named this element" from "a testid happens to
   * be on the page". Merging the DOM in here would make it true for any page with any testid.
   */
  it('leaves an observed testid out of the declared list', async () => {
    document.body.innerHTML = '<i data-testid="observed"></i>';
    const { registerCapabilities, declaredTestids, getCapabilities } = await freshModule();
    registerCapabilities({ testids: ['declared'] });
    expect(declaredTestids()).toEqual(['declared']);
    expect(getCapabilities().testids).toEqual(['declared', 'observed']);
  });
});
