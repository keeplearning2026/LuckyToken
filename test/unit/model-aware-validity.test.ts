import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { InvalidRequest, UnsupportedFeature } from "../../src/protocols/anthropic/failures.js";
import type { ResolvedAnthropicSourceProfile } from "../../src/protocols/anthropic/profile.js";
import {
  assertAnthropicModelAwareValidity,
  type AnthropicModelValidityPolicy,
} from "../../src/protocols/anthropic/representability.js";
import { validateAnthropicSourceRequest } from "../../src/protocols/anthropic/request.js";

const profile: ResolvedAnthropicSourceProfile = {
  version: "2023-06-01",
  betas: new Set(),
  userProfileIdPresent: false,
  unclassifiedAnthropicHeaders: [],
};

function fixtureModel(input: Array<"text" | "image"> = ["text"]): Model<string> {
  return {
    id: "name-that-must-not-drive-policy",
    name: "fixture",
    api: "fixture",
    provider: "fixture",
    baseUrl: "https://fixture.test",
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
}

function policy(
  prefill: "allowed" | "forbidden" | "unknown",
  imageFidelity: boolean,
): AnthropicModelValidityPolicy {
  return {
    revision: "test-policy-v1",
    classifyFinalAssistantPrefill: vi.fn(() => prefill),
    hasCertifiedImageFidelity: vi.fn(() => imageFidelity),
  };
}

describe("Anthropic model-aware validity", () => {
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
        profile,
        policy("unknown", true),
      ),
    ).toThrow(UnsupportedFeature);
    expect(() =>
      assertAnthropicModelAwareValidity(
        request,
        fixtureModel(["text", "image"]),
        profile,
        policy("unknown", false),
      ),
    ).toThrow(UnsupportedFeature);
    expect(() =>
      assertAnthropicModelAwareValidity(
        request,
        fixtureModel(["text", "image"]),
        profile,
        policy("unknown", true),
      ),
    ).not.toThrow();
  });

  it("maps prefill policy outcomes without guessing from model identity", () => {
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
        profile,
        policy("forbidden", false),
      ),
    ).toThrow(InvalidRequest);
    expect(() =>
      assertAnthropicModelAwareValidity(
        request,
        resolvedModel,
        profile,
        policy("allowed", false),
      ),
    ).toThrow(UnsupportedFeature);
    expect(() =>
      assertAnthropicModelAwareValidity(
        request,
        resolvedModel,
        profile,
        policy("unknown", false),
      ),
    ).toThrow(UnsupportedFeature);
  });
});
