import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { UnsupportedFeature } from "../../src/protocols/anthropic/failures.js";
import { assertAnthropicModelAwareValidity } from "../../src/protocols/anthropic/representability.js";
import { validateAnthropicSourceRequest } from "../../src/protocols/anthropic/request.js";

function fixtureModel(
  input: Array<"text" | "image"> = ["text"],
  reasoning = false,
): Model<string> {
  return {
    id: "name-that-must-not-drive-policy",
    name: "fixture",
    api: "fixture",
    provider: "fixture",
    baseUrl: "https://fixture.test",
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
}

const base64ImageMessage = {
  role: "user",
  content: [
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AA==" },
    },
  ],
};

describe("Anthropic model-aware validity", () => {
  it("allows historical thinking to fall back visibly on a non-reasoning model", () => {
    const request = validateAnthropicSourceRequest({
      model: "model",
      max_tokens: 32,
      messages: [
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "reasoning", signature: "opaque" },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: "follow up" },
      ],
    });

    expect(() =>
      assertAnthropicModelAwareValidity(
        request,
        fixtureModel(["text"], false),
      ),
    ).not.toThrow();
    expect(() =>
      assertAnthropicModelAwareValidity(
        request,
        fixtureModel(["text"], true),
      ),
    ).not.toThrow();
  });

  it("accepts image input when and only when the resolved model declares it", () => {
    const request = validateAnthropicSourceRequest({
      model: "model",
      max_tokens: 32,
      messages: [base64ImageMessage],
    });

    expect(() =>
      assertAnthropicModelAwareValidity(
        request,
        fixtureModel(["text", "image"]),
      ),
    ).not.toThrow();
    expect(() =>
      assertAnthropicModelAwareValidity(request, fixtureModel(["text"])),
    ).toThrow(UnsupportedFeature);
    expect(() =>
      assertAnthropicModelAwareValidity(request, fixtureModel(["text"])),
    ).toThrow(/does not declare image input/u);
  });

  it("allows final assistant content to be sent as ordinary history", () => {
    const request = validateAnthropicSourceRequest({
      model: "model",
      max_tokens: 32,
      messages: [
        { role: "user", content: "choose" },
        { role: "assistant", content: "answer: " },
      ],
    });

    expect(() =>
      assertAnthropicModelAwareValidity(request, fixtureModel()),
    ).not.toThrow();
  });
});
