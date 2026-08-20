import {
  createModels,
  type Context,
  type FetchFunction,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
  createCommandCodePrivateProvider,
} from "../../packages/provider-commandcode-private/src/provider.js";
const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function successResponse(): Response {
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({ type: "text-delta", id: "0", text: "done" }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    ].join("\n"),
  );
}

describe("complete CommandCode request conversion", () => {
  it("matches the golden request across every supported semantic family", async () => {
    const model: Model<typeof commandCodePrivateApiId> = {
      id: "golden-model",
      name: "golden-model",
      api: commandCodePrivateApiId,
      provider: commandCodePrivateProviderId,
      baseUrl: "https://fixture.commandcode.test/prefix/base",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 1_000,
    };
    const context: Context = {
      systemPrompt: "Golden system",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", mimeType: "image/png", data: "aQ==" },
          ],
          timestamp: 1,
        },
        {
          role: "assistant",
          api: "foreign-api",
          provider: "foreign-provider",
          model: "foreign-model",
          content: [
            { type: "text", text: "working", textSignature: "discarded" },
            {
              type: "thinking",
              thinking: "inspect both",
              thinkingSignature: "discarded",
            },
            { type: "toolCall", id: "call_a", name: "lookup", arguments: { q: "a" } },
            { type: "toolCall", id: "call_b", name: "lookup", arguments: { q: "b" } },
          ],
          usage,
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_a",
          toolName: "lookup",
          content: [{ type: "text", text: "A" }],
          isError: false,
          timestamp: 3,
        },
        {
          role: "toolResult",
          toolCallId: "call_b",
          toolName: "lookup",
          content: [{ type: "text", text: "B failed" }],
          isError: true,
          timestamp: 4,
        },
        { role: "user", content: "continue", timestamp: 5 },
      ],
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          parameters: {
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
            additionalProperties: false,
          },
        },
      ],
    };
    let request: Request | undefined;
    const fetch: FetchFunction = async (input, init) => {
      request = new Request(input, init);
      return successResponse();
    };
    const provider = createCommandCodePrivateProvider({
      apiKey: "bound-key",
      fetch,
      model,
      now: () => 1,
      compatibility: {
        cliEnvironment: "prod",
        ossPrimaryProvider: "bound-oss",
        permissionMode: "bypass",
      },
      createSessionId: () => "00000000-0000-4000-8000-000000000099",
    });
    const models = createModels();
    models.setProvider(provider);

    const result = await models
      .streamSimple(model, context, {
        apiKey: "effective-key",
        maxTokens: 123,
        temperature: 0,
        reasoning: "high",
        sessionId: "00000000-0000-4000-8000-000000000080",
        headers: {
          "X-Custom": "first",
          "x-custom": "last",
          "X-Remove": "present",
          "x-remove": null,
          Authorization: "Bearer caller-must-lose",
          "Content-Type": "text/plain",
          "X-OAuth-Token": "forbidden",
          "X-OAuth-Provider": "forbidden",
          "X-Session-Id": "forbidden",
        },
      })
      .result();
    expect(result.stopReason).toBe("stop");

    const fixture = JSON.parse(
      await readFile(
        new URL("../fixtures/commandcode-golden-request.json", import.meta.url),
        "utf8",
      ),
    ) as { endpoint: string; headers: Record<string, string>; body: unknown };
    expect(request?.url).toBe(fixture.endpoint);
    expect(Object.fromEntries(request?.headers.entries() ?? [])).toEqual(
      fixture.headers,
    );
    expect(await request?.json()).toEqual(fixture.body);
  });
});
