import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  COMMANDCODE_MODEL_FACTS,
  freezeCommandCodeModelFacts,
  projectCommandCodeModel,
  selectCommandCodeModelApi,
} from "@token/commandcode-model-catalog";
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
      "gpt-6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.4-mini",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4.1-flash",
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
      "xiaomi/mimo-v2.6-flash",
      "xiaomi/mimo-v2.6-pro",
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
      "poolside/laguna-s-2.1-free",
      "meta/muse-spark-1.1",
      "meta/muse-spark-1.2",
      "meta/muse-spark-1.2-contributor",
      "xai/grok-4.5",
      "xai/grok-4.6",
    ]);
  });

  it("matches the current CommandCode source-fact fingerprint", () => {
    const sourceShape = COMMANDCODE_MODEL_FACTS.map((facts) => ({
      id: facts.id,
      supportedEndpoints: [...facts.supportedEndpoints],
      name: facts.name,
      description: facts.description,
      input: [...facts.input],
      reasoning: facts.reasoning,
      thinkingLevelMap:
        facts.thinkingLevelMap === undefined
          ? null
          : { ...facts.thinkingLevelMap },
      contextWindow: facts.contextWindow,
      maxOutputTokens: facts.maxOutputTokens ?? null,
      minimumPlan: facts.minimumPlan,
    }));
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(sourceShape))
      .digest("hex");

    expect(fingerprint).toBe(
      "5a0ad83bc7af7b76a84e08ff68aaab1bfc3f0dfa72804b0dd2c292c82fd801ae",
    );
  });

  it("stores one reviewed Pi API selection per CommandCode model", () => {
    const byId = new Map(
      COMMANDCODE_MODEL_FACTS.map((model) => [model.id, model] as const),
    );

    expect(selectCommandCodeModelApi(byId.get("claude-sonnet-5")!)).toBe(
      "anthropic-messages",
    );
    expect(selectCommandCodeModelApi(byId.get("gpt-5.6-sol")!)).toBe(
      "openai-responses",
    );
    expect(
      selectCommandCodeModelApi(byId.get("deepseek/deepseek-v4.1-flash")!),
    ).toBe("openai-responses");
    expect(
      selectCommandCodeModelApi(byId.get("xiaomi/mimo-v2.6-flash")!),
    ).toBe("openai-responses");
    expect(
      selectCommandCodeModelApi(byId.get("stepfun/Step-3.5-Flash")!),
    ).toBe("openai-completions");
    expect(
      selectCommandCodeModelApi(byId.get("google/gemini-3.7-flash")!),
    ).toBe("openai-completions");
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
    expect(kimi?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    });
    expect(
      COMMANDCODE_MODEL_FACTS.find(
        (model) => model.id === "xiaomi/mimo-v2.6-flash",
      ),
    ).toMatchObject({
      supportedEndpoints: ["/chat/completions", "/responses"],
      name: "MiMo V2.6 Flash",
      description: "efficient long-context agentic coding",
      input: ["text", "image"],
      reasoning: false,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    });
    expect(
      COMMANDCODE_MODEL_FACTS.find((model) => model.id === "claude-sonnet-4-6"),
    ).toMatchObject({
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
      minimumPlan: "pro",
    });
    expect(
      COMMANDCODE_MODEL_FACTS.some((model) => model.id === "tencent/Hy3"),
    ).toBe(false);
    expect(
      COMMANDCODE_MODEL_FACTS.some((model) => model.id === "stealth/ox-alpha"),
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
      expect(facts.supportedEndpoints.length).toBeGreaterThan(0);
      expect(() => selectCommandCodeModelApi(facts)).not.toThrow();
      if (!facts.reasoning) expect(facts).not.toHaveProperty("thinkingLevelMap");
      expect(Object.isFrozen(facts)).toBe(true);
      expect(Object.isFrozen(facts.input)).toBe(true);
      if (facts.thinkingLevelMap !== undefined) {
        expect(Object.isFrozen(facts.thinkingLevelMap)).toBe(true);
      }
    }
    expect(ids.size).toBe(57);
    expect(plans).toEqual({ go: 35, goat: 4, pro: 13, max: 5 });
    expect(Object.isFrozen(COMMANDCODE_MODEL_FACTS)).toBe(true);
  });

  it("stores every reasoning capability as one explicit complete Pi level map", () => {
    const keys = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    for (const facts of COMMANDCODE_MODEL_FACTS) {
      if (!facts.reasoning) {
        expect(facts).not.toHaveProperty("thinkingLevelMap");
        continue;
      }
      const thinkingLevelMap = facts.thinkingLevelMap;
      expect(thinkingLevelMap).toBeDefined();
      if (thinkingLevelMap === undefined) throw new Error("missing level map");
      expect(Object.keys(thinkingLevelMap)).toEqual(keys);
      const allowed = new Set(["low", "medium", "high", "xhigh", "max"]);
      expect(thinkingLevelMap.off).toBeNull();
      expect(Object.values(thinkingLevelMap).every(
        (value) => value === null || allowed.has(value),
      )).toBe(true);
    }
  });

  it("rejects invalid in-memory reasoning mappings before projection", () => {
    expect(() =>
      freezeCommandCodeModelFacts([
        {
          id: "invalid-reasoning-map",
          supportedEndpoints: ["/responses"],
          name: "Invalid",
          description: "invalid reasoning map fixture",
          input: ["text"],
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: "bogus" as never,
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
            max: "max",
          },
          contextWindow: 100_000,
          minimumPlan: "go",
        },
      ]),
    ).toThrow(/invalid level map/u);
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
    expect(project("deepseek/deepseek-v4.1-flash").thinkingLevelMap).toEqual({
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
    const model = findCommandCodeModel("deepseek/deepseek-v4.1-flash");
    expect(model).toBeDefined();
    expect(model?.reasoning).toBe(true);
    expect(model?.input).toEqual(["text", "image"]);
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
      "gpt-6-luna",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4.1-flash",
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
      "xiaomi/mimo-v2.6-flash",
      "xiaomi/mimo-v2.6-pro",
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
      "poolside/laguna-s-2.1-free",
      "meta/muse-spark-1.2",
      "meta/muse-spark-1.2-contributor",
      "xai/grok-4.5",
      "xai/grok-4.6",
    ]);
    const sourceById = new Map(
      COMMANDCODE_MODEL_FACTS.map((model) => [model.id, model] as const),
    );
    for (const model of COMMANDCODE_GOAT_MODELS) {
      expect(model.provider).toBe("commandcode-goat");
      expect(model.api).toBe(
        selectCommandCodeModelApi(sourceById.get(model.id)!),
      );
      expect(model.baseUrl).toBe("https://api.commandcode.ai/provider/v1");
    }
  });

  it("keeps Goat compat specific to the selected Pi API", () => {
    const responses = COMMANDCODE_GOAT_MODELS.find(
      (model) => model.id === "deepseek/deepseek-v4.1-flash",
    );
    const completions = COMMANDCODE_GOAT_MODELS.find(
      (model) => model.id === "google/gemini-3.7-flash",
    );

    expect(responses).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.commandcode.ai/provider/v1",
    });
    expect(responses).not.toHaveProperty("compat");
    expect(completions).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      compat: {
        thinkingFormat: "openai",
        supportsReasoningEffort: true,
      },
    });
  });

  it("keeps CommandCode Private on its own API despite shared selected APIs", () => {
    const privateClaude = COMMANDCODE_MODELS.find(
      (model) => model.id === "claude-sonnet-5",
    );
    const privateResponses = COMMANDCODE_MODELS.find(
      (model) => model.id === "gpt-5.6-sol",
    );

    expect(privateClaude?.api).toBe("commandcode-private");
    expect(privateResponses?.api).toBe("commandcode-private");
  });

  it("freezes every model and its nested state", () => {
    for (const model of COMMANDCODE_MODELS) {
      expect(Object.isFrozen(model)).toBe(true);
      expect(Object.isFrozen(model.cost)).toBe(true);
      expect(Object.isFrozen(model.input)).toBe(true);
    }
  });
});
