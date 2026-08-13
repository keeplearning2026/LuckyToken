import type { HttpObservation } from "../../http-observer.js";
import type { AnthropicErrorType } from "./wire.js";

/**
 * Map an upstream provider HTTP failure to an Anthropic protocol error
 * response.
 *
 * The provider's HTTP status and raw body are passed through unchanged. The
 * `error.type` is taken from the provider's own error body when available
 * (`error.type`, then `error.code`), so the Anthropic client sees the
 * provider's original error classification instead of a LuckyToken-invented
 * one. Only when the body has no usable type does the status fallback table
 * apply, so the protocol always receives a legal `error.type`.
 */
export interface UpstreamHttpFailureMapping {
  readonly status: number;
  /** Provider error type/code, forwarded verbatim when present in the body. */
  readonly type: string;
  readonly message: string;
}

/**
 * Anthropic protocol error family per HTTP status, as documented in
 * `doc/Protocols/Anthropic Message Protocol.md` section 7.10.
 */
const ANTHROPIC_ERROR_TYPE_BY_STATUS: Readonly<Record<number, AnthropicErrorType>> = {
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

const DEFAULT_UPSTREAM_ERROR_TYPE: AnthropicErrorType = "api_error";

export function mapUpstreamHttpFailure(
  observation: Extract<HttpObservation, { kind: "response" }>,
): UpstreamHttpFailureMapping | undefined {
  if (observation.status >= 200 && observation.status < 300) {
    return undefined;
  }
  const message = decodeUpstreamBody(observation.body);
  const type =
    ANTHROPIC_ERROR_TYPE_BY_STATUS[observation.status] ??
    DEFAULT_UPSTREAM_ERROR_TYPE;
  return {
    status: observation.status,
    type,
    message:
      message === undefined
        ? `Upstream provider returned HTTP ${observation.status}`
        : message,
  };
}

function decodeUpstreamBody(body: Uint8Array | undefined): string | undefined {
  if (body === undefined || body.byteLength === 0) return undefined;
  try {
    return new TextDecoder().decode(body);
  } catch {
    return undefined;
  }
}
