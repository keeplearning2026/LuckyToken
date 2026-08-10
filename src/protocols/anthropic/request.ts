import type { Context } from "@earendil-works/pi-ai";

import { InvalidRequest, UnsupportedFeature } from "./failures.js";

export interface AnthropicTextInvocation {
  selector: string;
  context: Context;
  maxTokens: number;
  renderState: {
    clientModel: string;
  };
}

export interface ValidatedAnthropicSourceRequest {
  selector: string;
  maxTokens: number;
  messages: Array<Record<string, unknown>>;
  hasImages: boolean;
  finalAssistantPrefill: boolean;
}

const KNOWN_TOP_LEVEL_FIELDS = new Set([
  "model",
  "max_tokens",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
  "stop_sequences",
  "temperature",
  "top_p",
  "top_k",
  "stream",
  "cache_control",
  "container",
  "inference_geo",
  "service_tier",
  "metadata",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateOptionalFieldShapes(
  value: Record<string, unknown>,
  unsupported: string[],
): void {
  const arrayFields = ["tools", "stop_sequences"] as const;
  for (const name of arrayFields) {
    if (value[name] !== undefined && !Array.isArray(value[name])) {
      throw new InvalidRequest(`${name} must be an array when present`);
    }
  }
  const objectFields = [
    "tool_choice",
    "thinking",
    "output_config",
    "cache_control",
    "metadata",
  ] as const;
  for (const name of objectFields) {
    if (value[name] !== undefined && !isRecord(value[name])) {
      throw new InvalidRequest(`${name} must be an object when present`);
    }
  }
  const numericFields = ["temperature", "top_p"] as const;
  for (const name of numericFields) {
    if (
      value[name] !== undefined &&
      (typeof value[name] !== "number" || !Number.isFinite(value[name]))
    ) {
      throw new InvalidRequest(`${name} must be a finite number when present`);
    }
  }
  if (
    value.top_k !== undefined &&
    (!Number.isSafeInteger(value.top_k) || (value.top_k as number) < 0)
  ) {
    throw new InvalidRequest("top_k must be a non-negative safe integer");
  }
  if (value.stream !== undefined && typeof value.stream !== "boolean") {
    throw new InvalidRequest("stream must be boolean when present");
  }
  for (const name of ["container", "inference_geo", "service_tier"] as const) {
    if (value[name] !== undefined && typeof value[name] !== "string") {
      throw new InvalidRequest(`${name} must be a string when present`);
    }
  }
  if (
    value.system !== undefined &&
    typeof value.system !== "string" &&
    !Array.isArray(value.system)
  ) {
    throw new InvalidRequest("system must be a string or block array when present");
  }

  for (const name of KNOWN_TOP_LEVEL_FIELDS) {
    if (
      !["model", "max_tokens", "messages", "stream"].includes(name) &&
      value[name] !== undefined
    ) {
      unsupported.push(`unsupported top-level field: ${name}`);
    }
  }
  if (value.stream === true) unsupported.push("stream=true rendering");
}

function validateContentBlock(
  block: unknown,
  unsupported: string[],
  facts: { hasImages: boolean },
): void {
  if (!isRecord(block) || typeof block.type !== "string") {
    throw new InvalidRequest("message content blocks must be tagged objects");
  }
  switch (block.type) {
    case "text":
      if (typeof block.text !== "string") {
        throw new InvalidRequest("text blocks require string text");
      }
      if (Object.keys(block).some((name) => name !== "type" && name !== "text")) {
        unsupported.push("unknown text block field");
      }
      return;
    case "image":
      if (!isRecord(block.source) || typeof block.source.type !== "string") {
        throw new InvalidRequest("image blocks require a source object");
      }
      facts.hasImages = true;
      return;
    case "tool_use":
      if (
        typeof block.id !== "string" ||
        typeof block.name !== "string" ||
        !isRecord(block.input)
      ) {
        throw new InvalidRequest("tool_use requires id, name, and object input");
      }
      unsupported.push("tool_use content");
      return;
    case "tool_result": {
      if (typeof block.tool_use_id !== "string") {
        throw new InvalidRequest("tool_result requires tool_use_id");
      }
      if (block.is_error !== undefined && typeof block.is_error !== "boolean") {
        throw new InvalidRequest("tool_result.is_error must be boolean");
      }
      const content = block.content;
      if (
        content !== undefined &&
        typeof content !== "string" &&
        !Array.isArray(content)
      ) {
        throw new InvalidRequest("tool_result.content has an invalid shape");
      }
      if (Array.isArray(content) && content.length === 0) {
        unsupported.push("explicit empty tool_result content array");
      } else {
        unsupported.push("tool_result content");
      }
      return;
    }
    default:
      unsupported.push(`unknown content block: ${block.type}`);
  }
}

function validateMessages(
  messages: unknown,
  unsupported: string[],
): { messages: Array<Record<string, unknown>>; hasImages: boolean } {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new InvalidRequest("messages must be a non-empty array");
  }
  const facts = { hasImages: false };
  for (const message of messages) {
    if (
      !isRecord(message) ||
      (message.role !== "user" && message.role !== "assistant")
    ) {
      throw new InvalidRequest("messages require a user or assistant role");
    }
    if (Object.keys(message).some((name) => name !== "role" && name !== "content")) {
      unsupported.push("unknown message field");
    }
    if (typeof message.content === "string") continue;
    if (!Array.isArray(message.content)) {
      throw new InvalidRequest("message.content must be a string or block array");
    }
    if (message.content.length === 0) {
      unsupported.push("explicit empty ordinary message content array");
    }
    for (const block of message.content) {
      validateContentBlock(block, unsupported, facts);
    }
  }
  return { messages, hasImages: facts.hasImages };
}

export function validateAnthropicSourceRequest(
  value: unknown,
  unclassifiedAnthropicHeaders: readonly string[] = [],
): ValidatedAnthropicSourceRequest {
  if (!isRecord(value)) {
    throw new InvalidRequest("Request body must be a JSON object");
  }

  const { model, max_tokens: maxTokens, messages } = value;
  if (typeof model !== "string" || model.length === 0) {
    throw new InvalidRequest("model must be a non-empty string");
  }
  if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) < 0) {
    throw new InvalidRequest("max_tokens must be a non-negative safe integer");
  }

  const unsupported: string[] = [];
  for (const name of Object.keys(value)) {
    if (!KNOWN_TOP_LEVEL_FIELDS.has(name)) unsupported.push(`unknown body field: ${name}`);
  }
  validateOptionalFieldShapes(value, unsupported);
  const messageFacts = validateMessages(messages, unsupported);
  if ((maxTokens as number) === 0) unsupported.push("max_tokens=0");

  if (unclassifiedAnthropicHeaders.length > 0) {
    throw new UnsupportedFeature(
      `Unclassified Anthropic header: ${unclassifiedAnthropicHeaders[0]}`,
    );
  }
  if (unsupported.length > 0) {
    throw new UnsupportedFeature(unsupported[0] ?? "Unsupported Anthropic semantic");
  }

  return {
    selector: model,
    maxTokens: maxTokens as number,
    messages: messageFacts.messages,
    hasImages: messageFacts.hasImages,
    finalAssistantPrefill:
      messageFacts.messages.at(-1)?.role === "assistant",
  };
}

export function convertValidatedAnthropicTextRequest(
  request: ValidatedAnthropicSourceRequest,
  receivedAt: number,
): AnthropicTextInvocation {
  const { messages } = request;
  if (
    messages.length !== 1 ||
    messages[0]?.role !== "user" ||
    typeof messages[0].content !== "string"
  ) {
    throw new UnsupportedFeature("The current route supports one string user message");
  }

  return {
    selector: request.selector,
    context: {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: messages[0].content }],
          timestamp: receivedAt,
        },
      ],
    },
    maxTokens: request.maxTokens,
    renderState: { clientModel: request.selector },
  };
}

export function parseAnthropicTextInvocation(
  value: unknown,
  receivedAt: number,
  unclassifiedAnthropicHeaders: readonly string[] = [],
): AnthropicTextInvocation {
  return convertValidatedAnthropicTextRequest(
    validateAnthropicSourceRequest(value, unclassifiedAnthropicHeaders),
    receivedAt,
  );
}
