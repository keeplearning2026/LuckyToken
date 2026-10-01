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
  ],
  instructions: "You are the coding agent.",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Fix the widget." }],
    },
    { type: "compaction_trigger" },
  ],
});

describe("Provider Native routed compaction", () => {
  it("summarizes in-lane when the upstream cannot compact and returns one Token item", async () => {
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
      dependencies(models(model), fetch),
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

  it("decodes a replayed Token envelope before forwarding to the upstream", async () => {
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
      dependencies(models(model), fetch),
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
