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
import { cloneLosslessJsonObject } from "./json.js";

export interface CommandCodeResponseAuthority {
  api: string;
  provider: string;
  modelId: string;
  responseTimestamp: number;
  pricingModel: Model<string>;
}

export function captureCommandCodeResponseAuthority(
  model: Model<string>,
  now: () => number,
): CommandCodeResponseAuthority {
  const cost = {
    ...model.cost,
    ...(model.cost.tiers === undefined
      ? {}
      : { tiers: model.cost.tiers.map((tier) => ({ ...tier })) }),
  };
  return {
    api: model.api,
    provider: model.provider,
    modelId: model.id,
    responseTimestamp: now(),
    pricingModel: { ...model, cost },
  };
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

function convertUsage(
  result: CommandCodeResult,
  authority: CommandCodeResponseAuthority,
): Usage {
  const raw = result.rawUsage;
  const rawInputDetails = raw?.inputTokenDetails;
  if (rawInputDetails !== undefined && !isRecord(rawInputDetails)) {
    throw new Error("inputTokenDetails must be an object when present");
  }
  const inputDetails = isRecord(rawInputDetails) ? rawInputDetails : undefined;
  const rawOutputDetails = raw?.outputTokenDetails;
  if (rawOutputDetails !== undefined && !isRecord(rawOutputDetails)) {
    throw new Error("outputTokenDetails must be an object when present");
  }
  const outputDetails = isRecord(rawOutputDetails) ? rawOutputDetails : undefined;

  const cacheReadPresent =
    inputDetails !== undefined && Object.hasOwn(inputDetails, "cacheReadTokens");
  const cacheWritePresent =
    inputDetails !== undefined && Object.hasOwn(inputDetails, "cacheWriteTokens");
  const cacheRead = requireCount(
    cacheReadPresent
      ? inputDetails.cacheReadTokens
      : result.usage.cacheReadTokens,
    "cacheReadTokens",
  );
  const cacheWrite = requireCount(
    cacheWritePresent
      ? inputDetails.cacheWriteTokens
      : result.usage.cacheWriteTokens,
    "cacheWriteTokens",
  );
  const rawInputPresent = raw !== undefined && Object.hasOwn(raw, "inputTokens");
  const noCachePresent =
    inputDetails !== undefined && Object.hasOwn(inputDetails, "noCacheTokens");
  let input: number;
  if (noCachePresent) {
    input = requireCount(inputDetails?.noCacheTokens, "noCacheTokens");
  } else {
    const totalInput = requireCount(
      rawInputPresent ? raw?.inputTokens : result.usage.inputTokens,
      "inputTokens",
    );
    if (totalInput < cacheRead + cacheWrite) {
      throw new Error("CommandCode cached input exceeds total input");
    }
    input = totalInput - cacheRead - cacheWrite;
  }

  const output = requireCount(
    raw !== undefined && Object.hasOwn(raw, "outputTokens")
      ? raw.outputTokens
      : result.usage.outputTokens,
    "outputTokens",
  );
  const outputReasoningPresent =
    outputDetails !== undefined && Object.hasOwn(outputDetails, "reasoningTokens");
  const reasoningCandidate = outputReasoningPresent
    ? outputDetails.reasoningTokens
    : undefined;
  let reasoning: number | undefined;
  if (reasoningCandidate !== undefined) {
    reasoning = requireCount(reasoningCandidate, "reasoningTokens");
    if (reasoning > output) {
      throw new Error("CommandCode reasoning tokens exceed output tokens");
    }
  }

  const usage: Usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + cacheRead + cacheWrite + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  if (reasoning !== undefined) usage.reasoning = reasoning;
  return applyCommandCodeCapturedPricing(authority, usage);
}

function convertContent(
  result: CommandCodeResult,
  authority: CommandCodeResponseAuthority,
): Array<TextContent | ThinkingContent | ToolCall> {
  return result.content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "reasoning") {
      if (!authority.pricingModel.reasoning) {
        throw new Error(
          "CommandCode emitted reasoning for a non-reasoning certified route",
        );
      }
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

function stopReason(result: CommandCodeResult): Extract<StopReason, "stop" | "length" | "toolUse"> {
  if (result.finish.finishReason === "tool-calls") return "toolUse";
  if (result.finish.finishReason === "length") return "length";
  return "stop";
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
): void {
  if (result.systemPromptTokens !== undefined) {
    message.diagnostics = [
      {
        type: "commandcode.system_prompt_tokens",
        timestamp: message.timestamp,
        details: { systemPromptTokens: result.systemPromptTokens },
      },
    ];
  }
  const rawReason = result.finish.rawFinishReason ?? result.finish.finishReason;
  if (rawReason !== undefined) message.rawStopReason = rawReason;
}

export function createCommandCodeFailureMessage(
  authority: CommandCodeResponseAuthority,
  error: unknown,
  usage: Usage = zeroUsage(),
  aborted = false,
): AssistantMessage {
  return {
    ...baseMessage(authority, usage),
    content: [],
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

export function convertCommittedCommandCodeResult(
  result: CommandCodeResult,
  authority: CommandCodeResponseAuthority,
): AssistantMessage {
  let committedStopReason: Extract<StopReason, "stop" | "length" | "toolUse">;
  try {
    committedStopReason = stopReason(result);
  } catch (error) {
    const failed = createCommandCodeFailureMessage(authority, error);
    addDiagnostics(failed, result);
    return failed;
  }

  let trustworthyUsage: Usage;
  try {
    trustworthyUsage = convertUsage(result, authority);
  } catch (error) {
    const failed = createCommandCodeFailureMessage(authority, error);
    addDiagnostics(failed, result);
    return failed;
  }

  let content: Array<TextContent | ThinkingContent | ToolCall>;
  try {
    content = convertContent(result, authority);
  } catch (error) {
    const failed = createCommandCodeFailureMessage(
      authority,
      error,
      trustworthyUsage,
    );
    addDiagnostics(failed, result);
    return failed;
  }

  const message: AssistantMessage = {
    ...baseMessage(authority, trustworthyUsage),
    content,
    stopReason: committedStopReason,
  };
  addDiagnostics(message, result);
  return message;
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
