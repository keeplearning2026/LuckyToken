import type { Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { buildCodexCatalog } from "../../src/integrations/codex/catalog.js";

function model(input: {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  modalities?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
}): Model<string> {
  return {
    id: input.id,
    name: input.name ?? input.id,
    api: "test-api",
    provider: input.provider,
    baseUrl: "https://provider.test",
    reasoning: input.reasoning ?? false,
    input: input.modalities ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: input.contextWindow ?? 128_000,
    maxTokens: input.maxTokens ?? 32_000,
  };
}

describe("Codex catalog projection", () => {
  it("combines bare native Codex models with callable LuckyToken aliases", () => {
    const native = model({
      provider: "openai-codex",
      id: "gpt-native",
      name: "GPT Native",
      reasoning: true,
      modalities: ["text", "image"],
      contextWindow: 200_000,
    });
    const routed = model({
      provider: "anthropic",
      id: "claude-opus",
      name: "Claude Opus",
      reasoning: true,
      contextWindow: 180_000,
    });
    const models = {
      getModels: () => [routed],
    } as unknown as Models;

    const result = buildCodexCatalog({
      nativeModels: [native],
      nativeCatalogEntries: [
        {
          slug: "gpt-native",
          display_name: "GPT Native",
          visibility: "list",
          supported_in_api: true,
          model_messages: { instructions_template: "You are Codex Native." },
        },
      ],
      models,
      aliases: [
        {
          alias: "anthropic/claude-opus",
          target: { providerId: "anthropic", modelId: "claude-opus" },
        },
      ],
    });

    expect(result.modelCount).toBe(2);
    const parsed = JSON.parse(result.content) as { models: Array<Record<string, unknown>> };
    expect(parsed.models.map((entry) => entry.slug)).toEqual([
      "gpt-native",
      "anthropic/claude-opus",
    ]);
    expect(parsed.models[0]).toMatchObject({
      slug: "gpt-native",
      display_name: "GPT Native",
      context_window: 200_000,
      max_context_window: 200_000,
      input_modalities: ["text", "image"],
      visibility: "list",
      supported_in_api: true,
      prefer_websockets: false,
    });
    expect(parsed.models[1]).toMatchObject({
      slug: "anthropic/claude-opus",
      display_name: "Claude Opus",
      context_window: 180_000,
      input_modalities: ["text"],
    });
  });

  it("exposes slash-containing canonical models through their single-slash LuckyToken alias", () => {
    const routed = model({
      provider: "commandcode-private",
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      reasoning: true,
      contextWindow: 1_000_000,
    });
    const result = buildCodexCatalog({
      nativeModels: [],
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
        display_name: "DeepSeek V4 Flash",
        context_window: 1_000_000,
      }),
    );
  });

  it("preserves Codex-native metadata while forcing the native row onto LuckyToken's HTTP transport", () => {
    const native = model({
      provider: "openai-codex",
      id: "gpt-native",
      name: "GPT Native",
      reasoning: true,
      modalities: ["text", "image"],
      contextWindow: 200_000,
    });
    const result = buildCodexCatalog({
      nativeModels: [native],
      nativeCatalogEntries: [
        {
          slug: "gpt-native",
          display_name: "Codex Native Marketing Name",
          prefer_websockets: true,
          use_responses_lite: true,
          tool_mode: "code_mode_only",
          web_search_tool_type: "text_and_image",
          multi_agent_version: "v2",
          model_messages: { instructions_template: "You are Codex Native." },
          supported_reasoning_levels: [
            { effort: "low", description: "Native low" },
            { effort: "max", description: "Native max" },
          ],
          context_window: 999_999,
          max_context_window: 999_999,
          input_modalities: ["text"],
        },
      ],
      models: { getModels: () => [] } as unknown as Models,
      aliases: [],
    });

    const parsed = JSON.parse(result.content) as { models: Array<Record<string, unknown>> };
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0]).toMatchObject({
      slug: "gpt-native",
      display_name: "Codex Native Marketing Name",
      prefer_websockets: false,
      use_responses_lite: true,
      tool_mode: "code_mode_only",
      web_search_tool_type: "text_and_image",
      multi_agent_version: "v2",
      model_messages: { instructions_template: "You are Codex Native." },
      supported_reasoning_levels: [
        { effort: "low", description: "Native low" },
        { effort: "max", description: "Native max" },
      ],
      context_window: 200_000,
      max_context_window: 200_000,
      input_modalities: ["text", "image"],
    });
  });

  it("omits a native model from the picker when Codex has no native metadata for it", () => {
    const native = model({ provider: "openai-codex", id: "gpt-native" });
    const result = buildCodexCatalog({
      nativeModels: [native],
      nativeCatalogEntries: [],
      models: { getModels: () => [] } as unknown as Models,
      aliases: [],
    });

    expect(result.modelCount).toBe(0);
    expect(result.warnings.join("\n")).toContain("gpt-native");
    expect(result.warnings.join("\n")).toContain("native metadata");
  });

  it("preserves Codex account visibility for native models instead of forcing them into the picker", () => {
    const native = model({ provider: "openai-codex", id: "gpt-native" });
    const result = buildCodexCatalog({
      nativeModels: [native],
      nativeCatalogEntries: [
        {
          slug: "gpt-native",
          display_name: "GPT Native",
          visibility: "hide",
          supported_in_api: false,
          base_instructions: "You are Codex Native.",
        },
      ],
      models: { getModels: () => [] } as unknown as Models,
      aliases: [],
    });

    const parsed = JSON.parse(result.content) as { models: Array<Record<string, unknown>> };
    expect(parsed.models[0]).toMatchObject({
      slug: "gpt-native",
      visibility: "hide",
      supported_in_api: false,
    });
  });

  it("uses Codex coding-agent base instructions for routed aliases without native-only metadata", () => {
    const native = model({ provider: "openai-codex", id: "gpt-native" });
    const routed = model({ provider: "anthropic", id: "claude-opus", name: "Claude Opus" });
    const result = buildCodexCatalog({
      nativeModels: [native],
      nativeCatalogEntries: [
        {
          slug: "gpt-native",
          display_name: "GPT Native",
          base_instructions: "You are Codex, an agentic coding assistant.",
          model_messages: { instructions_template: "Native-only template" },
          use_responses_lite: true,
          prefer_websockets: true,
        },
      ],
      models: { getModels: () => [routed] } as unknown as Models,
      aliases: [
        {
          alias: "anthropic/claude-opus",
          target: { providerId: "anthropic", modelId: "claude-opus" },
        },
      ],
    });

    const parsed = JSON.parse(result.content) as { models: Array<Record<string, unknown>> };
    const row = parsed.models.find((entry) => entry.slug === "anthropic/claude-opus");
    expect(row).toMatchObject({
      base_instructions: "You are Codex, an agentic coding assistant.",
      prefer_websockets: false,
    });
    expect(row).not.toHaveProperty("model_messages");
    expect(row).not.toHaveProperty("use_responses_lite");
  });

  it("native model ids win over colliding aliases without mutating the alias contract", () => {
    const native = model({ provider: "openai-codex", id: "gpt-native" });
    const routed = model({ provider: "other", id: "routed" });
    const result = buildCodexCatalog({
      nativeModels: [native],
      nativeCatalogEntries: [
        {
          slug: "gpt-native",
          display_name: "GPT Native",
          model_messages: { instructions_template: "You are Codex Native." },
        },
      ],
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

  it("omits aliases with multiple slashes only from the Codex projection", () => {
    const routed = model({ provider: "provider", id: "vendor/model" });
    const result = buildCodexCatalog({
      nativeModels: [],
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

  it("omits aliases whose canonical target is no longer callable", () => {
    const result = buildCodexCatalog({
      nativeModels: [],
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
});
