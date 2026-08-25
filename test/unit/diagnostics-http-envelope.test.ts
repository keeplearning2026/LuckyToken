import { describe, expect, it } from "vitest";

import { encodeSafeHttpEnvelope } from "../../src/diagnostics/http-envelope.js";

function decode(bytes: Uint8Array | undefined): Record<string, unknown> {
  expect(bytes).toBeDefined();
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

describe("safe diagnostic HTTP envelopes", () => {
  it("keeps protocol-relevant metadata without credential-bearing headers or URL credentials", () => {
    const headers = new Headers({
      accept: "application/json",
      authorization: "Bearer never-persist-this",
      cookie: "session=never-persist-this",
      "content-type": "application/json",
      "x-request-id": "request-123",
      "x-unknown-secret": "never-persist-this",
    });

    const envelope = decode(encodeSafeHttpEnvelope({
      method: "POST",
      url: "https://user:password@example.test/v1/responses?api-version=2026-01-01&api_key=never-persist-this&unknown=never-persist-this",
      headers,
    }));

    expect(envelope).toMatchObject({
      schema: "Token.diagnostics.safe_http_envelope.v1",
      method: "POST",
      url: "https://example.test/v1/responses?api-version=2026-01-01&api_key=%5BREDACTED%5D&unknown=%5BREDACTED%5D",
      headerPolicy: "allowlist-v1",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-request-id": "request-123",
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("never-persist-this");
    expect(JSON.stringify(envelope)).not.toContain("password");
    expect(envelope.omittedHeaderNames).toEqual([
      "authorization",
      "cookie",
      "x-unknown-secret",
    ]);
  });

  it("records response status while bounding untrusted values", () => {
    const envelope = decode(encodeSafeHttpEnvelope({
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers({
        "content-type": "application/json",
        "retry-after": "10",
        "x-request-id": "x".repeat(20_000),
      }),
    }));

    expect(envelope).toMatchObject({
      status: 429,
      statusText: "Too Many Requests",
      headerPolicy: "allowlist-v1",
      headers: {
        "content-type": "application/json",
        "retry-after": "10",
      },
    });
    expect(envelope.truncatedHeaderNames).toEqual(["x-request-id"]);
    expect(encodeSafeHttpEnvelope({
      headers: {
        *entries() {
          throw new Error("hostile headers");
        },
      } as unknown as Headers,
    })).toBeUndefined();
  });
});
