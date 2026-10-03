import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import {
  normalizeContext,
  type FetchFunction,
  type Model,
} from "@earendil-works/pi-ai";
import { providerPackage } from "@token/provider-deepseek-response";
import { describe, expect, it } from "vitest";

const CONFIGURATION_PATH =
  'providerPackages["@token/provider-deepseek-response"]';

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

function responsesStream(events: readonly unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function textStreamEvents(text: string): readonly unknown[] {
  return [
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp_deepseek" },
    },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: {
        type: "message",
        id: "msg_deepseek",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 2,
      output_index: 0,
      content_index: 0,
      item_id: "msg_deepseek",
      delta: text,
    },
    {
      type: "response.output_item.done",
      sequence_number: 3,
      output_index: 0,
      item: {
        type: "message",
        id: "msg_deepseek",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      sequence_number: 4,
      response: {
        id: "resp_deepseek",
        status: "completed",
        usage: {
          input_tokens: 9,
          output_tokens: 2,
          total_tokens: 11,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ];
}

describe("DeepSeek Responses Provider Package", () => {
  it("serves the two pi-ai DeepSeek model facts over the Responses API", () => {
    const provider = createProvider();

    expect(provider.id).toBe("deepseek-response");
    expect(provider.name).toBe("DeepSeek (Responses)");
    expect(provider.baseUrl).toBe("https://api.deepseek.com");

    const models = provider.getModels();
    expect(models.map((model) => model.id)).toEqual([
      "deepseek-flash",
      "deepseek-v4-pro",
    ]);
    for (const model of models) {
      expect(model.api).toBe("openai-responses");
      expect(model.provider).toBe("deepseek-response");
      expect(model.baseUrl).toBe("https://api.deepseek.com");
      const upstream = deepseekProvider().getModels().find((entry) => entry.id === model.id)!;
      for (const key of ["name", "reasoning", "input", "inputLimits", "cost", "contextWindow", "maxTokens", "thinkingLevelMap", "promptCache"] as const) {
        expect(model[key], key).toEqual(upstream[key]);
      }
      expect(model.compat?.supportsDeveloperRole).toBe(false);
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

  it("posts the Pi Responses request to the documented DeepSeek endpoint", async () => {
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
      return responsesStream(textStreamEvents("Hello"));
    };

    const provider = createProvider();
    const flash = provider
      .getModels()
      .find((model) => model.id === "deepseek-flash") as Model<"openai-responses">;
    const stream = provider.streamSimple(
      flash,
      normalizeContext({
        systemPrompt: "You are a helpful assistant.",
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
      }),
      { apiKey: "test-key", fetch: fetchStub },
    );

    let text = "";
    for await (const event of stream) {
      if (event.type === "text_delta") text += event.delta;
      if (event.type === "error") {
        throw new Error(event.error.errorMessage ?? "DeepSeek stream failed");
      }
      if (event.type === "done") break;
    }

    expect(text).toBe("Hello");
    expect(capturedUrl).toBe("https://api.deepseek.com/responses");
    expect(capturedBody?.model).toBe("deepseek-flash");
    expect(capturedBody?.stream).toBe(true);
    expect(capturedBody?.store).toBe(false);
    expect(capturedBody?.reasoning).toEqual({ effort: "none" });

    const input = capturedBody?.input as ReadonlyArray<Record<string, unknown>>;
    expect(input[0]?.role).toBe("system");
    expect(input.some((item) => item.role === "developer")).toBe(false);
  });
});
