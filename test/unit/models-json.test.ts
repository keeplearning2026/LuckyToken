import { describe, expect, it } from "vitest";

import { parseModelsJson } from "../../src/providers/models-json.js";

describe("parseModelsJson", () => {
  it("parses a provider with models and provider-level defaults", () => {
    const config = parseModelsJson(
      JSON.stringify({
        providers: {
          "my-anthropic": {
            baseUrl: "https://gateway.example.com",
            api: "anthropic-messages",
            models: [{ id: "claude-sonnet", contextWindow: 200000 }],
          },
        },
      }),
    );
    expect(config.providers["my-anthropic"]?.baseUrl).toBe(
      "https://gateway.example.com",
    );
    expect(config.providers["my-anthropic"]?.models?.[0]?.id).toBe(
      "claude-sonnet",
    );
  });

  it("rejects missing providers root", () => {
    expect(() => parseModelsJson("{}")).toThrow(/Invalid models\.json schema/);
  });

  it("accepts a negative contextWindow at schema level (Pi behavior)", () => {
    const config = parseModelsJson(
      JSON.stringify({
        providers: {
          p: {
            baseUrl: "https://x",
            api: "anthropic-messages",
            models: [{ id: "m", contextWindow: -1 }],
          },
        },
      }),
    );
    expect(config.providers.p?.models?.[0]?.contextWindow).toBe(-1);
  });

  it("accepts provider ids with whitespace at schema level (Pi behavior)", () => {
    const config = parseModelsJson(
      JSON.stringify({
        providers: { "bad id": { baseUrl: "https://x", api: "a" } },
      }),
    );
    expect(config.providers["bad id"]?.baseUrl).toBe("https://x");
  });
});
