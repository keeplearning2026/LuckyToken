import { describe, expect, it } from "vitest";

import { PI_COMPATIBILITY_BASELINE } from "../../src/providers/pi-baseline.js";
import { composeEffectiveCatalog } from "../../src/providers/effective-composition.js";

/**
 * Ticket 09 public seam: the effective catalog projection.
 *
 * Expected literals are derived from the repository-pinned Pi baseline
 * (`@earendil-works/pi-coding-agent` 0.84.2 / `@earendil-works/pi-ai`
 * 0.84.2): built-in provider/model facts below are pinned catalog data, and
 * the malformed-case messages are the pinned Pi wording. No Pi internal
 * object is imported anywhere in this file.
 */
describe("effective catalog composition", () => {
  it("records the pinned Pi baseline and composes the built-in base layer with no user file", () => {
    const catalog = composeEffectiveCatalog({});

    expect(catalog.schemaVersion).toBe("luckytoken-effective-catalog-v1");
    expect(catalog.baseline).toEqual({
      package: "@earendil-works/pi-coding-agent",
      version: "0.84.2",
      schema: "pi-coding-agent-0.84.2-models-json-schema",
    });
    expect(catalog.baseline).toEqual(PI_COMPATIBILITY_BASELINE);
    expect(catalog.compositionErrors).toEqual([]);

    const openai = catalog.providers.find((provider) => provider.id === "openai");
    expect(openai).toBeDefined();
    expect(openai?.layer).toBe("builtin");
    expect(openai?.name).toBe("OpenAI");
    expect(openai?.baseUrl).toBe("https://api.openai.com/v1");
    expect(openai?.models[0]).toEqual({
      id: "gpt-4",
      name: "GPT-4",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 30, output: 60, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 8192,
      layer: "builtin",
      compat: { supportsStrictMode: true },
    });
    expect(openai?.models.find((model) => model.id === "gpt-5.4")?.compat).toMatchObject({
      supportsAdditionalTools: true,
      supportsToolSearch: true,
    });

    const anthropic = catalog.providers.find(
      (provider) => provider.id === "anthropic",
    );
    expect(anthropic?.name).toBe("Anthropic");
    expect(anthropic?.baseUrl).toBe("https://api.anthropic.com");
    const opus = anthropic?.models.find(
      (model) => model.id === "claude-opus-4-7",
    );
    expect(opus).toMatchObject({
      name: "Claude Opus 4.7",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1000000,
      maxTokens: 128000,
      layer: "builtin",
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      compat: {
        forceAdaptiveThinking: true,
        supportsTemperature: false,
        supportsStrictTools: true,
      },
    });
    // Built-ins form the lower layer and appear before custom providers.
    expect(catalog.providers.map((provider) => provider.id)).toEqual([
      "amazon-bedrock",
      "ant-ling",
      "anthropic",
      "azure-openai-responses",
      "baseten",
      "cerebras",
      "cloudflare-ai-gateway",
      "cloudflare-workers-ai",
      "deepseek",
      "fireworks",
      "github-copilot",
      "google",
      "google-vertex",
      "groq",
      "huggingface",
      "kimi-coding",
      "minimax",
      "minimax-cn",
      "mistral",
      "moonshotai",
      "moonshotai-cn",
      "nvidia",
      "openai",
      "openai-codex",
      "opencode",
      "opencode-go",
      "openrouter",
      "qwen-token-plan",
      "qwen-token-plan-cn",
      "qwen-token-plan-individual",
      "radius",
      "together",
      "vercel-ai-gateway",
      "xai",
      "xiaomi",
      "xiaomi-token-plan-ams",
      "xiaomi-token-plan-cn",
      "xiaomi-token-plan-sgp",
      "zai",
      "zai-coding-cn",
    ]);
  });

  it("creates a custom Provider with the pinned required/defaulted fields", () => {
    const catalog = composeEffectiveCatalog({
      "my-gateway": {
        baseUrl: "https://gateway.example.com/v1",
        api: "openai-completions",
        models: [
          {
            id: "m-1",
            contextWindow: 32000,
            maxTokens: 8192,
            reasoning: true,
          },
        ],
      },
    });

    expect(catalog.compositionErrors).toEqual([]);
    const provider = catalog.providers.find(
      (entry) => entry.id === "my-gateway",
    );
    expect(provider).toBeDefined();
    expect(provider?.layer).toBe("user");
    // Pinned defaulting: name falls back to the provider id.
    expect(provider?.name).toBe("my-gateway");
    expect(provider?.baseUrl).toBe("https://gateway.example.com/v1");
    expect(provider?.models).toEqual([
      {
        id: "m-1",
        name: "m-1",
        api: "openai-completions",
        provider: "my-gateway",
        baseUrl: "https://gateway.example.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 8192,
        layer: "user",
      },
    ]);

    // A bare definition inherits every pinned default.
    const defaulted = composeEffectiveCatalog({
      "my-gateway": {
        baseUrl: "https://gateway.example.com/v1",
        api: "anthropic-messages",
        models: [{ id: "bare" }],
      },
    });
    const bare = defaulted.providers
      .find((entry) => entry.id === "my-gateway")
      ?.models.find((model) => model.id === "bare");
    expect(bare).toMatchObject({
      name: "bare",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    });
  });

  it("accepts a custom Provider with no models when baseUrl is present (pinned)", () => {
    const catalog = composeEffectiveCatalog({
      empty: {
        baseUrl: "https://gateway.example.com/v1",
        api: "openai-completions",
      },
    });
    expect(catalog.compositionErrors).toEqual([]);
    const provider = catalog.providers.find((entry) => entry.id === "empty");
    expect(provider?.layer).toBe("user");
    expect(provider?.models).toEqual([]);
  });

  it("reports malformed custom Providers with the exact pinned errors and never guesses", () => {
    const cases: Array<{
      readonly name: string;
      readonly config: Record<string, unknown>;
      readonly message: string;
    }> = [
      {
        name: "missing api",
        config: {
          baseUrl: "https://x",
          models: [{ id: "m" }],
        },
        message:
          'Provider p, model m: no "api" specified. Set at provider or model level.',
      },
      {
        name: "missing baseUrl",
        config: {
          api: "openai-completions",
          models: [{ id: "m" }],
        },
        message: 'Provider p: "baseUrl" is required when defining custom models.',
      },
      {
        name: "invalid contextWindow",
        config: {
          baseUrl: "https://x",
          api: "openai-completions",
          models: [{ id: "m", contextWindow: 0 }],
        },
        message: "Provider p, model m: invalid contextWindow",
      },
      {
        name: "invalid maxTokens",
        config: {
          baseUrl: "https://x",
          api: "openai-completions",
          models: [{ id: "m", maxTokens: -5 }],
        },
        message: "Provider p, model m: invalid maxTokens",
      },
      {
        name: "empty provider entry",
        config: {},
        message:
          'Provider p: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".',
      },
      {
        name: "oauth without baseUrl",
        config: { oauth: "radius" },
        message: 'Provider p: "baseUrl" is required when "oauth" is set.',
      },
    ];

    for (const entry of cases) {
      const catalog = composeEffectiveCatalog({ p: entry.config });
      expect(catalog.providers.find((provider) => provider.id === "p")).toBeUndefined();
      expect(catalog.compositionErrors).toEqual([
        { providerId: "p", message: entry.message },
      ]);
    }
  });

  it("overlays a matching built-in Provider without losing unrelated built-in facts", () => {
    const catalog = composeEffectiveCatalog({
      openai: {
        name: "OpenAI via Gateway",
        baseUrl: "https://gateway.example.com/v1",
        modelOverrides: { "gpt-4": { name: "GPT-4 via Gateway" } },
      },
    });

    const openai = catalog.providers.find((provider) => provider.id === "openai");
    expect(openai?.layer).toBe("overlaid");
    expect(openai?.name).toBe("OpenAI via Gateway");
    expect(openai?.baseUrl).toBe("https://gateway.example.com/v1");

    const gpt4 = openai?.models.find((model) => model.id === "gpt-4");
    // The override changed only the name; every unrelated built-in fact
    // (cost, context window, compat, api) survives the overlay.
    expect(gpt4).toMatchObject({
      name: "GPT-4 via Gateway",
      baseUrl: "https://gateway.example.com/v1",
      api: "openai-responses",
      reasoning: false,
      input: ["text"],
      cost: { input: 30, output: 60, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 8192,
      layer: "overridden",
      overriddenFields: ["name"],
      compat: { supportsStrictMode: true },
    });

    // Untouched built-in models keep their layer and facts, but the
    // provider-level baseUrl overlay still applies to their baseUrl.
    const gpt5 = openai?.models.find((model) => model.id === "gpt-5");
    expect(gpt5).toMatchObject({
      layer: "builtin",
      baseUrl: "https://gateway.example.com/v1",
      contextWindow: 400000,
      cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
    });
    expect(gpt5?.overriddenFields).toBeUndefined();
  });

  it("upserts models by canonical provider/model identity and appends custom models in order", () => {
    const catalog = composeEffectiveCatalog({
      deepseek: {
        baseUrl: "https://gateway.example.com",
        models: [
          { id: "deepseek-v4-flash", contextWindow: 200000 },
          { id: "custom-model", reasoning: true },
        ],
      },
    });

    const deepseek = catalog.providers.find((provider) => provider.id === "deepseek");
    expect(deepseek?.layer).toBe("overlaid");
    // The upserted model replaces the base entry in place (base position
    // preserved); the custom model is appended after all base models.
    expect(deepseek?.models.map((model) => model.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "custom-model",
    ]);
    const flash = deepseek?.models.find((model) => model.id === "deepseek-v4-flash");
    expect(flash).toMatchObject({
      layer: "upserted",
      name: "deepseek-v4-flash",
      api: "openai-completions",
      baseUrl: "https://gateway.example.com",
      contextWindow: 200000,
      // Pinned defaulting applies to every field the definition omits.
      maxTokens: 16384,
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    const pro = deepseek?.models.find((model) => model.id === "deepseek-v4-pro");
    expect(pro).toMatchObject({ layer: "builtin", contextWindow: 1000000 });
    const custom = deepseek?.models.find((model) => model.id === "custom-model");
    expect(custom).toMatchObject({
      layer: "user",
      name: "custom-model",
      baseUrl: "https://gateway.example.com",
      reasoning: true,
    });
  });

  it("applies modelOverrides with pinned precedence and never creates models from them", () => {
    const catalog = composeEffectiveCatalog({
      openai: {
        modelOverrides: {
          "gpt-4": {
            name: "GPT-4 tuned",
            reasoning: true,
            contextWindow: 99999,
            input: ["text", "image"],
            cost: { input: 99 },
            compat: { supportsStrictMode: false },
          },
          "no-such-model": { name: "never created" },
        },
      },
    });

    const openai = catalog.providers.find((provider) => provider.id === "openai");
    const gpt4 = openai?.models.find((model) => model.id === "gpt-4");
    // Pinned field-wise merge: cost merges into the base cost, everything
    // else replaces; untouched fields survive.
    expect(gpt4).toMatchObject({
      layer: "overridden",
      name: "GPT-4 tuned",
      reasoning: true,
      contextWindow: 99999,
      input: ["text", "image"],
      cost: { input: 99, output: 60, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStrictMode: false },
      maxTokens: 8192,
    });
    expect(gpt4?.overriddenFields).toEqual([
      "name",
      "reasoning",
      "input",
      "cost",
      "contextWindow",
      "compat",
    ]);
    expect(
      openai?.models.some((model) => model.id === "no-such-model"),
    ).toBe(false);
  });

  it("applies every supported modelOverrides field with pinned merge semantics", () => {
    const catalog = composeEffectiveCatalog({
      anthropic: {
        modelOverrides: {
          "claude-opus-4-7": {
            name: "Override name",
            reasoning: false,
            thinkingLevelMap: { high: "h2", xhigh: null },
            input: ["text"],
            cost: { output: 7, tiers: [{ inputTokensAbove: 1, input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }] },
            contextWindow: 55555,
            maxTokens: 33333,
            samplingParams: { top_p: 0.5 },
            compat: { supportsTemperature: true },
          },
        },
      },
    });
    const model = catalog.providers
      .find((provider) => provider.id === "anthropic")!
      .models.find((entry) => entry.id === "claude-opus-4-7")!;
    expect(model).toMatchObject({
      layer: "overridden",
      name: "Override name",
      reasoning: false,
      // Pinned: thinkingLevelMap shallow-merges into the base map; the
      // override's explicit null replaces the base value.
      thinkingLevelMap: { high: "h2", max: "max", xhigh: null },
      input: ["text"],
      // Pinned: cost merges per field; tiers replaces.
      cost: {
        input: 5,
        output: 7,
        cacheRead: 0.5,
        cacheWrite: 6.25,
        tiers: [{ inputTokensAbove: 1, input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }],
      },
      contextWindow: 55555,
      maxTokens: 33333,
      // Pinned: compat shallow-merges plus nested routing keys.
      compat: {
        forceAdaptiveThinking: true,
        supportsTemperature: true,
        supportsStrictTools: true,
      },
    });
    // samplingParams is composed into the runtime facts (pinned field-wise
    // merge) but not projected; the attribution records the contribution.
    expect(model.overriddenFields).toEqual([
      "name",
      "reasoning",
      "thinkingLevelMap",
      "input",
      "cost",
      "contextWindow",
      "maxTokens",
      "samplingParams",
      "compat",
    ]);
  });

  it("applies modelOverrides after model upserts and merges nested compat keys", () => {
    const catalog = composeEffectiveCatalog({
      openai: {
        models: [{ id: "gpt-4", compat: { supportsStrictMode: true } }],
        modelOverrides: {
          // The upserted model is the target; the override applies on top.
          "gpt-4": {
            compat: {
              supportsStrictMode: false,
              openRouterRouting: { only: ["a"] },
            },
          },
        },
      },
    });
    const model = catalog.providers
      .find((provider) => provider.id === "openai")!
      .models.find((entry) => entry.id === "gpt-4")!;
    expect(model.layer).toBe("overridden");
    expect(model.compat).toEqual({
      supportsStrictMode: false,
      openRouterRouting: { only: ["a"] },
    });
    // A nested routing key from the base survives a partial override merge.
    const nested = composeEffectiveCatalog({
      openai: {
        modelOverrides: {
          "gpt-4": {
            compat: { openRouterRouting: { order: ["b"] } },
          },
        },
      },
    });
    const nestedModel = nested.providers
      .find((provider) => provider.id === "openai")!
      .models.find((entry) => entry.id === "gpt-4")!;
    expect(nestedModel.compat).toEqual({
      supportsStrictMode: true,
      openRouterRouting: { order: ["b"] },
    });
  });

  it("resolves explicit baseUrl precedence: model definition, then Provider, then base defaults", () => {
    const catalog = composeEffectiveCatalog({
      openai: {
        baseUrl: "https://provider.example.com",
        models: [
          { id: "gpt-4", baseUrl: "https://model.example.com" },
          { id: "gpt-5", contextWindow: 42 },
        ],
      },
    });
    const openai = catalog.providers.find((provider) => provider.id === "openai")!;
    // Model-level baseUrl wins over the Provider-level baseUrl.
    expect(
      openai.models.find((entry) => entry.id === "gpt-4")?.baseUrl,
    ).toBe("https://model.example.com");
    // Provider-level baseUrl wins for models without their own.
    expect(
      openai.models.find((entry) => entry.id === "gpt-5")?.baseUrl,
    ).toBe("https://provider.example.com");
    // Pinned applyModelsJson: the Provider-level baseUrl overlays every base
    // model (Radius configs excepted), including untouched built-ins.
    expect(
      openai.models.find((entry) => entry.id === "gpt-4o")?.baseUrl,
    ).toBe("https://provider.example.com");
    // The Provider-level baseUrl itself wins over the built-in default.
    expect(openai.baseUrl).toBe("https://provider.example.com");
  });

  it("swaps a same-id built-in baseline for the Radius baseline with no built-in models", () => {
    // Pinned model-runtime configureRadiusProviders(): a configured Provider
    // with oauth "radius" and a baseUrl replaces the same-id built-in
    // baseline with the Radius provider baseline, which starts with no
    // built-in models. applyModelsJson then composes only configured models.
    const catalog = composeEffectiveCatalog({
      openai: {
        baseUrl: "https://gateway.example.com/v1",
        oauth: "radius",
      },
    });
    const openai = catalog.providers.find((provider) => provider.id === "openai");
    expect(openai?.layer).toBe("overlaid");
    expect(openai?.name).toBe("openai");
    expect(openai?.baseUrl).toBe("https://gateway.example.com/v1");
    // The original built-in model list is gone: no gpt-4, no gpt-5.
    expect(openai?.models).toEqual([]);
    expect(catalog.compositionErrors).toEqual([]);
  });

  it("composes a Radius Provider from only its configured models with pinned defaults", () => {
    const catalog = composeEffectiveCatalog({
      openai: {
        baseUrl: "https://gateway.example.com",
        oauth: "radius",
        api: "openai-completions",
        models: [
          { id: "gpt-4", contextWindow: 99999 },
          { id: "gpt-5", reasoning: true, maxTokens: 200000 },
        ],
      },
    });
    const openai = catalog.providers.find((provider) => provider.id === "openai");
    expect(openai?.models.map((model) => model.id)).toEqual(["gpt-4", "gpt-5"]);
    // Every fact comes from the definition with pinned defaults; none of
    // the built-in gpt-4 facts (cost, context window) leak through.
    expect(openai?.models[0]).toMatchObject({
      id: "gpt-4",
      name: "gpt-4",
      api: "openai-completions",
      baseUrl: "https://gateway.example.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 99999,
      maxTokens: 16384,
      layer: "user",
    });
    expect(openai?.models[1]).toMatchObject({
      layer: "user",
      reasoning: true,
      maxTokens: 200000,
      contextWindow: 128000,
    });
    expect(catalog.compositionErrors).toEqual([]);
  });

  it("reports the exact pinned error for a Radius model without api defaults and isolates the Provider", () => {
    // With oauth "radius" the baseline has no built-in models, so a
    // configured model lacking api has no defaults to guess from: pinned Pi
    // emits its exact error and the Provider falls back to the empty Radius
    // baseline — never to the original built-in models.
    const catalog = composeEffectiveCatalog({
      anthropic: {
        baseUrl: "https://gateway.example.com",
        oauth: "radius",
        models: [{ id: "m" }],
      },
    });
    expect(catalog.compositionErrors).toEqual([
      {
        providerId: "anthropic",
        message:
          'Provider anthropic, model m: no "api" specified. Set at provider or model level.',
      },
    ]);
    const anthropic = catalog.providers.find(
      (provider) => provider.id === "anthropic",
    );
    // The failed Radius overlay falls back to the empty Radius baseline;
    // the original built-in Anthropic models are never served.
    expect(anthropic?.layer).toBe("builtin");
    expect(anthropic?.name).toBe("anthropic");
    expect(anthropic?.models).toEqual([]);
  });

  it("applies Radius semantics to custom Providers and isolates them without a base", () => {
    const catalog = composeEffectiveCatalog({
      "my-radius": {
        baseUrl: "https://gateway.example.com",
        oauth: "radius",
        api: "openai-completions",
        models: [{ id: "m", contextWindow: 32000 }],
      },
      "broken-radius": {
        baseUrl: "https://broken.example.com",
        oauth: "radius",
        models: [{ id: "m" }],
      },
    });
    const myRadius = catalog.providers.find(
      (provider) => provider.id === "my-radius",
    );
    expect(myRadius?.layer).toBe("user");
    expect(myRadius?.models).toMatchObject([
      { id: "m", layer: "user", api: "openai-completions", contextWindow: 32000 },
    ]);
    // A broken Radius custom Provider still gains the Radius baseline
    // (pinned configureRadiusProviders adds a base for every Radius config
    // id), so it falls back to that empty baseline with the exact pinned
    // error instead of disappearing.
    const brokenRadius = catalog.providers.find(
      (provider) => provider.id === "broken-radius",
    );
    expect(brokenRadius?.layer).toBe("user");
    expect(brokenRadius?.name).toBe("broken-radius");
    expect(brokenRadius?.models).toEqual([]);
    expect(catalog.compositionErrors).toEqual([
      {
        providerId: "broken-radius",
        message:
          'Provider broken-radius, model m: no "api" specified. Set at provider or model level.',
      },
    ]);
  });

  it("keeps non-Radius overlays unchanged", () => {
    const catalog = composeEffectiveCatalog({
      openai: {
        baseUrl: "https://gateway.example.com/v1",
        name: "OpenAI via Gateway",
        modelOverrides: { "gpt-4": { name: "GPT-4 via Gateway" } },
      },
    });
    const openai = catalog.providers.find((provider) => provider.id === "openai");
    expect(openai?.layer).toBe("overlaid");
    // Non-Radius overlays keep every built-in model with the Provider-level
    // baseUrl override applied.
    expect(openai?.models.map((model) => model.id)).toContain("gpt-4");
    expect(openai?.models[0]?.baseUrl).toBe("https://gateway.example.com/v1");
    expect(openai?.models.find((model) => model.id === "gpt-4")).toMatchObject({
      layer: "overridden",
      name: "GPT-4 via Gateway",
      contextWindow: 8192,
    });
  });

  it("isolates per-Provider composition failures and keeps useful public errors", () => {
    const catalog = composeEffectiveCatalog({
      broken: { models: [{ id: "m" }] },
      "ok-provider": {
        baseUrl: "https://ok.example.com",
        api: "openai-completions",
        models: [{ id: "m" }],
      },
      openai: { oauth: "radius" },
    });

    // The broken custom provider is excluded; the working one is present.
    expect(
      catalog.providers.find((provider) => provider.id === "broken"),
    ).toBeUndefined();
    expect(
      catalog.providers.find((provider) => provider.id === "ok-provider"),
    ).toMatchObject({ layer: "user" });
    // A failed overlay falls back to the untouched built-in base (pinned
    // model-runtime behavior) and the error is recorded.
    const openai = catalog.providers.find((provider) => provider.id === "openai");
    expect(openai?.layer).toBe("builtin");
    expect(openai?.models[0]?.baseUrl).toBe("https://api.openai.com/v1");
    // Errors follow the deterministic projection order: built-ins first
    // (in base order), then custom Providers in file order.
    expect(catalog.compositionErrors).toEqual([
      {
        providerId: "openai",
        message: 'Provider openai: "baseUrl" is required when "oauth" is set.',
      },
      {
        providerId: "broken",
        message:
          'Provider broken, model m: no "api" specified. Set at provider or model level.',
      },
    ]);
  });

  it("never projects credentials, headers, or request auth state", () => {
    const catalog = composeEffectiveCatalog({
      "secret-gateway": {
        baseUrl: "https://gateway.example.com/v1",
        api: "openai-completions",
        apiKey: "sk-super-secret-12345",
        headers: { Authorization: "Bearer sk-header-secret-67890" },
        models: [
          {
            id: "m",
            headers: { "x-custom": "sk-model-header-11111" },
          },
        ],
      },
    });
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain("sk-super-secret-12345");
    expect(serialized).not.toContain("sk-header-secret-67890");
    expect(serialized).not.toContain("sk-model-header-11111");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("headers");
    expect(serialized).not.toContain("auth");
  });
});
