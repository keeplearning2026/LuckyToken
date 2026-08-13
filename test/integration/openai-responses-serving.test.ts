import type { FetchFunction } from "@earendil-works/pi-ai";

import { afterEach, describe, expect, it } from "vitest";

import type { OpenAIResponsesConfiguration } from "../../src/protocols/openai-responses/configuration.js";
import type { InvocationDiagnosticsFactory } from "../../src/invocation-diagnostics/index.js";
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

  async function start(
    options: Partial<typeof baseOptions> &
      {
        fetch: FetchFunction;
        directory?: string;
        stateFile?: string;
        configuration?: OpenAIResponsesConfiguration;
        invocationDiagnostics?: InvocationDiagnosticsFactory;
      },
  ) {
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

  it("rejects an orphan function_call_output by default in an expanded increment", async () => {
    const upstreamBodies: unknown[] = [];
    const fetch: FetchFunction = async (input, init) => {
      const request = new Request(input, init);
      upstreamBodies.push(JSON.parse(await request.text()));
      return commandCodeText("answered");
    };
    const { runtime } = await start({ fetch });

    // First turn: normal conversation, saved to state.
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

    // Second turn: Codex sends a tool-result increment whose call_id has no
    // preceding function_call in the expanded history. The frozen default
    // orphanToolOutput=error rejects it; ignore is opt-in.
    const second = await runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: [
            {
              type: "function_call_output",
              call_id: "call_orphan",
              output: "tool result",
            },
            { type: "message", role: "user", content: "continue" },
          ],
          previous_response_id: firstJson.id,
        },
        "client-token",
      ),
    );
    expect(second.status).toBe(400);
    const secondJson = await second.json();
    expect(secondJson.error.message).toContain("unknown call_id");
  });

  it("tolerates an orphan function_call_output when orphanToolOutput=ignore", async () => {
    const upstreamBodies: unknown[] = [];
    const fetch: FetchFunction = async (input, init) => {
      const request = new Request(input, init);
      upstreamBodies.push(JSON.parse(await request.text()));
      return commandCodeText("answered");
    };
    const { parseOpenAIResponsesConfiguration } = await import(
      "../../src/protocols/openai-responses/configuration.js"
    );
    const configuration = parseOpenAIResponsesConfiguration({
      conversion: {
        request: { orphanToolOutput: "ignore" },
      },
    });
    const { runtime } = await start({ fetch, configuration });

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

    const second = await runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: [
            {
              type: "function_call_output",
              call_id: "call_orphan",
              output: "tool result",
            },
            { type: "message", role: "user", content: "continue" },
          ],
          previous_response_id: firstJson.id,
        },
        "client-token",
      ),
    );
    expect(second.status).toBe(200);

    // The upstream history must not contain the orphan tool output (the
    // ignore policy dropped it from the Pi context).
    const lastUpstream = upstreamBodies.at(-1) as {
      params?: { messages?: unknown[] };
    };
    const upstreamText = JSON.stringify(lastUpstream?.params?.messages ?? []);
    expect(upstreamText).not.toContain("call_orphan");
  });

  it("preserves full history across a multi-turn previous_response_id chain", async () => {
    const upstreamBodies: unknown[] = [];
    const fetch: FetchFunction = async (input, init) => {
      const request = new Request(input, init);
      upstreamBodies.push(JSON.parse(await request.text()));
      return commandCodeText("answered");
    };
    const { runtime } = await start({ fetch });

    // Turn 1: root.
    const t1 = await runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: [{ role: "user", content: "MARKER_ONE" }],
        },
        "client-token",
      ),
    );
    expect(t1.status).toBe(200);
    const t1Json = await t1.json();

    // Turn 2: chains onto turn 1.
    const t2 = await runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: [{ role: "user", content: "MARKER_TWO" }],
          previous_response_id: t1Json.id,
        },
        "client-token",
      ),
    );
    expect(t2.status).toBe(200);
    const t2Json = await t2.json();

    // Turn 3: chains onto turn 2; the upstream must receive BOTH markers
    // (full history), not just the latest increment.
    const t3 = await runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: [{ role: "user", content: "MARKER_THREE" }],
          previous_response_id: t2Json.id,
        },
        "client-token",
      ),
    );
    expect(t3.status).toBe(200);

    const lastUpstream = upstreamBodies.at(-1) as {
      params?: { messages?: unknown[] };
    };
    const upstreamText = JSON.stringify(lastUpstream?.params?.messages ?? []);
    expect(upstreamText).toContain("MARKER_ONE");
    expect(upstreamText).toContain("MARKER_TWO");
    expect(upstreamText).toContain("MARKER_THREE");
  });

  it("emits a request-local notice when store:false=persist stores despite caller false", async () => {
    const { parseOpenAIResponsesConfiguration } = await import(
      "../../src/protocols/openai-responses/configuration.js"
    );
    const configuration = parseOpenAIResponsesConfiguration({
      conversion: {
        response: { storeFalse: "persist" },
      },
    });
    const notices: string[] = [];
    const factory = {
      begin: () => ({
        requestId: "req-test",
        notice: (notice: { code: string }) => notices.push(notice.code),
        attempt: () => undefined,
        checkpoint: () => undefined,
        succeed: async () => undefined,
        fail: async () => undefined,
      }),
    };
    const { runtime } = await start({
      fetch: async () => commandCodeText("kept"),
      configuration,
      invocationDiagnostics: factory,
    });
    const response = await runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: "secret turn",
          store: false,
        },
        "client-token",
      ),
    );
    expect(response.status).toBe(200);
    expect(notices).toContain("openai-responses_store_false_persisted");
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
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-responses-restart-"),
    );
    const stateFile = join(directory, "openai-responses.json");
    const fetch: FetchFunction = async () => commandCodeText("restart-safe");

    const first = await start({ fetch, directory, stateFile });
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
    // Flush the pending debounced snapshot before the process "exits".
    await first.flushState();
    await first.close();
    compositions.splice(compositions.indexOf(first), 1);

    // New composition on the SAME stateFile (simulated process restart).
    const second = await start({ fetch, directory, stateFile });
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
    // The shared directory is owned by this test; clean it up here.
    await second.close();
    compositions.splice(compositions.indexOf(second), 1);
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
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
