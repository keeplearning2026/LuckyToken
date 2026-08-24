import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { ResponsesReasoningSource } from "./contract.js";

export type ResponsesContinuityValue =
  | {
      readonly kind: "opaque-signature";
      readonly value: string;
      readonly representation?: "redacted";
    }
  | {
      readonly kind: "reasoning-field-selector";
      readonly value: string;
    }
  | {
      readonly kind: "responses-reasoning-item";
      readonly value: string;
    };

export type ResponsesContinuityBlock =
  | {
      readonly target: "thinking" | "text";
      readonly contentIndex: number;
      readonly source: ResponsesReasoningSource;
      readonly continuity?: ResponsesContinuityValue;
    }
  | {
      readonly target: "toolCall";
      readonly contentIndex: number;
      readonly callId: string;
      readonly source: ResponsesReasoningSource;
      readonly continuity?: ResponsesContinuityValue;
    };

export interface ResponsesReasoningResponseExtraction {
  readonly source: ResponsesReasoningSource;
  readonly blocks: readonly ResponsesContinuityBlock[];
}

const RESPONSES_APIS = new Set([
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);
const OPAQUE_THINKING_APIS = new Set([
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
  "pi-messages",
]);
const OPAQUE_TEXT_APIS = new Set([
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "google-generative-ai",
  "google-vertex",
  "pi-messages",
]);
const OPAQUE_TOOL_APIS = new Set([
  "openai-completions",
  "google-generative-ai",
  "google-vertex",
  "pi-messages",
]);
const REASONING_SELECTORS = new Set([
  "reasoning_content",
  "reasoning",
  "reasoning_text",
]);

function sourceOf(message: AssistantMessage): ResponsesReasoningSource {
  return Object.freeze({
    provider: message.provider,
    api: message.api,
    model: message.model,
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeReasoningParts(
  value: unknown,
  type: "summary_text" | "reasoning_text",
): readonly Readonly<{ type: string; text: string }>[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every(
      (part) =>
        isRecord(part) && part.type === type && typeof part.text === "string",
    )
  ) {
    return undefined;
  }
  return Object.freeze(
    value.map((part) =>
      Object.freeze({ type, text: (part as Record<string, unknown>).text as string }),
    ),
  );
}

export function normalizeResponsesReasoningItem(
  value: string,
): Readonly<Record<string, unknown>> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.type !== "reasoning") return undefined;
  if (
    typeof parsed.id !== "string" ||
    parsed.id.length === 0 ||
    typeof parsed.encrypted_content !== "string" ||
    parsed.encrypted_content.length === 0
  ) {
    return undefined;
  }
  const summary = normalizeReasoningParts(parsed.summary, "summary_text");
  const content = normalizeReasoningParts(parsed.content, "reasoning_text");
  if (parsed.summary !== undefined && summary === undefined) return undefined;
  if (parsed.content !== undefined && content === undefined) return undefined;
  if (
    parsed.status !== undefined &&
    parsed.status !== "completed" &&
    parsed.status !== "incomplete"
  ) {
    return undefined;
  }
  return Object.freeze({
    type: "reasoning",
    id: parsed.id,
    ...(parsed.status === undefined ? {} : { status: parsed.status }),
    ...(summary === undefined ? {} : { summary }),
    ...(content === undefined ? {} : { content }),
    encrypted_content: parsed.encrypted_content,
  });
}

function isJsonObject(value: string): boolean {
  try {
    return isRecord(JSON.parse(value));
  } catch {
    return false;
  }
}

export function extractResponsesReasoning(
  message: AssistantMessage,
): ResponsesReasoningResponseExtraction {
  const source = sourceOf(message);
  const blocks: ResponsesContinuityBlock[] = [];
  for (const [contentIndex, block] of message.content.entries()) {
    if (block.type === "thinking") {
      let continuity: ResponsesContinuityValue | undefined;
      if (
        RESPONSES_APIS.has(source.api) &&
        typeof block.thinkingSignature === "string"
      ) {
        const item = normalizeResponsesReasoningItem(block.thinkingSignature);
        if (item !== undefined) {
          continuity = Object.freeze({
            kind: "responses-reasoning-item",
            value: JSON.stringify(item),
          });
        }
      } else if (
        source.api === "openai-completions" &&
        typeof block.thinkingSignature === "string" &&
        REASONING_SELECTORS.has(block.thinkingSignature)
      ) {
        continuity = Object.freeze({
          kind: "reasoning-field-selector",
          value: block.thinkingSignature,
        });
      } else if (
        OPAQUE_THINKING_APIS.has(source.api) &&
        typeof block.thinkingSignature === "string" &&
        block.thinkingSignature.length > 0
      ) {
        continuity = Object.freeze({
          kind: "opaque-signature",
          value: block.thinkingSignature,
          ...(block.redacted === true
            ? { representation: "redacted" as const }
            : {}),
        });
      }
      blocks.push(
        Object.freeze({
          target: "thinking",
          contentIndex,
          source,
          ...(continuity === undefined ? {} : { continuity }),
        }),
      );
      continue;
    }
    if (
      block.type === "text" &&
      OPAQUE_TEXT_APIS.has(source.api) &&
      typeof block.textSignature === "string" &&
      block.textSignature.length > 0
    ) {
      blocks.push(
        Object.freeze({
          target: "text",
          contentIndex,
          source,
          continuity: Object.freeze({
            kind: "opaque-signature",
            value: block.textSignature,
          }),
        }),
      );
      continue;
    }
    if (
      block.type === "toolCall" &&
      OPAQUE_TOOL_APIS.has(source.api) &&
      typeof block.thoughtSignature === "string" &&
      block.thoughtSignature.length > 0 &&
      (source.api !== "openai-completions" ||
        isJsonObject(block.thoughtSignature))
    ) {
      blocks.push(
        Object.freeze({
          target: "toolCall",
          contentIndex,
          callId: block.id,
          source,
          continuity: Object.freeze({
            kind: "opaque-signature",
            value: block.thoughtSignature,
          }),
        }),
      );
    }
  }
  return Object.freeze({ source, blocks: Object.freeze(blocks) });
}
