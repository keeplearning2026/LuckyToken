import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
  Usage,
} from "@earendil-works/pi-ai";

import { InvalidRequest, UnsupportedFeature } from "./failures.js";

export interface AnthropicInvocation {
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
  systemPrompt?: string;
}

export const SYNTHETIC_CLIENT_HISTORY_API = "luckytoken-client-history";
export const SYNTHETIC_CLIENT_HISTORY_PROVIDER = "luckytoken-client";

const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

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
  for (const name of KNOWN_TOP_LEVEL_FIELDS) {
    if (
      !["model", "max_tokens", "messages", "stream", "system"].includes(name) &&
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
      if (block.source.type !== "base64") {
        unsupported.push(`unsupported image source: ${block.source.type}`);
        return;
      }
      if (
        typeof block.source.media_type !== "string" ||
        typeof block.source.data !== "string" ||
        !BASE64_PATTERN.test(block.source.data)
      ) {
        throw new InvalidRequest(
          "base64 images require a media_type and valid base64 data",
        );
      }
      if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(block.source.media_type)) {
        unsupported.push(`unsupported image media type: ${block.source.media_type}`);
      }
      if (
        Object.keys(block).some((name) => name !== "type" && name !== "source") ||
        Object.keys(block.source).some(
          (name) => !["type", "media_type", "data"].includes(name),
        )
      ) {
        unsupported.push("unknown image field");
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

function validateSystem(
  value: unknown,
  unsupported: string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    throw new InvalidRequest("system must be a string or block array when present");
  }
  let text: string | undefined;
  for (const block of value) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      throw new InvalidRequest("system blocks must be text blocks");
    }
    if (Object.keys(block).some((name) => name !== "type" && name !== "text")) {
      unsupported.push("unsupported system text extension");
    }
    if (text === undefined) text = block.text;
  }
  if (value.length !== 1) unsupported.push("multiple system blocks");
  return text;
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
  const systemPrompt = validateSystem(value.system, unsupported);
  if ((maxTokens as number) === 0) unsupported.push("max_tokens=0");

  if (unclassifiedAnthropicHeaders.length > 0) {
    throw new UnsupportedFeature(
      `Unclassified Anthropic header: ${unclassifiedAnthropicHeaders[0]}`,
    );
  }
  if (unsupported.length > 0) {
    throw new UnsupportedFeature(unsupported[0] ?? "Unsupported Anthropic semantic");
  }

  const validated: ValidatedAnthropicSourceRequest = {
    selector: model,
    maxTokens: maxTokens as number,
    messages: messageFacts.messages,
    hasImages: messageFacts.hasImages,
    finalAssistantPrefill:
      messageFacts.messages.at(-1)?.role === "assistant",
  };
  if (systemPrompt !== undefined) validated.systemPrompt = systemPrompt;
  return validated;
}

type CanonicalContent = TextContent | ImageContent;

interface CanonicalMessage {
  role: "user" | "assistant";
  content: CanonicalContent[];
}

function convertPortableBlock(block: Record<string, unknown>): CanonicalContent {
  if (block.type === "text") {
    return { type: "text", text: block.text as string };
  }
  const source = block.source as Record<string, unknown>;
  return {
    type: "image",
    mimeType: source.media_type as string,
    data: source.data as string,
  };
}

function canonicalizeMessages(
  messages: Array<Record<string, unknown>>,
): CanonicalMessage[] {
  const result: CanonicalMessage[] = [];
  for (const message of messages) {
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : (message.content as Array<Record<string, unknown>>).map(
            convertPortableBlock,
          );
    const role = message.role as "user" | "assistant";
    const previous = result.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else result.push({ role, content });
  }
  return result;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function convertHistoricalAssistant(
  message: CanonicalMessage,
  clientModel: string,
  receivedAt: number,
): AssistantMessage {
  const content: TextContent[] = message.content.map((block) => {
    if (block.type !== "text") {
      throw new UnsupportedFeature("Historical assistant images are unsupported");
    }
    return block;
  });
  return {
    role: "assistant",
    api: SYNTHETIC_CLIENT_HISTORY_API,
    provider: SYNTHETIC_CLIENT_HISTORY_PROVIDER,
    model: clientModel,
    content,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: receivedAt,
  };
}

export function convertValidatedAnthropicRequest(
  request: ValidatedAnthropicSourceRequest,
  receivedAt: number,
): AnthropicInvocation {
  if (request.finalAssistantPrefill) {
    throw new Error("Model-aware prefill validity must complete before conversion");
  }
  const messages: Message[] = canonicalizeMessages(request.messages).map(
    (message) =>
      message.role === "user"
        ? {
            role: "user",
            content: message.content,
            timestamp: receivedAt,
          }
        : convertHistoricalAssistant(message, request.selector, receivedAt),
  );

  const context: Context = { messages };
  if (request.systemPrompt !== undefined) {
    context.systemPrompt = request.systemPrompt;
  }

  return {
    selector: request.selector,
    context,
    maxTokens: request.maxTokens,
    renderState: { clientModel: request.selector },
  };
}

export function parseAnthropicTextInvocation(
  value: unknown,
  receivedAt: number,
  unclassifiedAnthropicHeaders: readonly string[] = [],
): AnthropicInvocation {
  return convertValidatedAnthropicRequest(
    validateAnthropicSourceRequest(value, unclassifiedAnthropicHeaders),
    receivedAt,
  );
}
