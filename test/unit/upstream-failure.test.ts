import { describe, expect, it } from "vitest";

import type { HttpObservation } from "../../src/http-observer.js";
import { mapUpstreamHttpFailure } from "../../src/protocols/anthropic/upstream-failure.js";

function responseObservation(
  status: number,
  body?: Uint8Array,
): Extract<HttpObservation, { kind: "response" }> {
  return {
    kind: "response",
    status,
    statusText: `status ${status}`,
    headers: new Headers(),
    ...(body === undefined ? {} : { body }),
  };
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("mapUpstreamHttpFailure", () => {
  it.each([
    [400, "invalid_request_error"],
    [401, "authentication_error"],
    [402, "billing_error"],
    [403, "permission_error"],
    [404, "not_found_error"],
    [409, "conflict_error"],
    [413, "request_too_large"],
    [429, "rate_limit_error"],
    [500, "api_error"],
    [504, "timeout_error"],
    [529, "overloaded_error"],
  ] as const)(
    "maps HTTP %i to Anthropic error type %s",
    (status, type) => {
      const mapping = mapUpstreamHttpFailure(responseObservation(status));
      expect(mapping).toEqual({
        status,
        type,
        message: `Upstream provider returned HTTP ${status}`,
      });
    },
  );

  it("forwards the upstream body as the message", () => {
    const body = utf8('{"error":{"message":"rate limited","type":"rate_limit"}}');
    const mapping = mapUpstreamHttpFailure(responseObservation(429, body));
    expect(mapping?.message).toBe(
      '{"error":{"message":"rate limited","type":"rate_limit"}}',
    );
  });

  it("uses the provider's own error.type from the body verbatim", () => {
    const body = utf8('{"error":{"message":"quota","type":"insufficient_quota"}}');
    const mapping = mapUpstreamHttpFailure(responseObservation(429, body));
    expect(mapping?.type).toBe("insufficient_quota");
    expect(mapping?.status).toBe(429);
  });

  it("uses the provider's own error.code from the body when type is absent", () => {
    const body = utf8('{"error":{"code":"RATE_LIMITED","message":"slow down"}}');
    const mapping = mapUpstreamHttpFailure(responseObservation(429, body));
    expect(mapping?.type).toBe("RATE_LIMITED");
    expect(mapping?.message).toBe(
      '{"error":{"code":"RATE_LIMITED","message":"slow down"}}',
    );
  });

  it("falls back to the status table when the body has no usable type", () => {
    const body = utf8("not json at all");
    const mapping = mapUpstreamHttpFailure(responseObservation(429, body));
    expect(mapping?.type).toBe("rate_limit_error");
  });

  it("returns undefined for a successful response", () => {
    expect(mapUpstreamHttpFailure(responseObservation(200))).toBeUndefined();
  });

  it("falls back to api_error for unknown statuses", () => {
    const mapping = mapUpstreamHttpFailure(responseObservation(418));
    expect(mapping?.type).toBe("api_error");
    expect(mapping?.status).toBe(418);
  });

  it("uses a fallback message when no body is present", () => {
    const mapping = mapUpstreamHttpFailure(responseObservation(503));
    expect(mapping?.message).toBe("Upstream provider returned HTTP 503");
  });
});
