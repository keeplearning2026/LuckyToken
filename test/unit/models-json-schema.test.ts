import { describe, expect, it } from "vitest";

import {
  ModelConfig,
  type ModelsJsonProvider,
} from "../../src/providers/models-json-schema.js";

const PI_0_84_2_RESPONSES_COMPAT: NonNullable<ModelsJsonProvider["compat"]> = {
  supportsAdditionalTools: true,
};

describe("ModelConfig (extracted from Pi coding-agent)", () => {
  it("exposes the Pi 0.84.2 Responses additional-tools compat field", () => {
    const config = ModelConfig.parse(
      JSON.stringify({
        providers: {
          p: {
            api: "openai-responses",
            compat: PI_0_84_2_RESPONSES_COMPAT,
            models: [{ id: "m", compat: PI_0_84_2_RESPONSES_COMPAT }],
          },
        },
      }),
    );
    expect(config.getError()).toBeUndefined();
    expect(config.getProvider("p")?.compat).toMatchObject({
      supportsAdditionalTools: true,
    });
    expect(config.getProvider("p")?.models?.[0]?.compat).toMatchObject({
      supportsAdditionalTools: true,
    });
  });

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

  it("rejects invalid compat/model forms with the exact pinned schema errors", () => {
    const cases: Array<{ value: unknown; path: string; message: string }> = [
      {
        value: { providers: { p: { compat: 42 } } },
        path: "providers.p.compat",
        message: "must be object",
      },
      {
        value: { providers: { p: { modelOverrides: { m: "string" } } } },
        path: "providers.p.modelOverrides.m",
        message: "must be object",
      },
      {
        value: { providers: { p: { models: [{ id: "m", headers: [1] }] } } },
        path: "providers.p.models.0.headers",
        message: "must be object",
      },
      {
        value: { providers: { p: { headers: { "X": 5 } } } },
        path: "providers.p.headers.X",
        message: "must be string",
      },
      {
        value: { providers: { p: { apiKey: "" } } },
        path: "providers.p.apiKey",
        message: "must not have fewer than 1 characters",
      },
      {
        value: { providers: { p: { models: [{ id: "m", input: ["video"] }] } } },
        path: "providers.p.models.0.input.0",
        message: "must be equal to constant",
      },
      {
        value: { providers: { p: { oauth: "device-flow" } } },
        path: "providers.p.oauth",
        message: "must be equal to constant",
      },
    ];
    for (const { value, path, message } of cases) {
      const config = ModelConfig.parse(JSON.stringify(value));
      const error = config.getError();
      expect(error).toBeDefined();
      expect(error).toContain("Invalid models.json schema");
      expect(error).toContain(`${path}: ${message}`);
      // Never echoes the offending value.
      expect(error).not.toContain("device-flow");
      expect(error).not.toContain("42");
    }
  });

  it("accepts the pinned union laxness: nested compat value types and unknown override fields are schema-valid", () => {
    // Pinned schema semantics (TypeBox unions without strict
    // additionalProperties): a wrong-typed nested compat value and an
    // unknown modelOverride field pass schema validation exactly as the
    // pinned ModelConfig accepts them — composition ignores what it does not
    // apply. This documents the pinned meaning instead of generalizing
    // compat into LuckyToken feature flags.
    const config = ModelConfig.parse(
      JSON.stringify({
        providers: {
          p: {
            compat: { supportsStrictMode: "yes" },
            modelOverrides: {
              m: { api: "openai-completions", baseUrl: "https://ignored.example.com" },
            },
          },
        },
      }),
    );
    expect(config.getError()).toBeUndefined();
    const provider = config.getProvider("p");
    expect(provider?.compat).toEqual({ supportsStrictMode: "yes" });
    expect(provider?.modelOverrides?.m).toEqual({
      api: "openai-completions",
      baseUrl: "https://ignored.example.com",
    });
  });

  it("returns an empty config when the file is absent", async () => {
    const config = await ModelConfig.load(
      "/definitely/not/a/real/path/models.json",
    );
    expect(config.getError()).toBeUndefined();
    expect(config.getProviderIds()).toEqual([]);
  });
});
