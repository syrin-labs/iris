/**
 * URL redaction moved to `@reticlehq/core` so the driven path can apply the same rule.
 *
 * The heuristic is a property of the wire, not of the page: the server builds NET_DETAIL from URLs it
 * reads straight off the network stack, and those need redacting by exactly this rule rather than by a
 * second copy of it. Re-exported here because this module's name is where the SDK's own callers look.
 */
export { netUrlFields, redactUrl } from '@reticlehq/core';
