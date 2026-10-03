import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import {
  normalizeContext,
  type FetchFunction,
  type Model,
} from "@earendil-works/pi-ai";
import { providerPackage } from "@token/provider-deepseek-anthropic";
import { describe, expect, it } from "vitest";

const CONFIGURATION_PATH =
  'providerPackages["@token/provider-deepseek-anthropic"]';

function hostFetch(): FetchFunction {
  return async () => new Response(null, { status: 500 });
}

function createProvider() {
  return providerPackage.createProvider({
    configuration: Object.freeze({}),
    configurationPath: CONFIGURATION_PATH,
    host: Object.freeze({
      fetch: hostFetch(),
      now: () => 1,
      registerLocalOAuth: () => undefined,
      createUuid: () => "00000000-0000-4000-8000-000000000001",
    }),
  });
}

function anthropicStream(events: readonly unknown[]): Response {
  const body = events
    .map((event) => {
      const type = (event as { type: string }).type;
      return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function textStreamEvents(
  text: string,
  thinking: string,
): readonly unknown[] {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_deepseek",
        type: "message",
        role: "assistant",
        model: "deepseek-flash",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 9, output_tokens: 1 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "c2ln" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 9 },
    },
    { type: "message_stop" },
  ];
}

describe("DeepSeek Anthropic Provider Package", () => {
  it("serves the two pi-ai DeepSeek model facts over Anthropic Messages", () => {
    const provider = createProvider();

    expect(provider.id).toBe("deepseek-anthropic");
    expect(provider.name).toBe("DeepSeek (Anthropic)");
    expect(provider.baseUrl).toBe("https://api.deepseek.com/anthropic");

    const models = provider.getModels();
    expect(models.map((model) => model.id)).toEqual([
      "deepseek-flash",
      "deepseek-v4-pro",
    ]);
    for (const model of models) {
      expect(model.api).toBe("anthropic-messages");
      expect(model.provider).toBe("deepseek-anthropic");
      expect(model.baseUrl).toBe("https://api.deepseek.com/anthropic");
      const upstream = deepseekProvider().getModels().find((entry) => entry.id === model.id)!;
      for (const key of ["name", "reasoning", "input", "inputLimits", "cost", "contextWindow", "maxTokens", "thinkingLevelMap", "promptCache"] as const) {
        expect(model[key], key).toEqual(upstream[key]);
      }
      expect(model.compat?.forceAdaptiveThinking).toBe(true);
      expect(model.compat?.supportsLongCacheRetention).toBe(false);
    }

  });

  it("rejects unknown package configuration keys", () => {
    expect(() =>
      providerPackage.createProvider({
        configuration: { baseUrl: "https://example.com" },
        configurationPath: CONFIGURATION_PATH,
        host: {
          fetch: hostFetch(),
          now: () => 1,
          registerLocalOAuth: () => undefined,
          createUuid: () => "00000000-0000-4000-8000-000000000002",
        },
      }),
    ).toThrow(`${CONFIGURATION_PATH}.baseUrl is unknown`);
  });

  it("posts adaptive thinking with output_config.effort to DeepSeek", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const fetchStub: FetchFunction = async (input, init) => {
      capturedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      return anthropicStream(textStreamEvents("Hello", "think"));
    };

    const provider = createProvider();
    const flash = provider
      .getModels()
      .find((model) => model.id === "deepseek-flash") as Model<"anthropic-messages">;
    const stream = provider.streamSimple(
      flash,
      normalizeContext({
        systemPrompt: "You are a helpful assistant.",
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
      }),
      { apiKey: "test-key", reasoning: "high", fetch: fetchStub },
    );

    let text = "";
    let thinking = "";
    for await (const event of stream) {
      if (event.type === "text_delta") text += event.delta;
      if (event.type === "thinking_delta") thinking += event.delta;
      if (event.type === "error") {
        throw new Error(event.error.errorMessage ?? "DeepSeek stream failed");
      }
      if (event.type === "done") break;
    }

    expect(text).toBe("Hello");
    expect(thinking).toBe("think");
    // The Anthropic SDK appends `?beta=true` whenever Pi sends the
    // interleaved-thinking beta header; DeepSeek documents `anthropic-beta`
    // as ignored on `/messages`.
    expect(capturedUrl?.split("?")[0]).toBe(
      "https://api.deepseek.com/anthropic/v1/messages",
    );
    expect(capturedBody?.model).toBe("deepseek-flash");
    expect(capturedBody?.stream).toBe(true);
    expect(capturedBody?.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
    expect(capturedBody?.output_config).toEqual({ effort: "high" });
    expect(JSON.stringify(capturedBody?.system)).toContain(
      "You are a helpful assistant.",
    );
  });
});
