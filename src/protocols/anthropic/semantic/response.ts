import type { AssistantMessage } from "@earendil-works/pi-ai";

import {
  encodeAnthropicContinuity,
  type AnthropicContinuityAttachment,
  type AnthropicContinuitySource,
  type LuckyTokenAnthropicContinuityEnvelopeV1,
} from "./reasoning/continuity.js";

export interface AnthropicInterpretedResponse {
  readonly message: AssistantMessage;
  readonly toolCallerByContentIndex: ReadonlyMap<number, { readonly type: "direct" }>;
  readonly continuityByContentIndex: ReadonlyMap<
    number,
    LuckyTokenAnthropicContinuityEnvelopeV1
  >;
  readonly nativeThinkingIndexes: ReadonlySet<number>;
  readonly stop: {
    readonly reason: "end_turn" | "max_tokens" | "tool_use" | "refusal";
    readonly normalized: boolean;
  };
  readonly unavailable: {
    readonly textCitations: boolean;
    readonly responsePaths: readonly string[];
  };
}

type AnthropicStopReason = "end_turn" | "max_tokens" | "tool_use" | "refusal";

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
  let normalized = false;
  switch (message.api) {
    case "commandcode-private":
      if (raw === "stop") reason = "end_turn";
      else if (raw === "length") reason = "max_tokens";
      else if (raw === "tool-calls") reason = "tool_use";
      else {
        reason = fallbackStopReason(message);
        normalized = true;
      }
      break;
    case "anthropic-messages":
      if (raw === "stop_sequence") {
        reason = fallbackStopReason(message);
        normalized = true;
        break;
      }
      if (raw === "pause_turn") {
        throw new Error("Anthropic pause_turn lost its continuation state in Pi IR");
      }
      if (raw === "refusal") {
        reason = "refusal";
        break;
      }
      if (raw === "end_turn") reason = "end_turn";
      else if (raw === "max_tokens") reason = "max_tokens";
      else if (raw === "tool_use") reason = "tool_use";
      else {
        reason = fallbackStopReason(message);
        normalized = true;
      }
      break;
    case "bedrock-converse-stream":
      if (raw === "stop_sequence") {
        reason = fallbackStopReason(message);
        normalized = true;
        break;
      }
      if (raw === "end_turn") reason = "end_turn";
      else if (raw === "max_tokens" || raw === "model_context_window_exceeded") {
        reason = "max_tokens";
      } else if (raw === "tool_use") reason = "tool_use";
      else {
        reason = fallbackStopReason(message);
        normalized = true;
      }
      break;
    case "openai-completions":
      if (raw === "stop" || raw === "end") reason = "end_turn";
      else if (raw === "length") reason = "max_tokens";
      else if (raw === "function_call" || raw === "tool_calls") reason = "tool_use";
      else {
        reason = fallbackStopReason(message);
        normalized = true;
      }
      break;
    case "mistral-conversations":
      if (raw === "stop") reason = "end_turn";
      else if (raw === "length" || raw === "model_length") reason = "max_tokens";
      else if (raw === "tool_calls") reason = "tool_use";
      else {
        reason = fallbackStopReason(message);
        normalized = true;
      }
      break;
    case "google-generative-ai":
    case "google-vertex":
      if (raw === "STOP") reason = "end_turn";
      else if (raw === "MAX_TOKENS") reason = "max_tokens";
      else {
        reason = fallbackStopReason(message);
        normalized = true;
      }
      break;
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      if (raw === "completed") reason = "end_turn";
      else if (raw === "incomplete.max_output_tokens") reason = "max_tokens";
      else {
        reason = fallbackStopReason(message);
        normalized = true;
      }
      break;
    default:
      return { reason: fallbackStopReason(message), normalized: true };
  }

  const hasToolCall = message.content.some((block) => block.type === "toolCall");
  if (reason === "refusal" && hasToolCall) {
    throw new Error("Anthropic refusal terminal conflicts with Pi tool-call content");
  }
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
      normalized = true;
    } else {
      reason = "tool_use";
      normalized = true;
    }
  }
  const expectedPi = reason === "max_tokens"
    ? "length"
    : reason === "tool_use"
      ? "toolUse"
      : "stop";
  if (message.stopReason !== expectedPi) {
    reason = fallbackStopReason(message);
    normalized = true;
  }
  return {
    reason,
    normalized: normalized ||
      (message.api === "mistral-conversations" && raw === "model_length") ||
      (message.api === "bedrock-converse-stream" && raw === "model_context_window_exceeded"),
  };
}

function unavailableResponseFacts(message: AssistantMessage): {
  readonly textCitations: boolean;
  readonly responsePaths: readonly string[];
} {
  const refusalPaths = message.api === "anthropic-messages" &&
      message.rawStopReason === "refusal"
    ? ["$.stop_details"]
    : [];
  const api = message.api;
  if (api === "anthropic-messages") {
    return Object.freeze({
      textCitations: true,
      responsePaths: Object.freeze([
        "$.container",
        "$.usage.inference_geo",
        "$.usage.service_tier",
        ...refusalPaths,
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
  return message.api === "anthropic-messages";
}

const CONTINUITY_CERTIFIED_PI_APIS = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "google-generative-ai",
  "google-vertex",
  "pi-messages",
]);

/**
 * These Provider response grammars expose Pi `toolCall` only for ordinary
 * Client-declared functions. Anthropic Messages is deliberately absent: its
 * wire can attach a server caller to the same tool-use shape and Pi 0.84.2
 * discards that caller field.
 */
const DIRECT_TOOL_CALLER_CERTIFIED_PI_APIS = new Set([
  "commandcode-private",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "mistral-conversations",
  "google-generative-ai",
  "google-vertex",
  "bedrock-converse-stream",
  "pi-messages",
]);

function hasCertifiedBedrockContinuity(message: AssistantMessage): boolean {
  return message.api === "bedrock-converse-stream" &&
    message.provider === "amazon-bedrock" &&
    message.model === "us.anthropic.claude-sonnet-4-6";
}

function assertContinuityAttachmentCertified(
  message: AssistantMessage,
  contentIndex: number,
): void {
  if (
    CONTINUITY_CERTIFIED_PI_APIS.has(message.api) ||
    hasCertifiedBedrockContinuity(message)
  ) return;
  throw new Error(
    `Pi API ${message.api} continuity at content[${contentIndex}] is not certified by a pinned Provider-response parser fixture`,
  );
}

export function interpretAnthropicAssistantResponse(
  message: AssistantMessage,
  directToolNames: ReadonlySet<string>,
): AnthropicInterpretedResponse {
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
  const toolCallerByContentIndex = new Map<number, { readonly type: "direct" }>();
  message.content.forEach((block, index) => {
    const attachments: AnthropicContinuityAttachment[] = [];
    if (block.type === "thinking" && block.thinkingSignature !== undefined) {
      assertContinuityAttachmentCertified(message, index);
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
      assertContinuityAttachmentCertified(message, index);
      attachments.push({
        target: "text",
        kind: "opaque-signature",
        value: block.textSignature,
      });
    } else if (block.type === "toolCall" && block.thoughtSignature !== undefined) {
      assertContinuityAttachmentCertified(message, index);
      attachments.push({
        target: "toolCall",
        callId: block.id,
        kind: "opaque-signature",
        value: block.thoughtSignature,
      });
    }
    if (
      block.type === "toolCall" &&
      directToolNames.has(block.name) &&
      DIRECT_TOOL_CALLER_CERTIFIED_PI_APIS.has(message.api)
    ) {
      toolCallerByContentIndex.set(index, Object.freeze({ type: "direct" as const }));
    }
    const envelope = encodeAnthropicContinuity({ source, attachments });
    if (envelope !== undefined) continuityByContentIndex.set(index, envelope);
  });
  return Object.freeze({
    message,
    toolCallerByContentIndex,
    continuityByContentIndex,
    nativeThinkingIndexes,
    stop: Object.freeze(mapRawStopReason(message)),
    unavailable: unavailableResponseFacts(message),
  });
}
