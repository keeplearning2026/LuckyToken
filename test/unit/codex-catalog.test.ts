import type {
  Model,
  Models,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { buildCodexCatalog } from "../../src/integrations/codex/catalog.js";

function model(input: {
  provider: string;
  id: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
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
    ...(input.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: input.thinkingLevelMap }),
    input: input.modalities ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: input.contextWindow ?? 128_000,
    maxTokens: 32_000,
  };
}

describe("Codex catalog projection", () => {
  it("preserves Codex native rows and appends callable Token aliases", () => {
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
      priority: 400,
      prefer_websockets: true,
      context_window: 999_999,
      model_messages: { instructions_template: "Native-only template" },
      base_instructions: "You are Codex, an agent based on GPT-5.6.",
      supported_reasoning_levels: [
        { effort: "low", description: "Native low" },
        { effort: "medium", description: "Native medium" },
        { effort: "high", description: "Native high" },
        { effort: "xhigh", description: "Native xhigh" },
        { effort: "max", description: "Native max" },
        { effort: "ultra", description: "Native ultra" },
      ],
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
      display_name: "claude-opus [anthropic]",
      context_window: 180_000,
      input_modalities: ["text", "image"],
      base_instructions: "You are Codex, a coding agent powered by the selected model.",
      supported_reasoning_levels: [
        { effort: "low", description: "Native low" },
        { effort: "medium", description: "Native medium" },
        { effort: "high", description: "Native high" },
      ],
      support_verbosity: false,
      supports_parallel_tool_calls: false,
      supports_image_detail_original: false,
      priority: 401,
    });
    expect(result.modelCount).toBe(2);
  });

  it("derives the picker display name from the alias instead of Pi model.name", () => {
    const routed = model({ provider: "commandcode-private", id: "deepseek/deepseek-v4-flash" });

    const result = buildCodexCatalog({
      nativeCatalogEntries: [],
      models: { getModels: () => [routed] } as unknown as Models,
      aliases: [
        {
          alias: "commandcode-private/deepseek-v4-flash",
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
        slug: "commandcode-private/deepseek-v4-flash",
        display_name: "deepseek-v4-flash [commandcode-private]",
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
    const parsed = JSON.parse(result.content) as {
      models: Array<Record<string, unknown>>;
    };
    expect(parsed.models[0]).toMatchObject({
      supported_reasoning_levels: [],
      base_instructions: "You are Codex, a coding agent powered by the selected model.",
    });
  });

  it("advertises only efforts supported by both Pi model facts and the installed Codex vocabulary", () => {
    const routed = model({
      provider: "commandcode-private",
      id: "deepseek/deepseek-v4-flash",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      },
    });
    const result = buildCodexCatalog({
      nativeCatalogEntries: [
        {
          slug: "gpt-native",
          base_instructions: "Native instructions",
          supported_reasoning_levels: [
            { effort: "low", description: "Native low" },
            { effort: "medium", description: "Native medium" },
            { effort: "high", description: "Native high" },
            { effort: "xhigh", description: "Native xhigh" },
            { effort: "max", description: "Native max" },
            { effort: "ultra", description: "Native ultra" },
          ],
        },
      ],
      models: { getModels: () => [routed] } as unknown as Models,
      aliases: [
        {
          alias: "commandcode-private/deepseek-v4-flash",
          target: {
            providerId: "commandcode-private",
            modelId: "deepseek/deepseek-v4-flash",
          },
        },
      ],
    });

    const parsed = JSON.parse(result.content) as {
      models: Array<Record<string, unknown>>;
    };
    expect(parsed.models[1]?.supported_reasoning_levels).toEqual([
      { effort: "high", description: "Native high" },
      { effort: "max", description: "Native max" },
    ]);
    expect(parsed.models[1]?.default_reasoning_level).toBe("max");
  });

  it("projects a Pi minimal-only model into the Codex low slot", () => {
    const routed = model({
      provider: "provider",
      id: "minimal-only",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: "minimal",
        low: null,
        medium: null,
        high: null,
        xhigh: null,
        max: null,
      },
    });
    const result = buildCodexCatalog({
      nativeCatalogEntries: [
        {
          slug: "gpt-native",
          base_instructions: "Native instructions",
          supported_reasoning_levels: [
            { effort: "low", description: "Light" },
            { effort: "medium", description: "Medium" },
            { effort: "high", description: "High" },
            { effort: "xhigh", description: "Extra high" },
            { effort: "max", description: "Ultra" },
            { effort: "ultra", description: "Delegating ultra" },
          ],
        },
      ],
      models: { getModels: () => [routed] } as unknown as Models,
      aliases: [
        {
          alias: "provider/minimal-only",
          target: { providerId: "provider", modelId: "minimal-only" },
        },
      ],
    });

    const parsed = JSON.parse(result.content) as {
      models: Array<Record<string, unknown>>;
    };
    expect(parsed.models[1]?.supported_reasoning_levels).toEqual([
      { effort: "low", description: "Light" },
    ]);
    expect(parsed.models[1]?.default_reasoning_level).toBe("low");
  });

  it("maps only non-null Pi levels into the five Codex slots and deduplicates minimal with low", () => {
    const routed = model({
      provider: "provider",
      id: "five-slot",
      reasoning: true,
      thinkingLevelMap: {
        off: "none",
        minimal: "provider-minimal",
        low: "provider-low",
        medium: "provider-medium",
        high: null,
        xhigh: "provider-extra-high",
        max: "provider-ultra",
      },
    });
    const result = buildCodexCatalog({
      nativeCatalogEntries: [
        {
          slug: "gpt-native",
          supported_reasoning_levels: [
            { effort: "low", description: "Light" },
            { effort: "medium", description: "Medium" },
            { effort: "high", description: "High" },
            { effort: "xhigh", description: "Extra high" },
            { effort: "max", description: "Ultra" },
          ],
        },
      ],
      models: { getModels: () => [routed] } as unknown as Models,
      aliases: [
        {
          alias: "provider/five-slot",
          target: { providerId: "provider", modelId: "five-slot" },
        },
      ],
    });

    const parsed = JSON.parse(result.content) as {
      models: Array<Record<string, unknown>>;
    };
    expect(parsed.models[1]?.supported_reasoning_levels).toEqual([
      { effort: "low", description: "Light" },
      { effort: "medium", description: "Medium" },
      { effort: "xhigh", description: "Extra high" },
      { effort: "max", description: "Ultra" },
    ]);
    expect(parsed.models[1]?.default_reasoning_level).toBe("max");
  });

  it("emits the complete parser-required field set for a non-reasoning routed model", () => {
    const routed = model({ provider: "provider", id: "plain" });
    const result = buildCodexCatalog({
      nativeCatalogEntries: [],
      models: { getModels: () => [routed] } as unknown as Models,
      aliases: [
        {
          alias: "provider/plain",
          target: { providerId: "provider", modelId: "plain" },
        },
      ],
    });
    const parsed = JSON.parse(result.content) as {
      models: Array<Record<string, unknown>>;
    };
    const entry = parsed.models[0] as Record<string, unknown>;
    for (const required of [
      "slug",
      "display_name",
      "supported_reasoning_levels",
      "shell_type",
      "visibility",
      "supported_in_api",
      "priority",
      "base_instructions",
      "support_verbosity",
      "truncation_policy",
      "experimental_supported_tools",
    ]) {
      expect(entry).toHaveProperty(required);
    }
    expect(entry.supported_reasoning_levels).toEqual([]);
    expect(entry).not.toHaveProperty("default_reasoning_level");
  });

  it("warns instead of inventing a reasoning level when Codex vocabulary is unavailable", () => {
    const routed = model({ provider: "provider", id: "reasoning", reasoning: true });
    const result = buildCodexCatalog({
      nativeCatalogEntries: [],
      models: { getModels: () => [routed] } as unknown as Models,
      aliases: [
        {
          alias: "provider/reasoning",
          target: { providerId: "provider", modelId: "reasoning" },
        },
      ],
    });

    expect(result.warnings.join("\n")).toContain("do not overlap");
    const parsed = JSON.parse(result.content) as {
      models: Array<Record<string, unknown>>;
    };
    expect(parsed.models[0]?.supported_reasoning_levels).toEqual([]);
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
