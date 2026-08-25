import { providerPackage } from "@luckytoken/provider-commandcode-goat";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { findUpstreamFailureFact } from "@luckytoken/provider-contract/diagnostics";
import { describe, expect, it } from "vitest";

function openAICompletion(text: string): Response {
  const chunks = [
    {
      id: "chatcmpl-commandcode-goat",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek/deepseek-v4-flash",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-commandcode-goat",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek/deepseek-v4-flash",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 4,
        completion_tokens: 2,
        total_tokens: 6,
        prompt_tokens_details: {
          cached_tokens: 1,
          audio_tokens: 0,
        },
        completion_tokens_details: { reasoning_tokens: 1 },
        cache_creation_input_tokens: 1,
      },
    },
  ];
  const bytes = new TextEncoder().encode(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("")}data: [DONE]\r\n\r\n`,
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 13) {
        controller.enqueue(bytes.slice(offset, offset + 13));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("CommandCode Goat Provider Package", () => {
  it("exposes an independent OpenAI Completions Provider over the shared catalog", () => {
    const provider = providerPackage.createProvider({
      configuration: {},
      configurationPath:
        'providerPackages["@luckytoken/provider-commandcode-goat"]',
      host: {
        fetch: async () => new Response(null, { status: 500 }),
        now: () => 1,
        createUuid: () => "00000000-0000-4000-8000-000000000101",
      },
    });

    expect(provider.id).toBe("commandcode-goat");
    expect(provider.name).toBe("CommandCode Goat");
    expect(provider.getModels()).toHaveLength(40);
    expect(provider.getModels()[0]).toMatchObject({
      provider: "commandcode-goat",
      api: "openai-completions",
      baseUrl: "https://api.commandcode.ai/provider/v1",
    });
  });

  it("sends Bearer-authenticated requests through the host transport to chat/completions", async () => {
    const requests: Request[] = [];
    const fetch: FetchFunction = async (input, init) => {
      requests.push(new Request(input, init));
      return openAICompletion("hello from goat");
    };
    const provider = providerPackage.createProvider({
      configuration: {},
      configurationPath:
        'providerPackages["@luckytoken/provider-commandcode-goat"]',
      host: {
        fetch,
        now: () => 1,
        createUuid: () => "00000000-0000-4000-8000-000000000102",
      },
    });
    const model = provider
      .getModels()
      .find((entry) => entry.id === "deepseek/deepseek-v4-flash");
    expect(model).toBeDefined();

    const result = await provider
      .streamSimple(
        model!,
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
              timestamp: 1,
            },
          ],
        },
        { apiKey: "goat-secret", maxTokens: 32 },
      )
      .result();

    expect(result.content).toEqual([
      { type: "text", text: "hello from goat" },
    ]);
    expect(result.usage).toMatchObject({
      input: 3,
      cacheRead: 1,
      output: 2,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://api.commandcode.ai/provider/v1/chat/completions",
    );
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer goat-secret",
    );
    expect(requests[0]?.headers.get("x-cmd-zdr")).toBe("1");
    await expect(requests[0]?.json()).resolves.toMatchObject({
      model: "deepseek/deepseek-v4-flash",
      stream: true,
    });
  });

  it("sends only reasoning efforts declared by the projected model", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch: FetchFunction = async (input, init) => {
      bodies.push((await new Request(input, init).json()) as Record<string, unknown>);
      return openAICompletion("reasoning result");
    };
    const provider = providerPackage.createProvider({
      configuration: {},
      configurationPath:
        'providerPackages["@luckytoken/provider-commandcode-goat"]',
      host: {
        fetch,
        now: () => 1,
        createUuid: () => "00000000-0000-4000-8000-000000000104",
      },
    });
    const context = {
      messages: [{ role: "user" as const, content: "hello", timestamp: 1 }],
    };
    const deepSeek = provider
      .getModels()
      .find((entry) => entry.id === "deepseek/deepseek-v4-flash");
    const kimi = provider
      .getModels()
      .find((entry) => entry.id === "moonshotai/Kimi-K3");
    expect(deepSeek).toBeDefined();
    expect(kimi).toBeDefined();

    await provider
      .streamSimple(deepSeek!, context, {
        apiKey: "goat-secret",
        maxTokens: 32,
        reasoning: "low",
      })
      .result();
    await provider
      .streamSimple(kimi!, context, {
        apiKey: "goat-secret",
        maxTokens: 32,
        reasoning: "high",
      })
      .result();

    expect(bodies[0]?.reasoning_effort).toBe("high");
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
  });

  it("keeps Goat credentials under its own Provider auth interface", async () => {
    const provider = providerPackage.createProvider({
      configuration: {},
      configurationPath:
        'providerPackages["@luckytoken/provider-commandcode-goat"]',
      host: {
        fetch: async () => new Response(null, { status: 500 }),
        now: () => 1,
        createUuid: () => "00000000-0000-4000-8000-000000000103",
      },
    });
    const signal = new AbortController().signal;

    await expect(
      provider.auth.apiKey?.resolve({
        ctx: { env: async () => undefined, fileExists: async () => false },
        credential: { type: "api_key", key: "stored-goat-key" },
        signal,
      }),
    ).resolves.toMatchObject({
      auth: { apiKey: "stored-goat-key" },
      source: "stored credential",
    });
  });

  it("attaches the Pi adapter error as a neutral upstream-stream failure", async () => {
    const provider = providerPackage.createProvider({
      configuration: {},
      configurationPath:
        'providerPackages["@luckytoken/provider-commandcode-goat"]',
      host: {
        fetch: async () =>
          new Response(
            'data: {"id":"chatcmpl-truncated","object":"chat.completion.chunk","created":1,"model":"deepseek/deepseek-v4-flash","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        now: () => 1,
        createUuid: () => "00000000-0000-4000-8000-000000000105",
      },
    });
    const model = provider
      .getModels()
      .find((entry) => entry.id === "deepseek/deepseek-v4-flash");
    expect(model).toBeDefined();

    const events = [];
    for await (const event of provider.streamSimple(
      model!,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { apiKey: "goat-secret", maxTokens: 32 },
    )) {
      events.push(event);
    }
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("error");
    if (terminal?.type !== "error") throw new Error("expected error terminal");
    expect(terminal.error.errorMessage).toContain(
      "Stream ended without finish_reason",
    );
    expect(findUpstreamFailureFact(terminal.error.diagnostics)).toMatchObject({
      kind: "upstream_stream",
      message: terminal.error.errorMessage,
    });
  });

});
