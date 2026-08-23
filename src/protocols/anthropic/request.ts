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

import type { ConversionNotice } from "@luckytoken/provider-contract/diagnostics";
import { InvalidRequest, UnsupportedFeature } from "./failures.js";
import {
  convertAnthropicTools,
  validateAnthropicTools,
  type ValidatedAnthropicTool,
} from "./tools.js";

export interface AnthropicRequestRenderState {
  readonly selector: string;
  readonly stream: boolean;
}

export interface AnthropicRequestConversion {
  readonly selector: string;
  readonly context: Context;
  readonly options: Partial<ModelsSimpleStreamOptions>;
  readonly renderState: AnthropicRequestRenderState;
  readonly notices: readonly ConversionNotice[];
}

export interface AnthropicRequestConversionPolicy {
  readonly unknownContent: "error" | "ignore";
  readonly unresolvedToolCall: "error" | "xrepair";
  readonly localCacheControl: "ignore" | "promote";
}

export interface AnthropicRequestConversionInput {
  readonly request: unknown;
  readonly receivedAt: number;
  readonly policy: AnthropicRequestConversionPolicy;
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
  topP?: number;
  topK?: number;
  metadataUserId?: string;
  systemPrompt?: string;
  tools?: ValidatedAnthropicTool[];
  thinkingBudget?: number;
  cacheControl?: { ttl?: "5m" | "1h" };
}

export const SYNTHETIC_CLIENT_HISTORY_API = "luckytoken-client-history";
export const SYNTHETIC_CLIENT_HISTORY_PROVIDER = "luckytoken-client";

export const XREPAIR_NOTICE_CODE = "anthropic_unresolved_tool_call_xrepair";
export const PREFILL_DEGRADED_NOTICE_CODE =
  "anthropic_assistant_prefill_degraded_to_history";
export const THINKING_SIGNATURE_NOTICE_CODE =
  "anthropic_missing_thinking_signature";
export const LOCAL_CACHE_PROMOTED_NOTICE_CODE =
  "anthropic_local_cache_promoted";
export const UNKNOWN_CONTENT_IGNORED_NOTICE_CODE =
  "anthropic_unknown_content_ignored";

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const ANTHROPIC_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

const SERVER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "web_search",
  "web_fetch",
  "code_execution",
  "bash_code_execution",
  "text_editor_code_execution",
  "tool_search_tool_regex",
  "tool_search_tool_bm25",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestNotice(
  code: string,
  action: ConversionNotice["action"],
  jsonPath?: string,
): ConversionNotice {
  return Object.freeze({
    adapter: "anthropic-messages",
    direction: "request",
    code,
    ...(jsonPath === undefined ? {} : { jsonPath }),
    action,
  });
}

function validateOptionalFieldShapes(value: Record<string, unknown>): void {
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
    if (
      value[name] !== undefined &&
      value[name] !== null &&
      typeof value[name] !== "string"
    ) {
      throw new InvalidRequest(`${name} must be a string when present`);
    }
  }
}

function validateSystem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    throw new InvalidRequest("system must be a string or block array when present");
  }
  const texts: string[] = [];
  for (const block of value) {
    if (
      !isRecord(block) ||
      block.type !== "text" ||
      typeof block.text !== "string"
    ) {
      throw new InvalidRequest("system blocks must be text blocks");
    }
    texts.push(block.text);
  }
  return texts.join("\n");
}

function validateOutputConfig(
  value: unknown,
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new InvalidRequest("output_config must be an object when present");
  }
  const effort = value.effort;
  if (effort === undefined || effort === null) return undefined;
  if (typeof effort !== "string") {
    throw new InvalidRequest("output_config.effort must be a string when present");
  }
  if (!ANTHROPIC_EFFORTS.has(effort)) return undefined;
  return effort as "low" | "medium" | "high" | "xhigh" | "max";
}

function validateMetadata(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new InvalidRequest("metadata must be an object when present");
  }
  if (value.user_id === undefined || value.user_id === null) return undefined;
  if (typeof value.user_id !== "string") {
    throw new InvalidRequest("metadata.user_id must be a string when present");
  }
  return value.user_id;
}

function validateThinking(
  value: unknown,
): { budget?: number; dropped: boolean } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new InvalidRequest("thinking must be an object when present");
  }
  const type = value.type;
  if (typeof type !== "string") {
    throw new InvalidRequest("thinking.type must be a string");
  }
  if (type === "enabled") {
    if (
      !Number.isSafeInteger(value.budget_tokens) ||
      (value.budget_tokens as number) < 1_024 ||
      (value.budget_tokens as number) >= 2_147_483_647
    ) {
      throw new InvalidRequest(
        "thinking.enabled.budget_tokens must be an integer from 1024 upward",
      );
    }
    return { budget: value.budget_tokens as number, dropped: false };
  }
  if (type === "disabled" || type === "adaptive") {
    return { dropped: true };
  }
  throw new InvalidRequest(`thinking.type is not supported: ${type}`);
}

function validateCacheControl(
  value: unknown,
): { ttl?: "5m" | "1h" } | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new InvalidRequest("cache_control must be an object when present");
  }
  if (value.type !== undefined && value.type !== "ephemeral") {
    throw new InvalidRequest("cache_control.type must be ephemeral");
  }
  const ttl = value.ttl;
  if (ttl === undefined) return {};
  if (ttl !== "5m" && ttl !== "1h") {
    throw new InvalidRequest("cache_control.ttl must be 5m or 1h");
  }
  return { ttl };
}

function validateMessages(
  messages: unknown,
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
    if (typeof message.content === "string") {
      normalized.push({ role: message.role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) {
      throw new InvalidRequest("message.content must be a string or block array");
    }
    const assistantCallIds = new Set<string>();
    const isAssistantTurn = message.role === "assistant";
    for (const block of message.content) {
      const role: "user" | "assistant" =
        message.role === "system" ? "user" : message.role;
      validateContentBlock(block, facts, role);
      if (isAssistantTurn && isRecord(block) && block.type === "tool_use") {
        const id = block.id as string;
        if (assistantCallIds.has(id)) {
          throw new InvalidRequest(`Duplicate tool_use id in one turn: ${id}`);
        }
        assistantCallIds.add(id);
      }
    }
    normalized.push({ role: message.role, content: message.content });
  }
  return {
    messages: normalized,
    hasImages: facts.hasImages,
    hasThinking: facts.hasThinking,
  };
}

function validateContentBlock(
  block: unknown,
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
      facts.hasThinking = true;
      return;
    case "image":
      if (!isRecord(block.source) || typeof block.source.type !== "string") {
        throw new InvalidRequest("image blocks require a source object");
      }
      if (block.source.type !== "base64") {
        throw new UnsupportedFeature(
          `unsupported image source: ${String(block.source.type)}`,
        );
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
        throw new UnsupportedFeature(
          `unsupported image media type: ${block.source.media_type}`,
        );
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
      if (role !== "assistant") {
        throw new InvalidRequest("tool_use is valid only in an assistant turn");
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
      if (Array.isArray(content)) {
        for (const nestedBlock of content) {
          if (!isRecord(nestedBlock)) {
            throw new InvalidRequest("tool_result block-list entries must be objects");
          }
          if (nestedBlock.type === "tool_reference") {
            if (
              typeof nestedBlock.tool_name !== "string" ||
              nestedBlock.tool_name.length === 0
            ) {
              throw new InvalidRequest(
                "tool_reference requires a non-empty tool_name",
              );
            }
            continue;
          }
          if (
            nestedBlock.type !== "text" &&
            nestedBlock.type !== "image" &&
            nestedBlock.type !== "document" &&
            nestedBlock.type !== "search_result"
          ) {
            throw new InvalidRequest(
              "tool_result block-list content supports text, image, document, search_result, and tool_reference blocks only",
            );
          }
          validateContentBlock(nestedBlock, facts, role);
        }
      }
      return;
    }
    case "document":
      validateDocumentBlock(block);
      return;
    case "search_result":
      validateSearchResultBlock(block);
      return;
    case "server_tool_use": {
      if (
        typeof block.id !== "string" ||
        block.id.length === 0 ||
        typeof block.name !== "string" ||
        block.name.length === 0 ||
        !SERVER_TOOL_NAMES.has(block.name)
      ) {
        throw new InvalidRequest(
          "server_tool_use requires a non-empty id and a known server-tool name",
        );
      }
      if (block.input !== undefined && !isRecord(block.input)) {
        throw new InvalidRequest("server_tool_use.input must be an object");
      }
      return;
    }
    case "web_search_tool_result":
    case "web_fetch_tool_result":
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
      if (
        typeof block.tool_use_id !== "string" ||
        block.tool_use_id.length === 0
      ) {
        throw new InvalidRequest(
          `${block.type} requires a non-empty tool_use_id`,
        );
      }
      return;
    default:
      // Unknown future discriminators are classified by the conversion
      // policy, not by the validator: `unknownContent=ignore` must be able
      // to keep the request usable, while known malformed families still
      // fail here.
      return;
  }
}

function validateDocumentBlock(block: Record<string, unknown>): void {
  if (!isRecord(block.source) || typeof block.source.type !== "string") {
    throw new InvalidRequest("document blocks require a source object");
  }
  const sourceType = block.source.type;
  if (sourceType === "content") {
    if (!Array.isArray(block.source.content)) {
      throw new InvalidRequest("document content source must be an array");
    }
    for (const nested of block.source.content) {
      if (
        !isRecord(nested) ||
        nested.type !== "text" ||
        typeof nested.text !== "string"
      ) {
        throw new InvalidRequest(
          "document content source entries must be text blocks",
        );
      }
    }
    return;
  }
  if (sourceType === "text") {
    if (
      typeof block.source.data !== "string" ||
      (block.source.media_type !== undefined &&
        block.source.media_type !== "text/plain")
    ) {
      throw new InvalidRequest(
        "document text source requires string data with text/plain media type",
      );
    }
    return;
  }
  if (sourceType === "base64" || sourceType === "url") {
    // No resolver capability is installed for this source family, so the
    // source is treated as unsupported-known (frozen §4.3), not as malformed.
    throw new UnsupportedFeature(
      `document source requires resolution: ${sourceType}`,
    );
  }
  throw new InvalidRequest(`document source type is not supported: ${sourceType}`);
}

function validateSearchResultBlock(block: Record<string, unknown>): void {
  if (typeof block.title !== "string") {
    throw new InvalidRequest("search_result requires a string title");
  }
  if (typeof block.content !== "string") {
    throw new InvalidRequest("search_result requires string content");
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

  validateOptionalFieldShapes(value);
  const messageFacts = validateMessages(messages);
  const tools = validateAnthropicTools(value.tools);
  const systemPrompt = validateSystem(value.system);
  const metadataUserId = validateMetadata(value.metadata);
  const reasoning = validateOutputConfig(value.output_config);
  const thinking = validateThinking(value.thinking);
  const cacheControl = validateCacheControl(value.cache_control);

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
  if (value.top_p !== undefined) {
    validated.topP = value.top_p as number;
  }
  if (value.top_k !== undefined) {
    validated.topK = value.top_k as number;
  }
  if (metadataUserId !== undefined) validated.metadataUserId = metadataUserId;
  if (thinking?.budget !== undefined) validated.thinkingBudget = thinking.budget;
  if (cacheControl !== undefined) validated.cacheControl = cacheControl;
  return validated;
}

/**
 * Minimal selector extraction for passthrough routing.
 *
 * This deliberately performs no semantic validation beyond a JSON object
 * shape and a non-empty `model` string: passthrough must forward the raw
 * body verbatim, so upstream-accepted fields that LuckyToken conversion
 * would reject must not block the passthrough branch.
 */
export function extractAnthropicModelSelector(value: unknown): string {
  if (!isRecord(value)) {
    throw new InvalidRequest("Request body must be a JSON object");
  }
  const model = value.model;
  if (typeof model !== "string" || model.length === 0) {
    throw new InvalidRequest("model must be a non-empty string");
  }
  return model;
}

interface PendingToolCall {
  readonly id: string;
  readonly name: string;
}

type ConvertedBlock =
  | TextContent
  | ThinkingContent
  | ImageContent
  | { type: "toolUse"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "toolResult";
      toolUseId: string;
      toolName: string;
      content: Array<TextContent | ImageContent>;
      isError: boolean;
      addedToolNames?: string[];
    }
  | { type: "transcript"; text: string };

function convertDocumentBlock(
  block: Record<string, unknown>,
): ConvertedBlock {
  const source = block.source as Record<string, unknown>;
  if (source.type === "content") {
    const texts = (source.content as Array<Record<string, unknown>>)
      .map((entry) => entry.text as string)
      .join("\n");
    return { type: "text", text: texts };
  }
  if (source.type === "text") {
    return { type: "text", text: source.data as string };
  }
  // url/base64 document sources are resolver-dependent and cannot be
  // materialized without a resolver capability, which is not installed.
  // Report precisely as a Client conversion failure (§4.3 known-family
  // rule) instead of surfacing a bare internal error at the HTTP boundary.
  throw new UnsupportedFeature(
    `document source requires resolution: ${String(source.type)}`,
  );
}

function convertSearchResultBlock(
  block: Record<string, unknown>,
): ConvertedBlock {
  const title = block.title as string;
  const content = block.content as string;
  return {
    type: "text",
    text: content.length === 0 ? title : `${title}\n${content}`,
  };
}

function convertBlock(
  block: Record<string, unknown>,
  pendingCalls: readonly PendingToolCall[],
  knownToolNames: ReadonlySet<string> | undefined,
  notices: ConversionNotice[],
  policy: AnthropicRequestConversionPolicy,
  jsonPath: string,
): ConvertedBlock | undefined {
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
    case "redacted_thinking":
      return {
        type: "thinking",
        thinking: "",
        thinkingSignature: block.data as string,
        redacted: true,
      };
    case "image": {
      const source = block.source as Record<string, unknown>;
      if (source.type !== "base64") {
        throw new UnsupportedFeature(
          `unsupported image source: ${String(source.type)}`,
        );
      }
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
      const call = pendingCalls.find(
        (candidate) => candidate.id === block.tool_use_id,
      );
      if (call === undefined) {
        throw new InvalidRequest(
          `Orphan or duplicate tool_result id: ${block.tool_use_id}`,
        );
      }
      const rawContent = block.content;
      const content: Array<TextContent | ImageContent> = [];
      const addedToolNames: string[] = [];
      if (typeof rawContent === "string") {
        content.push({ type: "text", text: rawContent });
      } else if (Array.isArray(rawContent)) {
        for (const nested of rawContent) {
          const candidate = nested as Record<string, unknown>;
          if (candidate.type === "tool_reference") {
            if (
              knownToolNames === undefined ||
              !knownToolNames.has(candidate.tool_name as string)
            ) {
              throw new InvalidRequest(
                `Unknown referenced tool name: ${candidate.tool_name}`,
              );
            }
            addedToolNames.push(candidate.tool_name as string);
            continue;
          }
          const converted = convertBlock(
            candidate,
            [],
            knownToolNames,
            notices,
            policy,
            `${jsonPath}.content`,
          );
          if (converted?.type === "text" || converted?.type === "image") {
            content.push(converted);
          } else if (converted?.type === "transcript") {
            content.push({ type: "text", text: converted.text });
          }
        }
      }
      return {
        type: "toolResult",
        toolUseId: block.tool_use_id as string,
        toolName: call.name,
        content,
        isError: block.is_error === true,
        ...(addedToolNames.length === 0 ? {} : { addedToolNames }),
      };
    }
    case "document":
      return convertDocumentBlock(block);
    case "search_result":
      return convertSearchResultBlock(block);
    case "document-resolver-required":
      return convertDocumentBlock(block);
    case "server_tool_use":
      return {
        type: "transcript",
        text: `[server tool: ${String(block.name)}]`,
      };
    case "web_search_tool_result":
      return { type: "transcript", text: "[web search result]" };
    case "web_fetch_tool_result":
      return { type: "transcript", text: "[web fetch result]" };
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
      return { type: "transcript", text: `[${String(block.type)}]` };
    default:
      if (policy.unknownContent === "ignore") {
        notices.push(
          requestNotice(
            UNKNOWN_CONTENT_IGNORED_NOTICE_CODE,
            "ignore",
            jsonPath,
          ),
        );
        return undefined;
      }
      throw new UnsupportedFeature(`unknown content block: ${String(block.type)}`);
  }
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
  blocks: readonly ConvertedBlock[],
  clientModel: string,
  receivedAt: number,
): AssistantMessage {
  const content: Array<TextContent | ThinkingContent | ToolCall> = [];
  for (const block of blocks) {
    if (block.type === "text" || block.type === "thinking") {
      content.push(block);
    } else if (block.type === "toolUse") {
      content.push({
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: block.input,
      });
    } else if (block.type === "transcript") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      throw new UnsupportedFeature(
        "Historical assistant images are unsupported",
      );
    }
  }
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

function resolveSystemPrompt(
  request: ValidatedAnthropicSourceRequest,
): { systemPrompt?: string; degraded: boolean; firstSystemIndex?: number } {
  let degraded = false;
  const promptParts: string[] = [];
  if (request.systemPrompt !== undefined) promptParts.push(request.systemPrompt);
  for (const [index, message] of request.messages.entries()) {
    if (message.role !== "system") continue;
    degraded = true;
    const text = messageSystemText(message);
    if (text !== undefined) promptParts.push(text);
    if (promptParts.length === 0) return { degraded, firstSystemIndex: index };
    return {
      systemPrompt: promptParts.join("\n"),
      degraded,
      firstSystemIndex: index,
    };
  }
  return {
    ...(promptParts.length === 0 ? {} : { systemPrompt: promptParts.join("\n") }),
    degraded,
  };
}

function messageSystemText(message: Record<string, unknown>): string | undefined {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const texts: string[] = [];
  for (const block of message.content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      texts.push(block.text);
    }
  }
  return texts.length === 0 ? undefined : texts.join("\n");
}

export function convertValidatedAnthropicRequest(
  request: ValidatedAnthropicSourceRequest,
  receivedAt: number,
): AnthropicRequestConversion {
  return convertValidatedAnthropicRequestWithPolicy(request, receivedAt, {
    unknownContent: "error",
    unresolvedToolCall: "xrepair",
    localCacheControl: "ignore",
  });
}

export function convertValidatedAnthropicRequestWithPolicy(
  request: ValidatedAnthropicSourceRequest,
  receivedAt: number,
  policy: AnthropicRequestConversionPolicy,
): AnthropicRequestConversion {
  const notices: ConversionNotice[] = [];
  const messages: Message[] = [];
  const knownToolNames =
    request.tools === undefined
      ? undefined
      : new Set(request.tools.map((tool) => tool.name));
  const pendingCalls: PendingToolCall[] = [];

  const pushRepairResults = (jsonPath: string): void => {
    if (pendingCalls.length === 0) return;
    if (policy.unresolvedToolCall === "error") {
      throw new UnsupportedFeature(
        `Unresolved tool call: ${pendingCalls[0]?.id ?? "unknown"}`,
      );
    }
    for (const call of pendingCalls) {
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [
          {
            type: "text",
            text: "No result — the tool call did not complete (interrupted or lost).",
          },
        ],
        isError: true,
        timestamp: receivedAt,
      });
      notices.push(
        requestNotice(
          XREPAIR_NOTICE_CODE,
          "xrepair",
          `${jsonPath}.tool_result`,
        ),
      );
    }
    pendingCalls.length = 0;
  };

  const system = resolveSystemPrompt(request);
  const context: Context = { messages };
  if (system.systemPrompt !== undefined) {
    context.systemPrompt = system.systemPrompt;
  }
  if (system.degraded) {
    notices.push(
      requestNotice(
        "anthropic_message_system_promoted",
        "degrade",
        "$.messages[0]",
      ),
    );
  }

  for (const [messageIndex, message] of request.messages.entries()) {
    const sourceRole = message.role as "user" | "assistant" | "system";
    if (sourceRole === "system" && messageIndex === system.firstSystemIndex) {
      // The first message-level system entry contributes its text blocks to
      // the systemPrompt (already resolved above). Its non-text blocks keep
      // their normal mapping and are emitted as user content below, so they
      // are not granted system privilege and are not dropped.
      const rawContent = message.content;
      const blocks: ConvertedBlock[] = [];
      if (Array.isArray(rawContent)) {
        for (const [blockIndex, block] of rawContent.entries()) {
          const candidate = block as Record<string, unknown>;
          if (candidate.type === "text") continue;
          const converted = convertBlock(
            candidate,
            [],
            knownToolNames,
            notices,
            policy,
            `$.messages[${messageIndex}].content[${blockIndex}]`,
          );
          if (converted !== undefined) blocks.push(converted);
        }
      }
      const ordinary: Array<TextContent | ImageContent> = [];
      for (const block of blocks) {
        if (block.type === "transcript") {
          ordinary.push({ type: "text", text: block.text });
        } else if (
          block.type !== "toolResult" &&
          block.type !== "toolUse" &&
          block.type !== "thinking"
        ) {
          ordinary.push(block);
        }
      }
      if (ordinary.length > 0) {
        messages.push({ role: "user", content: ordinary, timestamp: receivedAt });
      }
      continue;
    }
    const role = sourceRole;
    const rawContent = message.content;
    const blocks: ConvertedBlock[] =
      typeof rawContent === "string"
        ? [{ type: "text", text: rawContent }]
        : [];
    if (Array.isArray(rawContent)) {
      for (const [blockIndex, block] of rawContent.entries()) {
        const converted = convertBlock(
          block as Record<string, unknown>,
          pendingCalls,
          knownToolNames,
          notices,
          policy,
          `$.messages[${messageIndex}].content[${blockIndex}]`,
        );
        if (converted !== undefined) blocks.push(converted);
      }
    }

    if (role === "assistant") {
      pushRepairResults(`$.messages[${messageIndex}]`);
      const assistant = convertHistoricalAssistant(
        blocks,
        request.selector,
        receivedAt,
      );
      const previous = messages.at(-1);
      if (previous?.role === "assistant") {
        previous.content.push(...assistant.content);
      } else {
        messages.push(assistant);
      }
      pendingCalls.length = 0;
      for (const block of blocks) {
        if (block.type === "toolUse") {
          pendingCalls.push({ id: block.id, name: block.name });
        }
      }
      if (request.finalAssistantPrefill && messageIndex === request.messages.length - 1) {
        notices.push(
          requestNotice(
            PREFILL_DEGRADED_NOTICE_CODE,
            "degrade",
            `$.messages[${messageIndex}]`,
          ),
        );
      }
      continue;
    }

    const ordinary: Array<TextContent | ImageContent> = [];
    const sourceContentWasEmpty = blocks.length === 0;
    const consumedResultIds = new Set<string>();
    const flushOrdinary = (): void => {
      if (ordinary.length === 0) return;
      const previous = messages.at(-1);
      if (previous?.role === "user" && Array.isArray(previous.content)) {
        // Safe adjacent-role merging: consecutive user messages combine
        // without crossing a ToolResult boundary.
        previous.content.push(...ordinary);
      } else {
        messages.push({
          role: "user",
          content: [...ordinary],
          timestamp: receivedAt,
        });
      }
      ordinary.length = 0;
    };
    for (const block of blocks) {
      if (block.type === "toolResult") {
        flushOrdinary();
        if (consumedResultIds.has(block.toolUseId)) {
          throw new InvalidRequest(
            `Orphan or duplicate tool_result id: ${block.toolUseId}`,
          );
        }
        consumedResultIds.add(block.toolUseId);
        const result: ToolResultMessage = {
          role: "toolResult",
          toolCallId: block.toolUseId,
          toolName: block.toolName,
          content: block.content,
          isError: block.isError,
          timestamp: receivedAt,
          ...(block.addedToolNames === undefined
            ? {}
            : { addedToolNames: block.addedToolNames }),
        };
        messages.push(result);
        const callIndex = pendingCalls.findIndex(
          (call) => call.id === block.toolUseId,
        );
        if (callIndex >= 0) pendingCalls.splice(callIndex, 1);
      } else if (block.type === "transcript") {
        ordinary.push({ type: "text", text: block.text });
      } else if (block.type === "toolUse") {
        throw new InvalidRequest(
          "tool_use is valid only in an assistant turn",
        );
      } else if (block.type === "thinking") {
        throw new InvalidRequest(
          "thinking is valid only in an assistant turn",
        );
      } else {
        ordinary.push(block);
      }
    }
    flushOrdinary();
    if (sourceContentWasEmpty) {
      // An explicitly empty source user message is preserved as an empty
      // UserMessage (frozen grammar boundary).
      messages.push({ role: "user", content: [], timestamp: receivedAt });
    }
  }

  pushRepairResults("$.messages");

  const tools = convertAnthropicTools(request.tools);
  if (tools !== undefined) context.tools = tools;

  const options: Partial<ModelsSimpleStreamOptions> = {
    maxTokens: request.maxTokens,
  };
  if (request.temperature !== undefined) {
    options.temperature = request.temperature;
  }
  const samplingParams: Record<string, unknown> = {};
  if (request.topP !== undefined) samplingParams.top_p = request.topP;
  if (request.topK !== undefined) samplingParams.top_k = request.topK;
  if (Object.keys(samplingParams).length > 0) {
    options.samplingParams = Object.freeze(samplingParams);
  }
  if (request.reasoning !== undefined) {
    options.reasoning = request.reasoning;
  }
  if (request.thinkingBudget !== undefined) {
    const level = request.reasoning ?? budgetLevel(request.thinkingBudget);
    const budgets: NonNullable<typeof options.thinkingBudgets> = {
      [level === "xhigh" || level === "max" ? "high" : level]:
        request.thinkingBudget,
    };
    options.thinkingBudgets = Object.freeze(budgets);
  }
  if (request.cacheControl !== undefined && policy.localCacheControl === "promote") {
    const retention =
      request.cacheControl.ttl === "1h" ? "long" : "short";
    options.cacheRetention = retention;
    notices.push(
      requestNotice(
        LOCAL_CACHE_PROMOTED_NOTICE_CODE,
        "degrade",
        "$.cache_control",
      ),
    );
  }
  if (request.metadataUserId !== undefined) {
    options.metadata = Object.freeze({ user_id: request.metadataUserId });
  }

  return {
    selector: request.selector,
    context,
    options,
    renderState: { selector: request.selector, stream: request.stream },
    notices: Object.freeze(notices),
  };
}

function budgetLevel(budget: number): "minimal" | "low" | "medium" | "high" {
  if (budget < 4_096) return "minimal";
  if (budget < 16_384) return "low";
  if (budget < 65_536) return "medium";
  return "high";
}

export function parseAnthropicTextInvocation(
  value: unknown,
  receivedAt: number,
): AnthropicRequestConversion {
  return convertValidatedAnthropicRequestWithPolicy(
    validateAnthropicSourceRequest(value),
    receivedAt,
    { unknownContent: "error", unresolvedToolCall: "xrepair", localCacheControl: "ignore" },
  );
}
