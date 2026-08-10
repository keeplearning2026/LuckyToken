import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  buildCommandCodeBody,
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
} from "../../src/providers/commandcode-private/provider.js";
import { createEmptyServerConfig } from "../../src/providers/commandcode-private/project.js";

const model: Model<typeof commandCodePrivateApiId> = {
  id: "model",
  name: "model",
  api: commandCodePrivateApiId,
  provider: commandCodePrivateProviderId,
  baseUrl: "https://fixture.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 100,
};
const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
};
const sessionId = "00000000-0000-4000-8000-000000000082";

function params(options: SimpleStreamOptions): Record<string, unknown> {
  return buildCommandCodeBody(
    model,
    context,
    options,
    createEmptyServerConfig(),
    sessionId,
    {},
  ).body.params as Record<string, unknown>;
}

describe("CommandCode generation control mapping", () => {
  it("keeps explicitly ignored Pi controls off the wire", () => {
    const value = params({
      maxTokens: 20,
      reasoning: "high",
      samplingParams: { top_p: 0.5 },
      cacheRetention: "long",
      transport: "websocket",
      websocketConnectTimeoutMs: 20,
      thinkingBudgets: { high: 10 },
      env: { VALUE: "not-wire" },
    });

    expect(value).toMatchObject({ max_tokens: 20, stream: true });
    expect(value).not.toHaveProperty("reasoning_effort");
    for (const key of [
      "samplingParams",
      "cacheRetention",
      "transport",
      "websocketConnectTimeoutMs",
      "thinkingBudgets",
      "env",
    ]) {
      expect(value).not.toHaveProperty(key);
    }
  });

  it("rejects deferred execution and invalid owned numeric controls", () => {
    expect(() => params({ maxTokens: 20, deferred: true })).toThrow("deferred");
    expect(() => params({ maxTokens: 0 })).toThrow("positive safe integer");
    expect(() => params({ maxTokens: 20, temperature: Number.NaN })).toThrow(
      "temperature",
    );
  });
});
