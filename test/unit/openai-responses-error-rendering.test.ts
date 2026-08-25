import { describe, expect, it } from "vitest";

import {
  renderResponsesError,
  renderResponsesErrorResponse,
} from "../../src/protocols/openai-responses/response.js";
import {
  mapUpstreamFailureFact,
  SAFE_RESPONSE_HEADERS,
} from "../../src/protocols/openai-responses/error-rendering.js";
import type { UpstreamFailureFact } from "@token/provider-contract/diagnostics";

describe("OpenAI Responses non-streaming error envelope", () => {
  it("preserves distinct message/type/code/param fields", () => {
    const prepared = renderResponsesError(
      429,
      "rate_limit_error",
      "slow down",
      "rate_limit_exceeded",
      "retry_after_30",
    );
    expect(prepared.status).toBe(429);
    expect(prepared.contentType).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(prepared.body))).toEqual({
      error: {
        message: "slow down",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
        param: "retry_after_30",
      },
    });
  });

  it("defaults code and param to null when absent", () => {
    const prepared = renderResponsesError(400, "invalid_request_error", "bad");
    expect(JSON.parse(new TextDecoder().decode(prepared.body))).toEqual({
      error: {
        message: "bad",
        type: "invalid_request_error",
        code: null,
        param: null,
      },
    });
  });

  it("renders the full Response error envelope from a prepared error", async () => {
    const response = renderResponsesErrorResponse({
      status: 503,
      type: "api_error",
      message: "upstream unavailable",
      code: "UPSTREAM_DOWN",
      param: null,
      safeHeaders: { "x-request-id": "req-1" },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("x-request-id")).toBe("req-1");
    expect(JSON.parse(await response.text())).toEqual({
      error: {
        message: "upstream unavailable",
        type: "api_error",
        code: "UPSTREAM_DOWN",
        param: null,
      },
    });
  });

  it("does not move an upstream code into target type", () => {
    // An upstream provider code stays a code; the target type is derived
    // from the validated status, never from the code string.
    const prepared = renderResponsesError(
      503,
      "api_error",
      "unavailable",
      "UPSTREAM_PAUSE",
      null,
    );
    const body = JSON.parse(
      new TextDecoder().decode(prepared.body),
    ) as { error: { type: string; code: string } };
    expect(body.error.type).toBe("api_error");
    expect(body.error.code).toBe("UPSTREAM_PAUSE");
  });

  it("bounds and redacts body-derived messages", () => {
    const huge = "x".repeat(10_000);
    const prepared = renderResponsesError(502, "api_error", huge);
    const body = JSON.parse(
      new TextDecoder().decode(prepared.body),
    ) as { error: { message: string } };
    expect(body.error.message.length).toBeLessThan(2_048);
    // A credential-looking fragment is redacted, never echoed.
    const secret = renderResponsesError(
      502,
      "api_error",
      "Bearer sk-secret-token-12345678 failed",
    );
    const secretBody = JSON.parse(
      new TextDecoder().decode(secret.body),
    ) as { error: { message: string } };
    expect(secretBody.error.message).not.toContain("sk-secret-token-12345678");
  });
});

describe("OpenAI Responses neutral failure fact → error mapping", () => {
  function fact(input: Partial<UpstreamFailureFact> & { kind: UpstreamFailureFact["kind"] }): UpstreamFailureFact {
    return {
      kind: input.kind,
      message: input.message ?? "provider failed",
      headers: input.headers ?? {},
      truncated: input.truncated ?? false,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.statusText === undefined ? {} : { statusText: input.statusText }),
      ...(input.providerType === undefined ? {} : { providerType: input.providerType }),
      ...(input.providerCode === undefined ? {} : { providerCode: input.providerCode }),
      ...(input.retryable === undefined ? {} : { retryable: input.retryable }),
      ...(input.attemptCount === undefined ? {} : { attemptCount: input.attemptCount }),
    };
  }

  it("maps an HTTP fact to a status-derived type with safe headers", () => {
    const mapping = mapUpstreamFailureFact(
      fact({
        kind: "http",
        status: 429,
        message: "slow down",
        headers: {
          "x-request-id": "req-42",
          "retry-after": "30",
          "set-cookie": "secret=1",
        },
      }),
    );
    expect(mapping.status).toBe(429);
    expect(mapping.type).toBe("rate_limit_error");
    expect(mapping.code).toBeNull();
    expect(mapping.param).toBeNull();
    expect(mapping.safeHeaders).toEqual({
      "x-request-id": "req-42",
      "retry-after": "30",
    });
    expect(mapping.safeHeaders).not.toHaveProperty("set-cookie");
  });

  it("preserves an opaque provider code in the code field, distinct from type", () => {
    const mapping = mapUpstreamFailureFact(
      fact({
        kind: "upstream_stream",
        status: 503,
        providerCode: "UPSTREAM_PAUSE",
        message: "paused",
      }),
    );
    expect(mapping.type).toBe("api_error");
    expect(mapping.code).toBe("UPSTREAM_PAUSE");
  });

  it("keeps type and code distinct for a provider type too", () => {
    const mapping = mapUpstreamFailureFact(
      fact({
        kind: "http",
        status: 502,
        providerType: "invalid_response_error",
        providerCode: "BAD_GATEWAY",
        message: "bad",
      }),
    );
    // The validated status drives the target type; the opaque provider
    // type/code never overwrite it.
    expect(mapping.type).toBe("api_error");
    expect(mapping.code).toBe("BAD_GATEWAY");
  });

  it("falls back to a deterministic message and 502 when no status is available", () => {
    const mapping = mapUpstreamFailureFact(
      fact({ kind: "timeout", message: "timed out" }),
    );
    expect(mapping.status).toBe(502);
    expect(mapping.message).toBe("timed out");
  });

  it("never forwards credentials/cookies/hop-by-hop headers", () => {
    const mapping = mapUpstreamFailureFact(
      fact({
        kind: "http",
        status: 500,
        message: "boom",
        headers: {
          authorization: "Bearer secret",
          cookie: "session=1",
          connection: "close",
          "x-request-id": "req-safe",
          "ratelimit-limit": "10",
        },
      }),
    );
    expect(mapping.safeHeaders).toEqual({
      "x-request-id": "req-safe",
      "ratelimit-limit": "10",
    });
  });

  it("exposes the fixed safe-header allowlist", () => {
    expect(SAFE_RESPONSE_HEADERS).toContain("request-id");
    expect(SAFE_RESPONSE_HEADERS).toContain("x-request-id");
    expect(SAFE_RESPONSE_HEADERS).toContain("retry-after");
    expect(SAFE_RESPONSE_HEADERS).toContain("ratelimit-limit");
    expect(SAFE_RESPONSE_HEADERS).not.toContain("authorization");
    expect(SAFE_RESPONSE_HEADERS).not.toContain("cookie");
    expect(SAFE_RESPONSE_HEADERS).not.toContain("connection");
    expect(SAFE_RESPONSE_HEADERS).not.toContain("set-cookie");
  });
});
