import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  COMMANDCODE_MODEL_FACTS,
  projectCommandCodeModel,
} from "@luckytoken/commandcode-model-catalog";
import {
  COMMANDCODE_MODELS,
  findCommandCodeModel,
} from "../../packages/provider-commandcode-private/src/models.js";
import { COMMANDCODE_GOAT_MODELS } from "../../packages/provider-commandcode-goat/src/models.js";

describe("CommandCode model catalog", () => {
  it("publishes the current CommandCode model facts in source order", () => {
    expect(COMMANDCODE_MODEL_FACTS.map((model) => model.id)).toEqual([
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-haiku-4-5-20251001",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.4-mini",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash-vision-exp",
      "moonshotai/Kimi-K3",
      "moonshotai/Kimi-K2.7-Code",
      "moonshotai/Kimi-K2.7-Code-Highspeed",
      "moonshotai/Kimi-K2.6",
      "moonshotai/Kimi-K2.5",
      "zai-org/GLM-5.3",
      "zai-org/GLM-5.2",
      "zai-org/GLM-5.2-Fast",
      "zai-org/GLM-5.1",
      "zai-org/GLM-5",
      "MiniMaxAI/MiniMax-M3",
      "MiniMaxAI/MiniMax-M2.7",
      "MiniMaxAI/MiniMax-M2.5",
      "xiaomi/mimo-v2.5-pro",
      "xiaomi/mimo-v2.5",
      "Qwen/Qwen3.8-Max",
      "Qwen/Qwen3.8-27B",
      "Qwen/Qwen3.7-Max",
      "Qwen/Qwen3.7-Plus",
      "Qwen/Qwen3.7-Flash",
      "Qwen/Qwen3.6-Max-Preview",
      "Qwen/Qwen3.6-Plus",
      "stepfun/Step-3.7-Flash",
      "stepfun/Step-3.5-Flash",
      "tencent/hy3-paid",
      "google/gemini-3.7-flash",
      "google/gemini-3.6-flash",
      "google/gemini-3.5-flash",
      "google/gemini-3.5-flash-lite",
      "google/gemini-3.1-flash-lite",
      "sakana/fugu-ultra",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "thinkingmachines/inkling",
      "thinkingmachines/inkling-small",
      "stealth/ox-alpha",
      "poolside/laguna-s-2.1-free",
      "meta/muse-spark-1.1",
      "meta/muse-spark-1.2",
      "meta/muse-spark-1.2-contributor",
      "xai/grok-4.5",
      "xai/grok-4.6",
    ]);
  });

  it("matches the corrected command-code 1.32.1 source-fact fingerprint", () => {
    const sourceShape = COMMANDCODE_MODEL_FACTS.map((facts) => ({
      id: facts.id,
      name: facts.name,
      description: facts.description,
      input: [...facts.input],
      reasoning: facts.reasoning,
      reasoningEfforts:
        facts.reasoningEfforts === undefined
          ? null
          : [...facts.reasoningEfforts],
      contextWindow: facts.contextWindow,
      maxOutputTokens: facts.maxOutputTokens ?? null,
      minimumPlan: facts.minimumPlan,
    }));
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(sourceShape))
      .digest("hex");

    expect(fingerprint).toBe(
      "bad008a25f1261a97a74baac070774fec82b15c1b9a48dbb3413047b9f1c54cd",
    );
  });

  it("keeps source facts distinct from Pi projection policy", () => {
    const kimi = COMMANDCODE_MODEL_FACTS.find(
      (model) => model.id === "moonshotai/Kimi-K3",
    );
    expect(kimi).toMatchObject({
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    });
    expect(kimi).not.toHaveProperty("reasoningEfforts");
    expect(
      COMMANDCODE_MODEL_FACTS.find((model) => model.id === "claude-sonnet-4-6"),
    ).toMatchObject({
      reasoning: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      minimumPlan: "pro",
    });
    expect(
      COMMANDCODE_MODEL_FACTS.some((model) => model.id === "tencent/Hy3"),
    ).toBe(false);
    expect(
      COMMANDCODE_MODEL_FACTS.some(
        (model) => model.id === "inclusionai/ling-3.0-flash-free",
      ),
    ).toBe(false);
  });

  it("satisfies the current catalog invariants and plan distribution", () => {
    const plans = { go: 0, goat: 0, pro: 0, max: 0 };
    const ids = new Set<string>();
    for (const facts of COMMANDCODE_MODEL_FACTS) {
      ids.add(facts.id);
      plans[facts.minimumPlan] += 1;
      expect(facts.input.length).toBeGreaterThan(0);
      expect(new Set(facts.input).size).toBe(facts.input.length);
      expect(Number.isSafeInteger(facts.contextWindow)).toBe(true);
      expect(facts.contextWindow).toBeGreaterThan(0);
      if (!facts.reasoning) expect(facts).not.toHaveProperty("reasoningEfforts");
      expect(Object.isFrozen(facts)).toBe(true);
      expect(Object.isFrozen(facts.input)).toBe(true);
      if (facts.reasoningEfforts !== undefined) {
        expect(Object.isFrozen(facts.reasoningEfforts)).toBe(true);
      }
    }
    expect(ids.size).toBe(58);
    expect(plans).toEqual({ go: 36, goat: 4, pro: 13, max: 5 });
    expect(Object.isFrozen(COMMANDCODE_MODEL_FACTS)).toBe(true);
  });

  it("keeps verified context and output limits without projection guesses", () => {
    const glm = COMMANDCODE_MODEL_FACTS.find(
      (model) => model.id === "zai-org/GLM-5.1",
    );
    expect(glm).toMatchObject({ contextWindow: 200_000 });
    expect(glm).not.toHaveProperty("maxOutputTokens");
    expect(
      COMMANDCODE_MODEL_FACTS.find((model) => model.id === "Qwen/Qwen3.8-27B"),
    ).toMatchObject({ contextWindow: 262_144, maxOutputTokens: 32_768 });
    expect(
      COMMANDCODE_MODEL_FACTS.find((model) => model.id === "stealth/ox-alpha"),
    ).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 131_072 });
  });

  it("projects every current fact into the CommandCode Private catalog", () => {
    expect(COMMANDCODE_MODELS.map((model) => model.id)).toEqual(
      COMMANDCODE_MODEL_FACTS.map((model) => model.id),
    );
  });

  it("projects CommandCode reasoning as the three explicit Pi states", () => {
    const projection = {
      provider: "fixture",
      api: "openai-completions" as const,
      baseUrl: "https://fixture.test",
    };
    const project = (id: string) => {
      const facts = COMMANDCODE_MODEL_FACTS.find((model) => model.id === id);
      expect(facts).toBeDefined();
      return projectCommandCodeModel(facts!, projection);
    };

    expect(project("claude-haiku-4-5-20251001")).not.toHaveProperty(
      "thinkingLevelMap",
    );
    expect(project("moonshotai/Kimi-K3").thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    });
    expect(project("deepseek/deepseek-v4-flash").thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });
  });

  it("keeps the built-in default model present with its known id", () => {
    const model = findCommandCodeModel("deepseek/deepseek-v4-flash");
    expect(model).toBeDefined();
    expect(model?.reasoning).toBe(true);
    expect(model?.input).toEqual(["text"]);
    expect(model?.maxTokens).toBe(64_000);
  });

  it("uses a model-specific output limit when the official catalog provides one", () => {
    const model = findCommandCodeModel("poolside/laguna-s-2.1-free");
    expect(model?.maxTokens).toBe(32_768);
  });

  it("maps T-only caps to text-only input and no reasoning", () => {
    const model = findCommandCodeModel("zai-org/GLM-5.2-Fast");
    expect(model?.input).toEqual(["text"]);
    expect(model?.reasoning).toBe(false);
  });

  it("maps V caps to image input", () => {
    const model = findCommandCodeModel("meta/muse-spark-1.2");
    expect(model?.input).toEqual(["text", "image"]);
  });

  it("maps R caps to reasoning with the official effort map", () => {
    const model = findCommandCodeModel("deepseek/deepseek-v4-pro");
    expect(model?.reasoning).toBe(true);
    expect(model?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });
  });

  it("marks every selectable effort unsupported when the source lists none", () => {
    const model = findCommandCodeModel("moonshotai/Kimi-K3");
    expect(model?.reasoning).toBe(true);
    expect(model?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    });
  });

  it("does not track volatile upstream prices", () => {
    for (const model of COMMANDCODE_MODELS) {
      expect(model.cost).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
    }
  });

  it("projects only Go and GOAT plan models for CommandCode Goat", () => {
    expect(COMMANDCODE_GOAT_MODELS.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-luna",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash-vision-exp",
      "moonshotai/Kimi-K3",
      "moonshotai/Kimi-K2.7-Code",
      "moonshotai/Kimi-K2.7-Code-Highspeed",
      "moonshotai/Kimi-K2.6",
      "moonshotai/Kimi-K2.5",
      "zai-org/GLM-5.3",
      "zai-org/GLM-5.2",
      "zai-org/GLM-5.2-Fast",
      "zai-org/GLM-5.1",
      "zai-org/GLM-5",
      "MiniMaxAI/MiniMax-M3",
      "MiniMaxAI/MiniMax-M2.7",
      "MiniMaxAI/MiniMax-M2.5",
      "xiaomi/mimo-v2.5-pro",
      "xiaomi/mimo-v2.5",
      "Qwen/Qwen3.8-Max",
      "Qwen/Qwen3.8-27B",
      "Qwen/Qwen3.7-Max",
      "Qwen/Qwen3.7-Plus",
      "Qwen/Qwen3.7-Flash",
      "Qwen/Qwen3.6-Max-Preview",
      "Qwen/Qwen3.6-Plus",
      "stepfun/Step-3.7-Flash",
      "stepfun/Step-3.5-Flash",
      "tencent/hy3-paid",
      "google/gemini-3.7-flash",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "thinkingmachines/inkling",
      "thinkingmachines/inkling-small",
      "stealth/ox-alpha",
      "poolside/laguna-s-2.1-free",
      "meta/muse-spark-1.2",
      "meta/muse-spark-1.2-contributor",
      "xai/grok-4.5",
      "xai/grok-4.6",
    ]);
    expect(COMMANDCODE_GOAT_MODELS[0]).toMatchObject({
      provider: "commandcode-goat",
      api: "openai-completions",
      baseUrl: "https://api.commandcode.ai/provider/v1",
    });
    for (const model of COMMANDCODE_GOAT_MODELS) {
      expect(model.api).toBe("openai-completions");
    }
  });

  it("freezes every model and its nested state", () => {
    for (const model of COMMANDCODE_MODELS) {
      expect(Object.isFrozen(model)).toBe(true);
      expect(Object.isFrozen(model.cost)).toBe(true);
      expect(Object.isFrozen(model.input)).toBe(true);
    }
  });
});
