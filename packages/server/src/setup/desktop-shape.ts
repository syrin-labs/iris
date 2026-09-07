/**
 * How a desktop app differs from a web app, for the phases that run after the files are written.
 *
 * `init` already understands Electron and Tauri when it writes files: desktop-doctor.ts checks the
 * Tauri CSP for a blocked bridge or IPC, the Electron preload, the capture helper. The runtime
 * phases did not, and they made three web-shaped assumptions that are wrong here — one of them
 * actively harmful.
 *
 * 1. **Do not open a browser.** The app's own window IS the client. Opening a tab creates a SECOND
 *    session that is not the app, and the session picker would then have to choose between them —
 *    which is exactly the stale-tab false green, arranged deliberately.
 * 2. **Do not wait for an HTTP port.** Tauri serves `tauri://localhost` (`http://tauri.localhost`
 *    on Windows) from inside the webview; there is nothing for `fetch` to probe. Electron under
 *    electron-vite does serve a renderer over HTTP, but the window is what matters, not the port.
 * 3. **Wait for the app to launch instead.** `tauri dev` builds Rust before a window appears, which
 *    is minutes on a cold cache, so the budget has to be the app's, not a web app's.
 */

/** What kind of thing setup is about to run. */
export const AppShape = {
  WEB: 'web',
  ELECTRON: 'electron',
  TAURI: 'tauri',
} as const;
export type AppShape = (typeof AppShape)[keyof typeof AppShape];

export const isDesktop = (shape: AppShape): boolean => AppShape.WEB !== shape;

/** Files and dependencies that name the shell, read through an injected reader. */
interface ShapeEvidence {
  /** `src-tauri/tauri.conf.json` exists. */
  readonly hasTauriConf: boolean;
  /** `electron` is a dependency or devDependency. */
  readonly hasElectronDep: boolean;
}

/**
 * Which shell this is.
 *
 * Tauri wins when both are present: a project with a Tauri config is a Tauri app whatever else it
 * has installed, and electron sometimes appears in a monorepo's root devDependencies.
 */
export function readShape(evidence: ShapeEvidence): AppShape {
  if (evidence.hasTauriConf) return AppShape.TAURI;
  if (evidence.hasElectronDep) return AppShape.ELECTRON;
  return AppShape.WEB;
}

/** A Tauri webview's own origin, which no HTTP probe from outside can reach. */
const TAURI_ORIGINS = ['tauri://localhost', 'http://tauri.localhost'] as const;

export function isDesktopOrigin(url: string): boolean {
  return TAURI_ORIGINS.some((origin) => url.startsWith(origin));
}

/**
 * How the phases should behave for this shape.
 *
 * Returned as data rather than branched at each call site, so the differences are visible in one
 * place and testable without a desktop runtime.
 */
interface ShapePolicy {
  /** Open a browser at the url. False for desktop: the app window is already the client. */
  readonly openBrowser: boolean;
  /** Require an HTTP response before looking for a session. */
  readonly requireHttpReady: boolean;
  /** How long the app gets to produce a session, which for Tauri includes a Rust build. */
  readonly connectBudgetMs: number;
  /** Said out loud, because a desktop run looks stuck if nobody explains the wait. */
  readonly note: string | undefined;
}

const WEB_CONNECT_MS = 120_000;
/** A cold `tauri dev` compiles the Rust side before a window exists. */
const DESKTOP_CONNECT_MS = 10 * 60_000;

export function policyFor(shape: AppShape): ShapePolicy {
  if (AppShape.WEB === shape) {
    return {
      openBrowser: true,
      requireHttpReady: true,
      connectBudgetMs: WEB_CONNECT_MS,
      note: undefined,
    };
  }
  return {
    openBrowser: false,
    requireHttpReady: false,
    connectBudgetMs: DESKTOP_CONNECT_MS,
    note:
      AppShape.TAURI === shape
        ? 'Tauri app: not opening a browser, because its own window is the client. A cold `tauri dev` builds the Rust side first, so the window can take minutes to appear.'
        : 'Electron app: not opening a browser, because its own window is the client. Waiting for the app to launch and dial in.',
  };
}
