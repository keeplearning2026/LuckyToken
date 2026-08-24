import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { UnsupportedFeature } from "../../src/protocols/anthropic/failures.js";
import {
  assertAnthropicModelAwareValidity,
  type AnthropicModelValidityPolicy,
} from "../../src/protocols/anthropic/representability.js";
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

function policy(imageFidelity: boolean): AnthropicModelValidityPolicy {
  return {
    revision: "test-policy-v1",
    hasCertifiedImageFidelity: () => imageFidelity,
  };
}

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
        policy(false),
      ),
    ).not.toThrow();
    expect(() =>
      assertAnthropicModelAwareValidity(
        request,
        fixtureModel(["text"], true),
        policy(false),
      ),
    ).not.toThrow();
  });

  it("requires both model image input capability and a certified fidelity path", () => {
    const request = validateAnthropicSourceRequest({
      model: "model",
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AA==" },
            },
          ],
        },
      ],
    });

    expect(() =>
      assertAnthropicModelAwareValidity(
        request,
        fixtureModel(["text"]),
        policy(true),
      ),
    ).toThrow(UnsupportedFeature);
    expect(() =>
      assertAnthropicModelAwareValidity(
        request,
        fixtureModel(["text", "image"]),
        policy(false),
      ),
    ).toThrow(UnsupportedFeature);
    expect(() =>
      assertAnthropicModelAwareValidity(
        request,
        fixtureModel(["text", "image"]),
        policy(true),
      ),
    ).not.toThrow();
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
    const resolvedModel = fixtureModel();

    expect(() =>
      assertAnthropicModelAwareValidity(
        request,
        resolvedModel,
        policy(false),
      ),
    ).not.toThrow();
  });
});
