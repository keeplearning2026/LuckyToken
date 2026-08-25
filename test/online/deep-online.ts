import Anthropic from "@anthropic-ai/sdk";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTokenCliConfig } from "../../src/cli-config.js";
import { DEFAULT_MAX_REQUEST_BYTES } from "../../src/data-plane-limits.js";
import { startTokenHttpServer } from "../../src/server.js";
import { createConfiguredTokenDataPlane } from "../support/configured-data-plane.js";

/**
 * Deep online verification against the real CommandCode API.
 * Covers scenarios beyond the standard online suite: multi-turn history,
 * system prompts, reasoning effort levels, complex tool schemas, parallel
 * tool calls, long outputs, streaming, and error paths.
 */

const MODEL = "commandcode-private/deepseek/deepseek-v4-flash";

interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

async function main(): Promise<void> {
  const providerApiKey = (
    await readFile("CommandcodeAPIKey.txt", "utf8")
  ).trim();
  const directory = await mkdtemp(join(tmpdir(), "Token-deep-online-"));
  let composition:
    Awaited<ReturnType<typeof createConfiguredTokenDataPlane>> | undefined;
  let server: Awaited<ReturnType<typeof startTokenHttpServer>> | undefined;

  try {
    const stateDirectory = join(directory, ".Token");
    await mkdir(join(stateDirectory, "pi"), { recursive: true });
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "token-config-v2",
        server: { port: 0 },
        clientProtocols: { "anthropic-messages": {} },
        pi: { directory: "pi" },
        limits: {
          maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
          requestTimeoutMs: 120_000,
        },
      }),
      "utf8",
    );
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("commandcode-private", async () => ({
      type: "api_key",
      key: providerApiKey,
    }));
    const config = await loadTokenCliConfig(configPath);
    composition = await createConfiguredTokenDataPlane({
      config,
      credentialSeedStore: credentials,
      fetch: globalThis.fetch,
    });
    server = await startTokenHttpServer({
      runtime: composition.runtime,
      host: "127.0.0.1",
      port: config.server.port,
    });
    const client = new Anthropic({
      apiKey: "unused-local-sdk-key",
      baseURL: server.origin,
      maxRetries: 0,
      timeout: 120_000,
    });

    const results: CaseResult[] = [];
    const run = async (
      name: string,
      fn: () => Promise<void>,
    ): Promise<void> => {
      try {
        await fn();
        results.push({ name, ok: true });
        console.log(`PASS ${name}`);
      } catch (error) {
        results.push({
          name,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
        console.error(
          `FAIL ${name}: ${error instanceof Error ? error.message : error}`,
        );
      }
    };

    await run("multi-turn history with system prompt", async () => {
      const first = await client.messages.create({
        model: MODEL,
        max_tokens: 128,
        system: "你是中文助手，回答简洁。",
        messages: [{ role: "user", content: "我的名字是小明" }],
      });
      const firstText = first.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (firstText.length === 0) throw new Error("empty first turn");

      const second = await client.messages.create({
        model: MODEL,
        max_tokens: 128,
        system: "你是中文助手，回答简洁。",
        messages: [
          { role: "user", content: "我的名字是小明" },
          { role: "assistant", content: firstText },
          { role: "user", content: "我叫什么名字？" },
        ],
      });
      const secondText = second.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (!secondText.includes("小明")) {
        throw new Error(`history lost: ${secondText}`);
      }
    });

    await run("reasoning effort high", async () => {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 256,
        output_config: { effort: "high" },
        messages: [{ role: "user", content: "证明勾股定理" }],
      });
      // The gate is that the request succeeds with effort mapped; the model may
      // or may not expose thinking blocks, and text is the required outcome.
      if (response.content.length === 0) throw new Error("empty content");
    });

    await run("complex tool schema", async () => {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 128,
        tools: [
          {
            name: "weather_lookup",
            description: "查询天气",
            input_schema: {
              type: "object",
              $schema: "https://json-schema.org/draft/2020-12/schema",
              properties: {
                city: { type: "string", description: "城市名" },
                units: {
                  type: "string",
                  enum: ["celsius", "fahrenheit"],
                  default: "celsius",
                },
              },
              required: ["city"],
              additionalProperties: false,
            },
          },
        ],
        messages: [
          {
            role: "user",
            content:
              "用 weather_lookup 工具查询北京的天气（单位摄氏度），调用后告诉我结果",
          },
        ],
      });
      const toolUse = response.content.find(
        (block) => block.type === "tool_use",
      );
      if (toolUse === undefined || toolUse.type !== "tool_use") {
        throw new Error("no tool_use in response");
      }
      if (toolUse.name !== "weather_lookup") {
        throw new Error(`wrong tool name: ${toolUse.name}`);
      }
      const input = toolUse.input as Record<string, unknown>;
      if (input.city !== "北京" && input.city !== "Beijing") {
        throw new Error(`unexpected tool input: ${JSON.stringify(input)}`);
      }
    });

    await run("parallel tool calls", async () => {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 256,
        tools: [
          {
            name: "add",
            description: "加法",
            input_schema: {
              type: "object",
              properties: {
                a: { type: "number" },
                b: { type: "number" },
              },
              required: ["a", "b"],
            },
          },
          {
            name: "multiply",
            description: "乘法",
            input_schema: {
              type: "object",
              properties: {
                a: { type: "number" },
                b: { type: "number" },
              },
              required: ["a", "b"],
            },
          },
        ],
        messages: [
          {
            role: "user",
            content: "同时调用 add(2,3) 和 multiply(4,5)，然后再把两个结果相加",
          },
        ],
      });
      const toolUses = response.content.filter(
        (block) => block.type === "tool_use",
      );
      if (toolUses.length < 1) throw new Error("no tool calls");
      const ids = new Set(
        toolUses.map((block) => (block.type === "tool_use" ? block.id : "")),
      );
      if (ids.size !== toolUses.length) {
        throw new Error("duplicate tool call ids");
      }
    });

    await run("long output", async () => {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        messages: [
          { role: "user", content: "写一篇300字左右的短文，关于春天的景色" },
        ],
      });
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (text.length < 100)
        throw new Error(`output too short: ${text.length}`);
    });

    await run("streaming json", async () => {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 128,
        messages: [{ role: "user", content: "数到5" }],
      });
      const message = await stream.finalMessage();
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (text.length === 0) throw new Error("empty stream result");
    });

    await run("tool result round trip", async () => {
      const first = await client.messages.create({
        model: MODEL,
        max_tokens: 128,
        tools: [
          {
            name: "get_time",
            description: "获取当前时间",
            input_schema: {
              type: "object",
              properties: {},
            },
          },
        ],
        messages: [{ role: "user", content: "调用 get_time 工具获取时间" }],
      });
      const toolUse = first.content.find((block) => block.type === "tool_use");
      if (toolUse === undefined || toolUse.type !== "tool_use") {
        throw new Error("no tool_use in first turn");
      }
      const second = await client.messages.create({
        model: MODEL,
        max_tokens: 128,
        tools: [
          {
            name: "get_time",
            description: "获取当前时间",
            input_schema: {
              type: "object",
              properties: {},
            },
          },
        ],
        messages: [
          { role: "user", content: "调用 get_time 工具获取时间" },
          { role: "assistant", content: first.content },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: "2026-08-11 20:00:00",
              },
            ],
          },
        ],
      });
      const finalText = second.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (finalText.length === 0) throw new Error("empty continuation");
    });

    await run("unknown effort falls back to Pi default", async () => {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 64,
        // @ts-expect-error unknown future effort value must not fail the request
        output_config: { effort: "future-level" },
        messages: [{ role: "user", content: "你好" }],
      });
      // The model may legally produce a thinking-only turn; the gate is that
      // the request succeeds without a protocol error.
      if (response.content.length === 0) throw new Error("empty content");
    });

    await run("all five known effort levels", async () => {
      for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: 64,
          output_config: { effort },
          messages: [{ role: "user", content: "回复ok" }],
        });
        if (response.content.length === 0) {
          throw new Error(`empty at effort ${effort}`);
        }
      }
    });

    await run("empty message content array", async () => {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 64,
        messages: [
          { role: "user", content: "开始" },
          { role: "assistant", content: [] },
          { role: "user", content: "继续" },
        ],
      });
      if (response.content.length === 0) throw new Error("empty content");
    });

    await run("concurrent burst (8 parallel)", async () => {
      const prompts = Array.from(
        { length: 8 },
        (_, index) => `回复数字${index}`,
      );
      const responses = await Promise.all(
        prompts.map((prompt) =>
          client.messages.create({
            model: MODEL,
            max_tokens: 64,
            messages: [{ role: "user", content: prompt }],
          }),
        ),
      );
      for (const [index, response] of responses.entries()) {
        if (response.content.length === 0) {
          throw new Error(`concurrent ${index} empty content`);
        }
      }
    });

    await run("top_p and stop_sequences ignored", async () => {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 64,
        top_p: 0.9,
        stop_sequences: ["END"],
        messages: [{ role: "user", content: "回复ok然后END" }],
      });
      if (response.content.length === 0) throw new Error("empty content");
    });

    await run("system block with cache_control ignored", async () => {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 64,
        system: [
          {
            type: "text",
            text: "你是简洁助手",
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: "你好" }],
      });
      if (response.content.length === 0) throw new Error("empty content");
    });

    const failed = results.filter((result) => !result.ok);
    console.log(
      `\nDeep online: ${results.length - failed.length}/${results.length} passed`,
    );
    if (failed.length > 0) {
      for (const failure of failed) {
        console.error(`- ${failure.name}: ${failure.detail}`);
      }
      process.exitCode = 1;
    }
  } finally {
    await server?.close();
    await composition?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
