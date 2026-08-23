import type { AssistantMessage } from "@earendil-works/pi-ai";

import {
  encodeAnthropicContinuity,
  type AnthropicContinuityAttachment,
  type AnthropicContinuitySource,
} from "../reasoning/continuity.js";
import type { AnthropicInterpretedResponse } from "./contract.js";

const CERTIFIED_APIS = new Set([
  "commandcode-private",
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "bedrock-converse-stream",
  "pi-messages",
]);

type AnthropicStopReason = "end_turn" | "max_tokens" | "tool_use";

function fallbackStopReason(message: AssistantMessage): AnthropicStopReason {
  if (message.stopReason === "length") return "max_tokens";
  if (message.stopReason === "toolUse") {
    if (!message.content.some((block) => block.type === "toolCall")) {
      throw new Error("Pi toolUse terminal has no tool-call content");
    }
    return "tool_use";
  }
  if (message.stopReason === "stop") {
    return message.content.some((block) => block.type === "toolCall")
      ? "tool_use"
      : "end_turn";
  }
  throw new Error(`Unsupported committed Pi stop reason: ${message.stopReason}`);
}

function mapRawStopReason(message: AssistantMessage): {
  readonly reason: AnthropicStopReason;
  readonly normalized: boolean;
} {
  const raw = message.rawStopReason;
  if (raw === undefined || message.api === "pi-messages") {
    return { reason: fallbackStopReason(message), normalized: raw === undefined };
  }
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("Pi rawStopReason must be a non-empty string when present");
  }
  let reason: AnthropicStopReason;
  switch (message.api) {
    case "commandcode-private":
      if (raw === "stop") reason = "end_turn";
      else if (raw === "length") reason = "max_tokens";
      else if (raw === "tool-calls") reason = "tool_use";
      else throw new Error(`Unknown CommandCode Private finish reason: ${raw}`);
      break;
    case "anthropic-messages":
      if (raw === "stop_sequence") {
        throw new Error("Anthropic stop_sequence lost the matched stop_sequence value in Pi IR");
      }
      if (raw === "pause_turn") {
        throw new Error("Anthropic pause_turn lost its continuation state in Pi IR");
      }
      if (raw === "refusal") {
        throw new Error("Anthropic refusal cannot be rendered as a successful response");
      }
      if (raw === "end_turn") reason = "end_turn";
      else if (raw === "max_tokens") reason = "max_tokens";
      else if (raw === "tool_use") reason = "tool_use";
      else throw new Error(`Unknown Anthropic stop reason: ${raw}`);
      break;
    case "bedrock-converse-stream":
      if (raw === "stop_sequence") {
        throw new Error("Bedrock stop_sequence lost the matched stop sequence in Pi IR");
      }
      if (raw === "end_turn") reason = "end_turn";
      else if (raw === "max_tokens" || raw === "model_context_window_exceeded") {
        reason = "max_tokens";
      } else if (raw === "tool_use") reason = "tool_use";
      else throw new Error(`Unknown Bedrock stop reason: ${raw}`);
      break;
    case "openai-completions":
      if (raw === "stop" || raw === "end") reason = "end_turn";
      else if (raw === "length") reason = "max_tokens";
      else if (raw === "function_call" || raw === "tool_calls") reason = "tool_use";
      else throw new Error(`Unknown Chat Completions finish reason: ${raw}`);
      break;
    case "mistral-conversations":
      if (raw === "stop") reason = "end_turn";
      else if (raw === "length" || raw === "model_length") reason = "max_tokens";
      else if (raw === "tool_calls") reason = "tool_use";
      else throw new Error(`Unknown Mistral finish reason: ${raw}`);
      break;
    case "google-generative-ai":
    case "google-vertex":
      if (raw === "STOP") reason = "end_turn";
      else if (raw === "MAX_TOKENS") reason = "max_tokens";
      else throw new Error(`Google response cannot be rendered after finish reason ${raw}`);
      break;
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      if (raw === "completed") reason = "end_turn";
      else if (raw === "incomplete.max_output_tokens") reason = "max_tokens";
      else throw new Error(`Responses terminal cannot be rendered after status ${raw}`);
      break;
    default:
      throw new Error(`No raw stop-reason interpreter for Pi API ${message.api}`);
  }

  const hasToolCall = message.content.some((block) => block.type === "toolCall");
  if (reason === "tool_use" && !hasToolCall) {
    throw new Error("Provider tool terminal has no tool-call content in Pi IR");
  }
  if (hasToolCall && reason !== "tool_use") {
    if (
      message.api === "google-generative-ai" ||
      message.api === "google-vertex" ||
      message.api === "openai-responses" ||
      message.api === "azure-openai-responses" ||
      message.api === "openai-codex-responses"
    ) {
      reason = "tool_use";
    } else {
      throw new Error("Provider terminal disagrees with retained tool-call content");
    }
  }
  const expectedPi =
    reason === "max_tokens" ? "length" : reason === "tool_use" ? "toolUse" : "stop";
  if (message.stopReason !== expectedPi) {
    throw new Error(
      `Pi stopReason ${message.stopReason} disagrees with Provider terminal ${raw}`,
    );
  }
  return {
    reason,
    normalized:
      (message.api === "mistral-conversations" && raw === "model_length") ||
      (message.api === "bedrock-converse-stream" && raw === "model_context_window_exceeded"),
  };
}

function unavailableResponseFacts(api: string): {
  readonly textCitations: boolean;
  readonly responsePaths: readonly string[];
} {
  if (api === "anthropic-messages") {
    return Object.freeze({
      textCitations: true,
      responsePaths: Object.freeze([
        "$.container",
        "$.usage.inference_geo",
        "$.usage.service_tier",
      ]),
    });
  }
  if (
    api === "openai-responses" ||
    api === "azure-openai-responses" ||
    api === "openai-codex-responses"
  ) {
    return Object.freeze({
      textCitations: true,
      responsePaths: Object.freeze(["$.usage.service_tier"]),
    });
  }
  if (api === "google-generative-ai" || api === "google-vertex") {
    return Object.freeze({ textCitations: true, responsePaths: Object.freeze([]) });
  }
  return Object.freeze({ textCitations: false, responsePaths: Object.freeze([]) });
}

function reasoningState(value: string): "opaque-signature" | "opaque-reasoning-state" {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).type === "reasoning"
    ) {
      return "opaque-reasoning-state";
    }
  } catch {
    // Opaque strings are intentionally not interpreted further.
  }
  return "opaque-signature";
}

function hasNativeAnthropicThinkingSignature(message: AssistantMessage): boolean {
  if (message.api === "anthropic-messages") return true;
  if (message.api !== "bedrock-converse-stream") return false;
  const identity = `${message.provider}/${message.model}`.toLowerCase();
  return identity.includes("anthropic.claude") ||
    identity.includes("anthropic/claude") ||
    identity.includes("claude");
}

export function interpretAnthropicAssistantResponse(
  message: AssistantMessage,
): AnthropicInterpretedResponse {
  if (!CERTIFIED_APIS.has(message.api)) {
    throw new Error(
      `Anthropic response interpretation is not certified for Pi API ${message.api}`,
    );
  }
  const source: AnthropicContinuitySource = Object.freeze({
    provider: message.provider,
    api: message.api,
    model: message.model,
  });
  const continuityByContentIndex = new Map<
    number,
    NonNullable<ReturnType<typeof encodeAnthropicContinuity>>
  >();
  const nativeThinkingIndexes = new Set<number>();
  message.content.forEach((block, index) => {
    const attachments: AnthropicContinuityAttachment[] = [];
    if (block.type === "thinking" && block.thinkingSignature !== undefined) {
      if (hasNativeAnthropicThinkingSignature(message)) {
        nativeThinkingIndexes.add(index);
        attachments.push({
          target: "thinking",
          kind: "native-field-provenance",
          ...(block.redacted === true ? { representation: "redacted" } : {}),
        });
      } else {
        attachments.push({
          target: "thinking",
          kind: reasoningState(block.thinkingSignature),
          value: block.thinkingSignature,
          ...(block.redacted === true ? { representation: "redacted" } : {}),
        });
      }
    } else if (block.type === "text" && block.textSignature !== undefined) {
      attachments.push({
        target: "text",
        kind: "opaque-signature",
        value: block.textSignature,
      });
    } else if (block.type === "toolCall" && block.thoughtSignature !== undefined) {
      attachments.push({
        target: "toolCall",
        callId: block.id,
        kind: "opaque-signature",
        value: block.thoughtSignature,
      });
    }
    const envelope = encodeAnthropicContinuity({ source, attachments });
    if (envelope !== undefined) continuityByContentIndex.set(index, envelope);
  });
  return Object.freeze({
    message,
    continuityByContentIndex,
    nativeThinkingIndexes,
    stop: Object.freeze(mapRawStopReason(message)),
    unavailable: unavailableResponseFacts(message.api),
    interpreter: `anthropic-from-${message.api}`,
  });
}
