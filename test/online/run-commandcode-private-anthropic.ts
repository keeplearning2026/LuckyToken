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
    throw new Error(`online_http_${response.status}: ${response.text.slice(0, 512)}`);
  }
  const result = JSON.parse(response.text) as unknown;
  if (
    !isOnlineRecord(result) ||
    result.type !== "message" ||
    result.role !== "assistant" ||
    !Array.isArray(result.content) ||
    !isOnlineRecord(result.usage)
  ) {
    throw new Error("online_anthropic_json_shape");
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
  if (summary.length === 0) throw new Error("online_private_thinking_missing");
  return summary;
}

function assertMarker(result: AnthropicResult, marker: string): void {
  const text = visibleText(result);
  if (!text.includes(marker)) throw new Error("online_private_marker_missing");
  if (!new Set(["end_turn", "max_tokens", "tool_use"]).has(result.stop_reason)) {
    throw new Error(`online_private_stop_reason_${result.stop_reason}`);
  }
}

function exchangeFor(
  harness: AnthropicOnlineHarness,
  marker: string,
): CapturedExchange {
  const exchange = harness.exchanges.findLast((candidate) => candidate.body.includes(marker));
  if (exchange !== undefined) return exchange;
  throw new Error(`online_private_upstream_capture_missing_${marker}`);
}

function providerPayload(exchange: CapturedExchange): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(exchange.body) as unknown;
  if (!isOnlineRecord(parsed)) throw new Error("online_private_provider_payload_shape");
  return parsed;
}

function assertBasicFinalWire(payload: Readonly<Record<string, unknown>>): void {
  const target = payload.params;
  if (!isOnlineRecord(target)) throw new Error("online_private_params_missing");
  if (
    target.max_tokens !== MAX_TOKENS ||
    target.temperature !== 0.4 ||
    target.reasoning_effort !== "high"
  ) {
    throw new Error("online_private_basic_projection_mismatch");
  }
  if (Object.hasOwn(target, "top_p") || Object.hasOwn(target, "top_k")) {
    throw new Error("online_private_unsupported_sampling_leaked");
  }
}

function assertReasoningReplay(
  payload: Readonly<Record<string, unknown>>,
  summary: string,
): void {
  const messages = readOnlineProviderMessages("commandcode-private", payload);
  const replayed = messages.some((message) =>
    message.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some(
      (block) => isOnlineRecord(block) && block.type === "reasoning" && block.text === summary,
    )
  );
  if (!replayed) throw new Error("online_private_full_history_reasoning_replay_missing");
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
    providerId: "commandcode-private",
    model: "commandcode-private/deepseek/deepseek-v4-flash",
    apiKeyFile: "CommandcodeAPIKey.txt",
  });
  const results: CaseResult[] = [];
  try {
    if (harness.providerApi !== "commandcode-private") {
      throw new Error(`online_private_api_${harness.providerApi}`);
    }

    const basicMarker = "LT_ANTHROPIC_PRIVATE_BASIC_01";
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

    const sseMarker = "LT_ANTHROPIC_PRIVATE_SSE_01";
    await runCase(results, "sse-lifecycle", async () => {
      const response = await harness.postSse({
        model: harness.selector,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: promptFor(sseMarker) }],
      });
      if (response.status !== 200) {
        throw new Error(`online_private_sse_http_${response.status}`);
      }
      if (
        response.eventTypes[0] !== "message_start" ||
        !response.eventTypes.includes("message_delta") ||
        response.eventTypes.at(-1) !== "message_stop" ||
        !response.visibleText.includes(sseMarker)
      ) {
        throw new Error(`online_private_sse_lifecycle_${response.eventTypes.join(",")}`);
      }
    });

    await runCase(results, "complete-history-reasoning-replay", async () => {
      if (firstTurn === undefined) throw new Error("online_private_first_turn_unavailable");
      const summary = reasoningSummary(firstTurn);
      const marker = "LT_ANTHROPIC_PRIVATE_HISTORY_02";
      parseSuccess(await harness.postJson({
        model: harness.selector,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "user", content: promptFor(basicMarker) },
          { role: "assistant", content: firstTurn.content },
          { role: "user", content: promptFor(marker) },
        ],
        output_config: { effort: "high" },
      }));
      assertReasoningReplay(providerPayload(exchangeFor(harness, marker)), summary);
    });

    const tool = {
      name: "online_private_lookup",
      description: "Return the supplied marker",
      input_schema: {
        type: "object",
        properties: { marker: { type: "string" } },
        required: ["marker"],
        additionalProperties: false,
      },
    } as const;

    await runCase(results, "tool-choice-auto-and-none", async () => {
      const autoMarker = "LT_ANTHROPIC_PRIVATE_TOOL_AUTO_01";
      parseSuccess(await harness.postJson({
        model: harness.selector,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: `Reply ${autoMarker}; do not call tools.` }],
        tools: [tool],
        tool_choice: { type: "auto" },
      }));
      const autoPayload = providerPayload(exchangeFor(harness, autoMarker));
      if (!isOnlineRecord(autoPayload.params) || !Array.isArray(autoPayload.params.tools) ||
        autoPayload.params.tools.length !== 1 || Object.hasOwn(autoPayload.params, "tool_choice")) {
        throw new Error("online_private_auto_tool_wire_mismatch");
      }

      const noneMarker = "LT_ANTHROPIC_PRIVATE_TOOL_NONE_01";
      const none = parseSuccess(await harness.postJson({
        model: harness.selector,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: promptFor(noneMarker) }],
        tools: [tool],
        tool_choice: { type: "none" },
      }));
      assertMarker(none, noneMarker);
      const nonePayload = providerPayload(exchangeFor(harness, noneMarker));
      if (!isOnlineRecord(nonePayload.params) || !Array.isArray(nonePayload.params.tools) ||
        nonePayload.params.tools.length !== 0) {
        throw new Error("online_private_none_tool_wire_mismatch");
      }
    });

    await runCase(results, "tool-choice-degraded-fallbacks", async () => {
      for (const [label, toolChoice] of [
        ["any", { type: "any" }],
        ["named", { type: "tool", name: tool.name }],
        ["serial", { type: "auto", disable_parallel_tool_use: true }],
      ] as const) {
        const marker = `LT_ANTHROPIC_PRIVATE_TOOL_${label.toUpperCase()}_01`;
        parseSuccess(await harness.postJson({
          model: harness.selector,
          max_tokens: MAX_TOKENS,
          messages: [{ role: "user", content: `Call ${tool.name} with marker ${marker}.` }],
          tools: [tool],
          tool_choice: toolChoice,
        }));
        const projected = providerPayload(exchangeFor(harness, marker));
        if (!isOnlineRecord(projected.params) || !Array.isArray(projected.params.tools)) {
          throw new Error(`online_private_tool_${label}_wire_missing`);
        }
        if (label === "named" && projected.params.tools.length !== 1) {
          throw new Error("online_private_named_tool_fallback_mismatch");
        }
      }
    });

    await runCase(results, "structured-output-guidance-fallback", async () => {
      const marker = "LT_ANTHROPIC_PRIVATE_SCHEMA_01";
      parseSuccess(await harness.postJson({
        model: harness.selector,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: `Return JSON containing ${marker}.` }],
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
      const projected = providerPayload(exchangeFor(harness, marker));
      if (
        !isOnlineRecord(projected.params) ||
        typeof projected.params.system !== "string" ||
        !projected.params.system.includes("Conformance is best effort")
      ) {
        throw new Error("online_private_schema_guidance_missing");
      }
    });

    await runCase(results, "reasoning-activation-degraded-fallbacks", async () => {
      for (const [label, maxTokens, thinking] of [
        ["disabled", MAX_TOKENS, { type: "disabled" }],
        [
          "enabled_budget",
          2_048,
          { type: "enabled", budget_tokens: 1_024 },
        ],
        ["adaptive", MAX_TOKENS, { type: "adaptive" }],
      ] as const) {
        const marker = `LT_ANTHROPIC_PRIVATE_REASONING_${label.toUpperCase()}_01`;
        parseSuccess(await harness.postJson({
          model: harness.selector,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: promptFor(marker) }],
          thinking,
        }));
        providerPayload(exchangeFor(harness, marker));
      }
    });

    await runCase(results, "stop-sequence-omitted", async () => {
      const marker = "LT_ANTHROPIC_PRIVATE_STOP_01";
      parseSuccess(await harness.postJson({
        model: harness.selector,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: promptFor(marker) }],
        stop_sequences: ["END"],
      }));
      const projected = providerPayload(exchangeFor(harness, marker));
      if (
        !isOnlineRecord(projected.params) ||
        Object.hasOwn(projected.params, "stop") ||
        Object.hasOwn(projected.params, "stop_sequences")
      ) {
        throw new Error("online_private_stop_sequence_leaked");
      }
    });

    process.stdout.write(`${JSON.stringify({
      protocol: "anthropic-messages",
      client: "direct-raw-protocol",
      provider: "commandcode-private",
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
    `CommandCode Private Anthropic suite failed\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
