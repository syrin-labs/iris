/**
 * The one thing the daemon cannot know: what the page actually contains.
 *
 * `diagnoseNoSession` in session/no-session-diagnosis.ts already tells the four daemon-side cases
 * apart — a session that came and went, something listening that never dialled, a wired project on
 * the wrong port, nothing listening at all — and its sentence is the one to lead with. None of that
 * requires fetching anything, which is also its limit: the daemon never sees the HTML.
 *
 * So this adds only the page-side fact and nothing else. Whether the SDK is IN what the server
 * returned splits the most common failure of all — a dev server still serving the bundle it built
 * before the build config was edited — from a connect that ran and returned early.
 */

/** What a single fetch of the app's url established. */
export interface PageProbe {
  /** The server answered at all. */
  readonly served: boolean;
  /** The SDK appears in what it answered with. */
  readonly sdkInPage: boolean;
  /**
   * The server ANSWERED and its certificate was refused. A self-signed dev cert is an ordinary
   * local setup, so treating this as "nothing is listening" tells someone to start a server that is
   * already running.
   */
  readonly tlsRefused?: boolean | undefined;
}

export const PageFinding = {
  NOT_SERVED: 'not-served',
  TLS_REFUSED: 'tls-refused',
  SDK_MISSING: 'sdk-missing',
  SDK_PRESENT: 'sdk-present',
} as const;
export type PageFinding = (typeof PageFinding)[keyof typeof PageFinding];

/** Pure, so the mapping is testable without a server or a browser. */
export function readPage(probe: PageProbe): PageFinding {
  if (true === probe.tlsRefused) return PageFinding.TLS_REFUSED;
  if (!probe.served) return PageFinding.NOT_SERVED;
  return probe.sdkInPage ? PageFinding.SDK_PRESENT : PageFinding.SDK_MISSING;
}

/**
 * What the page adds to the daemon's account. Deliberately a sentence to APPEND, not a replacement:
 * the daemon's diagnosis names the fix, and this says what the page looked like when we checked.
 */
export function describePage(finding: PageFinding, url: string): string {
  switch (finding) {
    case PageFinding.NOT_SERVED:
      // Leads with the cause. The break-matrix asserts this phrasing because it is what a reader
      // greps for after a timeout, and "nothing answered" reads as an observation about the check
      // rather than a statement about the machine.
      return `nothing is serving ${url} — the dev server is not up, so the SDK was never given the chance to load.`;
    case PageFinding.TLS_REFUSED:
      return (
        `${url} answered over HTTPS with a certificate this process will not accept, so setup could ` +
        'not read the page. The app itself may be perfectly fine; re-run with ' +
        'NODE_TLS_REJECT_UNAUTHORIZED=0 if you trust this dev certificate, or use the http origin.'
      );
    case PageFinding.SDK_MISSING:
      return (
        `${url} is served, and the SDK is NOT in the page. That is almost always a dev server still ` +
        'serving the bundle it built before the build config was edited: restart it and hard-reload.'
      );
    case PageFinding.SDK_PRESENT:
      return (
        `The SDK IS in the page at ${url} and never dialled the bridge, so it loaded and returned ` +
        'early: a localhost guard, a production-only check, or a bridge port that differs on the two sides.'
      );
  }
}
