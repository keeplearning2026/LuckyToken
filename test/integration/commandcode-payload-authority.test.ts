import {
  createModels,
  type Context,
  type FetchFunction,
  type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
  createCommandCodePrivateProvider,
} from "../../src/providers/commandcode-private/provider.js";
import type { ServerConfig } from "../../src/providers/commandcode-private/project.js";
import { findUpstreamFailureFact } from "../../src/protocols/upstream-failure.js";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("callback fixture expected an object");
  }
  return value as Record<string, unknown>;
}

function response(): Response {
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({ type: "text-delta", id: "0", text: "ok" }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    ].join("\n"),
  );
}

function model(): Model<typeof commandCodePrivateApiId> {
  return {
    id: "authority-model",
    name: "authority-model",
    api: commandCodePrivateApiId,
    provider: commandCodePrivateProviderId,
    baseUrl: "https://fixture.test",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1_000_000,
      output: 2_000_000,
      cacheRead: 0,
      cacheWrite: 0,
      tiers: [
        {
          inputTokensAbove: 0,
          input: 3_000_000,
          output: 4_000_000,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ],
    },
    contextWindow: 100_000,
    maxTokens: 100,
  };
}

const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
};
const projectConfig: ServerConfig = {
  workingDir: "/project",
  date: "2026-08-10",
  environment: "linux",
  structure: ["src"],
  isGitRepo: true,
  currentBranch: "main",
  mainBranch: "main",
  gitStatus: "Working tree clean",
  recentCommits: ["abc initial"],
};
const sessionId = "00000000-0000-4000-8000-000000000090";

describe("CommandCode payload authority", () => {
  it("allows the generation surface while preserving response identity and pricing", async () => {
    const selected = model();
    let requestBody: unknown;
    const fetch: FetchFunction = async (input, init) => {
      requestBody = await new Request(input, init).json();
      return response();
    };
    const callback = vi.fn((payload: unknown, callbackModel: Model<string>) => {
      const root = record(payload);
      const params = record(root.params);
      params.system = "hook system";
      params.messages = [{ role: "user", content: [{ type: "text", text: "hook" }] }];
      params.tools = [];
      params.max_tokens = 11;
      params.temperature = 0.25;
      params.reasoning_effort = "low";
      root.mode = "native-mode";

      callbackModel.id = "mutated-model";
      callbackModel.provider = "mutated-provider";
      callbackModel.api = "mutated-api";
      callbackModel.cost.input = 0;
      callbackModel.cost.output = 0;
      if (callbackModel.cost.tiers !== undefined) {
        callbackModel.cost.tiers[0] = {
          inputTokensAbove: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }
    });
    const provider = createCommandCodePrivateProvider({
      apiKey: "key",
      fetch,
      model: selected,
      now: () => 123,
      projectSnapshot: { snapshot: async () => projectConfig },
    });
    const models = createModels();
    models.setProvider(provider);

    const result = await models
      .streamSimple(selected, context, {
        maxTokens: 20,
        reasoning: "high",
        sessionId,
        metadata: { projectDir: "/project" },
        onPayload: callback,
      })
      .result();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(requestBody).toMatchObject({
      mode: "native-mode",
      params: {
        model: "authority-model",
        system: "hook system",
        max_tokens: 11,
        temperature: 0.25,
        reasoning_effort: "low",
      },
    });
    expect(result).toMatchObject({
      api: commandCodePrivateApiId,
      provider: commandCodePrivateProviderId,
      model: "authority-model",
      timestamp: 123,
      usage: {
        cost: { input: 3, output: 4, total: 7 },
      },
      stopReason: "stop",
    });
  });

  it("isolates project authority and rejects coordinated payload/model mutation", async () => {
    const selected = model();
    let fetchCalls = 0;
    const fetch: FetchFunction = async () => {
      fetchCalls += 1;
      return response();
    };
    const provider = createCommandCodePrivateProvider({
      apiKey: "key",
      fetch,
      model: selected,
      now: () => 123,
      projectSnapshot: { snapshot: async () => projectConfig },
    });
    const models = createModels();
    models.setProvider(provider);

    const result = await models
      .streamSimple(selected, context, {
        maxTokens: 20,
        sessionId,
        metadata: { projectDir: "/project" },
        onPayload: (payload, callbackModel) => {
          record(record(payload).config).workingDir = "/mutated";
          record(record(payload).params).model = "mutated-model";
          callbackModel.id = "mutated-model";
        },
      })
      .result();

    expect(fetchCalls).toBe(0);
    expect(projectConfig.workingDir).toBe("/project");
    expect(result).toMatchObject({
      model: "authority-model",
      stopReason: "error",
    });
    expect(findUpstreamFailureFact(result.diagnostics)).toMatchObject({
      kind: "conversion",
      retryable: false,
    });
  });

  it("reports a payload callback failure as a neutral callback fact before fetch", async () => {
    let fetchCalls = 0;
    const provider = createCommandCodePrivateProvider({
      apiKey: "key",
      fetch: async () => {
        fetchCalls += 1;
        return response();
      },
      model: model(),
      now: () => 123,
      projectSnapshot: { snapshot: async () => projectConfig },
    });

    const result = await provider
      .streamSimple(model(), context, {
        maxTokens: 20,
        sessionId,
        onPayload: () => {
          throw new Error("private callback detail");
        },
      })
      .result();

    expect(fetchCalls).toBe(0);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("CommandCode payload callback failed");
    const failure = findUpstreamFailureFact(result.diagnostics);
    expect(failure).toMatchObject({
      kind: "callback",
      phase: "payload_callback",
      retryable: false,
    });
    expect(failure?.message).toBe("CommandCode payload callback failed");
    expect(JSON.stringify(failure)).not.toContain("private callback detail");
  });

  it("rejects an injected unknown field as a neutral conversion fact before fetch", async () => {
    let fetchCalls = 0;
    const provider = createCommandCodePrivateProvider({
      apiKey: "key",
      fetch: async () => {
        fetchCalls += 1;
        return response();
      },
      model: model(),
      now: () => 123,
      projectSnapshot: { snapshot: async () => projectConfig },
    });

    const result = await provider
      .streamSimple(model(), context, {
        maxTokens: 20,
        sessionId,
        onPayload: (payload) => {
          record(payload).forbiddenField = true;
        },
      })
      .result();

    expect(fetchCalls).toBe(0);
    expect(result.stopReason).toBe("error");
    expect(findUpstreamFailureFact(result.diagnostics)).toMatchObject({
      kind: "conversion",
      retryable: false,
    });
  });

  it.each([
    ["invalid name", { "bad header": "value" }],
    ["invalid value", { "x-invalid": "line\r\nbreak" }],
  ])("rejects %s header syntax before fetch", async (_name, headers) => {
    let fetchCalls = 0;
    const provider = createCommandCodePrivateProvider({
      apiKey: "key",
      fetch: async () => {
        fetchCalls += 1;
        return response();
      },
      model: model(),
      now: () => 123,
      projectSnapshot: { snapshot: async () => projectConfig },
    });

    const result = await provider
      .streamSimple(model(), context, {
        maxTokens: 20,
        sessionId,
        headers,
      })
      .result();

    expect(fetchCalls).toBe(0);
    expect(result.stopReason).toBe("error");
    expect(findUpstreamFailureFact(result.diagnostics)).toMatchObject({
      kind: "conversion",
      retryable: false,
    });
  });
});
