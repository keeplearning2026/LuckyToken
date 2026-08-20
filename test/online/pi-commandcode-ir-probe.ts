#!/usr/bin/env node

import {
  createModels,
  InMemoryCredentialStore,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type FetchFunction,
  type ModelsSimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  createCommandCodePrivateProvider,
  providerPackage,
} from "@luckytoken/provider-commandcode-private";
import { findUpstreamFailureFact } from "@luckytoken/provider-contract/diagnostics";
import { COMMANDCODE_MODELS } from "../../packages/provider-commandcode-private/src/models.js";

/**
 * Direct Pi AI IR <-> CommandCode private provider online probe.
 *
 * Bypasses every Client Protocol adapter: Pi Context / SimpleStreamOptions
 * are fed straight into the registered CommandCode provider through the Pi
 * `Models.streamSimple` public contract, and the returned Pi stream/message
 * is validated for IR-level semantics.
 *
 * Coverage dimensions:
 *  - request controls (system, metadata, sampling, reasoning, budgets, cache)
 *  - message/content conversion (history, thinking replay, tools, results)
 *  - stream event lifecycle (start/text/thinking/toolcall/done)
 *  - errors (orphan/duplicate results, images, malformed arguments)
 *  - retries, cancellation, payload callbacks
 *  - usage and terminal consistency
 */

const MODEL_ID = "deepseek/deepseek-v4-flash";
const REQUEST_TIMEOUT_MS = 180_000;
const SUITE_TIMEOUT_MS = 30 * 60_000;

interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

const results: CaseResult[] = [];
const requestedCases = new Set(
  process.argv.slice(2).map((value) => value.trim()).filter((value) => value.length > 0),
);
const caseFilterActive = requestedCases.size > 0;
let activeCaseSignal: AbortSignal | undefined;
let suiteStartedAt = 0;

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  if (caseFilterActive && !requestedCases.has(name)) return;
  requestedCases.delete(name);
  if (suiteStartedAt === 0) suiteStartedAt = Date.now();
  if (Date.now() - suiteStartedAt > SUITE_TIMEOUT_MS) {
    results.push({ name, ok: false, detail: "suite wall-clock timeout" });
    console.error(`FAIL ${name}: suite wall-clock timeout`);
    return;
  }
  activeCaseSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    console.error(`FAIL ${name}: ${detail}`);
  } finally {
    activeCaseSignal = undefined;
  }
}

function fail(message: string): never {
  throw new Error(message);
}

async function collect(
  stream: AssistantMessageEventStream,
): Promise<AssistantMessage> {
  let terminal: AssistantMessage | undefined;
  for await (const event of stream) {
    if (event.type === "done") terminal = event.message;
    if (event.type === "error") {
      throw new Error(
        `Pi error terminal: ${event.error.errorMessage ?? "unknown"} (reason=${event.reason})`,
      );
    }
  }
  if (terminal === undefined) {
    fail("stream ended without a semantic terminal");
  }
  return terminal;
}

interface CollectedEvents {
  readonly types: readonly string[];
  readonly textDeltas: readonly string[];
  readonly thinkingDeltas: readonly string[];
  readonly toolCalls: readonly ToolCall[];
}

async function collectEvents(
  stream: AssistantMessageEventStream,
): Promise<{ message: AssistantMessage; events: CollectedEvents }> {
  const types: string[] = [];
  const textDeltas: string[] = [];
  const thinkingDeltas: string[] = [];
  const toolCalls: ToolCall[] = [];
  let terminal: AssistantMessage | undefined;
  for await (const event of stream) {
    types.push(event.type);
    if (event.type === "text_delta") textDeltas.push(event.delta);
    if (event.type === "thinking_delta") thinkingDeltas.push(event.delta);
    if (event.type === "toolcall_end") toolCalls.push(event.toolCall);
    if (event.type === "done") terminal = event.message;
    if (event.type === "error") {
      throw new Error(
        `Pi error terminal: ${event.error.errorMessage ?? "unknown"} (reason=${event.reason})`,
      );
    }
  }
  if (terminal === undefined) fail("stream ended without a semantic terminal");
  return {
    message: terminal,
    events: Object.freeze({
      types: Object.freeze(types),
      textDeltas: Object.freeze(textDeltas),
      thinkingDeltas: Object.freeze(thinkingDeltas),
      toolCalls: Object.freeze(toolCalls),
    }),
  };
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function usageValid(usage: AssistantMessage["usage"]): void {
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (!Number.isSafeInteger(usage[field]) || usage[field] < 0) {
      fail(`usage.${field} invalid: ${JSON.stringify(usage)}`);
    }
  }
  if (
    !Number.isSafeInteger(usage.totalTokens) ||
    usage.totalTokens < usage.input + usage.output
  ) {
    fail(`usage.totalTokens inconsistent: ${JSON.stringify(usage)}`);
  }
  if (
    usage.reasoning !== undefined &&
    (usage.reasoning < 0 || usage.reasoning > usage.output)
  ) {
    fail(`usage.reasoning out of range: ${JSON.stringify(usage)}`);
  }
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    if (!Number.isFinite(usage.cost[field]) || usage.cost[field] < 0) {
      fail(`usage.cost.${field} invalid: ${JSON.stringify(usage.cost)}`);
    }
  }
}

function terminalConsistent(message: AssistantMessage): void {
  const hasToolCall = message.content.some((block) => block.type === "toolCall");
  if (message.stopReason === "toolUse" && !hasToolCall) {
    fail("stopReason=toolUse without toolCall content");
  }
  if (message.stopReason === "stop" && hasToolCall) {
    fail("stopReason=stop with toolCall content");
  }
}

interface ProbeRuntime {
  models: ReturnType<typeof createModels>;
  model: ModelLike;
  options(
    overrides?: Partial<ModelsSimpleStreamOptions>,
  ): ModelsSimpleStreamOptions;
}

type ModelLike = ReturnType<
  ReturnType<typeof createModels>["getModels"]
>[number];

async function main(): Promise<void> {
  const apiKey = (await readFile("CommandcodeAPIKey.txt", "utf8")).trim();
  if (apiKey.length === 0) fail("CommandCode API key file is empty");

  const credentials = new InMemoryCredentialStore();
  await credentials.modify(
    "commandcode-private",
    async () => ({ type: "api_key", key: apiKey }),
  );
  const models = createModels({ credentials });
  models.setProvider(
    providerPackage.createProvider({
      configuration: {},
      configurationPath:
        'providerPackages["@luckytoken/provider-commandcode-private"]',
      host: {
        fetch: globalThis.fetch,
        now: Date.now,
        createUuid: randomUUID,
      },
    }),
  );
  const model = models
    .getModels()
    .find(
      (entry) =>
        entry.provider === "commandcode-private" && entry.id === MODEL_ID,
    );
  if (model === undefined) fail(`CommandCode model not registered: ${MODEL_ID}`);
  const runtime: ProbeRuntime = {
    models,
    model,
    options: (overrides = {}) => ({
      sessionId: `ir-probe-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      signal:
        overrides.signal ??
        activeCaseSignal ??
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...overrides,
    }),
  };

  // ---------- A. request controls ----------

  await run("basic text with marker", async () => {
    const marker = "LT_IR_BASIC_01";
    const message = await collect(
      runtime.models.streamSimple(
        runtime.model,
        {
          messages: [
            {
              role: "user",
              content: `Reply with the exact token ${marker} and no other text.`,
              timestamp: 1,
            },
          ],
        },
        runtime.options({ maxTokens: 256 }),
      ),
    );
    if (message.stopReason !== "stop" && message.stopReason !== "length") {
      fail(`unexpected stop reason: ${message.stopReason}`);
    }
    if (!textOf(message).includes(marker)) {
      fail(`marker missing: ${textOf(message)}`);
    }
    usageValid(message.usage);
    terminalConsistent(message);
  });

  await run("system prompt and metadata with upstream capture", async () => {
    const marker = "LT_IR_SYSTEM_01";
    const captured = captureFetch();
    const models2 = createModels({ credentials });
    models2.setProvider(
      createCommandCodePrivateProvider({
        models: COMMANDCODE_MODELS,
        fetch: captured.fetch,
        now: Date.now,
      }),
    );
    const model2 = models2
      .getModels()
      .find(
        (entry) =>
          entry.provider === "commandcode-private" && entry.id === MODEL_ID,
      );
    if (model2 === undefined) fail("model2 not registered");
    const message = await collect(
      models2.streamSimple(
        model2,
        {
          systemPrompt: "Always answer with the exact requested token.",
          messages: [
            {
              role: "user",
              content: `Reply with exactly ${marker}.`,
              timestamp: 1,
            },
          ],
        },
        {
          sessionId: "00000000-0000-4000-8000-000000000001",
          signal: activeCaseSignal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          maxTokens: 256,
          metadata: { user_id: "ir-probe-user" },
          samplingParams: { top_p: 0.9 },
          temperature: 0.5,
          cacheRetention: "short",
        },
      ),
    );
    if (!textOf(message).includes(marker)) fail(`marker missing`);
    const body = captured.bodies[0];
    if (body === undefined) fail("no upstream request captured");
    const params = body.params as Record<string, unknown>;
    if (params.system !== "Always answer with the exact requested token.") {
      fail(`system not forwarded: ${JSON.stringify(params.system)}`);
    }
    if (params.max_tokens !== 256) {
      fail(`max_tokens not forwarded: ${JSON.stringify(params.max_tokens)}`);
    }
    if (params.temperature !== 0.5) {
      fail(`temperature not forwarded: ${JSON.stringify(params.temperature)}`);
    }
    if (JSON.stringify(body).includes("ir-probe-user")) {
      fail(`metadata.user_id leaked into upstream wire`);
    }
  });

  await run("reasoning efforts clamp to model capability", async () => {
    const marker = "LT_IR_REASON_01";
    const captured = captureFetch();
    const models2 = createModels({ credentials });
    models2.setProvider(
      createCommandCodePrivateProvider({
        models: COMMANDCODE_MODELS,
        fetch: captured.fetch,
        now: Date.now,
      }),
    );
    const model2 = models2
      .getModels()
      .find(
        (entry) =>
          entry.provider === "commandcode-private" && entry.id === MODEL_ID,
      );
    if (model2 === undefined) fail("model2 not registered");
    const message = await collect(
      models2.streamSimple(
        model2,
        {
          messages: [
            {
              role: "user",
              content: `Reason briefly, then reply with exactly ${marker}.`,
              timestamp: 1,
            },
          ],
        },
        runtime.options({
          maxTokens: 512,
          reasoning: "high",
          thinkingBudgets: { high: 4096 },
        }),
      ),
    );
    const params = captured.bodies[0]?.params as Record<string, unknown> | undefined;
    if (params?.reasoning_effort !== "high") {
      fail(`reasoning_effort not forwarded: ${JSON.stringify(params?.reasoning_effort)}`);
    }
    if (!textOf(message).includes(marker)) fail(`marker missing`);
    usageValid(message.usage);
    if (message.usage.reasoning !== undefined && message.usage.reasoning > message.usage.output) {
      fail("reasoning > output");
    }
  });

  // ---------- B. messages/content semantics ----------

  await run("multi-turn history preserved", async () => {
    const marker = "LT_IR_HISTORY_01";
    const message = await collect(
      runtime.models.streamSimple(
        runtime.model,
        {
          messages: [
            { role: "user", content: "First turn.", timestamp: 1 },
            {
              role: "assistant",
              api: "pi",
              provider: "pi",
              model: MODEL_ID,
              content: [{ type: "text", text: "Prior assistant text." }],
              usage: zeroUsage(),
              stopReason: "stop",
              timestamp: 2,
            },
            {
              role: "user",
              content: `Reply with exactly ${marker}.`,
              timestamp: 3,
            },
          ],
        },
        runtime.options({ maxTokens: 256 }),
      ),
    );
    if (!textOf(message).includes(marker)) fail(`marker missing`);
  });

  await run("historical thinking without signature replays as reasoning", async () => {
    const marker = "LT_IR_THINK_REPLAY_01";
    const captured = captureFetch();
    const models2 = createModels({ credentials });
    models2.setProvider(
      createCommandCodePrivateProvider({
        models: COMMANDCODE_MODELS,
        fetch: captured.fetch,
        now: Date.now,
      }),
    );
    const model2 = models2
      .getModels()
      .find(
        (entry) =>
          entry.provider === "commandcode-private" && entry.id === MODEL_ID,
      );
    if (model2 === undefined) fail("model2 not registered");
    const message = await collect(
      models2.streamSimple(
        model2,
        {
          messages: [
            { role: "user", content: "Think.", timestamp: 1 },
            {
              role: "assistant",
              api: "pi",
              provider: "pi",
              model: MODEL_ID,
              content: [
                { type: "thinking", thinking: "historical reasoning" },
                { type: "text", text: "historical answer" },
              ],
              usage: zeroUsage(),
              stopReason: "stop",
              timestamp: 2,
            },
            {
              role: "user",
              content: `Reply with exactly ${marker}.`,
              timestamp: 3,
            },
          ],
        },
        runtime.options({ maxTokens: 256 }),
      ),
    );
    const wire = JSON.stringify(captured.bodies[0]);
    if (!wire.includes('"type":"reasoning"')) {
      fail("historical thinking did not convert to reasoning");
    }
    if (!textOf(message).includes(marker)) fail(`marker missing`);
  });

  await run("historical same-target thinking signature is dropped", async () => {
    const captured = captureFetch();
    const models2 = createModels({ credentials });
    models2.setProvider(
      createCommandCodePrivateProvider({
        models: COMMANDCODE_MODELS,
        fetch: captured.fetch,
        now: Date.now,
      }),
    );
    const model2 = models2
      .getModels()
      .find(
        (entry) =>
          entry.provider === "commandcode-private" && entry.id === MODEL_ID,
      );
    if (model2 === undefined) fail("model2 not registered");
    await collect(
      models2.streamSimple(
        model2,
        {
          messages: [
            { role: "user", content: "Think.", timestamp: 1 },
            {
              role: "assistant",
              api: model2.api,
              provider: model2.provider,
              model: model2.id,
              content: [
                {
                  type: "thinking",
                  thinking: "reasoning",
                  thinkingSignature: "opaque-signature",
                },
              ],
              usage: zeroUsage(),
              stopReason: "stop",
              timestamp: 2,
            },
            { role: "user", content: "Continue.", timestamp: 3 },
          ],
        },
        runtime.options({ maxTokens: 64 }),
      ),
    );
    const wire = JSON.stringify(captured.bodies[0]);
    if (!wire.includes('"type":"reasoning"')) {
      fail("same-target reasoning content was dropped");
    }
    if (wire.includes("opaque-signature")) {
      fail("same-target signature leaked into CommandCode wire");
    }
  });

  await run("tool call and result round trip", async () => {
    const context: Context = {
      tools: [
        {
          name: "ir_lookup",
          description: "Return the exact value given in the input.",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ],
      messages: [
        {
          role: "user",
          content:
            "Call ir_lookup exactly once with value LT_IR_TOOL_01. Do not answer in text.",
          timestamp: 1,
        },
      ],
    };
    const first = await collect(
      runtime.models.streamSimple(model, context, runtime.options({ maxTokens: 512 })),
    );
    const toolCall = first.content.find(
      (block): block is ToolCall => block.type === "toolCall",
    );
    if (toolCall === undefined) fail(`no toolCall; text=${textOf(first)}`);
    if (toolCall.name !== "ir_lookup" || toolCall.id.length === 0) {
      fail(`tool identity lost: ${JSON.stringify(toolCall)}`);
    }
    if (first.stopReason !== "toolUse") fail(`expected toolUse stop`);

    const second = await collect(
      runtime.models.streamSimple(
        model,
        {
          ...context,
          messages: [
            ...context.messages,
            {
              role: "assistant",
              api: "pi",
              provider: "pi",
              model: MODEL_ID,
              content: first.content,
              usage: first.usage,
              stopReason: first.stopReason,
              timestamp: 2,
            },
            {
              role: "toolResult",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              content: [{ type: "text", text: "tool returned LT_IR_TOOL_RESULT_01" }],
              isError: false,
              timestamp: 3,
            },
            {
              role: "user",
              content: "Report the tool result text exactly.",
              timestamp: 4,
            },
          ],
        },
        runtime.options({ maxTokens: 256 }),
      ),
    );
    if (!textOf(second).includes("LT_IR_TOOL_RESULT_01")) {
      fail(`tool result lost: ${textOf(second)}`);
    }
  });

  await run("parallel tool calls preserve identity", async () => {
    const context: Context = {
      tools: [
        {
          name: "ir_add",
          description: "Add two numbers.",
          parameters: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
        },
        {
          name: "ir_mul",
          description: "Multiply two numbers.",
          parameters: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
        },
      ],
      messages: [
        {
          role: "user",
          content: "Call ir_add(2,3) and ir_mul(4,5) in parallel.",
          timestamp: 1,
        },
      ],
    };
    const first = await collect(
      runtime.models.streamSimple(model, context, runtime.options({ maxTokens: 512 })),
    );
    const calls = first.content.filter(
      (block): block is ToolCall => block.type === "toolCall",
    );
    if (calls.length < 1) fail(`no parallel tool calls; stop=${first.stopReason}`);
    const ids = new Set(calls.map((call) => call.id));
    if (ids.size !== calls.length) fail("duplicate tool call ids");
  });

  await run("tool result isError maps and empty content keeps pairing", async () => {
    const captured = captureFetch();
    const models2 = createModels({ credentials });
    models2.setProvider(
      createCommandCodePrivateProvider({
        models: COMMANDCODE_MODELS,
        fetch: captured.fetch,
        now: Date.now,
      }),
    );
    const model2 = models2
      .getModels()
      .find(
        (entry) =>
          entry.provider === "commandcode-private" && entry.id === MODEL_ID,
      );
    if (model2 === undefined) fail("model2 not registered");
    const seededContext: Context = {
      tools: [
        {
          name: "ir_seeded",
          description: "Seeded tool.",
          parameters: { type: "object", properties: {} },
        },
      ],
      messages: [
        { role: "user", content: "Use the seeded result.", timestamp: 1 },
        {
          role: "assistant",
          api: "pi",
          provider: "pi",
          model: MODEL_ID,
          content: [
            {
              type: "toolCall",
              id: "seed_1",
              name: "ir_seeded",
              arguments: {},
            },
          ],
          usage: zeroUsage(),
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "seed_1",
          toolName: "ir_seeded",
          content: [],
          isError: true,
          timestamp: 3,
        },
        { role: "user", content: "Continue.", timestamp: 4 },
      ],
    };
    await collect(
      models2.streamSimple(model2, seededContext, runtime.options({ maxTokens: 64 })),
    );
    const wire = JSON.stringify(captured.bodies[0]);
    if (!wire.includes('"type":"error-text"')) {
      fail("isError=true did not map to error-text");
    }
    if (!wire.includes("seed_1")) fail("toolCallId pairing lost");
  });

  await run("missing tool result repaired by provider", async () => {
    const captured = captureFetch();
    const models2 = createModels({ credentials });
    models2.setProvider(
      createCommandCodePrivateProvider({
        models: COMMANDCODE_MODELS,
        fetch: captured.fetch,
        now: Date.now,
      }),
    );
    const model2 = models2
      .getModels()
      .find(
        (entry) =>
          entry.provider === "commandcode-private" && entry.id === MODEL_ID,
      );
    if (model2 === undefined) fail("model2 not registered");
    const missingContext: Context = {
      messages: [
        { role: "user", content: "Call a tool.", timestamp: 1 },
        {
          role: "assistant",
          api: "pi",
          provider: "pi",
          model: MODEL_ID,
          content: [
            { type: "toolCall", id: "missing_1", name: "ir_seeded", arguments: {} },
          ],
          usage: zeroUsage(),
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "user", content: "Next.", timestamp: 3 },
      ],
    };
    await collect(
      models2.streamSimple(model2, missingContext, runtime.options({ maxTokens: 64 })),
    );
    const wire = JSON.stringify(captured.bodies[0]);
    if (!wire.includes("No result")) {
      fail("missing result was not repaired with synthetic text");
    }
  });

  await run("orphan tool result rejected", async () => {
    await expectPiConversionFailure(
      runtime.models.streamSimple(
        runtime.model,
        {
          messages: [
            {
              role: "toolResult",
              toolCallId: "ghost",
              toolName: "nope",
              content: [],
              isError: false,
              timestamp: 1,
            },
          ],
        },
        runtime.options({ maxTokens: 64 }),
      ),
    );
  });

  await run("tool result image content is filtered", async () => {
    const captured = captureFetch();
    const models2 = createModels({ credentials });
    models2.setProvider(
      createCommandCodePrivateProvider({
        models: COMMANDCODE_MODELS,
        fetch: captured.fetch,
        now: Date.now,
      }),
    );
    const model2 = models2
      .getModels()
      .find(
        (entry) =>
          entry.provider === "commandcode-private" && entry.id === MODEL_ID,
      );
    if (model2 === undefined) fail("model2 not registered");
    await collect(
      models2.streamSimple(
        model2,
        {
          messages: [
            { role: "user", content: "Use tool.", timestamp: 1 },
            {
              role: "assistant",
              api: "pi",
              provider: "pi",
              model: MODEL_ID,
              content: [
                { type: "toolCall", id: "img_1", name: "ir_seeded", arguments: {} },
              ],
              usage: zeroUsage(),
              stopReason: "toolUse",
              timestamp: 2,
            },
            {
              role: "toolResult",
              toolCallId: "img_1",
              toolName: "ir_seeded",
              content: [
                { type: "image", mimeType: "image/png", data: "AA==" },
              ],
              isError: false,
              timestamp: 3,
            },
          ],
        },
        runtime.options({ maxTokens: 64 }),
      ),
    );
    const wire = JSON.stringify(captured.bodies[0]);
    if (!wire.includes('"toolCallId":"img_1"')) {
      fail("image-only ToolResult correlation was lost");
    }
    if (!wire.includes('"value":""') || wire.includes('"type":"image"')) {
      fail("image-only ToolResult did not degrade to empty text");
    }
  });

  await run("malformed toolCall arguments rejected", async () => {
    await expectPiConversionFailure(
      runtime.models.streamSimple(
        runtime.model,
        {
          messages: [
            { role: "user", content: "Use tool.", timestamp: 1 },
            {
              role: "assistant",
              api: "pi",
              provider: "pi",
              model: MODEL_ID,
              content: [
                {
                  type: "toolCall",
                  id: "bad_1",
                  name: "ir_seeded",
                  arguments: "not-an-object" as unknown as Record<string, unknown>,
                },
              ],
              usage: zeroUsage(),
              stopReason: "toolUse",
              timestamp: 2,
            },
            { role: "user", content: "Next.", timestamp: 3 },
          ],
        },
        runtime.options({ maxTokens: 64 }),
      ),
    );
  });

  // ---------- C. stream lifecycle ----------

  await run("stream event lifecycle matches final message", async () => {
    const marker = "LT_IR_STREAM_01";
    const { events } = await collectEvents(
      runtime.models.streamSimple(
        runtime.model,
        {
          messages: [
            {
              role: "user",
              content: `Reply with exactly ${marker}.`,
              timestamp: 1,
            },
          ],
        },
        runtime.options({ maxTokens: 256 }),
      ),
    );
    const types = events.types;
    if (types[0] !== "start") fail(`stream must start with start: ${types[0]}`);
    if (types.at(-1) !== "done") fail(`stream must end with done: ${types.at(-1)}`);
    const textStart = types.indexOf("text_start");
    if (textStart >= 0) {
      if (!types.slice(textStart).includes("text_end")) {
        fail("text_start without text_end");
      }
      const joined = events.textDeltas.join("");
      if (!joined.includes(marker)) fail(`text deltas missing marker: ${joined}`);
    }
    const thinkingStart = types.indexOf("thinking_start");
    if (thinkingStart >= 0) {
      if (!types.slice(thinkingStart).includes("thinking_end")) {
        fail("thinking_start without thinking_end");
      }
      const thinking = events.thinkingDeltas.join("");
      if (thinking.length === 0) fail("empty thinking deltas");
    }
    if (textStart < 0 && thinkingStart < 0) {
      fail("no content lifecycle observed");
    }
  });

  await run("toolcall stream lifecycle matches final message", async () => {
    const context: Context = {
      tools: [
        {
          name: "ir_stream_tool",
          description: "Streaming tool.",
          parameters: {
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
      ],
      messages: [
        {
          role: "user",
          content: "Call ir_stream_tool with q=stream-test.",
          timestamp: 1,
        },
      ],
    };
    const { message, events } = await collectEvents(
      runtime.models.streamSimple(model, context, runtime.options({ maxTokens: 512 })),
    );
    const types = events.types;
    const toolStart = types.indexOf("toolcall_start");
    if (toolStart < 0) {
      fail(`no toolcall_start; stop=${message.stopReason} text=${textOf(message)}`);
    }
    if (!types.slice(toolStart).includes("toolcall_end")) {
      fail("toolcall_start without toolcall_end");
    }
    const finalCalls = message.content.filter(
      (block): block is ToolCall => block.type === "toolCall",
    );
    const eventCalls = events.toolCalls;
    if (eventCalls.length !== finalCalls.length) {
      fail("toolcall_end count differs from final content");
    }
  });

  // ---------- D. errors / retries / cancellation ----------

  await run("max_tokens=1 produces length terminal", async () => {
    const message = await collect(
      runtime.models.streamSimple(
        runtime.model,
        {
          messages: [
            {
              role: "user",
              content:
                "Write a very long detailed multi-paragraph essay about protocol conversion.",
              timestamp: 1,
            },
          ],
        },
        runtime.options({ maxTokens: 1 }),
      ),
    );
    if (message.stopReason !== "length") {
      fail(`expected length stop, got ${message.stopReason}`);
    }
  });

  await run("empty messages rejected", async () => {
    await expectPiError(
      runtime.models.streamSimple(
        runtime.model,
        { messages: [] },
        runtime.options({ maxTokens: 64 }),
      ),
      /message|empty|user/u,
    );
  });

  await run("retry after 429 succeeds", async () => {
    let attempts = 0;
    const fetchImpl: FetchFunction = async (input, init) => {
      attempts += 1;
      const request = new Request(input, init);
      if (attempts === 1) {
        return new Response("retry", {
          status: 429,
          headers: { "retry-after-ms": "10" },
        });
      }
      const bodyText = await request.text();
      return upstreamJsonl(bodyText);
    };
    const models2 = createModels({ credentials });
    models2.setProvider(
      createCommandCodePrivateProvider({
        models: COMMANDCODE_MODELS,
        fetch: fetchImpl,
        now: Date.now,
      }),
    );
    const model2 = models2
      .getModels()
      .find(
        (entry) =>
          entry.provider === "commandcode-private" && entry.id === MODEL_ID,
      );
    if (model2 === undefined) fail("model2 not registered");
    const message = await collect(
      models2.streamSimple(
        model2,
        {
          messages: [
            { role: "user", content: "Reply with OK.", timestamp: 1 },
          ],
        },
        runtime.options({ maxTokens: 64, maxRetries: 1, maxRetryDelayMs: 100 }),
      ),
    );
    if (attempts !== 2) fail(`expected 2 attempts, got ${attempts}`);
    if (!textOf(message).includes("OK")) fail(`retry response lost`);
  });

  await run("onPayload replacement reaches upstream", async () => {
    const captured = captureFetch();
    const models2 = createModels({ credentials });
    models2.setProvider(
      createCommandCodePrivateProvider({
        models: COMMANDCODE_MODELS,
        fetch: captured.fetch,
        now: Date.now,
      }),
    );
    const model2 = models2
      .getModels()
      .find(
        (entry) =>
          entry.provider === "commandcode-private" && entry.id === MODEL_ID,
      );
    if (model2 === undefined) fail("model2 not registered");
    const message = await collect(
      models2.streamSimple(
        model2,
        {
          messages: [
            { role: "user", content: "Reply with LT_IR_PAYLOAD.", timestamp: 1 },
          ],
        },
        runtime.options({
          maxTokens: 128,
          onPayload: (payload: unknown) => {
            const record = payload as Record<string, unknown>;
            const params = record.params as Record<string, unknown>;
            const messages = params.messages as Array<Record<string, unknown>>;
            const lastUser = [...messages]
              .reverse()
              .find((entry) => entry.role === "user");
            if (lastUser !== undefined) {
              const lastText =
                typeof lastUser.content === "string"
                  ? lastUser.content
                  : (Array.isArray(lastUser.content)
                      ? lastUser.content
                          .map((block) =>
                            typeof block === "object" &&
                            block !== null &&
                            "text" in block &&
                            typeof block.text === "string"
                              ? block.text
                              : "",
                          )
                          .join("")
                      : "");
              return {
                ...record,
                params: {
                  ...params,
                  messages: [
                    ...messages,
                    {
                      role: "user",
                      content: [
                        {
                          type: "text",
                          text: `${lastText} LT_IR_PAYLOAD_REPLACED`,
                        },
                      ],
                    },
                  ],
                },
              };
            }
            return record;
          },
        }),
      ),
    );
    const body = captured.bodies[0];
    const bodyText = JSON.stringify(body);
    if (!bodyText.includes("LT_IR_PAYLOAD_REPLACED")) {
      fail("onPayload replacement did not reach upstream");
    }
    if (!textOf(message).includes("LT_IR_PAYLOAD_REPLACED")) {
      fail("replacement marker missing from response");
    }
  });

  await run("onResponse callback observes status", async () => {
    const statuses: number[] = [];
    const message = await collect(
      runtime.models.streamSimple(
        runtime.model,
        {
          messages: [
            { role: "user", content: "Reply with OK.", timestamp: 1 },
          ],
        },
        runtime.options({
          maxTokens: 64,
          onResponse: (response) => {
            statuses.push(response.status);
          },
        }),
      ),
    );
    if (statuses.length !== 1 || statuses[0] !== 200) {
      fail(`onResponse statuses: ${JSON.stringify(statuses)}`);
    }
    if (!textOf(message).includes("OK")) fail("marker missing");
  });

  await run("caller cancellation aborts cleanly", async () => {
    const controller = new AbortController();
    let markDispatched: (() => void) | undefined;
    const dispatched = new Promise<void>((resolvePromise) => {
      markDispatched = resolvePromise;
    });
    const observedFetch: FetchFunction = async (input, init) => {
      markDispatched?.();
      return globalThis.fetch(input, init);
    };
    const stream = runtime.models.streamSimple(
      runtime.model,
      {
        messages: [
          {
            role: "user",
            content: "Write a very long detailed essay about protocol conversion.",
            timestamp: 1,
          },
        ],
      },
      {
        sessionId: `ir-probe-cancel-${Date.now()}`,
        signal: controller.signal,
        maxTokens: 4096,
        fetch: observedFetch,
      },
    );
    const outcomePromise = (async () => {
      for await (const event of stream) {
        if (event.type === "done") {
          return { status: "done" as const };
        }
        if (event.type === "error") {
          return { status: "error" as const, reason: event.reason };
        }
      }
      return { status: "eof" as const };
    })();
    let dispatchTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        dispatched,
        new Promise<never>((_resolve, reject) => {
          dispatchTimer = setTimeout(
            () => reject(new Error("cancellation dispatch timeout")),
            30_000,
          );
        }),
      ]);
    } finally {
      if (dispatchTimer !== undefined) clearTimeout(dispatchTimer);
    }
    controller.abort(new Error("ir probe cancellation"));
    const outcome = await outcomePromise;
    if (outcome.status !== "error" || outcome.reason !== "aborted") {
      fail(`expected aborted terminal, got: ${JSON.stringify(outcome)}`);
    }
  });

  await run("real HTTP authentication failure retains neutral facts", async () => {
    const stream = runtime.models.streamSimple(
      runtime.model,
      {
        messages: [
          {
            role: "user",
            content: "This request must fail authentication before generation.",
            timestamp: 1,
          },
        ],
      },
      runtime.options({
        apiKey: `invalid-online-probe-${randomUUID()}`,
        maxRetries: 0,
        maxTokens: 16,
      }),
    );
    for await (const event of stream) {
      if (event.type === "done") {
        fail("invalid upstream credential unexpectedly succeeded");
      }
      if (event.type !== "error") continue;
      const fact = findUpstreamFailureFact(event.error.diagnostics);
      if (
        fact?.kind !== "http" ||
        (fact.status !== 401 && fact.status !== 403) ||
        fact.retryable !== false ||
        fact.attemptCount !== 1
      ) {
        fail(`incomplete neutral HTTP fact: ${JSON.stringify(fact)}`);
      }
      if (
        fact.snapshot === undefined ||
        fact.snapshot.capturedBytes < 1 ||
        typeof fact.snapshot.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(fact.snapshot.sha256)
      ) {
        fail(`missing bounded HTTP snapshot: ${JSON.stringify(fact.snapshot)}`);
      }
      return;
    }
    fail("invalid upstream credential ended without an error terminal");
  });

  // ---------- E. usage / identity ----------

  await run("response identity and raw stop reason present", async () => {
    const message = await collect(
      runtime.models.streamSimple(
        runtime.model,
        {
          messages: [
            { role: "user", content: "Reply with OK.", timestamp: 1 },
          ],
        },
        runtime.options({ maxTokens: 64 }),
      ),
    );
    if (typeof message.model !== "string" || message.model.length === 0) {
      fail("message.model missing");
    }
    if (typeof message.api !== "string" || typeof message.provider !== "string") {
      fail("message api/provider missing");
    }
    if (message.rawStopReason === undefined) {
      fail("rawStopReason missing");
    }
    usageValid(message.usage);
  });

  const failed = results.filter((result) => !result.ok);
  if (caseFilterActive && requestedCases.size > 0) {
    fail(`Unknown Pi IR probe case(s): ${[...requestedCases].join(", ")}`);
  }
  console.log(
    `\nPi IR <-> CommandCode probe: ${results.length - failed.length}/${results.length} passed`,
  );
  if (failed.length > 0) {
    for (const failure of failed) {
      console.error(`- ${failure.name}: ${failure.detail}`);
    }
    process.exitCode = 1;
  }
}

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

async function expectPiConversionFailure(
  stream: AssistantMessageEventStream,
): Promise<void> {
  for await (const event of stream) {
    if (event.type === "done") {
      fail(`expected error terminal, got done: ${textOf(event.message)}`);
    }
    if (event.type !== "error") continue;
    if (
      event.reason !== "error" ||
      event.error.errorMessage !== "CommandCode request conversion failed"
    ) {
      fail(
        `unexpected Pi conversion terminal: reason=${event.reason} ` +
          `message=${event.error.errorMessage ?? ""}`,
      );
    }
    const fact = findUpstreamFailureFact(event.error.diagnostics);
    if (fact?.kind !== "conversion" || fact.retryable !== false) {
      fail(`missing neutral conversion fact: ${JSON.stringify(fact)}`);
    }
    return;
  }
  fail("stream ended without a conversion error terminal");
}

async function expectPiError(
  stream: AssistantMessageEventStream,
  pattern: RegExp,
): Promise<void> {
  try {
    const message = await collect(stream);
    fail(`expected error terminal, got done: ${textOf(message)}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("expected error terminal")
    ) {
      throw error;
    }
    if (error instanceof Error && !pattern.test(error.message)) {
      fail(`error did not match ${pattern}: ${error.message}`);
    }
  }
}

function captureFetch(): {
  readonly fetch: FetchFunction;
  readonly bodies: readonly Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  const fetch: FetchFunction = async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();
    bodies.push(JSON.parse(text) as Record<string, unknown>);
    return upstreamJsonl(text);
  };
  return { fetch, bodies };
}

function upstreamJsonl(bodyText: string): Response {
  const echo = extractEchoMarker(bodyText);
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({ type: "text-delta", id: "0", text: echo }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      }),
    ].join("\n"),
    { status: 200 },
  );
}

function extractEchoMarker(bodyText: string): string {
  try {
    const body = JSON.parse(bodyText) as {
      params?: { messages?: Array<{ content?: unknown }> };
    };
    const messages = body.params?.messages ?? [];
    const found: string[] = [];
    for (const message of messages) {
      const candidates: string[] = [];
      if (typeof message.content === "string") {
        candidates.push(message.content);
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "text" in block &&
            typeof block.text === "string"
          ) {
            candidates.push(block.text);
          }
        }
      }
      for (const candidate of candidates) {
        for (const match of candidate.matchAll(/LT_[A-Z0-9_]+/gu)) {
          found.push(match[0]);
        }
      }
    }
    if (found.length > 0) return found.at(-1) as string;
  } catch {
    // fall through to default
  }
  return "OK";
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
