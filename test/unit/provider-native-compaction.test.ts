import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { handleHttpRequest, type HttpBoundaryDependencies } from "../../src/http.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import {
  ROUTED_COMPACTION_SYSTEM_PROMPT,
  TOKEN_COMPACTION_PREFIX,
} from "../../src/responses-compaction.js";
import { createProviderNativeResponses } from "../../src/provider-native-responses/index.js";
import { ambientProfileBindings } from "../support/profile-binding-fixture.js";

function responsesModel(provider: string, id = "real-model"): Model<string> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider,
    baseUrl: "https://responses.example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
}

function models(model: Model<string>): Models {
  return {
    getModels: () => [model],
    getAuth: async () => ({ auth: { apiKey: "sk-responses" } }),
  } as unknown as Models;
}

function dependencies(
  source: Models,
  fetch: FetchFunction,
  optionalRepairs = true,
): HttpBoundaryDependencies {
  const handler = createOpenAIResponsesHandler({
    models: source,
    providerNativeLane: createProviderNativeResponses({
      models: source,
      bindings: ambientProfileBindings,
      fetch,
    }),
    stateFile: "provider-native-compaction-state.json",
    maxRequestBytes: 4_000_000,
    createResponseId: () => "resp_test",
    now: () => 1,
    toolCallAdjacency: () => optionalRepairs,
    sseLifecycleNormalization: () => optionalRepairs,
    functionCallNamespaceRepair: () => optionalRepairs,
  });
  return {
    clientProtocols: [handler],
    requestTimeoutMs: undefined,
    shutdownSignal: undefined,
  };
}

function request(body: string): Request {
  return new Request("http://Token.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function sse(frames: readonly unknown[]): string {
  return (
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
    "data: [DONE]\n\n"
  );
}

function sseEvents(body: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const block of body.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (payload.length === 0 || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          events.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Non-JSON frames are not part of the asserted contract.
      }
    }
  }
  return events;
}

const COMPACTION_TURN = JSON.stringify({
  model: "commandcode-goat/real-model",
  stream: true,
  tools: [
    {
      type: "function",
      name: "marker_tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      type: "namespace",
      name: "multi_agent_v1",
      tools: [
        {
          type: "function",
          name: "spawn_agent",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          type: "function",
          name: "close_agent",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    },
  ],
  instructions: "You are the coding agent.",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Fix the widget." }],
    },
    {
      type: "function_call",
      call_id: "call_spawn_1",
      namespace: "multi_agent_v1",
      name: "spawn_agent",
      arguments: "{}",
    },
    {
      type: "function_call_output",
      call_id: "call_spawn_1",
      output: "agent started",
    },
    { type: "compaction_trigger" },
  ],
});

function compactionTurn(stream: boolean): string {
  const body = JSON.parse(COMPACTION_TURN) as Record<string, unknown>;
  body.stream = stream;
  return JSON.stringify(body);
}

describe("Provider Native routed compaction", () => {
  it.each([true, false])("summarizes in-lane and returns one Token item with optional repairs=%s", async (optionalRepairs) => {
    const model = responsesModel("commandcode-goat");
    const upstream: Request[] = [];
    const fetch: FetchFunction = async (input, init) => {
      upstream.push(new Request(input, init));
      return new Response(
        sse([
          {
            type: "response.created",
            response: { id: "resp_upstream", status: "in_progress" },
          },
          { type: "response.output_text.delta", delta: "handoff " },
          { type: "response.output_text.delta", delta: "summary" },
          {
            type: "response.completed",
            response: { id: "resp_upstream", status: "completed", output: [] },
          },
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const response = await handleHttpRequest(
      dependencies(models(model), fetch, optionalRepairs),
      request(COMPACTION_TURN),
    );

    expect(response.status).toBe(200);
    expect(upstream).toHaveLength(1);
    const forwarded = JSON.parse(await upstream[0]!.text()) as Record<
      string,
      unknown
    >;
    expect(forwarded.instructions).toBe(ROUTED_COMPACTION_SYSTEM_PROMPT);
    expect(forwarded.tools).toBeUndefined();
    expect(forwarded.tool_choice).toBeUndefined();
    expect(forwarded.parallel_tool_calls).toBeUndefined();
    const forwardedInput = forwarded.input as Record<string, unknown>[];
    expect(
      forwardedInput.some((item) => item.type === "compaction_trigger"),
    ).toBe(false);
    expect(
      forwardedInput.find((item) => item.type === "function_call"),
    ).toMatchObject({
      name: "multi_agent_v1__spawn_agent",
      call_id: "call_spawn_1",
    });
    expect(
      forwardedInput.some(
        (item) =>
          item.type === "function_call" && item.namespace !== undefined,
      ),
    ).toBe(false);
    expect(JSON.stringify(forwardedInput)).not.toContain("close_agent");
    expect(JSON.stringify(forwardedInput.at(-1))).toContain("## Goal");

    const events = sseEvents(await response.text());
    const items = events
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => event.item)
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null,
      );
    const compactionItems = items.filter((item) => item.type === "compaction");
    expect(items).toHaveLength(1);
    expect(compactionItems).toHaveLength(1);
    expect(
      events.some((event) => event.type === "response.completed"),
    ).toBe(true);
    const encrypted = String(compactionItems[0]!.encrypted_content);
    expect(encrypted).toMatch(/^Token1:/u);
    expect(
      Buffer.from(
        encrypted.slice(TOKEN_COMPACTION_PREFIX.length),
        "base64",
      ).toString("utf8"),
    ).toBe("handoff summary");
  });

  it.each([true, false])("parses a non-streaming JSON summarizer response with optional repairs=%s", async (optionalRepairs) => {
    const model = responsesModel("commandcode-goat");
    const upstream: Request[] = [];
    const fetch: FetchFunction = async (input, init) => {
      upstream.push(new Request(input, init));
      return new Response(
        JSON.stringify({
          id: "resp_upstream",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                { type: "output_text", text: "JSON handoff summary" },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const response = await handleHttpRequest(
      dependencies(models(model), fetch, optionalRepairs),
      request(compactionTurn(false)),
    );

    expect(response.status).toBe(200);
    expect(upstream).toHaveLength(1);
    const forwarded = JSON.parse(await upstream[0]!.text()) as Record<
      string,
      unknown
    >;
    expect(forwarded.stream).toBe(false);
    const rendered = (await response.json()) as {
      output: Record<string, unknown>[];
    };
    expect(rendered.output).toHaveLength(1);
    expect(rendered.output[0]).toMatchObject({ type: "compaction" });
    const encrypted = String(rendered.output[0]!.encrypted_content);
    expect(encrypted).toMatch(/^Token1:/u);
    expect(
      Buffer.from(
        encrypted.slice(TOKEN_COMPACTION_PREFIX.length),
        "base64",
      ).toString("utf8"),
    ).toBe("JSON handoff summary");
  });

  it.each([
    {
      description: "a non-completed JSON response",
      response: {
        id: "resp_upstream",
        object: "response",
        status: "incomplete",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "partial summary" }],
          },
        ],
      },
    },
    {
      description: "a completed JSON response with empty output",
      response: {
        id: "resp_upstream",
        object: "response",
        status: "completed",
        output: [],
      },
    },
  ])("rejects $description", async ({ response: responseBody }) => {
    const model = responsesModel("commandcode-goat");
    const fetch: FetchFunction = async () =>
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const response = await handleHttpRequest(
      dependencies(models(model), fetch),
      request(compactionTurn(false)),
    );

    expect(response.status).toBe(502);
  });

  it("uses the completed message item when the upstream omits text deltas", async () => {
    const model = responsesModel("commandcode-goat");
    const fetch: FetchFunction = async () =>
      new Response(
        sse([
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "message",
              role: "assistant",
              content: [
                { type: "output_text", text: "completed item summary" },
              ],
            },
          },
          {
            type: "response.completed",
            response: {
              id: "resp_upstream",
              status: "completed",
              output: [],
            },
          },
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    const response = await handleHttpRequest(
      dependencies(models(model), fetch),
      request(COMPACTION_TURN),
    );

    expect(response.status).toBe(200);
    const events = sseEvents(await response.text());
    const compactionItem = events
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => event.item)
      .find(
        (item): item is Record<string, unknown> =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "compaction",
      );
    expect(compactionItem).toBeDefined();
    const encrypted = String(compactionItem!.encrypted_content);
    expect(
      Buffer.from(
        encrypted.slice(TOKEN_COMPACTION_PREFIX.length),
        "base64",
      ).toString("utf8"),
    ).toBe("completed item summary");
  });

  it("rejects ambiguous flattened namespace history before native dispatch", async () => {
    const model = responsesModel("commandcode-goat");
    const upstream: Request[] = [];
    const fetch: FetchFunction = async (input, init) => {
      upstream.push(new Request(input, init));
      return new Response("unexpected dispatch", { status: 200 });
    };
    const response = await handleHttpRequest(
      dependencies(models(model), fetch),
      request(
        JSON.stringify({
          model: "commandcode-goat/real-model",
          stream: true,
          tools: [
            {
              type: "namespace",
              name: "alpha__beta",
              tools: [
                {
                  type: "function",
                  name: "gamma",
                  parameters: { type: "object", properties: {} },
                },
              ],
            },
            {
              type: "namespace",
              name: "alpha",
              tools: [
                {
                  type: "function",
                  name: "beta__gamma",
                  parameters: { type: "object", properties: {} },
                },
              ],
            },
          ],
          input: [
            {
              type: "function_call",
              call_id: "call_alpha_beta",
              namespace: "alpha__beta",
              name: "gamma",
              arguments: "{}",
            },
            {
              type: "function_call_output",
              call_id: "call_alpha_beta",
              output: "first",
            },
            {
              type: "function_call",
              call_id: "call_alpha",
              namespace: "alpha",
              name: "beta__gamma",
              arguments: "{}",
            },
            {
              type: "function_call_output",
              call_id: "call_alpha",
              output: "second",
            },
            { type: "compaction_trigger" },
          ],
        }),
      ),
    );

    expect(response.status).toBe(400);
    expect(upstream).toHaveLength(0);
    expect(await response.text()).toContain(
      "tool name collision after namespace flattening: alpha__beta__gamma",
    );
  });

  it.each([
    {
      description: "the stream ending after text deltas",
      frames: [
        { type: "response.output_text.delta", delta: "partial summary" },
      ],
    },
    {
      description: "a response.incomplete terminal event",
      frames: [
        { type: "response.output_text.delta", delta: "partial summary" },
        {
          type: "response.incomplete",
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        },
      ],
    },
    {
      description: "a response.failed terminal event",
      frames: [
        { type: "response.output_text.delta", delta: "partial summary" },
        {
          type: "response.failed",
          response: {
            status: "failed",
            error: { message: "upstream failure" },
          },
        },
      ],
    },
    {
      description: "text following response.completed",
      frames: [
        {
          type: "response.completed",
          response: { status: "completed", output: [] },
        },
        { type: "response.output_text.delta", delta: "late summary text" },
      ],
    },
  ])(
    "rejects nonempty deltas without response.completed: $description",
    async ({ frames }) => {
      const model = responsesModel("commandcode-goat");
      const fetch: FetchFunction = async () =>
        new Response(sse(frames), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });

      const response = await handleHttpRequest(
        dependencies(models(model), fetch),
        request(COMPACTION_TURN),
      );

      expect(response.status).toBe(502);
    },
  );

  it("rejects malformed SSE data even if later frames report completion", async () => {
    const model = responsesModel("commandcode-goat");
    const fetch: FetchFunction = async () =>
      new Response(
        [
          `data: ${JSON.stringify({
            type: "response.output_text.delta",
            delta: "partial summary",
          })}`,
          "",
          "data: {malformed-json",
          "",
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_upstream",
              status: "completed",
              output: [
                {
                  type: "message",
                  content: [{ type: "output_text", text: "completed summary" }],
                },
              ],
            },
          })}`,
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );

    const response = await handleHttpRequest(
      dependencies(models(model), fetch),
      request(COMPACTION_TURN),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('"type":"compaction"');
  });

  it("parses CRLF-framed summarizer SSE without dropping later deltas", async () => {
    const model = responsesModel("commandcode-goat");
    const fetch: FetchFunction = async () =>
      new Response(
        sse([
          { type: "response.output_text.delta", delta: "CRLF " },
          { type: "response.output_text.delta", delta: "summary" },
          {
            type: "response.completed",
            response: { id: "resp_upstream", status: "completed", output: [] },
          },
        ]).replace(/\n/gu, "\r\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );

    const response = await handleHttpRequest(
      dependencies(models(model), fetch),
      request(COMPACTION_TURN),
    );

    expect(response.status).toBe(200);
    const events = sseEvents(await response.text());
    const compactionItem = events
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => event.item)
      .find(
        (item): item is Record<string, unknown> =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "compaction",
      );
    expect(compactionItem).toBeDefined();
    const encrypted = String(compactionItem!.encrypted_content);
    expect(
      Buffer.from(
        encrypted.slice(TOKEN_COMPACTION_PREFIX.length),
        "base64",
      ).toString("utf8"),
    ).toBe("CRLF summary");
  });

  it("joins multiple SSE data lines before parsing the summarizer event", async () => {
    const model = responsesModel("commandcode-goat");
    const deltaFrame = JSON.stringify({
      type: "response.output_text.delta",
      delta: "multi-line summary",
    });
    const splitAt = deltaFrame.indexOf(',"delta":') + 1;
    const fetch: FetchFunction = async () =>
      new Response(
        [
          `data: ${deltaFrame.slice(0, splitAt)}`,
          `data: ${deltaFrame.slice(splitAt)}`,
          "",
          `data: ${JSON.stringify({
            type: "response.completed",
            response: { id: "resp_upstream", status: "completed", output: [] },
          })}`,
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );

    const response = await handleHttpRequest(
      dependencies(models(model), fetch),
      request(COMPACTION_TURN),
    );

    expect(response.status).toBe(200);
    const events = sseEvents(await response.text());
    const compactionItem = events
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => event.item)
      .find(
        (item): item is Record<string, unknown> =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "compaction",
      );
    expect(compactionItem).toBeDefined();
    const encrypted = String(compactionItem!.encrypted_content);
    expect(
      Buffer.from(
        encrypted.slice(TOKEN_COMPACTION_PREFIX.length),
        "base64",
      ).toString("utf8"),
    ).toBe("multi-line summary");
  });

  it("forwards a certified upstream compaction turn unchanged", async () => {
    const model = responsesModel("openai", "gpt-5");
    const upstream: Request[] = [];
    const fetch: FetchFunction = async (input, init) => {
      upstream.push(new Request(input, init));
      return new Response(
        sse([
          {
            type: "response.created",
            response: { id: "resp_upstream", status: "in_progress" },
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "compaction",
              id: "cmp_upstream",
              encrypted_content: "native-encrypted",
            },
          },
          {
            type: "response.completed",
            response: { id: "resp_upstream", status: "completed", output: [] },
          },
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const response = await handleHttpRequest(
      dependencies(models(model), fetch),
      request(
        JSON.stringify({
          model: "openai/gpt-5",
          stream: true,
          tools: [{ type: "function", name: "marker_tool", parameters: {} }],
          instructions: "You are the coding agent.",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Fix the widget." }],
            },
            { type: "compaction_trigger" },
          ],
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(upstream).toHaveLength(1);
    const forwarded = JSON.parse(await upstream[0]!.text()) as Record<
      string,
      unknown
    >;
    expect(forwarded.instructions).toBe("You are the coding agent.");
    expect(Array.isArray(forwarded.tools)).toBe(true);
    const forwardedInput = forwarded.input as Record<string, unknown>[];
    expect(
      forwardedInput.some((item) => item.type === "compaction_trigger"),
    ).toBe(true);
    await expect(response.text()).resolves.toContain("native-encrypted");
  });

  it.each([true, false])("decodes a replayed Token envelope with optional repairs=%s", async (optionalRepairs) => {
    const model = responsesModel("commandcode-goat");
    const upstream: Request[] = [];
    const fetch: FetchFunction = async (input, init) => {
      upstream.push(new Request(input, init));
      return new Response(
        sse([
          {
            type: "response.output_text.delta",
            delta: "continued",
          },
          {
            type: "response.completed",
            response: { id: "resp_upstream", status: "completed", output: [] },
          },
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    const envelope =
      TOKEN_COMPACTION_PREFIX +
      Buffer.from("earlier handoff summary", "utf8").toString("base64");

    const response = await handleHttpRequest(
      dependencies(models(model), fetch, optionalRepairs),
      request(
        JSON.stringify({
          model: "commandcode-goat/real-model",
          stream: true,
          input: [
            {
              type: "compaction",
              id: "cmp_1",
              encrypted_content: envelope,
            },
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "continue" }],
            },
          ],
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(upstream).toHaveLength(1);
    const forwardedText = await upstream[0]!.text();
    expect(forwardedText).toContain("earlier handoff summary");
    expect(forwardedText).not.toContain(TOKEN_COMPACTION_PREFIX);
  });
});
