import type { RedactionConfig } from '@reticlehq/core';

/**
 * What `reticle.connect()` accepts.
 *
 * Split out of reticle.ts when that file crossed the 600-line cap - the same move `session-info.ts`
 * made for the server's Session. A pure description of the SDK's public entry contract has no reason
 * to live inside the class that happens to consume it, and separating them keeps the surface every
 * integrating app actually reads reviewable on its own.
 */
export interface ReticleConnectOptions {
  /** WS endpoint of the local bridge. Defaults to ws://localhost:<port><path>. */
  url?: string;
  /** Human-friendly session label so the agent can target the right tab. */
  session?: string;
  /**
   * Stable project identity, normally stamped by the build plugin (e.g. "acme-web-9f3c1d"). Lets the
   * agent scope to the right app even when its dev server boots on an unexpected port. Optional.
   */
  projectId?: string;
  /**
   * Browser/bridge pairing token. Required whenever the daemon has one, which is the ordinary case:
   * it auto-provisions `~/.reticle/pairing-token` on first start and then refuses a hello without it,
   * including on localhost. Non-localhost additionally needs `allowNonLocalhost`.
   */
  token?: string;
  /** Explicitly allow Reticle on a non-localhost page or bridge. Requires token. */
  allowNonLocalhost?: boolean;
  /**
   * Escape hatch for the production backstop. Reticle is dev-only and refuses to connect when the
   * build reports NODE_ENV=production (an SSR healthcheck or a prod bundle opened locally would
   * otherwise activate). The real fix is to gate the import behind `import.meta.env.DEV` so it's
   * tree-shaken out; this flag only exists for the rare intentional prod diagnostic.
   */
  allowInProduction?: boolean;
  /** Show a small in-page status chip (connection + event count). */
  overlay?: boolean;
  /**
   * Capture request/response bodies on net.request events (dev-only; text-like content only,
   * sensitive keys redacted, per-body capped). Off by default - bodies cost tokens and can carry PII.
   */
  captureNetworkBodies?: boolean;
  /**
   * Make Reticle's OWN presenter visible to snapshots and queries. CONTRIBUTORS ONLY.
   *
   * The presenter is hidden from every tool by design, for a good reason: an agent that can drive
   * Reticle's own interface can fabricate its own impact report, and Reticle chrome in a snapshot is
   * noise in every other app on earth.
   *
   * The cost of that rule is that a HUD change is the only kind of change Reticle cannot be used to
   * check — the panel rendering it is invisible to everything that could look at it. This hatch
   * exists for exactly that case: the app under test IS Reticle. It reports itself in the app's
   * capabilities, so a verdict drawn with it open can never be mistaken for an ordinary one.
   */
  exposePresenter?: boolean;
  /**
   * The project root, so source paths report repo-relative instead of absolute.
   *
   * React's `_debugSource.fileName` is absolute; the babel stamp is repo-relative. Build plugins that
   * can `define` a global set it themselves; frameworks that cannot (Next passes it through env,
   * Astro through its own config) hand it here instead. Taking it as a connect OPTION is what keeps
   * the generated app-side code plain JavaScript - the previous shape made the caller assign a global,
   * and the TypeScript cast that needed shipped into a `.jsx` file and broke the build.
   */
  root?: string;
  /**
   * The SDK's own package version, so a version-skewed pair against the daemon can name itself
   * rather than surfacing as a bare `-32000`. Build plugins supply it automatically; pass it here
   * only for a hand-wired connect that has no plugin.
   */
  sdkVersion?: string;
  /** Presenter mode: glow border, animated cursor, click/hover effects, narration HUD. */
  present?: boolean;
  /** Per-action pacing (ms) in presenter mode so a human can follow. Default 450. */
  pace?: number;
  /** Min ms each narration line stays visible before the next replaces it (presenter). Default 3000. */
  narrationDwellMs?: number;
  /**
   * Border behavior in presenter mode: 'session' (default) persists the border for the whole
   * session; 'busy' restores the fade-after-idle behavior.
   */
  border?: 'session' | 'busy';
  /** Max accumulated activity-log rows before the oldest are pruned (presenter). Default 50. */
  logMax?: number;
  /**
   * Mount the floating human-recorder toolbar (Record/Stop/Annotate).
   * Default off - purely additive, dev-only.
   */
  recorder?: boolean;
  /**
   * Mount the page annotator: expanding the HUD enters click-to-annotate mode, and Reticle emits
   * a HUMAN_MARK the agent drains via reticle_review. Defaults to ON with the presenter; pass
   * `annotate: false` to suppress.
   */
  annotate?: boolean;
  /** Live-control: overridable ended-border fade delay (native timer). Default 4000. */
  endedFadeMs?: number;
  /** Session auto-end after this much agent idle (presenter). Default 5min; agent-tunable via reticle_session. */
  idleEndMs?: number;
  /**
   * Extend the redaction rules with your app's own vocabulary.
   *
   * ```ts
   * reticle.connect({
   *   redact: {
   *     keys: ['deviceSecretRef', /^partner[-_]?code$/i],  // also redact these
   *     allow: ['designToken'],                            // stop redacting this false positive
   *   },
   * });
   * ```
   *
   * Additive only - there is no way to replace the built-in rule, because a config that could would
   * eventually ship an app that leaks. `keys` strings match a key name exactly (case-insensitively);
   * a RegExp is tested against it. `allow` exempts a key from the DEFAULT rule and loses to `keys`.
   *
   * Literal `keys` strings also cross the bridge, so the daemon redacts them on the driven path,
   * where request bodies are captured raw from the network stack and never pass through this SDK.
   * RegExp entries and `allow` do NOT cross - see docs/usage.md ("Extending the redaction rules") for why, and what that means.
   */
  redact?: RedactionConfig;
}
