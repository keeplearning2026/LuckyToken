/**
 * Protocol-neutral HTTP header sets owned by the Anthropic Provider Native
 * lane. Both the outbound envelope and the upstream-response filter derive
 * from the same list so a header can never be hop-by-hop on one side and
 * end-to-end on the other.
 */
export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "content-encoding",
]);
