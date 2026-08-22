import { providerPackage } from "@luckytoken/provider-commandcode-goat";
import type { FetchFunction } from "@earendil-works/pi-ai";
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
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    },
  ];
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
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
    expect(provider.getModels()).toHaveLength(33);
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
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://api.commandcode.ai/provider/v1/chat/completions",
    );
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer goat-secret",
    );
    await expect(requests[0]?.json()).resolves.toMatchObject({
      model: "deepseek/deepseek-v4-flash",
      stream: true,
    });
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
});
