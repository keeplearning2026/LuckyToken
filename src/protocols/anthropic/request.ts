import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  ModelsSimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";

import { InvalidRequest, UnsupportedFeature } from "./failures.js";
import {
  convertAnthropicTools,
  validateAnthropicTools,
  type ValidatedAnthropicTool,
} from "./tools.js";

export interface AnthropicInvocation {
  selector: string;
  context: Context;
  options: ModelsSimpleStreamOptions;
  renderState: {
    clientModel: string;
    stream: boolean;
  };
}

export interface ValidatedAnthropicSourceRequest {
  selector: string;
  maxTokens: number;
  reasoning?: "low" | "medium" | "high" | "xhigh" | "max";
  messages: Array<Record<string, unknown>>;
  hasImages: boolean;
  hasThinking: boolean;
  finalAssistantPrefill: boolean;
  stream: boolean;
  temperature?: number;
  metadataUserId?: string;
  systemPrompt?: string;
  tools?: ValidatedAnthropicTool[];
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
      ![
        "model",
        "max_tokens",
        "messages",
        "stream",
        "system",
        "tools",
        "temperature",
        "metadata",
        "output_config",
      ].includes(name) &&
      value[name] !== undefined
    ) {
      unsupported.push(`unsupported top-level field: ${name}`);
    }
  }
}

function validateContentBlock(
  block: unknown,
  unsupported: string[],
  facts: { hasImages: boolean; hasThinking: boolean },
  role: "user" | "assistant",
): void {
  if (!isRecord(block) || typeof block.type !== "string") {
    throw new InvalidRequest("message content blocks must be tagged objects");
  }
  switch (block.type) {
    case "text":
      if (typeof block.text !== "string") {
        throw new InvalidRequest("text blocks require string text");
      }
      if (block.citations !== undefined) {
        if (role !== "assistant" || block.citations !== null) {
          unsupported.push("unsupported text citations");
        }
      }
      if (
        Object.keys(block).some(
          (name) => !["type", "text", "citations"].includes(name),
        )
      ) {
        unsupported.push("unknown text block field");
      }
      return;
    case "thinking":
      if (
        typeof block.thinking !== "string" ||
        typeof block.signature !== "string"
      ) {
        throw new InvalidRequest(
          "thinking blocks require string thinking and signature fields",
        );
      }
      if (role !== "assistant") {
        throw new InvalidRequest("thinking is valid only in an assistant turn");
      }
      if (
        Object.keys(block).some(
          (name) => !["type", "thinking", "signature"].includes(name),
        )
      ) {
        unsupported.push("unknown thinking block field");
      }
      facts.hasThinking = true;
      return;
    case "redacted_thinking":
      if (typeof block.data !== "string") {
        throw new InvalidRequest("redacted_thinking requires string data");
      }
      if (role !== "assistant") {
        throw new InvalidRequest(
          "redacted_thinking is valid only in an assistant turn",
        );
      }
      if (Object.keys(block).some((name) => !["type", "data"].includes(name))) {
        unsupported.push("unknown redacted_thinking block field");
      }
      unsupported.push("redacted thinking");
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
        block.id.length === 0 ||
        typeof block.name !== "string" ||
        block.name.length === 0 ||
        !isRecord(block.input)
      ) {
        throw new InvalidRequest(
          "tool_use requires non-empty id and name strings and object input",
        );
      }
      if (block.caller !== undefined) {
        if (!isRecord(block.caller) || typeof block.caller.type !== "string") {
          throw new InvalidRequest("tool_use.caller must be a tagged object");
        }
        if (block.caller.type !== "direct") {
          unsupported.push(`unsupported tool_use caller: ${block.caller.type}`);
        }
        if (Object.keys(block.caller).some((name) => name !== "type")) {
          unsupported.push("unknown tool_use caller field");
        }
      }
      if (
        Object.keys(block).some(
          (name) => !["type", "id", "name", "input", "caller"].includes(name),
        )
      ) {
        unsupported.push("unknown tool_use field");
      }
      return;
    case "tool_result": {
      if (
        typeof block.tool_use_id !== "string" ||
        block.tool_use_id.length === 0
      ) {
        throw new InvalidRequest("tool_result requires a non-empty tool_use_id");
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
      if (typeof content === "string") {
        // Doc §4.2: string tool_result content converts to a single TextContent.
      } else if (Array.isArray(content)) {
        for (const nestedBlock of content) {
          if (
            !isRecord(nestedBlock) ||
            (nestedBlock.type !== "text" && nestedBlock.type !== "image")
          ) {
            throw new InvalidRequest(
              "tool_result block-list content supports text and image blocks only",
            );
          }
          validateContentBlock(nestedBlock, unsupported, facts, "user");
        }
      }
      if (
        Object.keys(block).some(
          (name) =>
            !["type", "tool_use_id", "content", "is_error"].includes(name),
        )
      ) {
        unsupported.push("unknown tool_result field");
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
  const texts: string[] = [];
  for (const block of value) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      throw new InvalidRequest("system blocks must be text blocks");
    }
    if (Object.keys(block).some((name) => name !== "type" && name !== "text")) {
      unsupported.push("unsupported system text extension");
    }
    texts.push(block.text);
  }
  return texts.join("\n");
}

const ANTHROPIC_EFFORT_TO_REASONING = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function validateOutputConfig(
  value: unknown,
  unsupported: string[],
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new InvalidRequest("output_config must be an object when present");
  }
  for (const key of Object.keys(value)) {
    if (key !== "effort") unsupported.push(`unsupported output_config field: ${key}`);
  }
  const effort = value.effort;
  if (effort === undefined) return undefined;
  if (typeof effort !== "string" || !ANTHROPIC_EFFORT_TO_REASONING.has(effort)) {
    unsupported.push(`unsupported output_config.effort: ${String(effort)}`);
    return undefined;
  }
  return effort as "low" | "medium" | "high" | "xhigh" | "max";
}

function validateMetadata(
  value: unknown,
  unsupported: string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new InvalidRequest("metadata must be an object when present");
  }
  for (const key of Object.keys(value)) {
    if (key !== "user_id") unsupported.push(`unsupported metadata field: ${key}`);
  }
  if (value.user_id === undefined) return undefined;
  if (typeof value.user_id !== "string") {
    throw new InvalidRequest("metadata.user_id must be a string when present");
  }
  return value.user_id;
}

function validateMessages(
  messages: unknown,
  unsupported: string[],
): {
  messages: Array<Record<string, unknown>>;
  hasImages: boolean;
  hasThinking: boolean;
} {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new InvalidRequest("messages must be a non-empty array");
  }
  const facts = { hasImages: false, hasThinking: false };
  const normalized: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (
      !isRecord(message) ||
      (message.role !== "user" &&
        message.role !== "assistant" &&
        message.role !== "system")
    ) {
      throw new InvalidRequest(
        "messages require a user, assistant, or system role",
      );
    }
    if (Object.keys(message).some((name) => name !== "role" && name !== "content")) {
      unsupported.push("unknown message field");
    }
    const normalizedRole: "user" | "assistant" =
      message.role === "system" ? "user" : (message.role as "user" | "assistant");
    if (typeof message.content === "string") {
      normalized.push({ role: normalizedRole, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) {
      throw new InvalidRequest("message.content must be a string or block array");
    }
    if (message.content.length === 0) {
      unsupported.push("explicit empty ordinary message content array");
    }
    for (const block of message.content) {
      validateContentBlock(
        block,
        unsupported,
        facts,
        normalizedRole,
      );
    }
    normalized.push({ role: normalizedRole, content: message.content });
  }
  return {
    messages: normalized,
    hasImages: facts.hasImages,
    hasThinking: facts.hasThinking,
  };
}

interface SourceTurn {
  role: "user" | "assistant";
  content: Array<Record<string, unknown>>;
}

function sourceTurns(messages: Array<Record<string, unknown>>): SourceTurn[] {
  const turns: SourceTurn[] = [];
  for (const message of messages) {
    const content =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : (message.content as Array<Record<string, unknown>>);
    const role = message.role as SourceTurn["role"];
    const previous = turns.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else turns.push({ role, content: [...content] });
  }
  return turns;
}

function validateToolTurnLifecycle(
  messages: Array<Record<string, unknown>>,
): void {
  let pending: Map<string, string> | undefined;

  for (const turn of sourceTurns(messages)) {
    if (turn.role === "assistant") {
      if (pending !== undefined && pending.size > 0) {
        throw new InvalidRequest(
          "Every tool_use must be resolved in the immediately following user turn",
        );
      }
      const calls = new Map<string, string>();
      for (const block of turn.content) {
        if (block.type === "tool_result") {
          throw new InvalidRequest("tool_result is not valid in an assistant turn");
        }
        if (block.type !== "tool_use") continue;
        const id = block.id as string;
        if (calls.has(id)) {
          throw new InvalidRequest(`Duplicate tool_use id in one turn: ${id}`);
        }
        calls.set(id, block.name as string);
      }
      pending = calls.size === 0 ? undefined : calls;
      continue;
    }

    let sawOrdinaryContent = false;
    for (const block of turn.content) {
      if (block.type === "tool_use") {
        throw new InvalidRequest("tool_use is not valid in a user turn");
      }
      if (block.type !== "tool_result") {
        sawOrdinaryContent = true;
        continue;
      }
      if (sawOrdinaryContent) {
        throw new InvalidRequest(
          "tool_result blocks must precede ordinary user content",
        );
      }
      const id = block.tool_use_id as string;
      if (pending === undefined || !pending.has(id)) {
        throw new InvalidRequest(`Orphan or duplicate tool_result id: ${id}`);
      }
      pending.delete(id);
    }
    if (pending !== undefined && pending.size > 0) {
      throw new InvalidRequest(
        "Every tool_use must be resolved in the immediately following user turn",
      );
    }
    pending = undefined;
  }

  if (pending !== undefined && pending.size > 0) {
    throw new InvalidRequest("The final assistant tool turn has unresolved tool_use IDs");
  }
}

export function validateAnthropicSourceRequest(
  value: unknown,
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
  validateToolTurnLifecycle(messageFacts.messages);
  const tools = validateAnthropicTools(value.tools, unsupported);
  const systemPrompt = validateSystem(value.system, unsupported);
  const metadataUserId = validateMetadata(value.metadata, unsupported);
  const reasoning = validateOutputConfig(value.output_config, unsupported);

  if (unsupported.length > 0) {
    throw new UnsupportedFeature(unsupported[0] ?? "Unsupported Anthropic semantic");
  }

  const validated: ValidatedAnthropicSourceRequest = {
    selector: model,
    maxTokens: maxTokens as number,
    messages: messageFacts.messages,
    hasImages: messageFacts.hasImages,
    hasThinking: messageFacts.hasThinking,
    stream: value.stream === true,
    finalAssistantPrefill:
      messageFacts.messages.at(-1)?.role === "assistant",
  };
  if (reasoning !== undefined) validated.reasoning = reasoning;
  if (systemPrompt !== undefined) validated.systemPrompt = systemPrompt;
  if (tools !== undefined) validated.tools = tools;
  if (value.temperature !== undefined) {
    validated.temperature = value.temperature as number;
  }
  if (metadataUserId !== undefined) validated.metadataUserId = metadataUserId;
  return validated;
}

interface CanonicalToolUse {
  type: "toolUse";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface CanonicalToolResult {
  type: "toolResult";
  toolUseId: string;
  content: Array<TextContent | ImageContent>;
  isError: boolean;
}

type CanonicalContent =
  | TextContent
  | ThinkingContent
  | ImageContent
  | CanonicalToolUse
  | CanonicalToolResult;

interface CanonicalMessage {
  role: "user" | "assistant";
  content: CanonicalContent[];
}

function convertPortableBlock(block: Record<string, unknown>): CanonicalContent {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text as string };
    case "thinking": {
      const signature = block.signature as string;
      return {
        type: "thinking",
        thinking: block.thinking as string,
        ...(signature.length > 0 ? { thinkingSignature: signature } : {}),
      };
    }
    case "image": {
      const source = block.source as Record<string, unknown>;
      return {
        type: "image",
        mimeType: source.media_type as string,
        data: source.data as string,
      };
    }
    case "tool_use":
      return {
        type: "toolUse",
        id: block.id as string,
        name: block.name as string,
        input: block.input as Record<string, unknown>,
      };
    case "tool_result": {
      const rawContent = block.content;
      if (rawContent === undefined) {
        return {
          type: "toolResult",
          toolUseId: block.tool_use_id as string,
          content: [],
          isError: block.is_error === true,
        };
      }
      if (typeof rawContent === "string") {
        return {
          type: "toolResult",
          toolUseId: block.tool_use_id as string,
          content: [{ type: "text", text: rawContent }],
          isError: block.is_error === true,
        };
      }
      if (!Array.isArray(rawContent)) {
        throw new Error("Unsupported tool_result content reached conversion");
      }
      const content = rawContent.map((nestedBlock) => {
        const converted = convertPortableBlock(nestedBlock as Record<string, unknown>);
        if (converted.type !== "text" && converted.type !== "image") {
          throw new Error("Invalid nested tool_result content reached conversion");
        }
        return converted;
      });
      return {
        type: "toolResult",
        toolUseId: block.tool_use_id as string,
        content,
        isError: block.is_error === true,
      };
    }
    default:
      throw new Error("Unsupported source block reached conversion");
  }
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
  const content: Array<TextContent | ThinkingContent | ToolCall> =
    message.content.map((block) => {
      if (block.type === "text" || block.type === "thinking") return block;
      if (block.type === "toolUse") {
        return {
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: block.input,
        };
      }
      if (block.type === "image") {
        throw new UnsupportedFeature(
          "Historical assistant images are unsupported",
        );
      }
      throw new Error("tool_result reached an assistant conversion invariant");
    });
  return {
    role: "assistant",
    api: SYNTHETIC_CLIENT_HISTORY_API,
    provider: SYNTHETIC_CLIENT_HISTORY_PROVIDER,
    model: clientModel,
    content,
    usage: emptyUsage(),
    stopReason: content.some((block) => block.type === "toolCall")
      ? "toolUse"
      : "stop",
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
  const messages: Message[] = [];
  let pending = new Map<string, string>();

  for (const message of canonicalizeMessages(request.messages)) {
    if (message.role === "assistant") {
      const assistant = convertHistoricalAssistant(
        message,
        request.selector,
        receivedAt,
      );
      messages.push(assistant);
      pending = new Map(
        assistant.content
          .filter((block): block is ToolCall => block.type === "toolCall")
          .map((block) => [block.id, block.name]),
      );
      continue;
    }

    const ordinary: Array<TextContent | ImageContent> = [];
    for (const block of message.content) {
      if (block.type === "toolResult") {
        const toolName = pending.get(block.toolUseId);
        if (toolName === undefined) {
          throw new Error("Validated tool_result correlation was lost");
        }
        const result: ToolResultMessage = {
          role: "toolResult",
          toolCallId: block.toolUseId,
          toolName,
          content: block.content,
          isError: block.isError,
          timestamp: receivedAt,
        };
        messages.push(result);
        pending.delete(block.toolUseId);
      } else if (block.type === "toolUse") {
        throw new Error("tool_use reached a user conversion invariant");
      } else if (block.type === "thinking") {
        throw new Error("thinking reached a user conversion invariant");
      } else {
        ordinary.push(block);
      }
    }
    if (ordinary.length > 0) {
      messages.push({ role: "user", content: ordinary, timestamp: receivedAt });
    }
  }

  const context: Context = { messages };
  if (request.systemPrompt !== undefined) {
    context.systemPrompt = request.systemPrompt;
  }
  const tools = convertAnthropicTools(request.tools);
  if (tools !== undefined) context.tools = tools;

  const options: ModelsSimpleStreamOptions = { maxTokens: request.maxTokens };
  if (request.temperature !== undefined) {
    options.temperature = request.temperature;
  }
  if (request.reasoning !== undefined) {
    options.reasoning = request.reasoning;
  }
  if (request.metadataUserId !== undefined) {
    options.metadata = { user_id: request.metadataUserId };
  }

  return {
    selector: request.selector,
    context,
    options,
    renderState: { clientModel: request.selector, stream: request.stream },
  };
}

export function parseAnthropicTextInvocation(
  value: unknown,
  receivedAt: number,
): AnthropicInvocation {
  return convertValidatedAnthropicRequest(
    validateAnthropicSourceRequest(value),
    receivedAt,
  );
}
