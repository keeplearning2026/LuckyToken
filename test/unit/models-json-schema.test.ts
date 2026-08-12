import { describe, expect, it } from "vitest";

import { ModelConfig } from "../../src/providers/models-json-schema.js";

describe("ModelConfig (extracted from Pi coding-agent)", () => {
  it("parses a provider with the full Pi schema", async () => {
    const config = ModelConfig.parse(
      JSON.stringify({
        providers: {
          "my-anthropic": {
            name: "My Anthropic",
            baseUrl: "https://gateway.example.com",
            api: "anthropic-messages",
            apiKey: "sk-test",
            headers: { "x-custom": "v" },
            compat: { supportsStrictTools: true },
            models: [
              {
                id: "claude-sonnet",
                name: "Claude Sonnet",
                reasoning: true,
                thinkingLevelMap: { high: "high", max: "max" },
                input: ["text", "image"],
                cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
                contextWindow: 200000,
                maxTokens: 64000,
                samplingParams: { temperature: 0.7 },
                headers: { "x-model": "m" },
                compat: { supportsStrictTools: true },
              },
            ],
          },
        },
      }),
    );
    expect(config.getError()).toBeUndefined();
    const provider = config.getProvider("my-anthropic");
    expect(provider?.baseUrl).toBe("https://gateway.example.com");
    expect(provider?.models?.[0]?.id).toBe("claude-sonnet");
    expect(provider?.models?.[0]?.thinkingLevelMap?.max).toBe("max");
  });

  it("strips comments and trailing commas like Pi", async () => {
    const config = ModelConfig.parse(
      `{
        // user comment
        "providers": {
          "p": {
            "baseUrl": "https://x.example.com",
            "api": "anthropic-messages",
            "models": [{ "id": "m", },],
          },
        },
      }`,
    );
    expect(config.getError()).toBeUndefined();
    expect(config.getProvider("p")?.models?.[0]?.id).toBe("m");
  });

  it("reports schema errors with a path", () => {
    const config = ModelConfig.parse(
      JSON.stringify({
        providers: {
          p: {
            baseUrl: "https://x.example.com",
            api: "anthropic-messages",
            models: [{ id: "" }], // empty id violates minLength 1
          },
        },
      }),
    );
    expect(config.getError()).toMatch(/Invalid models\.json schema/);
  });

  it("returns an empty config when the file is absent", async () => {
    const config = await ModelConfig.load(
      "/definitely/not/a/real/path/models.json",
    );
    expect(config.getError()).toBeUndefined();
    expect(config.getProviderIds()).toEqual([]);
  });
});
