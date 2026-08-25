import type { FetchFunction } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { ServingCertificationFailure } from "../support/commandcode-serving-certification.js";
import type { AnthropicModelValidityPolicy } from "../../src/protocols/anthropic/representability.js";
import {
  createCommandCodeServingTestComposition,
  createCommandCodeTestRuntime,
  type CommandCodeServingTestOptions,
} from "../support/commandcode-serving.js";

function anthropicRequest(body: Record<string, unknown>): Request {
  return new Request("http://Token.test/v1/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer client-key",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
}

function textResponse(text = "done"): Response {
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({ type: "text-delta", id: "0", text }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    ].join("\n"),
  );
}

describe("certified serving composition", () => {
  it("publishes a Provider-blind runtime beside its immutable certification", () => {
    const composition = createCommandCodeServingTestComposition({
      clientApiKey: "client-key",
      commandCodeApiKey: "provider-key",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () => textResponse(),
      modelId: "model",
    });
    const { runtime, certification } = composition;

    expect(Object.keys(composition).sort()).toEqual(["certification", "runtime"]);
    expect(Object.keys(runtime).sort()).toEqual(["handle", "routes"]);
    expect(certification.result).toBe("CERTIFIED");
    expect(JSON.stringify(certification)).not.toContain("client-key");
    expect(JSON.stringify(certification)).not.toContain("provider-key");
    expect(runtime).not.toHaveProperty("models");
    expect(runtime).not.toHaveProperty("setProvider");
    expect(runtime).not.toHaveProperty("deleteProvider");
    expect(runtime).not.toHaveProperty("clearProviders");
    expect(runtime).not.toHaveProperty("refresh");
    expect(runtime).not.toHaveProperty("login");
    expect(runtime).not.toHaveProperty("logout");
  });

  it("fails startup with a FAILED manifest when serving facts are not certifiable", () => {
    let failure: unknown;
    try {
      createCommandCodeServingTestComposition({
        clientApiKey: "client-key",
        commandCodeApiKey: "provider-key",
        commandCodeBaseUrl: "https://commandcode.test",
        fetch: async () => textResponse(),
        modelId: "model",
        routerDefaults: { temperature: 1 },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ServingCertificationFailure);
    expect((failure as ServingCertificationFailure).manifest.result).toBe("FAILED");
  });

  it("isolates admitted and future requests from caller-owned configuration mutation", async () => {
    let releaseFetch: (() => void) | undefined;
    let markFetchStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const compatibility = { cliEnvironment: "prod" };
    const modelInput: Array<"text" | "image"> = ["text", "image"];
    const validityPolicy = {
      revision: "image-policy-v1",
      hasCertifiedImageFidelity: (): boolean => true,
    } satisfies AnthropicModelValidityPolicy;
    const upstreamRequests: Request[] = [];
    const fetch: FetchFunction = async (input, init) => {
      upstreamRequests.push(new Request(input, init));
      if (upstreamRequests.length === 1) {
        markFetchStarted?.();
        await release;
      }
      return textResponse();
    };
    const runtimeOptions: CommandCodeServingTestOptions = {
      clientApiKey: "client-key",
      commandCodeApiKey: "provider-key",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch,
      modelId: "model",
      modelInput,
      commandCodeCompatibility: compatibility,
      anthropicModelValidityPolicy: validityPolicy,
      createSessionId: () => "00000000-0000-4000-8000-000000000121",
    };
    const composition = createCommandCodeServingTestComposition(runtimeOptions);
    const { runtime, certification } = composition;

    const handling = runtime.handle(
      anthropicRequest({
        model: "model",
        max_tokens: 10,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "AA==" },
              },
            ],
          },
        ],
      }),
    );
    await started;

    compatibility.cliEnvironment = "staging";
    modelInput.splice(0, modelInput.length, "text");
    validityPolicy.revision = "mutated-policy";
    validityPolicy.hasCertifiedImageFidelity = () => false;
    releaseFetch?.();

    const response = await handling;
    expect(response.status).toBe(200);
    expect(certification.policies.modelValidity.revision).toBe("image-policy-v1");
    expect(upstreamRequests[0]?.headers.get("x-cli-environment")).toBe(
      "production",
    );

    const futureResponse = await runtime.handle(
      anthropicRequest({
        model: "model",
        max_tokens: 10,
        messages: [{ role: "user", content: "future" }],
      }),
    );
    expect(futureResponse.status).toBe(200);
    expect(upstreamRequests).toHaveLength(2);
  });

  it("preserves a provider tool-call identity through the next client turn", async () => {
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const fetch: FetchFunction = async (input, init) => {
      const request = new Request(input, init);
      upstreamBodies.push((await request.json()) as Record<string, unknown>);
      if (upstreamBodies.length === 1) {
        return new Response(
          [
            JSON.stringify({
              type: "tool-input-start",
              id: "Call_Exact-1",
              toolName: "lookup",
            }),
            JSON.stringify({ type: "tool-input-end", id: "Call_Exact-1" }),
            JSON.stringify({
              type: "tool-call",
              toolCallId: "Call_Exact-1",
              toolName: "lookup",
              input: { q: "x" },
            }),
            JSON.stringify({
              type: "finish",
              finishReason: "tool-calls",
              totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }),
          ].join("\n"),
        );
      }
      return textResponse("round trip complete");
    };
    const runtime = createCommandCodeTestRuntime({
      clientApiKey: "client-key",
      commandCodeApiKey: "provider-key",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch,
      modelId: "model",
      createMessageId: () => "msg_round_trip",
      createSessionId: () => "00000000-0000-4000-8000-000000000122",
    });

    const first = await runtime.handle(
      anthropicRequest({
        model: "model",
        max_tokens: 10,
        tools: [
          {
            name: "lookup",
            description: "Lookup",
            input_schema: {
              type: "object",
              properties: { q: { type: "string" } },
              required: ["q"],
            },
          },
        ],
        messages: [{ role: "user", content: "use the tool" }],
      }),
    );
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody).toMatchObject({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "Call_Exact-1",
          name: "lookup",
          input: { q: "x" },
        },
      ],
    });

    const second = await runtime.handle(
      anthropicRequest({
        model: "model",
        max_tokens: 10,
        tools: [
          {
            name: "lookup",
            description: "Lookup",
            input_schema: {
              type: "object",
              properties: { q: { type: "string" } },
              required: ["q"],
            },
          },
        ],
        messages: [
          { role: "user", content: "use the tool" },
          { role: "assistant", content: firstBody.content },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "Call_Exact-1",
                content: [{ type: "text", text: "exact result" }],
              },
            ],
          },
        ],
      }),
    );

    expect(second.status).toBe(200);
    expect(upstreamBodies[1]).toMatchObject({
      params: {
        messages: [
          { role: "user" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "Call_Exact-1",
                toolName: "lookup",
                input: { q: "x" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "Call_Exact-1",
              toolName: "lookup",
                output: { type: "text", value: "exact result" },
              },
            ],
          },
        ],
      },
    });
  });
});
