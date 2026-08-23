import type { FetchFunction } from "@earendil-works/pi-ai";

import { afterEach, describe, expect, it } from "vitest";

import type { OpenAIResponsesConfiguration } from "../../src/protocols/openai-responses/configuration.js";
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
        maxRequestBytes?: number;
      },
  ) {
    const composition = await createOpenAIResponsesServingTestComposition({
      ...baseOptions,
      ...options,
    });
    compositions.push(composition);
    return composition;
  }

  it("does not require a LuckyToken client credential", async () => {
    const fetch: FetchFunction = async () => commandCodeText("anonymous");
    const { runtime } = await start({ fetch });

    const response = await runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: [{ role: "user", content: "hello" }],
        },
        "not-a-client-token",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "completed" });
  });

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

  it("does not let Authorization affect unknown-model classification", async () => {
    const { runtime } = await start({
      fetch: async () => commandCodeText("unused"),
    });
    const response = await runtime.handle(
      responsesRequest(
        { model: "m", input: "x" },
        "wrong-token",
      ),
    );
    expect(response.status).toBe(404);
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

  it("returns 400 for a non-JSON request body", async () => {
    const { runtime } = await start({
      fetch: async () => commandCodeText("unused"),
    });
    const response = await runtime.handle(
      new Request("http://luckytoken.test/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer client-token",
          "content-type": "application/json",
        },
        body: "{not json",
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { type: string; message: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("not valid JSON");
  });

  it("returns 413 when the request body exceeds the configured byte ceiling", async () => {
    const { runtime } = await start({
      fetch: async () => commandCodeText("unused"),
      maxRequestBytes: 64,
    });
    const response = await runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: "x".repeat(10_000),
        },
        "client-token",
      ),
    );
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe("request_too_large");
  });

  it("admits Responses bodies above the previous 32 MiB default", async () => {
    const { runtime } = await start({
      fetch: async () => {
        throw new Error("unknown models must not reach an upstream");
      },
    });
    const response = await runtime.handle(
      responsesRequest(
        {
          model: "unknown/provider",
          input: "x".repeat(32 * 1024 * 1024),
        },
        "client-token",
      ),
    );

    expect(response.status).toBe(404);
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

  it("renders an incomplete SSE terminal with clean created snapshot when upstream stops on length", async () => {
    // The provider commits a length terminal: the adapter forms an
    // incomplete Response and the SSE sequence must carry the terminal-only
    // incomplete_details only on the response.incomplete event — never on the
    // response.created snapshot (which claims in_progress).
    const fetch: FetchFunction = async () =>
      new Response(
        [
          JSON.stringify({ type: "text-start", id: "0" }),
          JSON.stringify({ type: "text-delta", id: "0", text: "partial" }),
          JSON.stringify({ type: "text-end", id: "0" }),
          JSON.stringify({
            type: "finish",
            finishReason: "length",
            totalUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
          }),
          "",
        ].join("\n"),
      );
    const { runtime } = await start({ fetch });
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
    const frames = (await response.text())
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
      .map((frame) => JSON.parse(frame.replace(/^data: /, "")) as {
        type: string;
        response: {
          status: string;
          error: unknown;
          incomplete_details: unknown;
        };
      });
    expect(frames.map((f) => f.type)).toEqual([
      "response.created",
      "response.output_item.done",
      "response.incomplete",
    ]);
    expect(frames[0]!.response.status).toBe("in_progress");
    expect(frames[0]!.response.error).toBeNull();
    expect(frames[0]!.response.incomplete_details).toBeNull();
    const terminal = frames[2]!;
    expect(terminal.response.status).toBe("incomplete");
    expect(terminal.response.error).toBeNull();
    expect(terminal.response.incomplete_details).toEqual({
      reason: "max_output_tokens",
    });
  });

  it("returns a non-streaming error for an upstream error terminal, never response.failed", async () => {
    // An upstream provider failure surfaces as a Pi error terminal before any
    // Response object is formed; the adapter returns the non-streaming error
    // envelope and must not fabricate a response.failed SSE terminal.
    const fetch: FetchFunction = async () =>
      new Response(
        [
          JSON.stringify({ type: "text-start", id: "0" }),
          JSON.stringify({ type: "text-delta", id: "0", text: "partial" }),
          JSON.stringify({
            type: "finish",
            finishReason: "error",
            errorMessage: "upstream exploded",
            totalUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          }),
          "",
        ].join("\n"),
      );
    const { runtime } = await start({ fetch });
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
    // The error surfaces as a non-2xx JSON error, never as a 200 SSE stream
    // with response.failed (no Response object has been formed).
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/json");
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("response.failed");
    expect(text).not.toContain("response.completed");
    expect(text).not.toContain("[DONE]");
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
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.code).toBeNull();
    expect(body.error.message).toContain("slow down");
  });

  it("returns non-2xx JSON for a pre-commit failure instead of fabricating response.failed", async () => {
    // An upstream 503 before the first SSE byte: the response is a non-2xx
    // JSON error envelope, never a fabricated response.failed terminal.
    const fetch: FetchFunction = async () =>
      new Response(
        JSON.stringify({ error: { message: "upstream down" } }),
        {
          status: 503,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req-safe-123",
          },
        },
      );
    const { runtime } = await start({ fetch });
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
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { error: { type: string; code: string | null } };
    expect(body.error.type).toBe("api_error");
    expect(body.error.code).toBeNull();
    const text = JSON.stringify(body);
    expect(text).not.toContain("response.failed");
    expect(text).not.toContain("response.completed");
    expect(text).not.toContain("[DONE]");
  });

  it("returns non-2xx JSON for a pre-commit failure in non-streaming mode too", async () => {
    // The pre-commit failure contract is mode-independent: a non-stream
    // request also receives the JSON error envelope, never a fabricated
    // Response object with status failed.
    const fetch: FetchFunction = async () =>
      new Response(
        JSON.stringify({ error: { message: "upstream down" } }),
        { status: 502, headers: { "content-type": "application/json" } },
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
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as {
      error: { type: string; status?: string };
    };
    expect(body.error.type).toBe("api_error");
    // A bare JSON error envelope, not a Response object carrying status.
    expect(body).not.toHaveProperty("status");
    expect(JSON.stringify(body)).not.toContain("response.failed");
  });

  it("preserves safe request-id/retry headers on non-streaming errors", async () => {
    const fetch: FetchFunction = async () =>
      new Response(JSON.stringify({ error: { message: "throttled" } }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-42",
          "retry-after": "17",
          "set-cookie": "secret=1",
        },
      });
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
    expect(response.headers.get("x-request-id")).toBe("req-42");
    expect(response.headers.get("retry-after")).toBe("17");
    // Unsafe headers never survive.
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("authorization")).toBeNull();
  });

  it("emits atomic SSE with monotonic sequence numbers and the status-matching terminal", async () => {
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
    const text = await response.text();
    const frames = text
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
      .map((frame) => JSON.parse(frame.replace(/^data: /, "")) as {
        type: string;
        sequence_number: number;
      });
    // created → output_item.done → completed → [DONE]
    expect(frames.map((f) => f.type)).toEqual([
      "response.created",
      "response.output_item.done",
      "response.completed",
    ]);
    const sequences = frames.map((f) => f.sequence_number);
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]!).toBeGreaterThan(sequences[i - 1]!);
    }
    expect(sequences[0]).toBe(0);
    // The completed terminal carries the full object with null error fields.
    const terminal = frames.at(-1) as unknown as {
      response: { status: string; error: unknown; incomplete_details: unknown };
    };
    expect(terminal.response.status).toBe("completed");
    expect(terminal.response.error).toBeNull();
    expect(terminal.response.incomplete_details).toBeNull();
    expect(text).toContain("data: [DONE]");
  });

  it("echoes an explicit temperature of zero as effective, never as absence", async () => {
    // temperature:0 is a legal target value and must be echoed as 0 — it is
    // not the same as an absent temperature (which renders null).
    const { runtime } = await start({
      fetch: async () => commandCodeText("answered"),
    });
    const response = await runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: "hello",
          temperature: 0,
        },
        "client-token",
      ),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { temperature: number | null };
    expect(json.temperature).toBe(0);
  });

  it("echoes effective normalized controls in the response object", async () => {
    const { runtime } = await start({
      fetch: async () => commandCodeText("answered"),
    });
    const response = await runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: "hello",
          // A dropped forced control and a parallel flag must never be echoed
          // as effective; the response carries target defaults instead.
          tool_choice: { type: "shell" },
          parallel_tool_calls: false,
          temperature: 0.5,
          top_p: 0.9,
        },
        "client-token",
      ),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.tool_choice).toBe("auto");
    expect(json.parallel_tool_calls).toBe(true);
    expect(json.temperature).toBe(0.5);
    expect(json.top_p).toBe(0.9);
    expect(json.tools).toEqual([]);
  });

  it("echoes the effective executable tools actually offered to Pi", async () => {
    const { runtime } = await start({
      fetch: async () => commandCodeText("answered"),
    });
    const response = await runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: "hello",
          tools: [
            { type: "function", name: "lookup", parameters: { type: "object" } },
            { type: "custom", name: "apply_patch" },
            // Hosted declaration is dropped and must never be echoed.
            { type: "web_search", name: "web_search" },
          ],
          tool_choice: "none",
        },
        "client-token",
      ),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;
    // tool_choice none removed the catalog entirely; no tool is echoed.
    expect(json.tool_choice).toBe("none");
    expect(json.tools).toEqual([]);
  });

  it("echoes custom tools in the SDK CustomTool shape, never inventing input_schema", async () => {
    // The installed SDK models a custom tool as
    // {type:'custom', name, description?, format?} — there is no input_schema
    // field on CustomTool. An effective echo must not invent wire fields the
    // target type does not have (ticket 17: echo effective normalized tools).
    const { runtime } = await start({
      fetch: async () => commandCodeText("answered"),
    });
    const response = await runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: "hello",
          tools: [
            // strict:false keeps the function tool out of CommandCode's
            // constrained-sampling requirement path (the mock provider
            // rejects require).
            {
              type: "function",
              name: "lookup",
              parameters: { type: "object" },
              strict: false,
            },
            { type: "custom", name: "apply_patch" },
          ],
          tool_choice: "auto",
        },
        "client-token",
      ),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { tools: Array<Record<string, unknown>> };
    const byName = new Map(json.tools.map((tool) => [tool.name, tool]));
    const custom = byName.get("apply_patch");
    expect(custom).toBeDefined();
    expect(custom!.type).toBe("custom");
    // SDK CustomTool has no input_schema field; a freeform custom tool is
    // expressed through the SDK's `format` slot or omitted entirely.
    expect(custom).not.toHaveProperty("input_schema");
    // The function tool keeps its SDK FunctionTool shape.
    const fn = byName.get("lookup");
    expect(fn).toMatchObject({
      type: "function",
      name: "lookup",
      parameters: { type: "object" },
    });
  });

  it("echoes tool_choice allowed filtering as the SDK auto value, never a raw allowed string", async () => {
    // The SDK Response.tool_choice accepts 'none'|'auto'|'required' or the
    // ToolChoiceAllowed object; a bare "allowed" string is not a legal wire
    // value. The allowed_tools filter is auto-mode filtering, so the
    // effective echo is "auto" with the filtered catalog (ticket 17: echo
    // effective normalized controls).
    const { runtime } = await start({
      fetch: async () => commandCodeText("answered"),
    });
    const response = await runtime.handle(
      responsesRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          input: "hello",
          tools: [
            // strict:false keeps the function tools out of CommandCode's
            // constrained-sampling requirement path.
            {
              type: "function",
              name: "lookup",
              parameters: { type: "object" },
              strict: false,
            },
            {
              type: "function",
              name: "other",
              parameters: { type: "object" },
              strict: false,
            },
          ],
          tool_choice: { type: "allowed", allowed_tools: ["lookup"] },
        },
        "client-token",
      ),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      tool_choice: string;
      tools: Array<{ name: string }>;
    };
    expect(json.tool_choice).toBe("auto");
    expect(json.tools.map((tool) => tool.name)).toEqual(["lookup"]);
  });

  it("redacts and bounds a pre-commit body-derived message", async () => {
    // AC7: unsafe body text is bounded and redacted even on the pre-commit
    // error path. A credential-looking fragment must never be echoed.
    const fetch: FetchFunction = async () =>
      new Response(
        JSON.stringify({
          error: {
            type: "api_error",
            message: "Bearer sk-secret-token-12345678 failed",
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
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
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).not.toContain("sk-secret-token-12345678");
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
