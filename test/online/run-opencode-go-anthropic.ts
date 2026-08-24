import { readOnlineProviderMessages } from "./provider-wire.js";
import {
  createAnthropicOnlineHarness,
  isOnlineRecord,
  type AnthropicOnlineHarness,
  type CapturedExchange,
  type LocalHttpResult,
} from "./run-anthropic-messages.js";

const MAX_TOKENS = 512;

interface AnthropicContentBlock extends Readonly<Record<string, unknown>> {
  readonly type: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly id?: string;
  readonly name?: string;
  readonly luckytoken_continuity?: unknown;
}

interface AnthropicResult {
  readonly type: "message";
  readonly role: "assistant";
  readonly content: readonly AnthropicContentBlock[];
  readonly stop_reason: string;
  readonly usage: Readonly<Record<string, unknown>>;
}

interface CaseResult {
  readonly id: string;
  readonly status: "pass" | "fail";
  readonly ms: number;
  readonly error?: string;
}

function promptFor(marker: string): string {
  return `Reply with the exact token ${marker} and no other text.`;
}

function parseSuccess(response: LocalHttpResult): AnthropicResult {
  if (response.status !== 200) {
    throw new Error(`online_opencode_http_${response.status}: ${response.text.slice(0, 512)}`);
  }
  const result = JSON.parse(response.text) as unknown;
  if (
    !isOnlineRecord(result) ||
    result.type !== "message" ||
    result.role !== "assistant" ||
    !Array.isArray(result.content) ||
    !isOnlineRecord(result.usage)
  ) {
    throw new Error("online_opencode_anthropic_json_shape");
  }
  return result as unknown as AnthropicResult;
}

function visibleText(result: AnthropicResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function reasoningSummary(result: AnthropicResult): string {
  const summary = result.content
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking ?? "")
    .join("\n");
  if (summary.length === 0) throw new Error("online_opencode_thinking_missing");
  return summary;
}

function assertItemExtensionV1(result: AnthropicResult): void {
  const carried = result.content.some((block) => {
    if (block.type !== "thinking" || !isOnlineRecord(block.luckytoken_continuity)) {
      return false;
    }
    return block.luckytoken_continuity.version === 1 &&
      Array.isArray(block.luckytoken_continuity.attachments) &&
      block.luckytoken_continuity.attachments.length > 0;
  });
  if (!carried) throw new Error("online_opencode_item_extension_v1_missing");
}

function assertMarker(result: AnthropicResult, marker: string): void {
  if (!visibleText(result).includes(marker)) throw new Error("online_opencode_marker_missing");
  if (!new Set(["end_turn", "max_tokens", "tool_use"]).has(result.stop_reason)) {
    throw new Error(`online_opencode_stop_reason_${result.stop_reason}`);
  }
}

function exchangeFor(
  harness: AnthropicOnlineHarness,
  marker: string,
): CapturedExchange {
  const exchange = harness.exchanges.findLast((candidate) => candidate.body.includes(marker));
  if (exchange !== undefined) return exchange;
  throw new Error(`online_opencode_upstream_capture_missing_${marker}`);
}

function providerPayload(exchange: CapturedExchange): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(exchange.body) as unknown;
  if (!isOnlineRecord(parsed)) throw new Error("online_opencode_provider_payload_shape");
  return parsed;
}

function assertBasicFinalWire(payload: Readonly<Record<string, unknown>>): void {
  const tokenLimit = payload.max_completion_tokens ?? payload.max_tokens;
  if (
    tokenLimit !== MAX_TOKENS ||
    payload.temperature !== 0.4 ||
    payload.top_p !== 0.8 ||
    payload.top_k !== 12 ||
    payload.reasoning_effort !== "high"
  ) {
    throw new Error("online_opencode_basic_projection_mismatch");
  }
}

function assertReasoningReplay(
  payload: Readonly<Record<string, unknown>>,
  summary: string,
): void {
  const messages = readOnlineProviderMessages("openai-completions", payload);
  const replayed = messages.some((message) =>
    message.role === "assistant" &&
    ["reasoning_content", "reasoning", "reasoning_text"].some(
      (field) => message[field] === summary,
    )
  );
  if (!replayed) throw new Error("online_opencode_full_history_reasoning_replay_missing");
}

async function runCase(
  results: CaseResult[],
  id: string,
  operation: () => Promise<void>,
): Promise<void> {
  const started = performance.now();
  try {
    await operation();
    results.push(Object.freeze({
      id,
      status: "pass",
      ms: Math.round(performance.now() - started),
    }));
  } catch (error) {
    results.push(Object.freeze({
      id,
      status: "fail",
      ms: Math.round(performance.now() - started),
      error: (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 1_024),
    }));
  }
}

async function run(): Promise<void> {
  const harness = await createAnthropicOnlineHarness({
    providerId: "opencode-go",
    model: "deepseek-v4-flash",
    apiKeyFile: "OpenCodeAPIkey.txt",
    alias: "opencode-go/deepseek-v4-flash",
  });
  const results: CaseResult[] = [];
  try {
    if (harness.providerApi !== "openai-completions") {
      throw new Error(`online_opencode_api_${harness.providerApi}`);
    }

    const basicMarker = "LT_ANTHROPIC_OPENCODE_BASIC_01";
    let firstTurn: AnthropicResult | undefined;
    await runCase(results, "json-basic-final-wire", async () => {
      firstTurn = parseSuccess(await harness.postJson({
        model: harness.selector,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: promptFor(basicMarker) }],
        temperature: 0.4,
        top_p: 0.8,
        top_k: 12,
        output_config: { effort: "high" },
      }));
      assertMarker(firstTurn, basicMarker);
      reasoningSummary(firstTurn);
      assertBasicFinalWire(providerPayload(exchangeFor(harness, basicMarker)));
    });

    const sseMarker = "LT_ANTHROPIC_OPENCODE_SSE_01";
    await runCase(results, "sse-lifecycle", async () => {
      const response = await harness.postSse({
        model: harness.selector,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: promptFor(sseMarker) }],
      });
      if (response.status !== 200) {
        throw new Error(`online_opencode_sse_http_${response.status}`);
      }
      if (
        response.eventTypes[0] !== "message_start" ||
        !response.eventTypes.includes("message_delta") ||
        response.eventTypes.at(-1) !== "message_stop" ||
        !response.visibleText.includes(sseMarker)
      ) {
        throw new Error(`online_opencode_sse_lifecycle_${response.eventTypes.join(",")}`);
      }
    });

    await runCase(results, "complete-history-reasoning-replay", async () => {
      if (firstTurn === undefined) throw new Error("online_opencode_first_turn_unavailable");
      const summary = reasoningSummary(firstTurn);
      assertItemExtensionV1(firstTurn);
      const marker = "LT_ANTHROPIC_OPENCODE_HISTORY_02";
      const next = parseSuccess(await harness.postJson({
        model: harness.selector,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "user", content: promptFor(basicMarker) },
          { role: "assistant", content: firstTurn.content },
          { role: "user", content: promptFor(marker) },
        ],
        output_config: { effort: "high" },
      }));
      assertMarker(next, marker);
      assertReasoningReplay(providerPayload(exchangeFor(harness, marker)), summary);
    });

    const toolName = "online_anthropic_opencode_lookup";
    const tool = {
      name: toolName,
      description: "Return the supplied marker",
      input_schema: {
        type: "object",
        properties: { marker: { type: "string" } },
        required: ["marker"],
        additionalProperties: false,
      },
    } as const;

    await runCase(results, "tool-choice-auto", async () => {
      const marker = "LT_ANTHROPIC_OPENCODE_TOOL_AUTO_01";
      parseSuccess(await harness.postJson({
        model: harness.selector,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: `Reply ${marker}; do not call tools.` }],
        tools: [tool],
        tool_choice: { type: "auto" },
      }));
      const payload = providerPayload(exchangeFor(harness, marker));
      if (payload.tool_choice !== "auto" || payload.parallel_tool_calls !== true) {
        throw new Error("online_opencode_auto_tool_wire_mismatch");
      }
    });

    await runCase(results, "tool-choice-required-any", async () => {
      const marker = "LT_ANTHROPIC_OPENCODE_TOOL_ANY_01";
      const result = parseSuccess(await harness.postJson({
        model: harness.selector,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: `Call ${toolName} with marker ${marker}.` }],
        tools: [tool],
        tool_choice: { type: "any" },
      }));
      if (!result.content.some((block) => block.type === "tool_use")) {
        throw new Error("online_opencode_required_tool_missing");
      }
      const payload = providerPayload(exchangeFor(harness, marker));
      if (payload.tool_choice !== "required" || payload.parallel_tool_calls !== true) {
        throw new Error("online_opencode_required_tool_wire_mismatch");
      }
    });

    await runCase(results, "tool-choice-named-serial", async () => {
      const marker = "LT_ANTHROPIC_OPENCODE_TOOL_NAMED_01";
      const result = parseSuccess(await harness.postJson({
        model: harness.selector,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: `Call ${toolName} with marker ${marker}.` }],
        tools: [tool],
        tool_choice: {
          type: "tool",
          name: toolName,
          disable_parallel_tool_use: true,
        },
      }));
      const selectedTool = result.content.find(
        (block) => block.type === "tool_use" && block.name === toolName,
      );
      if (selectedTool?.id === undefined) throw new Error("online_opencode_named_tool_missing");
      const payload = providerPayload(exchangeFor(harness, marker));
      if (
        payload.parallel_tool_calls !== false ||
        !isOnlineRecord(payload.tool_choice) ||
        !isOnlineRecord(payload.tool_choice.function) ||
        payload.tool_choice.function.name !== toolName
      ) {
        throw new Error("online_opencode_named_serial_wire_mismatch");
      }
    });

    await runCase(results, "tool-choice-none", async () => {
      const marker = "LT_ANTHROPIC_OPENCODE_TOOL_NONE_01";
      const result = parseSuccess(await harness.postJson({
        model: harness.selector,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: promptFor(marker) }],
        tools: [tool],
        tool_choice: { type: "none" },
      }));
      assertMarker(result, marker);
      const payload = providerPayload(exchangeFor(harness, marker));
      if (payload.tool_choice !== "none" || Object.hasOwn(payload, "parallel_tool_calls")) {
        throw new Error("online_opencode_none_tool_wire_mismatch");
      }
    });

    await runCase(results, "stop-and-structured-output", async () => {
      const marker = "LT_ANTHROPIC_OPENCODE_JSON_01";
      const result = parseSuccess(await harness.postJson({
        model: harness.selector,
        max_tokens: MAX_TOKENS,
        messages: [{
          role: "user",
          content: `Return JSON with answer exactly ${marker}.`,
        }],
        stop_sequences: ["LT_NEVER_STOP_OPENCODE"],
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
              additionalProperties: false,
            },
          },
        },
      }));
      const parsed = JSON.parse(visibleText(result)) as unknown;
      if (!isOnlineRecord(parsed) || parsed.answer !== marker) {
        throw new Error("online_opencode_structured_response_mismatch");
      }
      const payload = providerPayload(exchangeFor(harness, marker));
      if (!Array.isArray(payload.stop) || payload.stop[0] !== "LT_NEVER_STOP_OPENCODE" ||
        !isOnlineRecord(payload.response_format) || payload.response_format.type !== "json_schema") {
        throw new Error("online_opencode_stop_or_structure_wire_mismatch");
      }
    });

    await runCase(results, "reasoning-disabled", async () => {
      const marker = "LT_ANTHROPIC_OPENCODE_DISABLED_01";
      const result = parseSuccess(await harness.postJson({
        model: harness.selector,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: promptFor(marker) }],
        thinking: { type: "disabled" },
      }));
      assertMarker(result, marker);
      const payload = providerPayload(exchangeFor(harness, marker));
      if (
        Object.hasOwn(payload, "thinking") ||
        Object.hasOwn(payload, "reasoning_effort") ||
        Object.hasOwn(payload, "thinking_token_budget")
      ) {
        throw new Error("online_opencode_disabled_reasoning_fallback_mismatch");
      }
    });

    await runCase(results, "reasoning-activation-degraded-fallbacks", async () => {
      for (const [label, maxTokens, thinking] of [
        [
          "enabled_budget",
          2_048,
          { type: "enabled", budget_tokens: 1_024 },
        ],
        ["adaptive", MAX_TOKENS, { type: "adaptive" }],
      ] as const) {
        const marker = `LT_ANTHROPIC_OPENCODE_REASONING_${label.toUpperCase()}_01`;
        parseSuccess(await harness.postJson({
          model: harness.selector,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: promptFor(marker) }],
          thinking,
        }));
        providerPayload(exchangeFor(harness, marker));
      }
    });

    process.stdout.write(`${JSON.stringify({
      protocol: "anthropic-messages",
      client: "direct-raw-protocol",
      provider: "opencode-go",
      model: harness.selector,
      providerApi: harness.providerApi,
      cases: results,
    }, null, 2)}\n`);
    if (results.some((result) => result.status === "fail")) process.exitCode = 1;
  } finally {
    await harness.close();
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `OpenCode Go Anthropic suite failed\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
