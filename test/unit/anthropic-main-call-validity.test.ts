import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  assertAnthropicModelAwareValidity,
  defaultAnthropicModelValidityPolicy,
} from "../../src/protocols/anthropic/representability.js";
import { validateAnthropicSourceRequest } from "../../src/protocols/anthropic/request.js";

const target = {
  id: "target-model",
  name: "Target model",
  api: "openai-completions",
  provider: "target-provider",
  baseUrl: "https://provider.invalid/v1",
  reasoning: true,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 8_192,
} as Model<string>;

function assertValidForTarget(request: Record<string, unknown>): void {
  assertAnthropicModelAwareValidity(
    validateAnthropicSourceRequest({
      model: "client-selector",
      max_tokens: 1_024,
      messages: [{ role: "user", content: "hello" }],
      ...request,
    }),
    target,
    defaultAnthropicModelValidityPolicy,
  );
}

describe("Anthropic main-call validity", () => {
  it.each([
    {
      label: "a zero output-token ceiling that Pi cannot preserve",
      request: { max_tokens: 0 },
      message: /output-token ceiling|max_tokens/iu,
    },
    {
      label: "URL document without a target representation",
      request: {
        messages: [{
          role: "user",
          content: [{
            type: "document",
            source: { type: "url", url: "https://example.test/a.pdf" },
          }],
        }],
      },
      message: /document|model-visible/iu,
    },
  ])("rejects $label before Provider payload projection", ({ request, message }) => {
    expect(() => assertValidForTarget(request)).toThrow(message);
  });

  it("allows server tools and inference geography to reach target disposition", () => {
    const request = validateAnthropicSourceRequest({
      model: "client-selector",
      max_tokens: 1_024,
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      inference_geo: "us",
    });

    expect(() => assertAnthropicModelAwareValidity(
      request,
      target,
      defaultAnthropicModelValidityPolicy,
    )).not.toThrow();
  });
});
