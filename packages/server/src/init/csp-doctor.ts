/**
 * `doctor`'s web CSP check — the sibling of the desktop one next door.
 *
 * The desktop findings exist because a Tauri app with the default CSP runs perfectly and never
 * connects. The WEB version of that failure had no check at all, and it arrived twice in one batch
 * of field reports: two Next apps where `init` printed success for every step, the SDK mounted, the
 * dial URL was right, and the browser silently refused the WebSocket because `connect-src` excluded
 * the bridge. The violation is reported in the browser's console and nowhere else, so every check on
 * this side stayed green while the app was permanently unreachable.
 *
 * Reads the files a CSP is actually written in, by name — a full source scan would be slower and
 * would find policy strings in test fixtures and documentation.
 */

import { cspConnectSrcProblem, devCspAddition } from './csp-check.js';

/** Read a project-relative file, or undefined when it is absent/unreadable. */
type ReadFile = (relative: string) => string | undefined;

interface CspDiagnosis {
  /** Which file to look at. */
  file: string;
  /** What is wrong, in one line. */
  problem: string;
  /** Exactly what to add — copy-pasteable, with the port actually in use. */
  fix: string;
}

/**
 * The places a Content-Security-Policy gets written in a JS app.
 *
 * Next config and middleware cover `headers()` and the edge-middleware style; the layouts and the
 * plain `index.html` cover the `<meta http-equiv>` style. Both reported cases were in this list.
 */
export const CSP_FILES: readonly string[] = [
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'middleware.ts',
  'middleware.js',
  'src/middleware.ts',
  'app/layout.tsx',
  'app/layout.js',
  'pages/_document.tsx',
  'pages/_document.js',
  'index.html',
  'public/index.html',
  // Vite puts the entry HTML at the project root; electron-vite and Tauri put the RENDERER's one
  // under src/. MarkText declares its policy in `src/renderer/index.html`, and a desktop app is the
  // likeliest place to meet a strict CSP at all — Electron's own security guidance asks for one.
  'src/index.html',
  'src/renderer/index.html',
  'vercel.json',
  'netlify.toml',
];

export function diagnoseWebCsp(
  read: ReadFile,
  port: number,
  alsoCheck: readonly string[] = [],
): CspDiagnosis[] {
  const findings: CspDiagnosis[] = [];
  for (const file of [...alsoCheck, ...CSP_FILES]) {
    const source = read(file);
    if (source === undefined) continue;
    const problem = cspConnectSrcProblem(source, port);
    if (problem === undefined) continue;
    findings.push({ file, problem, fix: devCspAddition(port) });
  }
  return findings;
}
