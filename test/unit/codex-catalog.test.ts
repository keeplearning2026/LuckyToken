import type { Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { buildCodexCatalog } from "../../src/integrations/codex/catalog.js";

function model(input: {
  provider: string;
  id: string;
  reasoning?: boolean;
  modalities?: Array<"text" | "image">;
  contextWindow?: number;
}): Model<string> {
  return {
    id: input.id,
    name: `marketing:${input.id}`,
    api: "test-api",
    provider: input.provider,
    baseUrl: "https://provider.test",
    reasoning: input.reasoning ?? false,
    input: input.modalities ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: input.contextWindow ?? 128_000,
    maxTokens: 32_000,
  };
}

describe("Codex catalog projection", () => {
  it("preserves Codex native rows and appends callable LuckyToken aliases", () => {
    const routed = model({
      provider: "anthropic",
      id: "claude-opus",
      reasoning: true,
      modalities: ["text", "image"],
      contextWindow: 180_000,
    });
    const native = {
      slug: "gpt-native",
      display_name: "Codex Native Marketing Name",
      visibility: "hide",
      supported_in_api: false,
      prefer_websockets: true,
      context_window: 999_999,
      model_messages: { instructions_template: "Native-only template" },
      base_instructions: "You are Codex, an agentic coding assistant.",
    };

    const result = buildCodexCatalog({
      nativeCatalogEntries: [native],
      models: { getModels: () => [routed] } as unknown as Models,
      aliases: [
        {
          alias: "anthropic/claude-opus",
          target: { providerId: "anthropic", modelId: "claude-opus" },
        },
      ],
    });

    const parsed = JSON.parse(result.content) as { models: Array<Record<string, unknown>> };
    expect(parsed.models[0]).toEqual(native);
    expect(parsed.models[1]).toMatchObject({
      slug: "anthropic/claude-opus",
      display_name: "anthropic/claude-opus",
      context_window: 180_000,
      input_modalities: ["text", "image"],
      base_instructions: "You are Codex, an agentic coding assistant.",
    });
    expect(result.modelCount).toBe(2);
  });

  it("uses the alias, not Pi model.name, as the only Codex-facing identity for injected models", () => {
    const routed = model({ provider: "commandcode-private", id: "deepseek/deepseek-v4-flash" });

    const result = buildCodexCatalog({
      nativeCatalogEntries: [],
      models: { getModels: () => [routed] } as unknown as Models,
      aliases: [
        {
          alias: "commandcode-private/deepseek-deepseek-v4-flash",
          target: {
            providerId: "commandcode-private",
            modelId: "deepseek/deepseek-v4-flash",
          },
        },
      ],
    });

    const parsed = JSON.parse(result.content) as { models: Array<Record<string, unknown>> };
    expect(parsed.models).toContainEqual(
      expect.objectContaining({
        slug: "commandcode-private/deepseek-deepseek-v4-flash",
        display_name: "commandcode-private/deepseek-deepseek-v4-flash",
      }),
    );
    expect(result.content).not.toContain("marketing:deepseek/deepseek-v4-flash");
  });

  it("keeps routed aliases available when Codex native metadata is unavailable", () => {
    const routed = model({ provider: "anthropic", id: "claude-opus" });

    const result = buildCodexCatalog({
      nativeCatalogEntries: [],
      models: { getModels: () => [routed] } as unknown as Models,
      aliases: [
        {
          alias: "anthropic/claude-opus",
          target: { providerId: "anthropic", modelId: "claude-opus" },
        },
      ],
    });

    expect(result.modelCount).toBe(1);
    expect(result.content).toContain("anthropic/claude-opus");
  });

  it("lets a native Codex slug win over a colliding injected alias", () => {
    const routed = model({ provider: "other", id: "routed" });
    const result = buildCodexCatalog({
      nativeCatalogEntries: [{ slug: "gpt-native", display_name: "GPT Native" }],
      models: { getModels: () => [routed] } as unknown as Models,
      aliases: [
        {
          alias: "gpt-native",
          target: { providerId: "other", modelId: "routed" },
        },
      ],
    });

    expect(result.modelCount).toBe(1);
    expect(result.warnings.join("\n")).toContain("gpt-native");
    expect(result.warnings.join("\n")).toContain("native");
  });

  it("omits aliases whose canonical target is no longer callable", () => {
    const result = buildCodexCatalog({
      nativeCatalogEntries: [],
      models: { getModels: () => [] } as unknown as Models,
      aliases: [
        {
          alias: "anthropic/missing",
          target: { providerId: "anthropic", modelId: "missing" },
        },
      ],
    });

    expect(result.modelCount).toBe(0);
    expect(result.warnings.join("\n")).toContain("not callable");
  });

  it("does not expose an invalid multi-slash alias to Codex", () => {
    const routed = model({ provider: "provider", id: "vendor/model" });
    const result = buildCodexCatalog({
      nativeCatalogEntries: [],
      models: { getModels: () => [routed] } as unknown as Models,
      aliases: [
        {
          alias: "provider/vendor/model",
          target: { providerId: "provider", modelId: "vendor/model" },
        },
      ],
    });

    expect(result.modelCount).toBe(0);
    expect(result.warnings.join("\n")).toContain("multiple '/' segments");
  });
});
