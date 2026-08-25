import {
  calculateCost,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";

import type { CommandCodeResult } from "./assembler.js";
import { COMMANDCODE_PROVIDER_ID } from "./constants.js";
import { cloneLosslessJsonObject } from "./json.js";
import {
  createConversionNoticeDiagnostic,
  createInvocationAttemptDiagnostic,
  createUpstreamFailureDiagnostic,
  type ConversionNotice,
} from "@token/provider-contract/diagnostics";
import {
  commandCodeNeutralFailure,
  CommandCodeNeutralFailureError,
} from "./failure.js";

export interface CommandCodeResponseAuthority {
  api: string;
  provider: string;
  modelId: string;
  responseTimestamp: number;
  pricingModel: Model<string>;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function requireDeepFrozen(
  value: unknown,
  field: string,
  seen = new Set<object>(),
): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  if (!Object.isFrozen(value)) {
    throw new Error(`${field} must be immutable`);
  }
  seen.add(value);
  for (const [name, nested] of Object.entries(value)) {
    requireDeepFrozen(nested, `${field}.${name}`, seen);
  }
}

export function captureCommandCodeResponseAuthority(
  model: Model<string>,
  now: () => number,
): CommandCodeResponseAuthority {
  const responseTimestamp = now();
  if (!Number.isSafeInteger(responseTimestamp) || responseTimestamp < 0) {
    throw new TypeError(
      "CommandCode response timestamp must be a non-negative safe integer",
    );
  }
  const cost = {
    ...model.cost,
    ...(model.cost.tiers === undefined
      ? {}
      : { tiers: model.cost.tiers.map((tier) => ({ ...tier })) }),
  };
  const pricingModel: Model<string> = {
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
  return deepFreeze({
    api: model.api,
    provider: model.provider,
    modelId: model.id,
    responseTimestamp,
    pricingModel,
  });
}

export function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function applyCommandCodeCapturedPricing(
  authority: CommandCodeResponseAuthority,
  usage: Usage,
): Usage {
  calculateCost(authority.pricingModel, usage);
  return usage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function optionalCount(
  record: Readonly<Record<string, unknown>> | undefined,
  field: string,
): number | undefined {
  if (record === undefined || !Object.hasOwn(record, field)) return undefined;
  return requireCount(record[field], field);
}

function requireSameCount(
  left: number | undefined,
  right: number | undefined,
  fields: string,
): void {
  if (left !== undefined && right !== undefined && left !== right) {
    throw new Error(`${fields} must agree`);
  }
}

function safeTokenSum(field: string, ...values: readonly number[]): number {
  const sum = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(sum)) {
    throw new Error(`${field} exceeds the safe-integer range`);
  }
  return sum;
}

function convertUsage(
  result: CommandCodeResult,
  authority: CommandCodeResponseAuthority,
): Usage {
  const raw = result.rawUsage;
  if (raw === undefined) return zeroUsage();

  const rawInputDetails = raw.inputTokenDetails;
  if (!isRecord(rawInputDetails)) {
    throw new Error("inputTokenDetails must be an object");
  }
  const rawOutputDetails = raw.outputTokenDetails;
  if (rawOutputDetails !== undefined && !isRecord(rawOutputDetails)) {
    throw new Error("outputTokenDetails must be an object when present");
  }
  const outputDetails = isRecord(rawOutputDetails) ? rawOutputDetails : undefined;

  // Online CommandCode evidence for deepseek-v4-flash consistently exposes
  // these direct fields. They are the only authoritative sources for the
  // Pi Usage input / cache-read / output components. Never reconstruct input
  // by subtracting cache fields from inputTokens.
  const input = optionalCount(rawInputDetails, "noCacheTokens");
  const cacheRead = optionalCount(rawInputDetails, "cacheReadTokens");
  const output = optionalCount(raw, "outputTokens");
  if (input === undefined) throw new Error("noCacheTokens is required for trusted usage");
  if (cacheRead === undefined) throw new Error("cacheReadTokens is required for trusted usage");
  if (output === undefined) throw new Error("outputTokens is required for trusted usage");

  // Cache write is preserved only when explicitly present. When absent, a
  // reported inputTokens partition must prove that the missing component is
  // exactly zero; otherwise usage is not trustworthy enough to publish.
  const explicitCacheWrite = optionalCount(rawInputDetails, "cacheWriteTokens");
  const rawInput = optionalCount(raw, "inputTokens");
  const cacheWrite = explicitCacheWrite ?? 0;
  if (rawInput !== undefined) {
    const partitionedInput = safeTokenSum(
      "CommandCode input token partition",
      input,
      cacheRead,
      cacheWrite,
    );
    if (rawInput !== partitionedInput) {
      throw new Error(
        "inputTokens must equal noCacheTokens plus cache read and cache write",
      );
    }
  } else if (explicitCacheWrite === undefined) {
    throw new Error(
      "inputTokens is required to prove an absent cacheWriteTokens component",
    );
  }

  const aliasedCacheRead = optionalCount(raw, "cachedInputTokens");
  requireSameCount(
    cacheRead,
    aliasedCacheRead,
    "cacheReadTokens and cachedInputTokens",
  );

  const nestedReasoning = optionalCount(outputDetails, "reasoningTokens");
  const aliasedReasoning = optionalCount(raw, "reasoningTokens");
  requireSameCount(
    nestedReasoning,
    aliasedReasoning,
    "outputTokenDetails.reasoningTokens and reasoningTokens",
  );
  const reasoning = nestedReasoning;
  if (reasoning !== undefined && reasoning > output) {
    throw new Error("CommandCode reasoning tokens exceed output tokens");
  }
  const text = optionalCount(outputDetails, "textTokens");
  if (text !== undefined && text > output) {
    throw new Error("CommandCode text tokens exceed output tokens");
  }
  if (text !== undefined && reasoning !== undefined) {
    const detailedOutput = safeTokenSum(
      "CommandCode detailed output tokens",
      text,
      reasoning,
    );
    if (detailedOutput !== output) {
      throw new Error(
        "CommandCode text and reasoning token details must equal output tokens",
      );
    }
  }

  const computedTotal = safeTokenSum(
    "CommandCode totalTokens",
    input,
    cacheRead,
    cacheWrite,
    output,
  );
  const sourceTotal = optionalCount(raw, "totalTokens");
  if (sourceTotal !== undefined && sourceTotal !== computedTotal) {
    throw new Error("CommandCode totalTokens must agree with token components");
  }

  const usage: Usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: sourceTotal ?? computedTotal,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  if (reasoning !== undefined) usage.reasoning = reasoning;
  return applyCommandCodeCapturedPricing(authority, usage);
}

function convertContent(
  result: CommandCodeResult,
): Array<TextContent | ThinkingContent | ToolCall> {
  return result.content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "reasoning") {
      return { type: "thinking", thinking: block.text };
    }
    return {
      type: "toolCall",
      id: block.id,
      name: block.toolName,
      arguments: cloneLosslessJsonObject(
        block.input,
        `CommandCode ToolUse ${block.id} input`,
      ),
    };
  });
}

function stopReason(
  result: CommandCodeResult,
  content: readonly (TextContent | ThinkingContent | ToolCall)[],
): Extract<StopReason, "stop" | "length" | "toolUse"> {
  if (result.finish.finishReason === "length") return "length";
  return content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
}

function baseMessage(
  authority: CommandCodeResponseAuthority,
  usage: Usage,
): Omit<AssistantMessage, "content" | "stopReason"> {
  return {
    role: "assistant",
    api: authority.api,
    provider: authority.provider,
    model: authority.modelId,
    usage,
    timestamp: authority.responseTimestamp,
  };
}

function addDiagnostics(
  message: AssistantMessage,
  result: CommandCodeResult,
  notices: readonly ConversionNotice[],
  semanticNotices: readonly ConversionNotice[] = [],
): AssistantMessage {
  const diagnostics = [
    ...(message.diagnostics ?? []),
    ...(result.attempts ?? []).map((attempt) =>
      createInvocationAttemptDiagnostic(attempt, message.timestamp),
    ),
    ...[...notices, ...result.notices, ...semanticNotices].map((notice) =>
    createConversionNoticeDiagnostic(notice, message.timestamp),
    ),
  ];
  if (result.systemPromptTokens !== undefined) {
    diagnostics.push(
      {
        type: "commandcode.system_prompt_tokens",
        timestamp: message.timestamp,
        details: { systemPromptTokens: result.systemPromptTokens },
      },
    );
  }
  const rawReason = result.finish.rawFinishReason ?? result.finish.finishReason;
  return deepFreeze({
    ...message,
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
    ...(rawReason === undefined ? {} : { rawStopReason: rawReason }),
  });
}

function conversionFailure(cause: unknown): CommandCodeNeutralFailureError {
  return commandCodeNeutralFailure(
    {
      kind: "conversion",
      providerType: "commandcode_to_pi",
      providerCode: "INVALID_COMMITTED_RESULT",
      message: "CommandCode response could not be converted to Pi IR",
      retryable: false,
    },
    cause,
  );
}

function mismatchNotice(): ConversionNotice {
  return Object.freeze({
    adapter: COMMANDCODE_PROVIDER_ID,
    direction: "response",
    code: "finish_content_mismatch_degraded",
    action: "degrade",
  });
}

function usageUnavailableNotice(): ConversionNotice {
  return Object.freeze({
    adapter: COMMANDCODE_PROVIDER_ID,
    direction: "response",
    code: "usage_unavailable_degraded",
    jsonPath: "$.finish.totalUsage",
    action: "degrade",
  });
}

export function createCommandCodeFailureMessage(
  authority: CommandCodeResponseAuthority,
  error: unknown,
  usage: Usage = zeroUsage(),
  aborted = false,
): AssistantMessage {
  const message: AssistantMessage = {
    ...baseMessage(authority, usage),
    content: [],
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
  };
  if (error instanceof CommandCodeNeutralFailureError) {
    message.diagnostics = [
      createUpstreamFailureDiagnostic(error.failure, message.timestamp),
      ...error.attempts.map((attempt) =>
        createInvocationAttemptDiagnostic(attempt, message.timestamp),
      ),
    ];
  }
  return deepFreeze(message);
}

export function convertCommittedCommandCodeResult(
  result: CommandCodeResult,
  authority: CommandCodeResponseAuthority,
  notices: readonly ConversionNotice[] = [],
): AssistantMessage {
  try {
    requireDeepFrozen(result, "CommandCode committed result");
  } catch (error) {
    return createCommandCodeFailureMessage(authority, conversionFailure(error));
  }

  let trustworthyUsage = zeroUsage();
  let usageNotices: readonly ConversionNotice[] = [];
  try {
    trustworthyUsage = convertUsage(result, authority);
  } catch {
    // Usage is accounting/observability, never model-visible semantics.
    // Malformed or inconsistent usage degrades to Pi's all-zero fallback and
    // a bounded warning; content/tool/finish conversion continues normally.
    usageNotices = [usageUnavailableNotice()];
  }

  let content: Array<TextContent | ThinkingContent | ToolCall>;
  try {
    content = convertContent(result);
  } catch (error) {
    const failed = createCommandCodeFailureMessage(
      authority,
      conversionFailure(error),
      trustworthyUsage,
    );
    return addDiagnostics(failed, result, notices, usageNotices);
  }

  const committedStopReason = stopReason(result, content);
  const contentHasTool = content.some((block) => block.type === "toolCall");
  const wireClaimsTool = result.finish.finishReason === "tool-calls";
  const semanticNotices = [
    ...usageNotices,
    ...(contentHasTool === wireClaimsTool ? [] : [mismatchNotice()]),
  ];

  const message: AssistantMessage = {
    ...baseMessage(authority, trustworthyUsage),
    content,
    stopReason: committedStopReason,
    ...(result.responseIdentity === undefined
      ? {}
      : {
          responseId: result.responseIdentity.responseId,
          responseModel: result.responseIdentity.responseModel,
        }),
  };
  return addDiagnostics(message, result, notices, semanticNotices);
}

function clonePartial(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type === "text") return { ...block };
      if (block.type === "thinking") return { ...block };
      return { ...block, arguments: { ...block.arguments } };
    }),
    usage: {
      ...message.usage,
      cost: { ...message.usage.cost },
    },
  };
}

function abortedBeforeReplay(message: AssistantMessage): AssistantMessage {
  const aborted: AssistantMessage = {
    ...message,
    content: [],
    usage: zeroUsage(),
    stopReason: "aborted",
  };
  delete aborted.errorMessage;
  return aborted;
}

export function replayCommandCodeAssistantMessage(
  stream: AssistantMessageEventStream,
  message: AssistantMessage,
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted === true) {
    const aborted = abortedBeforeReplay(message);
    stream.push({ type: "error", reason: "aborted", error: aborted });
    stream.end();
    return;
  }
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
    stream.end();
    return;
  }
  if (
    message.stopReason !== "stop" &&
    message.stopReason !== "length" &&
    message.stopReason !== "toolUse"
  ) {
    throw new Error("CommandCode replay received an invalid success stop reason");
  }

  const partial: AssistantMessage = {
    ...message,
    content: [],
    usage: zeroUsage(),
    stopReason: "pending",
  };
  stream.push({ type: "start", partial: clonePartial(partial) });
  for (const [contentIndex, block] of message.content.entries()) {
    if (block.type === "text") {
      partial.content.push({ type: "text", text: "" });
      stream.push({
        type: "text_start",
        contentIndex,
        partial: clonePartial(partial),
      });
      (partial.content[contentIndex] as TextContent).text = block.text;
      stream.push({
        type: "text_delta",
        contentIndex,
        delta: block.text,
        partial: clonePartial(partial),
      });
      stream.push({
        type: "text_end",
        contentIndex,
        content: block.text,
        partial: clonePartial(partial),
      });
      continue;
    }
    if (block.type === "thinking") {
      partial.content.push({ type: "thinking", thinking: "" });
      stream.push({
        type: "thinking_start",
        contentIndex,
        partial: clonePartial(partial),
      });
      (partial.content[contentIndex] as ThinkingContent).thinking = block.thinking;
      stream.push({
        type: "thinking_delta",
        contentIndex,
        delta: block.thinking,
        partial: clonePartial(partial),
      });
      stream.push({
        type: "thinking_end",
        contentIndex,
        content: block.thinking,
        partial: clonePartial(partial),
      });
      continue;
    }
    partial.content.push({
      type: "toolCall",
      id: block.id,
      name: block.name,
      arguments: {},
    });
    stream.push({
      type: "toolcall_start",
      contentIndex,
      partial: clonePartial(partial),
    });
    (partial.content[contentIndex] as ToolCall).arguments = block.arguments;
    stream.push({
      type: "toolcall_end",
      contentIndex,
      toolCall: block,
      partial: clonePartial(partial),
    });
  }
  stream.push({ type: "done", reason: message.stopReason, message });
  stream.end();
}
