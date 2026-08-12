import type { Model } from "@earendil-works/pi-ai";

import { describe, expect, it } from "vitest";

import { renderResponsesModelsList } from "../../src/protocols/openai-responses/models.js";

function model(id: string, provider: string): Model<string> {
  return {
    id,
    name: id,
    api: "commandcode-private",
    provider,
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
}

describe("OpenAI Responses model discovery", () => {
  it("exposes every model as a provider/model_id selector", () => {
    const list = renderResponsesModelsList(
      {
        getModels: () => [
          model("deepseek/deepseek-v4-flash", "commandcode-private"),
          model("gpt-5.6-luna", "commandcode-private"),
          model("claude-3-7-sonnet", "anthropic"),
        ],
      },
      1_786_400_000,
    );

    expect(list.object).toBe("list");
    expect(list.data).toEqual([
      {
        id: "commandcode-private/deepseek/deepseek-v4-flash",
        object: "model",
        created: 1_786_400_000,
        owned_by: "commandcode-private",
      },
      {
        id: "commandcode-private/gpt-5.6-luna",
        object: "model",
        created: 1_786_400_000,
        owned_by: "commandcode-private",
      },
      {
        id: "anthropic/claude-3-7-sonnet",
        object: "model",
        created: 1_786_400_000,
        owned_by: "anthropic",
      },
    ]);
  });

  it("produces ids that resolve through the selector contract", () => {
    const list = renderResponsesModelsList(
      {
        getModels: () => [model("deepseek/deepseek-v4-flash", "commandcode-private")],
      },
      0,
    );
    const id = list.data[0]?.id;
    // The id must round-trip through the selector format: provider before
    // the first slash, model id (which may contain slashes) after it.
    const slashIndex = id?.indexOf("/") ?? -1;
    expect(id?.slice(0, slashIndex)).toBe("commandcode-private");
    expect(id?.slice(slashIndex + 1)).toBe("deepseek/deepseek-v4-flash");
  });
});
