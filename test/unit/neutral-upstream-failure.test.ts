import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  Models,
  Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { execute, ExecutionFailure } from "../../src/execution.js";
import {
  createUpstreamFailureDiagnostic,
  createUpstreamFailureFact,
  findUpstreamFailureFact,
  type UpstreamFailureKind,
} from "@luckytoken/provider-contract/diagnostics";

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const model: Model<string> = {
  id: "model", name: "model", api: "test", provider: "fixture",
  baseUrl: "https://fixture.invalid", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10, maxTokens: 10,
};
const context: Context = { messages: [{ role: "user", content: "safe", timestamp: 1 }] };

function failureInput(kind: UpstreamFailureKind) {
  return {
    kind,
    message: `${kind} failed`,
    ...(kind === "http" ? { status: 429 } : {}),
    ...(kind === "transport" ? { phase: "connect" as const } : {}),
  };
}

describe("protocol-neutral upstream failure contract", () => {
  it.each([
    "http", "upstream_stream", "transport", "timeout", "configuration",
    "protocol", "conversion", "callback", "caller_cancellation",
  ] as const)("constructs and deeply freezes %s facts", (kind) => {
    const fact = createUpstreamFailureFact(failureInput(kind));
    expect(fact.kind).toBe(kind);
    expect(Object.isFrozen(fact)).toBe(true);
    expect(Object.isFrozen(fact.headers)).toBe(true);
  });

  it("preserves safe structured facts unchanged through Pi diagnostics and execution", async () => {
    const fact = createUpstreamFailureFact({
      kind: "upstream_stream",
      status: 503,
      statusText: "Unavailable",
      providerType: "abort",
      providerCode: "UPSTREAM_PAUSE",
      message: "provider stopped",
      snapshot: {
        mediaType: "application/json",
        capturedBytes: 64,
        totalBytes: 128,
        sha256: "a".repeat(64),
        truncated: true,
      },
      headers: {
        "x-request-id": "req-safe",
        authorization: "Bearer MUST_NOT_SURVIVE",
      },
      retryable: true,
      attemptCount: 3,
    });
    const failed: AssistantMessage = {
      role: "assistant", api: "test", provider: "fixture", model: "model",
      content: [], usage, stopReason: "error", errorMessage: "fallback only",
      diagnostics: [createUpstreamFailureDiagnostic(fact, 1)], timestamp: 1,
    };
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { type: "error", reason: "error", error: failed } as const;
      },
    } as unknown as AssistantMessageEventStream;
    const models = { streamSimple: () => stream } as unknown as Models;

    try {
      await execute(models, model, context, {});
      throw new Error("expected execution failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionFailure);
      expect((error as ExecutionFailure).failure).toBe(fact);
      expect((error as ExecutionFailure).diagnostic).toBe("fallback only");
    }
    expect(fact.headers).toEqual({ "x-request-id": "req-safe" });
    expect(fact.providerType).toBe("abort");
    expect(fact.kind).not.toBe("caller_cancellation");
  });

  it("rejects or sanitizes invalid status, unsafe fields, headers, text, and snapshots", () => {
    expect(() => createUpstreamFailureFact({ kind: "http", status: 200, message: "bad" })).toThrow("status");
    expect(() => createUpstreamFailureFact({ kind: "http", status: 600, message: "bad" })).toThrow("status");
    expect(() => createUpstreamFailureFact({ kind: "transport", message: "bad" })).toThrow("phase");
    expect(() => createUpstreamFailureFact({
      kind: "protocol", message: "safe", rawBody: "prompt",
    } as never)).toThrow("rawBody");
    const sanitized = createUpstreamFailureFact({
      kind: "protocol",
      message: "Bearer highly-sensitive-value",
      headers: { cookie: "private", "x-request-id": "ok" },
    });
    expect(sanitized.message).toBe("[REDACTED]");
    expect(sanitized.headers).toEqual({ "x-request-id": "ok" });
    expect(sanitized.truncated).toBe(true);
    expect(() => createUpstreamFailureFact({
      kind: "protocol", message: "bad snapshot",
      snapshot: { capturedBytes: 65_537, truncated: false },
    })).toThrow("capturedBytes");
  });

  it("ignores forged diagnostics and keeps diagnostics out of model history", () => {
    const fact = createUpstreamFailureFact({ kind: "protocol", message: "safe" });
    const diagnostic = createUpstreamFailureDiagnostic(fact, 1);
    const forged = { ...diagnostic, details: { failure: { ...fact } } };
    expect(findUpstreamFailureFact([forged])).toBeUndefined();
    expect(context.messages).toEqual([{ role: "user", content: "safe", timestamp: 1 }]);
    expect(JSON.stringify(context)).not.toContain("luckytoken_upstream_failure");
  });
});
