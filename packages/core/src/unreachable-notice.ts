/**
 * The one phrase in the page's unreachable warning that the daemon parses.
 *
 * A page whose websocket never opened logs its own diagnosis, and the daemon that leased that page
 * reads the address back out of it — the only way either side can name a port mismatch, since the
 * page cannot see the daemon and the daemon never saw the dial.
 *
 * That makes the message a WIRE FORMAT between two packages that must not import each other:
 * `@reticlehq/browser` writes it into a console line, `@reticlehq/server` matches it. Nothing else
 * connects them, so a reworded sentence would break the match with no type error, no failing test in
 * either package, and no symptom except the lease hint quietly going back to guessing.
 *
 * So the prefix lives here, at the bottom of the graph, where a shared contract belongs. Both sides
 * are pinned to it by test.
 */

/** Prefix of the page's unreachable warning. The address follows, then a period. */
export const UNREACHABLE_NOTICE_PREFIX = '[Reticle] this page could not open a websocket to ';

/** Matches the notice and captures the address the page tried. */
export function unreachableUrlIn(text: string): string | undefined {
  if (!text.startsWith(UNREACHABLE_NOTICE_PREFIX)) return undefined;
  const rest = text.slice(UNREACHABLE_NOTICE_PREFIX.length);
  const end = rest.indexOf('. ');
  const url = 0 > end ? rest : rest.slice(0, end);
  return 0 === url.length ? undefined : url;
}
