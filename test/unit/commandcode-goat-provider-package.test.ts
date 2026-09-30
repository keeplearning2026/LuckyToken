import { providerPackage } from "@token/provider-commandcode-goat";
import {
  COMMANDCODE_MODEL_CATALOG_SCHEMA,
  DEFAULT_COMMANDCODE_MODEL_CATALOG,
} from "@token/commandcode-model-catalog";
import { normalizeContext, type FetchFunction } from "@earendil-works/pi-ai";
import { findUpstreamFailureFact } from "@token/provider-contract/diagnostics";
import { describe, expect, it } from "vitest";

function packageConfiguration(
  catalog: unknown = DEFAULT_COMMANDCODE_MODEL_CATALOG,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    catalog,
    provider: Object.freeze({}),
  });
}

function openAICompletion(
  text: string,
  model = "google/gemini-3.7-flash",
): Response {
  const chunks = [
    {
      id: "chatcmpl-commandcode-goat",
      object: "chat.completion.chunk",
      created: 1,
      model,
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
      model,
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
  it("exposes a mixed-API Provider over the shared selected catalog", () => {
    const provider = providerPackage.createProvider({
      configuration: packageConfiguration(),
      configurationPath:
        'providerPackages["@token/provider-commandcode-goat"]',
      host: {
        fetch: async () => new Response(null, { status: 500 }),
        now: () => 1,
        createUuid: () => "00000000-0000-4000-8000-000000000101",
      },
    });

    expect(provider.id).toBe("commandcode-goat");
    expect(provider.name).toBe("CommandCode Goat");
    expect(provider.getModels()).toHaveLength(39);
    expect(provider.getModels()[0]).toMatchObject({
      provider: "commandcode-goat",
      api: "openai-responses",
      baseUrl: "https://api.commandcode.ai/provider/v1",
    });
    expect(
      provider
        .getModels()
        .find((model) => model.id === "google/gemini-3.7-flash"),
    ).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://api.commandcode.ai/provider/v1",
    });
  });

  it("uses the explicit endpoint even when Responses is also supported", () => {
    const provider = providerPackage.createProvider({
      configuration: packageConfiguration({
        schema: COMMANDCODE_MODEL_CATALOG_SCHEMA,
        models: [
          {
            id: "explicit-chat",
            name: "Explicit Chat",
            description: "explicit Goat endpoint fixture",
            supportedEndpoints: ["/chat/completions", "/responses"],
            endpoint: "/chat/completions",
            input: ["text"],
            reasoning: false,
            contextWindow: 100_000,
            minimumPlan: "go",
          },
        ],
      }),
      configurationPath: "commandcode-models.json",
      host: {
        fetch: async () => new Response(null, { status: 500 }),
        now: () => 1,
        createUuid: () => "00000000-0000-4000-8000-000000000108",
      },
    });

    expect(provider.getModels()[0]).toMatchObject({
      id: "explicit-chat",
      api: "openai-completions",
      compat: {
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
        thinkingFormat: "openai",
        supportsReasoningEffort: true,
      },
    });
  });

  it("dispatches Responses-selected models through the Pi Responses API", async () => {
    const requests: Request[] = [];
    const fetch: FetchFunction = async (input, init) => {
      requests.push(new Request(input, init));
      return new Response('{"error":{"message":"captured"}}', {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };
    const provider = providerPackage.createProvider({
      configuration: packageConfiguration(),
      configurationPath:
        'providerPackages["@token/provider-commandcode-goat"]',
      host: {
        fetch,
        now: () => 1,
        createUuid: () => "00000000-0000-4000-8000-000000000106",
      },
    });
    const model = provider
      .getModels()
      .find((entry) => entry.id === "deepseek/deepseek-v4.1-flash");
    expect(model).toMatchObject({ api: "openai-responses" });

    for await (const event of provider.streamSimple(
      model!,
      normalizeContext({
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
      }),
      { apiKey: "goat-secret", maxTokens: 32 },
    )) {
      void event;
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://api.commandcode.ai/provider/v1/responses",
    );
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer goat-secret",
    );
    await expect(requests[0]?.json()).resolves.toMatchObject({
      model: "deepseek/deepseek-v4.1-flash",
      stream: true,
    });
  });

  it("carries declared user images onto both OpenAI-shaped provider wires", async () => {
    const responsesBodies: Array<Record<string, unknown>> = [];
    const responsesProvider = providerPackage.createProvider({
      configuration: packageConfiguration(),
      configurationPath:
        'providerPackages["@token/provider-commandcode-goat"]',
      host: {
        fetch: async (input, init) => {
          responsesBodies.push(
            (await new Request(input, init).json()) as Record<string, unknown>,
          );
          return new Response('{"error":{"message":"captured"}}', {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        },
        now: () => 1,
        createUuid: () => "00000000-0000-4000-8000-000000000109",
      },
    });
    const responsesModel = responsesProvider
      .getModels()
      .find((entry) => entry.id === "deepseek/deepseek-v4.1-flash");
    expect(responsesModel).toMatchObject({ api: "openai-responses" });

    for await (const event of responsesProvider.streamSimple(
      responsesModel!,
      normalizeContext({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image", mimeType: "image/png", data: "AA==" },
            ],
            timestamp: 1,
          },
        ],
      }),
      { apiKey: "goat-secret", maxTokens: 32 },
    )) {
      void event;
    }

    expect(responsesBodies).toHaveLength(1);
    expect(responsesBodies[0]?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "input_image",
              detail: "auto",
              image_url: "data:image/png;base64,AA==",
            }),
          ]),
        }),
      ]),
    );

    const completionBodies: Array<Record<string, unknown>> = [];
    const completionsProvider = providerPackage.createProvider({
      configuration: packageConfiguration(),
      configurationPath:
        'providerPackages["@token/provider-commandcode-goat"]',
      host: {
        fetch: async (input, init) => {
          completionBodies.push(
            (await new Request(input, init).json()) as Record<string, unknown>,
          );
          return openAICompletion("image accepted");
        },
        now: () => 1,
        createUuid: () => "00000000-0000-4000-8000-000000000110",
      },
    });
    const completionsModel = completionsProvider
      .getModels()
      .find((entry) => entry.id === "google/gemini-3.7-flash");
    expect(completionsModel).toMatchObject({ api: "openai-completions" });

    await completionsProvider
      .streamSimple(
        completionsModel!,
        normalizeContext({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "describe" },
                { type: "image", mimeType: "image/png", data: "AA==" },
              ],
              timestamp: 1,
            },
          ],
        }),
        { apiKey: "goat-secret", maxTokens: 32 },
      )
      .result();

    expect(completionBodies).toHaveLength(1);
    expect(completionBodies[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "image_url",
              image_url: { url: "data:image/png;base64,AA==" },
            }),
          ]),
        }),
      ]),
    );
  });

  it("dispatches a catalog-only Anthropic model without rebuilding the Provider", async () => {
    const requests: Request[] = [];
    const fetch: FetchFunction = async (input, init) => {
      requests.push(new Request(input, init));
      return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"captured"}}', {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };
    const provider = providerPackage.createProvider({
      configuration: packageConfiguration({
        schema: COMMANDCODE_MODEL_CATALOG_SCHEMA,
        models: [
          {
            id: "future-goat-messages",
            name: "Future Goat Messages",
            description: "catalog-only Anthropic transport fixture",
            supportedEndpoints: ["/messages"],
            endpoint: "/messages",
            input: ["text"],
            reasoning: false,
            contextWindow: 100_000,
            minimumPlan: "go",
          },
        ],
      }),
      configurationPath: "commandcode-models.json",
      host: {
        fetch,
        now: () => 1,
        createUuid: () => "00000000-0000-4000-8000-000000000107",
      },
    });
    const model = provider.getModels()[0];
    expect(model).toMatchObject({
      id: "future-goat-messages",
      api: "anthropic-messages",
      baseUrl: "https://api.commandcode.ai/provider",
    });

    for await (const event of provider.streamSimple(
      model!,
      normalizeContext({
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
      }),
      { apiKey: "goat-secret", maxTokens: 32 },
    )) {
      void event;
    }

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe(
      "/provider/v1/messages",
    );
    expect(requests[0]?.headers.get("x-api-key")).toBe("goat-secret");
    await expect(requests[0]?.json()).resolves.toMatchObject({
      model: "future-goat-messages",
      stream: true,
    });
  });

  it("sends Bearer-authenticated requests through the host transport to chat/completions", async () => {
    const requests: Request[] = [];
    const fetch: FetchFunction = async (input, init) => {
      requests.push(new Request(input, init));
      return openAICompletion("hello from goat");
    };
    const provider = providerPackage.createProvider({
      configuration: packageConfiguration(),
      configurationPath:
        'providerPackages["@token/provider-commandcode-goat"]',
      host: {
        fetch,
        now: () => 1,
        createUuid: () => "00000000-0000-4000-8000-000000000102",
      },
    });
    const model = provider
      .getModels()
      .find((entry) => entry.id === "google/gemini-3.7-flash");
    expect(model).toBeDefined();

    const result = await provider
      .streamSimple(
        model!,
        normalizeContext({
          systemPrompt: "root instruction",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
              timestamp: 1,
            },
          ],
        }),
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
    const body = (await requests[0]?.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "google/gemini-3.7-flash",
      stream: true,
      max_tokens: 32,
    });
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: "root instruction",
        }),
      ]),
    );
    expect(body.messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "developer" }),
      ]),
    );
  });

  it("sends only reasoning efforts declared by the projected model", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch: FetchFunction = async (input, init) => {
      bodies.push((await new Request(input, init).json()) as Record<string, unknown>);
      return openAICompletion("reasoning result");
    };
    const provider = providerPackage.createProvider({
      configuration: packageConfiguration(),
      configurationPath:
        'providerPackages["@token/provider-commandcode-goat"]',
      host: {
        fetch,
        now: () => 1,
        createUuid: () => "00000000-0000-4000-8000-000000000104",
      },
    });
    const context = normalizeContext({
      messages: [{ role: "user" as const, content: "hello", timestamp: 1 }],
    });
    const gemini = provider
      .getModels()
      .find((entry) => entry.id === "google/gemini-3.7-flash");
    const step = provider
      .getModels()
      .find((entry) => entry.id === "stepfun/Step-3.5-Flash");
    expect(gemini).toBeDefined();
    expect(step).toBeDefined();

    await provider
      .streamSimple(gemini!, context, {
        apiKey: "goat-secret",
        maxTokens: 32,
        reasoning: "low",
      })
      .result();
    await provider
      .streamSimple(step!, context, {
        apiKey: "goat-secret",
        maxTokens: 32,
        reasoning: "high",
      })
      .result();

    expect(bodies[0]?.reasoning_effort).toBe("low");
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
  });

  it("keeps Goat credentials under its own Provider auth interface", async () => {
    const provider = providerPackage.createProvider({
      configuration: packageConfiguration(),
      configurationPath:
        'providerPackages["@token/provider-commandcode-goat"]',
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
      configuration: packageConfiguration(),
      configurationPath:
        'providerPackages["@token/provider-commandcode-goat"]',
      host: {
        fetch: async () =>
          new Response(
            'data: {"id":"chatcmpl-truncated","object":"chat.completion.chunk","created":1,"model":"google/gemini-3.7-flash","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        now: () => 1,
        createUuid: () => "00000000-0000-4000-8000-000000000105",
      },
    });
    const model = provider
      .getModels()
      .find((entry) => entry.id === "google/gemini-3.7-flash");
    expect(model).toBeDefined();

    const events = [];
    for await (const event of provider.streamSimple(
      model!,
      normalizeContext({
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
      }),
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
