/**
 * Replay the real Codex CLI request samples captured by
 * `test/online/run-codex-cli.ts` (sanitized into
 * `test/fixtures/codex-cli-requests/`). Every sample is a genuine
 * `POST /v1/responses` body the official Codex CLI produced, so this suite
 * proves LuckyToken accepts the exact wire shapes the real client sends —
 * offline, with a mocked upstream fetch.
 */
import type { FetchFunction } from "@earendil-works/pi-ai";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOpenAIResponsesServingTestComposition,
  type OpenAIResponsesServingTestComposition,
} from "../support/openai-responses-serving.js";

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
  return new Request("http://luckytoken.test/v1/responses", {
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

  expect(samples.length).toBeGreaterThan(0);

  for (const sample of samples) {
    it(`accepts ${sample.file}`, async () => {
      const upstreamBodies: unknown[] = [];
      const fetch: FetchFunction = async (input, init) => {
        const request = new Request(input, init);
        upstreamBodies.push(JSON.parse(await request.text()));
        return commandCodeText("replayed");
      };
      const { runtime } = await start(fetch);

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

      // Deep: every input item must be accepted without rejection (the
      // sanitized samples include message/reasoning/tool shapes).
      const input = sample.body.input;
      if (Array.isArray(input)) {
        for (const item of input) {
          const type = (item as { type?: string })?.type ?? "message";
          expect([
            "message",
            "reasoning",
            "function_call",
            "function_call_output",
            "custom_tool_call",
            "custom_tool_call_output",
            "web_search_call",
            "compaction",
          ]).toContain(type);
        }
      }

      // Deep: the upstream received a converted CommandCode conversation
      // (roles user/assistant/tool), proving the wire conversion succeeded.
      const lastUpstream = upstreamBodies.at(-1) as {
        params?: { messages?: Array<{ role?: string }> };
      } | undefined;
      const roles = lastUpstream?.params?.messages?.map((m) => m.role) ?? [];
      expect(roles.length).toBeGreaterThan(0);
      for (const role of roles) {
        expect(["user", "assistant", "tool"]).toContain(role);
      }
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
 * Parse the atomic SSE sequence LuckyToken emits for `stream: true` into the
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
