import type { HttpObservation } from "../http-observer.js";

/**
 * Map an upstream provider HTTP failure to a protocol-agnostic error shape.
 *
 * Only non-2xx `response` observations are provider HTTP failures. The
 * provider's own error type/code is forwarded verbatim when present
 * (`error.type`, then `error.code`); otherwise a status fallback applies.
 */
export interface UpstreamHttpFailureMapping {
  readonly status: number;
  readonly type: string;
  readonly message: string;
}

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

export function mapUpstreamHttpFailure(
  observation: Extract<HttpObservation, { kind: "response" }>,
): UpstreamHttpFailureMapping | undefined {
  if (observation.status >= 200 && observation.status < 300) {
    return undefined;
  }
  const message = decodeUpstreamBody(observation.body);
  const type =
    extractUpstreamErrorType(message) ??
    ERROR_TYPE_BY_STATUS[observation.status] ??
    "api_error";
  return {
    status: observation.status,
    type,
    message:
      message === undefined
        ? `Upstream provider returned HTTP ${observation.status}`
        : message,
  };
}

function extractUpstreamErrorType(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const error = (parsed as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return undefined;
  }
  const candidate = (error as Record<string, unknown>).type ?? (error as Record<string, unknown>).code;
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  return candidate;
}

function decodeUpstreamBody(body: Uint8Array | undefined): string | undefined {
  if (body === undefined || body.byteLength === 0) return undefined;
  try {
    return new TextDecoder().decode(body);
  } catch {
    return undefined;
  }
}
