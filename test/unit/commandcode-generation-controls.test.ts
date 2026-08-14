import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  buildCommandCodeBody,
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
} from "../../src/providers/commandcode-private/provider.js";
import { findCommandCodeModel } from "../../src/providers/commandcode-private/models.js";
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

  it("executes synchronously and omits every deferred variant", () => {
    for (const deferred of [true, false, { window: "15m" }] as const) {
      const value = params({ maxTokens: 20, deferred });
      expect(value).not.toHaveProperty("deferred");
      expect(value.max_tokens).toBe(20);
    }
  });

  it("rejects invalid owned numeric controls", () => {
    expect(() => params({ maxTokens: 0 })).toThrow("positive safe integer");
    expect(() => params({ maxTokens: 20, temperature: Number.NaN })).toThrow(
      "temperature",
    );
  });

  it("preserves the accepted max-token value even when a shared estimate would clamp it", () => {
    const constrainedModel = {
      ...model,
      contextWindow: 5,
      maxTokens: 100,
    };
    const value = buildCommandCodeBody(
      constrainedModel,
      context,
      { maxTokens: 20 },
      createEmptyServerConfig(),
      sessionId,
      {},
    ).body.params as Record<string, unknown>;

    expect(value.max_tokens).toBe(20);
  });

  it("falls back to model.maxTokens when maxTokens is absent", () => {
    const value = params({});
    expect(value.max_tokens).toBe(100);
  });

  it("does not invent a fixed default when model.maxTokens is absent", () => {
    const customModel = { ...model, maxTokens: 100 };
    const value = buildCommandCodeBody(
      customModel,
      context,
      {},
      createEmptyServerConfig(),
      sessionId,
      {},
    ).body.params as Record<string, unknown>;
    expect(value.max_tokens).toBe(100);
  });

  it.each([
    ["minimal", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
  ] as const)(
    "maps default reasoning level %s to CommandCode effort %s",
    (level, effort) => {
      const reasoningModel = {
        ...model,
        reasoning: true,
      };
      const value = buildCommandCodeBody(
        reasoningModel,
        context,
        { maxTokens: 20, reasoning: level },
        createEmptyServerConfig(),
        sessionId,
        {},
      ).body.params as Record<string, unknown>;
      expect(value.reasoning_effort).toBe(effort);
    },
  );

  it.each([
    ["xhigh", "xhigh"],
    ["max", "max"],
  ] as const)(
    "maps model-declared reasoning level %s to CommandCode effort %s",
    (level, effort) => {
      const reasoningModel = {
        ...model,
        reasoning: true,
        thinkingLevelMap: { [level]: level },
      };
      const value = buildCommandCodeBody(
        reasoningModel,
        context,
        { maxTokens: 20, reasoning: level },
        createEmptyServerConfig(),
        sessionId,
        {},
      ).body.params as Record<string, unknown>;
      expect(value.reasoning_effort).toBe(effort);
    },
  );

  it("uses the explicit model thinkingLevelMap when present", () => {
    const mappedModel = {
      ...model,
      reasoning: true,
      thinkingLevelMap: { high: "xhigh" },
    };
    const value = buildCommandCodeBody(
      mappedModel,
      context,
      { maxTokens: 20, reasoning: "high" },
      createEmptyServerConfig(),
      sessionId,
      {},
    ).body.params as Record<string, unknown>;
    expect(value.reasoning_effort).toBe("xhigh");
  });

  it("falls back to the highest supported effort for unsupported levels", () => {
    const strictModel = {
      ...model,
      reasoning: true,
      thinkingLevelMap: { off: null, high: "high", max: "max" },
    };
    for (const level of ["minimal", "low", "medium", "xhigh"] as const) {
      const value = buildCommandCodeBody(
        strictModel,
        context,
        { maxTokens: 20, reasoning: level },
        createEmptyServerConfig(),
        sessionId,
        {},
      ).body.params as Record<string, unknown>;
      expect(value.reasoning_effort, level).toBe("max");
    }
  });

  it("falls back to the highest supported effort even for high", () => {
    const strictModel = {
      ...model,
      reasoning: true,
      thinkingLevelMap: { off: null, max: "max" },
    };
    const value = buildCommandCodeBody(
      strictModel,
      context,
      { maxTokens: 20, reasoning: "high" },
      createEmptyServerConfig(),
      sessionId,
      {},
    ).body.params as Record<string, unknown>;
    expect(value.reasoning_effort).toBe("max");
  });

  it("omits reasoning_effort when reasoning is absent or clamps to off", () => {
    const reasoningModel = { ...model, reasoning: false };
    const absent = buildCommandCodeBody(
      reasoningModel,
      context,
      { maxTokens: 20 },
      createEmptyServerConfig(),
      sessionId,
      {},
    ).body.params as Record<string, unknown>;
    expect(absent).not.toHaveProperty("reasoning_effort");

    const off = buildCommandCodeBody(
      reasoningModel,
      context,
      { maxTokens: 20, reasoning: "high" },
      createEmptyServerConfig(),
      sessionId,
      {},
    ).body.params as Record<string, unknown>;
    expect(off).not.toHaveProperty("reasoning_effort");
  });

  it("clamps unsupported catalog efforts through the Pi model capability", () => {
    const catalogModel = findCommandCodeModel("deepseek/deepseek-v4-flash");
    expect(catalogModel).toBeDefined();

    const low = buildCommandCodeBody(
      catalogModel!,
      context,
      { maxTokens: 20, reasoning: "low" },
      createEmptyServerConfig(),
      sessionId,
      {},
    ).body.params as Record<string, unknown>;
    expect(low.reasoning_effort).toBe("high");

    const xhigh = buildCommandCodeBody(
      catalogModel!,
      context,
      { maxTokens: 20, reasoning: "xhigh" },
      createEmptyServerConfig(),
      sessionId,
      {},
    ).body.params as Record<string, unknown>;
    expect(xhigh.reasoning_effort).toBe("max");
  });

  it.each(["xhigh", "max"] as const)(
    "clamps %s to high when a reasoning model has no explicit effort map",
    (level) => {
      const reasoningModel = { ...model, reasoning: true };
      const value = buildCommandCodeBody(
        reasoningModel,
        context,
        { maxTokens: 20, reasoning: level },
        createEmptyServerConfig(),
        sessionId,
        {},
      ).body.params as Record<string, unknown>;
      expect(value.reasoning_effort).toBe("high");
    },
  );
});
