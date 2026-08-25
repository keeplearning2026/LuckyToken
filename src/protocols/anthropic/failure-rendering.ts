import type { UpstreamFailureFact } from "@token/provider-contract/diagnostics";
import type { AnthropicErrorType } from "./wire.js";

export interface AnthropicFailureMapping {
  readonly status: number;
  readonly type: AnthropicErrorType;
  readonly message: string;
  readonly safeHeaders: Readonly<Record<string, string>>;
}

const ERROR_TYPE_BY_STATUS: Readonly<Record<number, AnthropicErrorType>> = {
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

const SAFE_RESPONSE_HEADERS = new Set([
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

const RETRYABLE_TIMEOUT_TYPES: ReadonlySet<AnthropicErrorType> = new Set([
  "timeout_error",
  "overloaded_error",
  "rate_limit_error",
]);

export function requestIdFromFact(fact: UpstreamFailureFact): string | undefined {
  const requestId = fact.headers["request-id"] ?? fact.headers["x-request-id"];
  if (
    typeof requestId === "string" &&
    /^[A-Za-z0-9._:-]{1,256}$/u.test(requestId)
  ) {
    return requestId;
  }
  return undefined;
}

function safeHeadersFromFact(
  fact: UpstreamFailureFact,
): Readonly<Record<string, string>> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(fact.headers)) {
    if (!SAFE_RESPONSE_HEADERS.has(name)) continue;
    safe[name] = value;
  }
  return Object.freeze(safe);
}

export function mapUpstreamFailureFact(
  fact: UpstreamFailureFact,
): AnthropicFailureMapping {
  const fallbackType =
    fact.status === undefined
      ? "api_error"
      : (ERROR_TYPE_BY_STATUS[fact.status] ?? "api_error");
  const message =
    fact.message.length === 0
      ? `Upstream provider failed: ${fact.kind}`
      : fact.message;
  return {
    status: fact.status ?? 502,
    type: fallbackType,
    message,
    safeHeaders: safeHeadersFromFact(fact),
  };
}

export function isRetryableUpstreamFailure(
  fact: UpstreamFailureFact,
): boolean {
  if (fact.retryable === true) return true;
  if (
    fact.status !== undefined &&
    RETRYABLE_TIMEOUT_TYPES.has(ERROR_TYPE_BY_STATUS[fact.status] ?? "api_error")
  ) {
    return true;
  }
  return false;
}
