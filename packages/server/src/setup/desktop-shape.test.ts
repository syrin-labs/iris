import { describe, expect, it } from 'vitest';
import { AppShape, isDesktop, isDesktopOrigin, policyFor, readShape } from './desktop-shape.js';

describe('reading the shell', () => {
  it('is a web app when nothing says otherwise', () => {
    expect(readShape({ hasTauriConf: false, hasElectronDep: false })).toBe(AppShape.WEB);
  });

  it('reads a tauri config as tauri', () => {
    expect(readShape({ hasTauriConf: true, hasElectronDep: false })).toBe(AppShape.TAURI);
  });

  it('reads an electron dependency as electron', () => {
    expect(readShape({ hasTauriConf: false, hasElectronDep: true })).toBe(AppShape.ELECTRON);
  });

  // electron turns up in a monorepo's root devDependencies for reasons unrelated to this app; a
  // tauri.conf.json does not turn up by accident.
  it('prefers tauri when a project somehow has both', () => {
    expect(readShape({ hasTauriConf: true, hasElectronDep: true })).toBe(AppShape.TAURI);
  });
});

describe('what changes for a desktop app', () => {
  // The harmful one. The app's own window is the client, so opening a tab creates a SECOND session
  // that is not the app — the stale-tab false green, arranged on purpose.
  it('never opens a browser', () => {
    for (const shape of [AppShape.ELECTRON, AppShape.TAURI]) {
      expect(policyFor(shape).openBrowser).toBe(false);
    }
    expect(policyFor(AppShape.WEB).openBrowser).toBe(true);
  });

  // Tauri serves its webview from tauri://localhost, which no fetch from outside can reach.
  it('does not gate on an HTTP response', () => {
    expect(policyFor(AppShape.TAURI).requireHttpReady).toBe(false);
    expect(policyFor(AppShape.WEB).requireHttpReady).toBe(true);
  });

  // A cold `tauri dev` compiles Rust before a window exists. A web app's budget would call that dead.
  it('gives the app long enough to build and launch', () => {
    expect(policyFor(AppShape.TAURI).connectBudgetMs).toBeGreaterThan(
      policyFor(AppShape.WEB).connectBudgetMs,
    );
  });

  // A run with no browser and a multi-minute wait looks stuck unless somebody says why.
  it('explains the wait, and names the shell doing it', () => {
    expect(policyFor(AppShape.TAURI).note).toContain('Tauri');
    expect(policyFor(AppShape.ELECTRON).note).toContain('Electron');
    expect(policyFor(AppShape.WEB).note).toBeUndefined();
  });

  it('knows which shapes are desktop', () => {
    expect(isDesktop(AppShape.WEB)).toBe(false);
    expect(isDesktop(AppShape.ELECTRON)).toBe(true);
    expect(isDesktop(AppShape.TAURI)).toBe(true);
  });
});

describe('the origin a tauri webview serves from', () => {
  it('recognises both platforms, because Windows differs', () => {
    expect(isDesktopOrigin('tauri://localhost/index.html')).toBe(true);
    expect(isDesktopOrigin('http://tauri.localhost/')).toBe(true);
  });

  it('does not mistake a dev server for one', () => {
    expect(isDesktopOrigin('http://localhost:1420/')).toBe(false);
  });
});
