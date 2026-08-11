import {
  createModels,
  type AssistantMessage,
  type Context,
  type FetchFunction,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
  createCommandCodePrivateProvider,
} from "../../src/providers/commandcode-private/provider.js";
import { createEmptyServerConfig } from "../../src/providers/commandcode-private/project.js";

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const historicalToolTurn: AssistantMessage = {
  role: "assistant",
  api: "luckytoken-client-history",
  provider: "luckytoken-client",
  model: "client-selector",
  content: [
    { type: "text", text: " \t" },
    {
      type: "toolCall",
      id: "Call_Exact",
      name: "Tool_Exact",
      arguments: { nested: [1, true, null] },
    },
  ],
  usage,
  stopReason: "toolUse",
  timestamp: 1,
};

const context: Context = {
  systemPrompt: "system exact\n",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "" },
        { type: "image", mimeType: "image/png", data: "AA==" },
      ],
      timestamp: 1,
    },
    historicalToolTurn,
    {
      role: "toolResult",
      toolCallId: "Call_Exact",
      toolName: "Tool_Exact",
      content: [{ type: "text", text: "result exact" }],
      isError: false,
      timestamp: 1,
    },
    { role: "user", content: "tail", timestamp: 1 },
  ],
  tools: [
    {
      name: "Tool_Exact",
      description: "schema exact",
      parameters: {
        type: "object",
        properties: {
          value: {
            type: "string",
            minLength: 1,
            pattern: "^[a-z]+$",
          },
        },
        required: ["value"],
        additionalProperties: false,
        dependentRequired: { value: ["other"] },
      },
    },
  ],
};

interface CapturedRun {
  authorization: string | null;
  payload: Record<string, unknown>;
}

async function run(apiKey: string): Promise<CapturedRun> {
  let upstream: Request | undefined;
  const fetch: FetchFunction = async (input, init) => {
    upstream = new Request(input, init);
    return new Response(
      [
        JSON.stringify({ type: "text-start", id: "t" }),
        JSON.stringify({ type: "text-delta", id: "t", text: "done" }),
        JSON.stringify({ type: "text-end", id: "t" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        }),
      ].join("\n"),
    );
  };
  const model: Model<typeof commandCodePrivateApiId> = {
    id: "model",
    name: "model",
    api: commandCodePrivateApiId,
    provider: commandCodePrivateProviderId,
    baseUrl: "https://commandcode.test",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 5,
    maxTokens: 100,
  };
  const models = createModels();
  models.setProvider(
    createCommandCodePrivateProvider({
      apiKey,
      fetch,
      model,
      now: () => 1,
      projectSnapshot: { snapshot: async () => createEmptyServerConfig() },
    }),
  );
  const selected = models.getModels()[0] as Model<typeof commandCodePrivateApiId>;
  const result = await models
    .streamSimple(selected, context, {
      maxTokens: 20,
      sessionId: "00000000-0000-4000-8000-000000000120",
    })
    .result();
  expect(result.stopReason).toBe("stop");
  if (upstream === undefined) throw new Error("upstream request was not captured");
  return {
    authorization: upstream.headers.get("authorization"),
    payload: (await upstream.json()) as Record<string, unknown>,
  };
}

describe("Pi runtime fidelity on the certified route", () => {
  it("bypasses lossy shared transforms and preserves Provider-facing semantics", async () => {
    const first = await run("key-one");
    const second = await run("key-two");

    expect(first.authorization).toBe("Bearer key-one");
    expect(second.authorization).toBe("Bearer key-two");
    expect(second.payload).toEqual(first.payload);
    expect(first.payload).toMatchObject({
      params: {
        max_tokens: 20,
        system: "system exact\n",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "" },
              {
                type: "image",
                image: "data:image/png;base64,AA==",
                mimeType: "image/png",
              },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: " \t" },
              {
                type: "tool-call",
                toolCallId: "Call_Exact",
                toolName: "Tool_Exact",
                input: { nested: [1, true, null] },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "Call_Exact",
                output: { type: "text", value: "result exact" },
              },
            ],
          },
          { role: "user", content: [{ type: "text", text: "tail" }] },
        ],
        tools: [
          {
            name: "Tool_Exact",
            input_schema: {
              type: "object",
              properties: {
                value: {
                  type: "string",
                  minLength: 1,
                  pattern: "^[a-z]+$",
                },
              },
              required: ["value"],
              additionalProperties: false,
              dependentRequired: { value: ["other"] },
            },
          },
        ],
      },
    });
    expect(JSON.stringify(first.payload)).not.toContain(
      "No result — the tool call did not complete",
    );
  });
});
