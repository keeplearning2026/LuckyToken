import {
  clampThinkingLevel,
  createModels,
  getSupportedThinkingLevels,
  normalizeContext,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAICodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

import type { CodexNativeCatalogSnapshot } from "../../src/integrations/codex/native-catalog-source.js";
import type { CodexNativeCatalogEntry } from "../../src/integrations/codex/native-catalog-source.js";
import {
  buildCodexModelCandidates,
  type CodexPiModelLike,
} from "../../src/integrations/codex/codex-model-candidates.js";
import { applyAutomaticModelOverlay } from "../../src/providers/automatic-model-overlay.js";
import { registerTokenProviders } from "../../src/providers/catalog.js";
import { createConfigValueResolver } from "../../src/providers/config-value.js";
import type { ModelsJsonModel } from "../../src/providers/models-json-schema.js";
import { captureFinalPiPayload } from "../support/pi-final-payload.js";

const PROVIDER_ID = "openai-codex";
type CodexApiModel = Model<"openai-codex-responses">;
const REASONING_MODEL_ID = "gpt-9.9-sol";
const PLAIN_MODEL_ID = "gpt-9.9-luna-probe";

const codexToken = `x.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" },
  }),
).toString("base64url")}.x`;

function piModels(): readonly CodexPiModelLike[] {
  const provider = builtinProviders().find((builtin) => builtin.id === PROVIDER_ID);
  if (provider === undefined) throw new Error("Pi bundled openai-codex provider is missing");
  return provider.getModels();
}

function nativeSnapshot(
  models: readonly CodexNativeCatalogEntry[],
): CodexNativeCatalogSnapshot {
  return Object.freeze({
    source: "bundled" as const,
    runtimeIdentity: Object.freeze({
      command: "codex",
      version: "0.159.2",
      codexHome: "C:\\test-codex-home",
    }),
    entries: Object.freeze(
      models.map((entry) => Object.freeze({ ...entry }) as CodexNativeCatalogEntry),
    ),
    warnings: Object.freeze([]),
    generation: "native-generation-a",
  });
}

const reasoningNativeRow: CodexNativeCatalogEntry = Object.freeze({
  slug: REASONING_MODEL_ID,
  display_name: "Probe Reasoner",
  visibility: "list",
  supported_in_api: true,
  supported_reasoning_levels: [
    { effort: "low", description: "Low" },
    { effort: "medium", description: "Medium" },
    { effort: "high", description: "High" },
  ],
  input_modalities: ["text", "image"],
  context_window: 1_050_000,
});

const plainNativeRow: CodexNativeCatalogEntry = Object.freeze({
  slug: PLAIN_MODEL_ID,
  display_name: "Probe Plain",
  visibility: "list",
  supported_in_api: true,
  supported_reasoning_levels: [],
  input_modalities: ["text"],
  context_window: 128_000,
});

function candidateModels(): {
  readonly reasoning: ModelsJsonModel;
  readonly plain: ModelsJsonModel;
} {
  const generation = buildCodexModelCandidates({
    snapshot: nativeSnapshot([reasoningNativeRow, plainNativeRow]),
    piModels: piModels(),
  });
  const reasoning = generation.candidates.find((candidate) => candidate.id === REASONING_MODEL_ID);
  const plain = generation.candidates.find((candidate) => candidate.id === PLAIN_MODEL_ID);
  if (reasoning === undefined || plain === undefined) {
    throw new Error("the probe native rows were not appended");
  }
  return { reasoning, plain };
}

/** The served catalog registration path: real Pi builtins composed with the
 * automatic overlay, exactly like the Backend runtime. */
function servedModels(): {
  readonly models: ReturnType<typeof createModels>;
  readonly reasoning: CodexApiModel;
  readonly plain: CodexApiModel;
} {
  const models = createModels();
  // Building the candidates proves both probe rows are appendable before the
  // real registration path is exercised.
  candidateModels();
  registerTokenProviders(models, {
    modelsJson: {
      providers: applyAutomaticModelOverlay({
        providers: Object.freeze({}),
        overlay: buildCodexModelCandidates({
          snapshot: nativeSnapshot([reasoningNativeRow, plainNativeRow]),
          piModels: piModels(),
        }),
        providerId: PROVIDER_ID,
      }) as never,
    },
    configValues: createConfigValueResolver({ envSource: () => undefined }),
  });
  const served = models.getModels(PROVIDER_ID);
  const servedReasoning = served.find((model) => model.id === REASONING_MODEL_ID);
  const servedPlain = served.find((model) => model.id === PLAIN_MODEL_ID);
  if (servedReasoning === undefined || servedPlain === undefined) {
    throw new Error("the overlay did not register the probe models");
  }
  return {
    models,
    reasoning: servedReasoning as CodexApiModel,
    plain: servedPlain as CodexApiModel,
  };
}

function toolContext(messages: Context["messages"]) {
  return normalizeContext({ messages });
}

async function payloadFor(
  model: CodexApiModel,
  context: ReturnType<typeof normalizeContext>,
  options: { readonly reasoning?: string } = {},
): Promise<Record<string, unknown>> {
  const payload = await captureFinalPiPayload((onPayload) =>
    streamOpenAICodexResponses(model, context, {
      apiKey: codexToken,
      maxTokens: 128,
      ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning as never }),
      onPayload,
    }),
  );
  expect(payload).toBeTypeOf("object");
  return payload as Record<string, unknown>;
}

describe("appended openai-codex model certification", () => {
  it("registers the native union without modifying Pi's bundled models", () => {
    const before = piModels().map((model) => model.id).sort();
    const { models, reasoning, plain } = servedModels();
    const servedIds = models.getModels(PROVIDER_ID).map((model) => model.id);

    expect(servedIds).toEqual(
      expect.arrayContaining([...before, REASONING_MODEL_ID, PLAIN_MODEL_ID]),
    );
    expect(reasoning.api).toBe("openai-codex-responses");
    expect(reasoning.baseUrl).toBe("https://chatgpt.com/backend-api");
    expect(reasoning.compat).toMatchObject({ supportsStrictMode: false });
    expect(plain.compat).toMatchObject({ supportsStrictMode: false });
    // Pi's own bundled model facts are unchanged by the composition.
    expect(piModels().map((model) => model.id).sort()).toEqual(before);
  });

  it("exposes exactly the native reasoning ladder through Pi's public helpers", () => {
    const { reasoning, plain } = servedModels();

    expect(getSupportedThinkingLevels(reasoning)).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    // `null` (not omission) is what removes a level: no provider default can
    // be sent for off/xhigh/max on this native row.
    expect(reasoning.thinkingLevelMap).toMatchObject({
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    });
    expect(getSupportedThinkingLevels(plain)).toEqual(["off"]);
  });

  it("sends the mapped effort for every enabled level through the real adapter", async () => {
    const { reasoning } = servedModels();
    const context = toolContext([{ role: "user", content: "hello", timestamp: 1 }]);
    const expected = { minimal: "low", low: "low", medium: "medium", high: "high" } as const;

    for (const level of getSupportedThinkingLevels(reasoning)) {
      if (level === "off") continue;
      expect(clampThinkingLevel(reasoning, level)).toBe(level);
      const payload = await payloadFor(reasoning, context, { reasoning: level });
      expect(payload.reasoning, `level ${level}`).toEqual({
        effort: expected[level as keyof typeof expected],
        summary: "auto",
      });
    }

    // A level the native ladder does not carry is clamped to a certified one
    // instead of being sent as an unverified raw effort.
    expect(clampThinkingLevel(reasoning, "xhigh")).toBe("high");
    expect(clampThinkingLevel(reasoning, "max")).toBe("high");
    const clamped = await payloadFor(reasoning, context, { reasoning: "xhigh" });
    expect(clamped.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("requests no reasoning level when the Client omits it", async () => {
    const { reasoning, plain } = servedModels();
    const context = toolContext([{ role: "user", content: "hello", timestamp: 1 }]);

    // The plan's reasoning contract: omission means no level is requested
    // through Pi, so the adapter must not synthesize a provider default.
    const reasoningPayload = await payloadFor(reasoning, context);
    expect(reasoningPayload.reasoning).toBeUndefined();

    const plainPayload = await payloadFor(plain, context);
    expect(plainPayload.reasoning).toBeUndefined();
  });

  it("does not claim strict tool constraints from the conservative compat set", async () => {
    const { reasoning } = servedModels();
    const context = normalizeContext({
      messages: [{ role: "user", content: "use the tool", timestamp: 1 }],
      tools: [
        {
          name: "probe_tool",
          description: "probe",
          parameters: { type: "object", properties: { value: { type: "string" } } },
        },
      ],
    });

    const payload = await payloadFor(reasoning, context);
    const tools = payload.tools as readonly Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: "function", name: "probe_tool" });
    expect(Object.hasOwn(tools[0]!, "strict")).toBe(false);
  });

  it("copies compat only from a same-generation sibling, and the copied true is certified", async () => {
    // Same-generation sibling: both ids reduce to the `gpt-9.9` generation.
    const sibling: CodexPiModelLike = {
      id: "gpt-9.9-luna",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      compat: { supportsStrictMode: true },
      maxTokens: 4_096,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    };
    const generation = buildCodexModelCandidates({
      snapshot: nativeSnapshot([reasoningNativeRow]),
      piModels: [sibling],
    });
    const candidate = generation.candidates.find(
      (entry) => entry.id === REASONING_MODEL_ID,
    );
    expect(candidate).toBeDefined();
    expect(generation.evidence[0]).toMatchObject({
      source: "same-generation-sibling",
      siblingId: "gpt-9.9-luna",
    });
    expect(candidate?.compat).toMatchObject({ supportsStrictMode: true });
    expect(candidate?.maxTokens).toBe(4_096);

    const model = {
      id: candidate!.id,
      name: candidate!.name ?? candidate!.id,
      api: candidate!.api!,
      provider: PROVIDER_ID,
      baseUrl: candidate!.baseUrl!,
      reasoning: candidate!.reasoning ?? false,
      ...(candidate!.thinkingLevelMap === undefined
        ? {}
        : { thinkingLevelMap: candidate!.thinkingLevelMap }),
      input: candidate!.input ?? ["text"],
      cost: candidate!.cost!,
      contextWindow: candidate!.contextWindow!,
      maxTokens: candidate!.maxTokens!,
      compat: candidate!.compat!,
    } as CodexApiModel;
    const context = normalizeContext({
      messages: [{ role: "user", content: "use the tool", timestamp: 1 }],
      tools: [
        {
          name: "probe_tool",
          description: "probe",
          parameters: { type: "object", properties: {} },
        },
      ],
    });

    const payload = await payloadFor(model, context);
    const tools = payload.tools as readonly Record<string, unknown>[];
    expect(Object.hasOwn(tools[0]!, "strict")).toBe(true);
  });

  it("round-trips a normal tool call and its output", async () => {
    const { reasoning } = servedModels();
    const context = toolContext([
      {
        role: "assistant",
        api: "openai-codex-responses",
        provider: PROVIDER_ID,
        model: REASONING_MODEL_ID,
        timestamp: 1,
        stopReason: "toolUse",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: [
          {
            type: "toolCall",
            id: "call_probe|fc_probe",
            name: "probe_tool",
            arguments: { value: "hello" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_probe|fc_probe",
        toolName: "probe_tool",
        timestamp: 2,
        isError: false,
        content: [{ type: "text", text: "probe output" }],
      },
    ]);

    const payload = await payloadFor(reasoning, context);
    const input = payload.input as readonly Record<string, unknown>[];
    const call = input.find((item) => item.type === "function_call");
    const output = input.find((item) => item.type === "function_call_output");
    expect(call).toMatchObject({ name: "probe_tool", call_id: "call_probe" });
    expect(output).toMatchObject({ call_id: "call_probe" });
  });

  it("carries an image for an image-capable appended model", async () => {
    const { reasoning, plain } = servedModels();
    const imageContext = toolContext([
      {
        role: "user",
        timestamp: 1,
        content: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/png", data: "QUJD" },
        ],
      },
    ]);

    const payload = await payloadFor(reasoning, imageContext);
    const input = payload.input as readonly Record<string, unknown>[];
    const content = input[0]?.content as readonly Record<string, unknown>[];
    expect(content).toContainEqual({
      type: "input_image",
      image_url: "data:image/png;base64,QUJD",
      detail: "auto",
    });

    // The text-only sibling never claims image input.
    expect(plain.input).toEqual(["text"]);
  });

  it("replays the complete thinking/text/tool-call attachment on the next request", async () => {
    const { reasoning } = servedModels();
    const reasoningItem = {
      type: "reasoning",
      id: "rs_probe",
      encrypted_content: "encrypted-probe",
      summary: [],
    };
    const context = toolContext([
      {
        role: "assistant",
        api: "openai-codex-responses",
        provider: PROVIDER_ID,
        model: REASONING_MODEL_ID,
        timestamp: 1,
        stopReason: "toolUse",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: [
          {
            type: "thinking",
            thinking: "probe reasoning",
            thinkingSignature: JSON.stringify(reasoningItem),
          },
          {
            type: "text",
            text: "probe answer",
            textSignature: JSON.stringify({ v: 1, id: "msg_probe" }),
          },
          {
            type: "toolCall",
            id: "call_probe|fc_probe",
            name: "probe_tool",
            arguments: { value: "hello" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_probe|fc_probe",
        toolName: "probe_tool",
        timestamp: 2,
        isError: false,
        content: [{ type: "text", text: "probe output" }],
      },
      { role: "user", content: "continue", timestamp: 3 },
    ]);

    const payload = await payloadFor(reasoning, context);
    const input = payload.input as readonly Record<string, unknown>[];

    expect(input).toContainEqual(reasoningItem);
    const message = input.find(
      (item) => item.type === "message" && item.role === "assistant",
    );
    expect(message).toMatchObject({
      id: "msg_probe",
      content: [{ type: "output_text", text: "probe answer" }],
    });
    expect(
      input.find((item) => item.type === "function_call"),
    ).toMatchObject({ call_id: "call_probe" });
    expect(
      input.find((item) => item.type === "function_call_output"),
    ).toMatchObject({ call_id: "call_probe" });
  });
});
