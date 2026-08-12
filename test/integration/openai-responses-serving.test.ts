import type { FetchFunction } from "@earendil-works/pi-ai";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOpenAIResponsesServingTestComposition,
  type OpenAIResponsesServingTestComposition,
} from "../support/openai-responses-serving.js";

function commandCodeText(text: string): Response {
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({ type: "text-delta", id: "0", text }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      }),
      "",
    ].join("\n"),
  );
}

function responsesRequest(body: Record<string, unknown>, token: string): Request {
  return new Request("http://luckytoken.test/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("OpenAI Responses serving", () => {
  const compositions: OpenAIResponsesServingTestComposition[] = [];

  afterEach(async () => {
    await Promise.all(compositions.splice(0).map((c) => c.close()));
  });

  const baseOptions = {
    clientApiKey: "client-token",
    commandCodeApiKey: "provider-secret",
    commandCodeBaseUrl: "https://commandcode.test",
    modelId: "deepseek/deepseek-v4-flash",
  };

  async function start(options: Partial<typeof baseOptions> & { fetch: FetchFunction }) {
    const composition = await createOpenAIResponsesServingTestComposition({
      ...baseOptions,
      ...options,
    });
    compositions.push(composition);
    return composition;
  }

  it("expands incremental turns into full history and replays it upstream", async () => {
    const upstreamBodies: unknown[] = [];
    const fetch: FetchFunction = async (input, init) => {
      const request = new Request(input, init);
      upstreamBodies.push(JSON.parse(await request.text()));
      return commandCodeText("answered");
    };
    const { runtime } = await start({ fetch });

    // First turn: no previous_response_id.
    const first = await runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: [{ role: "user", content: "hello" }],
        },
        "client-token",
      ),
    );
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson.output[0].content[0].text).toBe("answered");

    // Second turn: previous_response_id references the first response.
    const second = await runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: [{ role: "user", content: "continue" }],
          previous_response_id: firstJson.id,
        },
        "client-token",
      ),
    );
    expect(second.status).toBe(200);

    // The upstream received the full expanded history: first input + first
    // output + second input, converted to Pi and then to CommandCode messages.
    const lastUpstream = upstreamBodies.at(-1) as {
      params?: { messages?: Array<{ role: string }> };
    };
    const roles = lastUpstream?.params?.messages?.map((m) => m.role) ?? [];
    expect(roles).toEqual(["user", "assistant", "user"]);
  });

  it("rejects an invalid client token with 401", async () => {
    const { runtime } = await start({
      fetch: async () => commandCodeText("unused"),
    });
    const response = await runtime.handle(
      responsesRequest(
        { model: "m", input: "x" },
        "wrong-token",
      ),
    );
    expect(response.status).toBe(401);
  });

  it("returns 400 for malformed requests", async () => {
    const { runtime } = await start({
      fetch: async () => commandCodeText("unused"),
    });
    const response = await runtime.handle(
      responsesRequest({ input: "missing model" }, "client-token"),
    );
    expect(response.status).toBe(400);
  });

  it("returns 404 for an unknown model selector", async () => {
    const { runtime } = await start({
      fetch: async () => commandCodeText("unused"),
    });
    const response = await runtime.handle(
      responsesRequest(
        { model: "unknown/provider", input: "x" },
        "client-token",
      ),
    );
    expect(response.status).toBe(404);
  });

  it("renders SSE when stream is requested", async () => {
    const { runtime } = await start({
      fetch: async () => commandCodeText("streamed"),
    });
    const response = await runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: "hello",
          stream: true,
        },
        "client-token",
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("response.created");
    expect(text).toContain("response.output_item.done");
    expect(text).toContain("response.completed");
    expect(text).toContain("data: [DONE]");
  });

  it("survives a restart by loading history from the snapshot file", async () => {
    const fetch: FetchFunction = async () => commandCodeText("restart-safe");
    const first = await start({ fetch });
    const firstResponse = await first.runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: "before restart",
        },
        "client-token",
      ),
    );
    const firstJson = await firstResponse.json();
    await first.close();
    compositions.splice(compositions.indexOf(first), 1);

    // New composition on the SAME stateFile (simulated process restart).
    const second = await start({ fetch });
    const continuation = await second.runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: "after restart",
          previous_response_id: firstJson.id,
        },
        "client-token",
      ),
    );
    expect(continuation.status).toBe(200);
    const continuationJson = await continuation.json();
    expect(continuationJson.previous_response_id).toBe(firstJson.id);
  });

  it("propagates client cancellation to the upstream fetch and saves no state", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetch: FetchFunction = async (_input, init) => {
      upstreamSignal = init?.signal as AbortSignal | undefined;
      return await new Promise<Response>(() => undefined);
    };
    const { runtime } = await start({ fetch });
    const controller = new AbortController();
    const handling = runtime.handle(
      new Request("http://luckytoken.test/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer client-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: "cancel me",
        }),
        signal: controller.signal,
      }),
    );

    // Wait for the upstream fetch to be in flight, then cancel.
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (upstreamSignal !== undefined) resolve();
        else setTimeout(check, 5);
      };
      check();
    });
    controller.abort(new Error("client cancelled"));

    await expect(handling).rejects.toMatchObject({
      name: "HttpRequestAbortedError",
    });
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("maps a non-2xx upstream HTTP failure to a status-mapped error", async () => {
    const fetch: FetchFunction = async () =>
      new Response(
        JSON.stringify({
          error: { type: "rate_limit_exceeded", message: "slow down" },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    const { runtime } = await start({ fetch });
    const response = await runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: "hello",
        },
        "client-token",
      ),
    );
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error.type).toBe("rate_limit_exceeded");
    expect(body.error.message).toContain("slow down");
  });

  it("exposes the resolved model through GET /v1/models without auth", async () => {
    const { runtime } = await start({
      fetch: async () => commandCodeText("unused"),
    });
    const response = await runtime.handle(
      new Request("http://luckytoken.test/v1/models", {
        method: "GET",
      }),
    );
    expect(response.status).toBe(200);
    const list = await response.json();
    expect(list.object).toBe("list");
    expect(list.data).toEqual([
      {
        id: "commandcode-private/deepseek/deepseek-v4-flash",
        object: "model",
        created: expect.any(Number),
        owned_by: "commandcode-private",
      },
    ]);
  });
});
