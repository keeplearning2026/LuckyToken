import type { UpstreamFailureFact } from "@token/provider-contract/diagnostics";

/**
 * Responses-owned error rendering: one complete Response object or one
 * neutral failure fact feeds JSON/SSE rendering. No Provider code is moved
 * here and no string is ever reparsed to recover a status.
 */

/** The fixed safe response-header allowlist. Credentials, cookies, proxy
 *  credentials, and hop-by-hop headers are never forwarded and cannot be
 *  enabled by configuration. */
export const SAFE_RESPONSE_HEADERS = new Set([
  "request-id",
  "retry-after",
  "trace-id",
  "x-request-id",
  "x-trace-id",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
]);

/** Maximum length of a body-derived error message after redaction. */
export const MAX_ERROR_MESSAGE_LENGTH = 1_024;

const ERROR_TYPE_BY_STATUS: Readonly<Record<number, string>> = {
  400: "invalid_request_error",
  401: "authentication_error",
  402: "billing_error",
  403: "permission_error",
  404: "not_found_error",
  409: "conflict_error",
  413: "request_too_large",
  429: "rate_limit_error",
  500: "api_error",
  504: "timeout_error",
  529: "overloaded_error",
};

/** Map a validated protocol-neutral failure fact to the Responses error
 *  envelope fields. The target `type` is derived from the validated status
 *  only; an opaque Provider type/code is preserved in the `code` field and
 *  never moves into `type`. */
export function mapUpstreamFailureFact(
  fact: UpstreamFailureFact,
): {
  readonly status: number;
  readonly type: string;
  readonly code: string | null;
  readonly param: string | null;
  readonly message: string;
  readonly safeHeaders: Readonly<Record<string, string>>;
} {
  const fallbackType =
    fact.status === undefined
      ? "api_error"
      : (ERROR_TYPE_BY_STATUS[fact.status] ?? "api_error");
  const message = redactMessage(fact.message);
  const safeHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(fact.headers)) {
    if (!SAFE_RESPONSE_HEADERS.has(name)) continue;
    safeHeaders[name] = value;
  }
  return {
    status: fact.status ?? 502,
    type: fallbackType,
    code: fact.providerCode ?? null,
    param: null,
    message:
      message.length === 0
        ? `Upstream provider failed: ${fact.kind}`
        : message,
    safeHeaders: Object.freeze(safeHeaders),
  };
}

/** Bound and redact a body-derived error message. Credential-looking
 *  fragments (Bearer tokens, sk-/key-/token-/secret- prefixed values) are
 *  never echoed. */
export function redactMessage(message: string): string {
  const redacted = message
    .replace(/\b(?:bearer|basic)\s+\S+/giu, "[REDACTED]")
    .replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9._-]{8,}\b/giu, "[REDACTED]");
  if (redacted.length <= MAX_ERROR_MESSAGE_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`;
}
