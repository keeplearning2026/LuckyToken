/**
 * Replay the real Codex CLI request samples captured by
 * `test/online/run-codex-cli.ts` (sanitized into
 * `test/fixtures/codex-cli-requests/`). Every sample is a genuine
 * `POST /v1/responses` body the official Codex CLI produced, so this suite
 * proves Token accepts the exact wire shapes the real client sends —
 * offline, with a mocked upstream fetch.
 */
import type { FetchFunction } from "@earendil-works/pi-ai";
import { readdirSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOpenAIResponsesServingTestComposition,
  type OpenAIResponsesServingTestComposition,
} from "../support/openai-responses-serving.js";
import {
  convertResponsesRequest,
  type ResponseRequestConversionPolicy,
} from "../../src/protocols/openai-responses/request.js";

const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures", "codex-cli-requests");

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

interface FixtureSample {
  readonly file: string;
  readonly body: Record<string, unknown>;
}

const replayPolicy: ResponseRequestConversionPolicy = {
  privilegedMessages: "first",
  unknownInputItem: "error",
  orphanToolOutput: "error",
  unresolvedToolCall: "xrepair",
  futureReasoningEffort: "max",
};

function record(value: unknown): Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function sourceTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const candidate = record(part);
    return typeof candidate.text === "string" ? [candidate.text] : [];
  });
}

function sourceSystemPrompt(body: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof body.instructions === "string") parts.push(body.instructions);
  for (const item of Array.isArray(body.input) ? body.input : []) {
    const candidate = record(item);
    if (candidate.type !== "message") continue;
    if (candidate.role !== "developer" && candidate.role !== "system") continue;
    parts.push(sourceTextParts(candidate.content).join(""));
  }
  return parts.filter((part) => part.length > 0).join("\n");
}

function sourceConversationProjection(body: Record<string, unknown>): string[] {
  const events: string[] = [];
  for (const item of Array.isArray(body.input) ? body.input : []) {
    const candidate = record(item);
    const type = candidate.type ?? "message";
    if (type === "message") {
      if (candidate.role === "developer" || candidate.role === "system") continue;
      for (const text of sourceTextParts(candidate.content)) {
        events.push(`${String(candidate.role)}:text:${text}`);
      }
      continue;
    }
    if (type === "reasoning") {
      const summary = sourceTextParts(candidate.summary).join("");
      const content = sourceTextParts(candidate.content).join("");
      // This fixture resolves to a model declared reasoning:false. The
      // target-aware reasoning module therefore preserves visible summary
      // text through the required assistant-content fallback.
      events.push(`assistant:text:${summary || content}`);
      continue;
    }
    if (type === "function_call" || type === "custom_tool_call") {
      events.push(
        `assistant:call:${String(candidate.call_id)}:${String(candidate.name)}`,
      );
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      events.push(
        `tool:result:${String(candidate.call_id)}:${String(candidate.output)}`,
      );
    }
  }
  return events;
}

function commandCodeConversationProjection(messages: unknown): string[] {
  const events: string[] = [];
  expect(Array.isArray(messages)).toBe(true);
  for (const message of messages as unknown[]) {
    const candidate = record(message);
    const role = String(candidate.role);
    expect(Array.isArray(candidate.content)).toBe(true);
    for (const rawBlock of candidate.content as unknown[]) {
      const block = record(rawBlock);
      if (block.type === "text") {
        events.push(`${role}:text:${String(block.text)}`);
      } else if (block.type === "reasoning") {
        events.push(`assistant:reasoning:${String(block.text)}`);
      } else if (block.type === "tool-call") {
        events.push(
          `assistant:call:${String(block.toolCallId)}:${String(block.toolName)}`,
        );
      } else if (block.type === "tool-result") {
        const output = record(block.output);
        events.push(
          `tool:result:${String(block.toolCallId)}:${String(output.value)}`,
        );
      }
    }
  }
  return events;
}

function executableSourceTools(body: Record<string, unknown>): Record<string, unknown>[] {
  return (Array.isArray(body.tools) ? body.tools : [])
    .map(record)
    .filter((tool) => tool.type === "function" || tool.type === "custom");
}

function loadFixtures(): FixtureSample[] {
  const files = readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const samples: FixtureSample[] = [];
  for (const file of files) {
    const body = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8")) as Record<
      string,
      unknown
    >;
    samples.push({ file, body });
  }
  return samples;
}

function responsesRequest(body: Record<string, unknown>, token: string): Request {
  return new Request("http://Token.test/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("Codex CLI request sample replay", () => {
  const compositions: OpenAIResponsesServingTestComposition[] = [];
  const samples = loadFixtures();

  afterEach(async () => {
    await Promise.all(compositions.splice(0).map((c) => c.close()));
  });

  const baseOptions = {
    clientApiKey: "client-token",
    commandCodeApiKey: "provider-secret",
    commandCodeBaseUrl: "https://commandcode.test",
    modelId: "deepseek/deepseek-v4-flash",
  };

  async function start(fetch: FetchFunction) {
    const composition = await createOpenAIResponsesServingTestComposition({
      ...baseOptions,
      fetch,
    });
    compositions.push(composition);
    return composition;
  }

  expect(samples).toHaveLength(27);

  for (const sample of samples) {
    it(`accepts ${sample.file}`, async () => {
      const upstreamBodies: unknown[] = [];
      const fetch: FetchFunction = async (input, init) => {
        const request = new Request(input, init);
        upstreamBodies.push(JSON.parse(await request.text()));
        return commandCodeText("replayed");
      };
      const composition = await start(fetch);
      const { runtime } = composition;

      const response = await runtime.handle(
        responsesRequest(sample.body, "client-token"),
      );

      // Black-box: accepted with a well-formed response object.
      expect(response.status).toBe(200);
      const isStream = sample.body.stream === true;
      const json = isStream
        ? parseSseResponse(await response.text())
        : ((await response.json()) as Record<string, unknown>);
      expect(typeof json.id).toBe("string");
      expect(json.object).toBe("response");
      expect(["completed", "incomplete", "in_progress"]).toContain(json.status);
      expect(Array.isArray(json.output)).toBe(true);
      const usage = json.usage as Record<string, unknown> | undefined;
      expect(usage).toBeDefined();
      expect(typeof usage?.input_tokens).toBe("number");
      expect(typeof usage?.output_tokens).toBe("number");
      const inputDetails = usage?.input_tokens_details as
        | Record<string, unknown>
        | undefined;
      expect(inputDetails).toBeDefined();
      expect(typeof inputDetails?.cached_tokens).toBe("number");

      const lastUpstream = record(upstreamBodies.at(-1));
      const params = record(lastUpstream.params);

      // Developer/system authority is delivered through the Pi systemPrompt
      // and reaches the Provider's dedicated system field, not message text.
      expect(params.system).toBe(sourceSystemPrompt(sample.body));

      // The effective executable catalog is exact and ordered. Hosted
      // tool_search/web_search declarations are not misrepresented as BYOT
      // functions at the CommandCode boundary.
      const sourceTools = executableSourceTools(sample.body);
      const upstreamTools = (params.tools as unknown[]).map(record);
      expect(upstreamTools.map((tool) => tool.name)).toEqual(
        sourceTools.map((tool) => tool.name),
      );
      expect((json.tools as Array<{ name?: string }>).map((tool) => tool.name)).toEqual(
        sourceTools.map((tool) => tool.name),
      );

      // All 27 captured requests use the same explicit controls. The support
      // model is non-reasoning, so high is legally clamped to omission rather
      // than invented on the Provider wire.
      expect(sample.body).toMatchObject({
        stream: true,
        store: false,
        tool_choice: "auto",
        parallel_tool_calls: true,
        reasoning: { effort: "high" },
        text: { verbosity: "low" },
      });
      expect(params).toMatchObject({ stream: true, max_tokens: 64_000 });
      expect(params).not.toHaveProperty("reasoning_effort");
      expect(json).toMatchObject({
        tool_choice: "auto",
        parallel_tool_calls: true,
      });

      // Every captured apply_patch definition carries Lark grammar. Assert
      // the actual fixture maps into Pi grammar authority, then into the
      // CommandCode target's documented ordinary input:string tool shape.
      const sourceApplyPatch = sourceTools.find((tool) => tool.name === "apply_patch")!;
      const format = record(sourceApplyPatch.format);
      expect(format).toMatchObject({ type: "grammar", syntax: "lark" });
      expect(typeof format.definition).toBe("string");
      expect(String(format.definition).length).toBeGreaterThan(0);
      const piInvocation = convertResponsesRequest(sample.body, 1, replayPolicy);
      const piApplyPatch = piInvocation.invocation.pi.context.tools?.find(
        (tool) => tool.name === "apply_patch",
      );
      expect(piApplyPatch?.constrainedSampling).toEqual({
        type: "grammar",
        variants: { openai_lark: format.definition },
      });
      const upstreamApplyPatch = upstreamTools.find(
        (tool) => tool.name === "apply_patch",
      )!;
      expect(upstreamApplyPatch).not.toHaveProperty("grammar");
      expect(upstreamApplyPatch.input_schema).toMatchObject({
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      });

      // Normalize both source and target to model-visible events. Equality
      // proves text/reasoning/tool-call/tool-result order and correlation,
      // independent of protocol-specific containers.
      expect(commandCodeConversationProjection(params.messages)).toEqual(
        sourceConversationProjection(sample.body),
      );

      // store:false=honor writes neither memory nor disk. A follow-up by the
      // returned id must miss before any second upstream request can start.
      await composition.flushState();
      await expect(access(composition.stateFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const followUp = await runtime.handle(
        responsesRequest(
          {
            model: sample.body.model,
            input: "follow-up must miss",
            previous_response_id: json.id,
          },
          "client-token",
        ),
      );
      expect(followUp.status).toBe(400);
      expect(upstreamBodies).toHaveLength(1);
    });
  }

  it("preserves tool definitions (custom/function) across conversion", async () => {
    const applyPatchSample = samples.find((s) => s.file.includes("tool_apply_patch"));
    expect(applyPatchSample).toBeDefined();
    const tools = applyPatchSample?.body.tools;
    expect(Array.isArray(tools)).toBe(true);
    const custom = (tools as Array<{ type?: string; name?: string }>).find(
      (t) => t.type === "custom",
    );
    expect(custom?.name).toBe("apply_patch");

    const upstreamBodies: unknown[] = [];
    const fetch: FetchFunction = async (input, init) => {
      const request = new Request(input, init);
      upstreamBodies.push(JSON.parse(await request.text()));
      return commandCodeText("replayed");
    };
    const { runtime } = await start(fetch);
    const response = await runtime.handle(
      responsesRequest(applyPatchSample!.body, "client-token"),
    );
    expect(response.status).toBe(200);

    // The custom tool must be exposed to the provider as a function with a
    // single string `input` parameter (freeform normalization).
    const lastUpstream = upstreamBodies.at(-1) as {
      params?: { tools?: unknown[] };
    } | undefined;
    const upstreamText = JSON.stringify(lastUpstream?.params?.tools ?? []);
    expect(upstreamText).toContain("apply_patch");
    expect(upstreamText).toContain('"input"');
  });

  it("accepts reasoning and stream fields without rejection", async () => {
    const reasoningSample = samples.find((s) => s.file.includes("reasoning"));
    expect(reasoningSample).toBeDefined();
    expect(reasoningSample!.body.reasoning).toBeDefined();

    const { runtime } = await start(async () => commandCodeText("replayed"));
    const response = await runtime.handle(
      responsesRequest(reasoningSample!.body, "client-token"),
    );
    expect(response.status).toBe(200);
  });
});

/**
 * Parse the atomic SSE sequence Token emits for `stream: true` into the
 * terminal response object (response.completed frame).
 */
function parseSseResponse(text: string): Record<string, unknown> {
  let completed: Record<string, unknown> | undefined;
  for (const block of text.split("\n\n")) {
    const dataLine = block
      .split("\n")
      .find((line) => line.startsWith("data: "));
    if (dataLine === undefined) continue;
    const payload = dataLine.slice("data: ".length);
    if (payload === "[DONE]") continue;
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    if (parsed.type === "response.completed") {
      completed = parsed.response as Record<string, unknown>;
    }
  }
  if (completed === undefined) {
    throw new Error("replay_missing_sse_completed");
  }
  return completed;
}
