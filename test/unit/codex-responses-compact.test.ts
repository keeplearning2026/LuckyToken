import type { AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import type { AliasModelSource } from "../../src/alias-model-seam.js";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { createOpenAIResponsesCompactHandler } from "../../src/protocols/openai-responses/compact.js";
import { CODEX_COMPACT_PROMPT } from "../../src/protocols/openai-responses/compact-semantic.js";

function compactRequest(model: string, input: unknown[]): Request {
  return new Request("http://luckytoken.test/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input }),
  });
}

function model(provider: string, id: string, api = "fixture-api"): Model<string> {
  return {
    id,
    name: id,
    provider,
    api,
    baseUrl: "https://provider.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  };
}

function aliasSource(alias: string, target: Model<string>): AliasModelSource {
  return {
    requestSnapshot: async () =>
      ({
        resolve: (selector: string) =>
          selector === alias
            ? { providerId: target.provider, modelId: target.id }
            : undefined,
      }) as never,
  };
}

function summaryMessage(target: Model<string>, text: string): AssistantMessage {
  return {
    role: "assistant",
    api: target.api,
    provider: target.provider,
    model: target.id,
    content: [{ type: "text", text }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

describe("OpenAI Responses compact three-lane routing", () => {
  it("lets Local Native claim compact without resolving Pi Models or falling through", async () => {
    const local = {
      claims: vi.fn((selector: string) => selector === "gpt-native"),
      execute: vi.fn(async () => new Response("local-compact", { status: 502 })),
    };
    const models = new Proxy({} as Models, {
      get() {
        throw new Error("Pi Models must not be touched after Local Compact claims");
      },
    });
    const handler = createOpenAIResponsesCompactHandler({
      models,
      localNativeLane: local,
      stateFile: "unused-compact-local.json",
      maxRequestBytes: 1024,
    });

    const response = await handler.handle(compactRequest("gpt-native", []));

    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toBe("local-compact");
    expect(local.execute).toHaveBeenCalledOnce();
  });

  it("lets Provider Native claim the resolved model without entering Semantic execution", async () => {
    const target = model("openai", "gpt-5", "openai-responses");
    const models = { getModels: () => [target] } as unknown as Models;
    const executeOperation = vi.fn(async () => {
      throw new Error("Semantic execution must not run after Provider Native claims");
    });
    const provider = {
      claims: vi.fn(() => true),
      execute: vi.fn(async () =>
        new Response(JSON.stringify({ object: "response.compaction", output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    };
    const handler = createOpenAIResponsesCompactHandler({
      models,
      providerNativeLane: provider,
      executeOperation,
      stateFile: "unused-compact-provider.json",
      maxRequestBytes: 1024,
    });

    const response = await handler.handle(compactRequest("openai/gpt-5", []));

    expect(response.status).toBe(200);
    expect(provider.claims).toHaveBeenCalledWith(target, "compact");
    expect(provider.execute).toHaveBeenCalledOnce();
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("projects Provider Native compact success model identity losslessly back to the requested alias", async () => {
    const target = model("openai", "gpt-5", "openai-responses");
    const models = { getModels: () => [target] } as unknown as Models;
    const upstreamBody =
      '{\n  "object":"response.compaction", "model" : "gpt-5", "future_number":9007199254740993, "negative_zero":-0,\n  "output":[{"type":"compaction","encrypted_content":"opaque"}]\n}';
    const provider = {
      claims: vi.fn(() => true),
      execute: vi.fn(async () =>
        new Response(upstreamBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    };
    const handler = createOpenAIResponsesCompactHandler({
      models,
      aliasSource: aliasSource("my-alias", target),
      providerNativeLane: provider,
      stateFile: "unused-compact-alias-success.json",
      maxRequestBytes: 1024,
    });

    const response = await handler.handle(compactRequest("my-alias", []));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(
      upstreamBody.replace('"gpt-5"', '"my-alias"'),
    );
  });

  it("filters unsafe Provider Native compact response headers", async () => {
    const target = model("openai", "gpt-5", "openai-responses");
    const models = { getModels: () => [target] } as unknown as Models;
    const provider = {
      claims: vi.fn(() => true),
      execute: vi.fn(async () =>
        new Response('{"object":"response.compaction","output":[]}', {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "sid=secret",
            authorization: "Bearer upstream-secret",
            "content-length": "999",
            "content-encoding": "gzip",
            "x-safe-provider-header": "keep-me",
          },
        }),
      ),
    };
    const handler = createOpenAIResponsesCompactHandler({
      models,
      providerNativeLane: provider,
      stateFile: "unused-compact-header-filter.json",
      maxRequestBytes: 1024,
    });

    const response = await handler.handle(compactRequest("openai/gpt-5", []));

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("authorization")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("x-safe-provider-header")).toBe("keep-me");
  });

  it("returns 502 when a claimed Provider Native compact response body cannot be read", async () => {
    const target = model("openai", "gpt-5", "openai-responses");
    const models = { getModels: () => [target] } as unknown as Models;
    const executeOperation = vi.fn(async () => {
      throw new Error("Semantic execution must not run after Provider Native claims");
    });
    const provider = {
      claims: vi.fn(() => true),
      execute: vi.fn(async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error("compact-body-canary"));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    };
    const handler = createOpenAIResponsesCompactHandler({
      models,
      providerNativeLane: provider,
      executeOperation,
      stateFile: "unused-compact-body-read.json",
      maxRequestBytes: 1024,
    });

    const response = await handler.handle(compactRequest("openai/gpt-5", []));

    expect(response.status).toBe(502);
    const wire = await response.text();
    expect(wire).toContain("Upstream compact response could not be read");
    expect(wire).not.toContain("compact-body-canary");
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("sanitizes Provider Native compact alias errors instead of leaking canonical identity", async () => {
    const target = model("openai", "gpt-5", "openai-responses");
    const models = { getModels: () => [target] } as unknown as Models;
    const provider = {
      claims: vi.fn(() => true),
      execute: vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "canonical gpt-5 at openai provider failed canary-compact-secret",
            },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
      ),
    };
    const handler = createOpenAIResponsesCompactHandler({
      models,
      aliasSource: aliasSource("my-alias", target),
      providerNativeLane: provider,
      stateFile: "unused-compact-alias-error.json",
      maxRequestBytes: 1024,
    });

    const response = await handler.handle(compactRequest("my-alias", []));

    expect(response.status).toBe(502);
    const wire = await response.text();
    expect(wire).toContain("Upstream provider failed");
    expect(wire).not.toContain("gpt-5");
    expect(wire).not.toContain("openai");
    expect(wire).not.toContain("canary-compact-secret");
  });

  it("runs synthetic compact directly through the Semantic executor and retains recent user turns", async () => {
    const target = model("semantic", "summary-model");
    const models = { getModels: () => [target] } as unknown as Models;
    const executeOperation = vi.fn(async (_models, selected, context) => {
      expect(selected).toBe(target);
      expect(JSON.stringify(context)).toContain(CODEX_COMPACT_PROMPT);
      return summaryMessage(target, "SUMMARY BODY");
    });
    const handler = createOpenAIResponsesCompactHandler({
      models,
      executeOperation,
      stateFile: "unused-compact-semantic.json",
      maxRequestBytes: 1024 * 1024,
      createResponseId: () => "resp_summary",
      now: () => 1,
    });

    const response = await handler.handle(
      compactRequest("semantic/summary-model", [
        { type: "message", role: "user", content: [{ type: "input_text", text: "FIRST" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "SECOND" }] },
      ]),
    );

    expect(response.status).toBe(200);
    expect(executeOperation).toHaveBeenCalledOnce();
    const body = (await response.json()) as { output: Array<Record<string, unknown>> };
    expect(body.output).toHaveLength(3);
    expect(JSON.stringify(body.output[0])).toContain("FIRST");
    expect(JSON.stringify(body.output[1])).toContain("SECOND");
    expect(JSON.stringify(body.output[2])).toContain("SUMMARY BODY");
  });

  it("keeps compact routing separate from Semantic compact execution", async () => {
    const source = await readFile(
      "src/protocols/openai-responses/compact.ts",
      "utf8",
    );
    const semantic = await readFile(
      "src/protocols/openai-responses/compact-semantic.ts",
      "utf8",
    );
    expect(source).not.toContain("responsesHandler");
    expect(source).not.toContain(".handle(internalRequest)");
    expect(source).not.toMatch(/integrations[\\/]codex/u);
    expect(source).not.toContain("executeSemanticResponses");
    expect(source).not.toContain("RETAINED_USER_CHAR_BUDGET");
    expect(source).toContain("executeSemanticCompact");
    expect(semantic).toContain("executeSemanticResponses");
    expect(semantic).toContain("CODEX_COMPACT_PROMPT");
  });
});
