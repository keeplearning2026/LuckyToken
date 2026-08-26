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

import type { ConversionNotice } from "@token/provider-contract/diagnostics";
import { InvalidRequest, UnsupportedFeature } from "./failures.js";
import {
  convertAnthropicTools,
  validateAnthropicTools,
  type ValidatedAnthropicTool,
} from "./tools.js";
import type { AnthropicConversionResult } from "./semantic/invocation.js";
import type {
  AnthropicEffortIntent,
  AnthropicReasoningSemantics,
  AnthropicThinkingActivation,
  AnthropicThinkingDisplayIntent,
} from "./semantic/reasoning/contract.js";
import {
  decodeAnthropicContinuity,
  type AnthropicContinuityAttachment,
  type AnthropicContinuitySource,
} from "./semantic/reasoning/continuity.js";
import type {
  AnthropicCandidateId,
  AnthropicCacheControl,
  AnthropicCaller,
  AnthropicOutputFormat,
  AnthropicPresence,
  AnthropicProjectionSupplement,
  ReadonlyJsonObject,
  AnthropicToolChoice,
} from "./semantic/supplement/contract.js";
import { anthropicCandidateId } from "./semantic/supplement/contract.js";
import { immutableJsonObject } from "./semantic/supplement/immutable-json.js";
import {
  validateAnthropicSupplementContentBlock,
  validateAnthropicSystemSupplementBlock,
} from "./semantic/supplement/validation.js";

export interface AnthropicRequestRenderState {
  readonly selector: string;
  readonly stream: boolean;
  readonly thinkingDisplay: AnthropicThinkingDisplayIntent;
  /** Ordinary Client tools whose response calls have proven direct ownership. */
  readonly directToolNames: readonly string[];
}

export type AnthropicRequestConversion = AnthropicConversionResult;

export interface AnthropicRequestConversionPolicy {
  readonly unknownContent: "error" | "ignore";
}

export interface AnthropicRequestConversionInput {
  readonly request: unknown;
  readonly receivedAt: number;
  readonly policy: AnthropicRequestConversionPolicy;
}

export interface ValidatedAnthropicSourceRequest {
  selector: string;
  maxTokens: number;
  reasoning: AnthropicReasoningSemantics;
  messages: Array<Record<string, unknown>>;
  hasImages: boolean;
  hasThinking: boolean;
  finalAssistantPrefill: boolean;
  stream: boolean;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  toolChoice?: AnthropicToolChoice;
  outputFormat: AnthropicPresence<AnthropicOutputFormat>;
  metadataUserId: AnthropicPresence<string>;
  serviceTier: AnthropicPresence<"auto" | "standard_only">;
  inferenceGeo: AnthropicPresence<string>;
  container: AnthropicPresence<string>;
  systemPrompt?: string;
  systemSource?: string | Array<Record<string, unknown>>;
  tools?: ValidatedAnthropicTool[];
  cacheControl: AnthropicPresence<AnthropicCacheControl>;
  unclaimedTopLevelKeys: readonly string[];
}

export const SYNTHETIC_CLIENT_HISTORY_API = "Token-client-history";
export const SYNTHETIC_CLIENT_HISTORY_PROVIDER = "Token-client";

export const PREFILL_DEGRADED_NOTICE_CODE =
  "anthropic_assistant_prefill_degraded_to_history";
export const THINKING_SIGNATURE_NOTICE_CODE =
  "anthropic_missing_thinking_signature";
export const UNKNOWN_CONTENT_IGNORED_NOTICE_CODE =
  "anthropic_unknown_content_ignored";
export const UNCLAIMED_REQUEST_FIELD_NOTICE_CODE =
  "anthropic_unclaimed_request_field";
export const UNKNOWN_EFFORT_FALLBACK_NOTICE_CODE =
  "anthropic_unknown_effort_fallback";
export const MESSAGE_SYSTEM_DEGRADED_NOTICE_CODE =
  "anthropic_message_system_degraded";
export const UNRESOLVED_TOOL_CALL_REPAIRED_NOTICE_CODE =
  "anthropic_unresolved_tool_call_repaired";

const INCOMPLETE_TOOL_CALL_RESULT_TEXT =
  "No result — the tool call did not complete (interrupted or lost).";

const ANTHROPIC_CONSUMED_TOP_LEVEL_KEYS = new Set([
  "model",
  "max_tokens",
  "messages",
  "system",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "tools",
  "tool_choice",
  "stop_sequences",
  "thinking",
  "output_config",
  "metadata",
  "cache_control",
  "inference_geo",
  "service_tier",
  "container",
]);
const MAX_UNCLAIMED_REQUEST_FIELD_NOTICES = 8;

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

/**
 * Creates a request-local working view without reading unclaimed properties.
 * Declared values are cloned lazily when their consumer actually reads them;
 * validators may therefore prune unclaimed siblings without mutating Client
 * input or triggering an unclaimed getter.
 */
function cloneDemandDrivenValue<T>(
  value: T,
  seen = new WeakMap<object, unknown>(),
): T {
  if (typeof value !== "object" || value === null) return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing as T;

  const source = value as object;
  const clone: unknown[] | Record<string, unknown> = Array.isArray(value)
    ? []
    : {};
  seen.set(source, clone);
  for (const key of Object.keys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined) continue;
    Object.defineProperty(clone, key, {
      enumerable: true,
       configurable: true,
       get() {
        if (!("value" in descriptor)) {
          throw new InvalidRequest(
            `Consumed request property ${key} must not be an accessor`,
          );
        }
        const selected = descriptor.value;
        const copied = cloneDemandDrivenValue(selected, seen);
        Object.defineProperty(clone, key, {
          value: copied,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        return copied;
      },
      set(next: unknown) {
        Object.defineProperty(clone, key, {
          value: next,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      },
    });
  }
  return clone as T;
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
    "metadata",
  ] as const;
  for (const name of objectFields) {
    if (value[name] !== undefined && !isRecord(value[name])) {
      throw new InvalidRequest(`${name} must be an object when present`);
    }
  }
  if (
    value.cache_control !== undefined &&
    value.cache_control !== null &&
    !isRecord(value.cache_control)
  ) {
    throw new InvalidRequest("cache_control must be an object or null when present");
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
  for (const [index, block] of value.entries()) {
    if (
      !isRecord(block) ||
      block.type !== "text" ||
      typeof block.text !== "string"
    ) {
      throw new InvalidRequest("system blocks must be text blocks");
    }
    validateAnthropicSystemSupplementBlock(block, `$.system[${index}]`);
    texts.push(block.text);
  }
  return texts.join("\n");
}

function validateOutputConfig(value: unknown): {
  effort: AnthropicEffortIntent;
  format: AnthropicPresence<AnthropicOutputFormat>;
} {
  if (value === undefined) {
    return {
      effort: { kind: "omitted" },
      format: { kind: "omitted" },
    };
  }
  if (!isRecord(value)) {
    throw new InvalidRequest("output_config must be an object when present");
  }
  const effort = value.effort;
  let effortIntent: AnthropicEffortIntent;
  if (effort === undefined) {
    effortIntent = { kind: "omitted" };
  } else if (effort === null) {
    effortIntent = { kind: "explicit-null" };
  } else if (typeof effort !== "string") {
    throw new InvalidRequest("output_config.effort must be a string when present");
  } else if (!ANTHROPIC_EFFORTS.has(effort)) {
    effortIntent = {
      kind: "specified",
      level: "max",
      normalizedFromUnknown: effort,
    };
  } else {
    effortIntent = {
      kind: "specified",
      level: effort as "low" | "medium" | "high" | "xhigh" | "max",
    };
  }

  const format = value.format;
  let formatIntent: AnthropicPresence<AnthropicOutputFormat>;
  if (format === undefined) {
    formatIntent = { kind: "omitted" };
  } else if (format === null) {
    formatIntent = { kind: "explicit-null" };
  } else if (
    !isRecord(format) ||
    format.type !== "json_schema" ||
    !isRecord(format.schema)
  ) {
    throw new InvalidRequest(
      "output_config.format must be null or a json_schema object",
    );
  } else {
    formatIntent = {
      kind: "specified",
      value: {
        kind: "json-schema",
        schema: immutableJsonObject(
          structuredClone(format.schema),
          "$.output_config.format.schema",
        ),
      },
    };
  }
  return { effort: effortIntent, format: formatIntent };
}

function validateMetadata(value: unknown): AnthropicPresence<string> {
  if (value === undefined) return { kind: "omitted" };
  if (!isRecord(value)) {
    throw new InvalidRequest("metadata must be an object when present");
  }
  if (value.user_id === undefined) return { kind: "omitted" };
  if (value.user_id === null) return { kind: "explicit-null" };
  if (typeof value.user_id !== "string") {
    throw new InvalidRequest("metadata.user_id must be a string when present");
  }
  return { kind: "specified", value: value.user_id };
}

function validateThinkingDisplay(value: unknown): AnthropicThinkingDisplayIntent {
  if (value === undefined) return { kind: "omitted" };
  if (value === null) return { kind: "explicit-null" };
  if (value === "summarized" || value === "omitted") {
    return { kind: "specified", value };
  }
  throw new InvalidRequest(
    "thinking.display must be summarized, omitted, null, or absent",
  );
}

function validateThinking(value: unknown): AnthropicThinkingActivation {
  if (value === undefined) return { kind: "omitted" };
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
    return {
      kind: "enabled",
      budgetTokens: value.budget_tokens as number,
      display: validateThinkingDisplay(value.display),
    };
  }
  if (type === "disabled") {
    if (value.display !== undefined) {
      throw new InvalidRequest("thinking.disabled does not accept display");
    }
    return { kind: "disabled" };
  }
  if (type === "adaptive") {
    return {
      kind: "adaptive",
      display: validateThinkingDisplay(value.display),
    };
  }
  throw new InvalidRequest(`thinking.type is not supported: ${type}`);
}

function validateCacheControl(
  value: unknown,
): AnthropicPresence<AnthropicCacheControl> {
  if (value === undefined) return { kind: "omitted" };
  if (value === null) return { kind: "explicit-null" };
  if (!isRecord(value)) {
    throw new InvalidRequest("cache_control must be an object when present");
  }
  if (value.type !== undefined && value.type !== "ephemeral") {
    throw new InvalidRequest("cache_control.type must be ephemeral");
  }
  const ttl = value.ttl;
  if (ttl === undefined) return { kind: "specified", value: {} };
  if (ttl !== "5m" && ttl !== "1h") {
    throw new InvalidRequest("cache_control.ttl must be 5m or 1h");
  }
  return { kind: "specified", value: { ttl } };
}

function validateNullableString(
  value: Record<string, unknown>,
  field: "container" | "inference_geo",
): AnthropicPresence<string> {
  const candidate = value[field];
  if (candidate === undefined) return { kind: "omitted" };
  if (candidate === null) return { kind: "explicit-null" };
  return { kind: "specified", value: candidate as string };
}

function validateServiceTier(
  value: unknown,
): AnthropicPresence<"auto" | "standard_only"> {
  if (value === undefined) return { kind: "omitted" };
  if (value !== "auto" && value !== "standard_only") {
    throw new InvalidRequest("service_tier must be auto or standard_only");
  }
  return { kind: "specified", value };
}

function validateStopSequences(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new InvalidRequest("stop_sequences must be an array of strings");
  }
  return [...value] as string[];
}

function validateToolChoice(value: unknown): AnthropicToolChoice | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new InvalidRequest("tool_choice must contain a string type");
  }
  if (value.type === "none") {
    if (value.disable_parallel_tool_use !== undefined) {
      throw new InvalidRequest(
        "tool_choice.none does not accept disable_parallel_tool_use",
      );
    }
    return { kind: "none" };
  }
  if (
    value.disable_parallel_tool_use !== undefined &&
    typeof value.disable_parallel_tool_use !== "boolean"
  ) {
    throw new InvalidRequest(
      "tool_choice.disable_parallel_tool_use must be boolean",
    );
  }
  const disableParallelToolUse = value.disable_parallel_tool_use === true;
  if (value.type === "auto" || value.type === "any") {
    return { kind: value.type, disableParallelToolUse };
  }
  if (value.type === "tool") {
    if (typeof value.name !== "string" || value.name.length === 0) {
      throw new InvalidRequest("tool_choice.tool requires a non-empty name");
    }
    return { kind: "named", name: value.name, disableParallelToolUse };
  }
  throw new InvalidRequest(`tool_choice.type is not supported: ${value.type}`);
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
  for (const [messageIndex, message] of messages.entries()) {
    if (
      !isRecord(message) ||
      (message.role !== "user" &&
        message.role !== "assistant" &&
        message.role !== "system")
    ) {
      throw new InvalidRequest(
        "messages require a user, assistant, or Token-compatible system role",
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
    for (const [contentIndex, block] of message.content.entries()) {
      if (isRecord(block)) {
        validateAnthropicSupplementContentBlock(
          block,
          `$.messages[${messageIndex}].content[${contentIndex}]`,
        );
      }
      const role = message.role === "system"
        ? "user"
        : message.role as "user" | "assistant";
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
      if (block.source.type === "url") {
        if (typeof block.source.url !== "string" || block.source.url.length === 0) {
          throw new InvalidRequest("URL image sources require a non-empty URL");
        }
        facts.hasImages = true;
        return;
      }
      if (block.source.type !== "base64") {
        throw new InvalidRequest(
          `image source type is not supported: ${String(block.source.type)}`,
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
    case "container_upload":
      if (typeof block.file_id !== "string" || block.file_id.length === 0) {
        throw new InvalidRequest("container_upload requires a non-empty file_id");
      }
      return;
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
    if (
      sourceType === "base64" &&
      (typeof block.source.data !== "string" ||
        typeof block.source.media_type !== "string")
    ) {
      throw new InvalidRequest("base64 document sources require media_type and data");
    }
    if (
      sourceType === "url" &&
      (typeof block.source.url !== "string" || block.source.url.length === 0)
    ) {
      throw new InvalidRequest("URL document sources require a non-empty URL");
    }
    return;
  }
  throw new InvalidRequest(`document source type is not supported: ${sourceType}`);
}

function validateSearchResultBlock(block: Record<string, unknown>): void {
  if (typeof block.source !== "string") {
    throw new InvalidRequest("search_result requires a string source");
  }
  if (typeof block.title !== "string") {
    throw new InvalidRequest("search_result requires a string title");
  }
  if (!Array.isArray(block.content)) {
    throw new InvalidRequest("search_result content must be a text-block array");
  }
}

export function validateAnthropicSourceRequest(
  value: unknown,
): ValidatedAnthropicSourceRequest {
  if (!isRecord(value)) {
    throw new InvalidRequest("Request body must be a JSON object");
  }
  const request = cloneDemandDrivenValue(value);

  const { model, max_tokens: maxTokens, messages } = request;
  if (typeof model !== "string" || model.length === 0) {
    throw new InvalidRequest("model must be a non-empty string");
  }
  if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) < 1) {
    throw new InvalidRequest("max_tokens must be a positive safe integer");
  }

  validateOptionalFieldShapes(request);
  const messageFacts = validateMessages(messages);
  const tools = validateAnthropicTools(request.tools);
  const systemPrompt = validateSystem(request.system);
  const metadataUserId = validateMetadata(request.metadata);
  const outputConfig = validateOutputConfig(request.output_config);
  const thinking = validateThinking(request.thinking);
  const cacheControl = validateCacheControl(request.cache_control);
  if (
    thinking.kind === "enabled" &&
    thinking.budgetTokens >= (maxTokens as number)
  ) {
    throw new InvalidRequest(
      "thinking.enabled.budget_tokens must be less than max_tokens",
    );
  }

  const validated: ValidatedAnthropicSourceRequest = {
    selector: model,
    maxTokens: maxTokens as number,
    reasoning: {
      activation: thinking,
      effort: outputConfig.effort,
      history: [],
      continuity: [],
    },
    messages: messageFacts.messages,
    hasImages: messageFacts.hasImages,
    hasThinking: messageFacts.hasThinking,
    stream: request.stream === true,
    finalAssistantPrefill:
      messageFacts.messages.at(-1)?.role === "assistant",
    outputFormat: outputConfig.format,
    metadataUserId,
    serviceTier: validateServiceTier(request.service_tier),
    inferenceGeo: validateNullableString(request, "inference_geo"),
    container: validateNullableString(request, "container"),
    cacheControl,
    unclaimedTopLevelKeys: Object.freeze(
      Object.keys(request)
        .filter((key) => !ANTHROPIC_CONSUMED_TOP_LEVEL_KEYS.has(key))
        .slice(0, MAX_UNCLAIMED_REQUEST_FIELD_NOTICES),
    ),
  };
  if (systemPrompt !== undefined) validated.systemPrompt = systemPrompt;
  if (request.system !== undefined) {
    validated.systemSource = structuredClone(
      request.system as string | Array<Record<string, unknown>>,
    );
  }
  if (tools !== undefined) validated.tools = tools;
  if (request.temperature !== undefined) {
    validated.temperature = request.temperature as number;
  }
  if (request.top_p !== undefined) {
    validated.topP = request.top_p as number;
  }
  if (request.top_k !== undefined) {
    validated.topK = request.top_k as number;
  }
  const stopSequences = validateStopSequences(request.stop_sequences);
  if (stopSequences !== undefined) validated.stopSequences = stopSequences;
  const toolChoice = validateToolChoice(request.tool_choice);
  if (toolChoice?.kind === "named") {
    const exists = tools?.some((tool) => tool.name === toolChoice.name) === true;
    if (!exists) {
      throw new InvalidRequest(
        `tool_choice named tool ${toolChoice.name} is not present in tools`,
      );
    }
  }
  if (toolChoice !== undefined) validated.toolChoice = toolChoice;
  return validated;
}

/**
 * Minimal selector extraction for passthrough routing.
 *
 * This deliberately performs no semantic validation beyond a JSON object
 * shape and a non-empty `model` string: passthrough must forward the raw
 * body verbatim, so upstream-accepted fields that Token conversion
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

interface ConversationToolRepair {
  readonly beforeMessageIndex: number;
  readonly beforeContentIndex?: number;
  readonly callId: string;
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
  | { type: "transcript"; text: string }
  | { type: "supplementOnly" };

function convertDocumentBlock(
  block: Record<string, unknown>,
): ConvertedBlock {
  const source = block.source as Record<string, unknown>;
  if (source.type === "content") {
    if (typeof source.content === "string") {
      return { type: "text", text: source.content };
    }
    const texts = (source.content as Array<Record<string, unknown>>)
      .filter((entry) => entry.type === "text")
      .map((entry) => entry.text as string);
    return texts.length === 0
      ? { type: "supplementOnly" }
      : { type: "text", text: texts.join("\n") };
  }
  if (source.type === "text") {
    return { type: "text", text: source.data as string };
  }
  // URL/base64 documents are retained in the protocol-owned supplement.
  // Pi IR must not fabricate visible text for bytes it did not resolve.
  return { type: "supplementOnly" };
}

function convertSearchResultBlock(
  block: Record<string, unknown>,
): ConvertedBlock {
  const title = block.title as string;
  const content = (block.content as Array<Record<string, unknown>>)
    .map((entry) => entry.text as string)
    .join("\n");
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
      if (source.type !== "base64") return { type: "supplementOnly" };
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
      return { type: "supplementOnly" };
    case "web_search_tool_result":
    case "web_fetch_tool_result":
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
    case "container_upload":
      return { type: "supplementOnly" };
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

function decodeBlockContinuity(
  block: Record<string, unknown>,
  jsonPath: string,
): {
  readonly source?: AnthropicContinuitySource;
  readonly attachments: readonly AnthropicContinuityAttachment[];
  readonly notices: readonly ConversionNotice[];
} {
  if (block.type === "thinking") {
    return decodeAnthropicContinuity({
      value: block.token_continuity,
      owner: {
        target: "thinking",
        representation: "thinking",
        hasNativeValue:
          typeof block.signature === "string" && block.signature.length > 0,
      },
      jsonPath,
    });
  }
  if (block.type === "redacted_thinking") {
    return decodeAnthropicContinuity({
      value: block.token_continuity,
      owner: {
        target: "thinking",
        representation: "redacted",
        hasNativeValue: typeof block.data === "string" && block.data.length > 0,
      },
      jsonPath,
    });
  }
  if (block.type === "text") {
    return decodeAnthropicContinuity({
      value: block.token_continuity,
      owner: { target: "text" },
      jsonPath,
    });
  }
  if (block.type === "tool_use" && typeof block.id === "string") {
    return decodeAnthropicContinuity({
      value: block.token_continuity,
      owner: { target: "toolCall", callId: block.id },
      jsonPath,
    });
  }
  return { attachments: [], notices: [] };
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

function withoutCandidateOnlyFields(
  value: Record<string, unknown>,
  path: string,
): ReadonlyJsonObject {
  const copied = structuredClone(value);
  delete copied.token_continuity;
  delete copied.cache_control;
  return immutableJsonObject(copied, path);
}

const CONTENT_CONTAINER_TYPES = new Set([
  "search_result",
  "tool_result",
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
]);

function visitContentBlocks(
  block: Record<string, unknown>,
  visit: (candidate: Record<string, unknown>, nestedPath: readonly (string | number)[]) => void,
  nestedPath: readonly (string | number)[] = [],
): void {
  visit(block, nestedPath);
  const childArrays: Array<readonly [readonly (string | number)[], unknown[]]> = [];
  if (CONTENT_CONTAINER_TYPES.has(String(block.type)) && Array.isArray(block.content)) {
    childArrays.push([[...nestedPath, "content"], block.content]);
  }
  if (block.type === "document" && isRecord(block.source) && Array.isArray(block.source.content)) {
    childArrays.push([[...nestedPath, "source", "content"], block.source.content]);
  }
  for (const [parentPath, children] of childArrays) {
    children.forEach((child, childIndex) => {
      if (!isRecord(child)) return;
      visitContentBlocks(child, visit, [...parentPath, childIndex]);
    });
  }
}

function withoutContentCandidateOnlyFields(
  value: Record<string, unknown>,
  path: string,
): ReadonlyJsonObject {
  const copied = structuredClone(value);
  if (copied.caller === undefined) delete copied.caller;
  visitContentBlocks(copied, (candidate) => {
    delete candidate.token_continuity;
    delete candidate.cache_control;
  });
  return immutableJsonObject(copied, path);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function contentPiRepresentation(
  block: Record<string, unknown>,
): "partial" | "none" | undefined {
  switch (block.type) {
    case "text":
      return hasOnlyKeys(block, ["type", "text", "token_continuity"])
        ? undefined
        : "partial";
    case "thinking":
      return hasOnlyKeys(block, [
        "type",
        "thinking",
        "signature",
        "token_continuity",
      ])
        ? undefined
        : "partial";
    case "redacted_thinking":
      return hasOnlyKeys(block, ["type", "data", "token_continuity"])
        ? undefined
        : "partial";
    case "image": {
      const source = block.source as Record<string, unknown>;
      return source.type === "base64" && hasOnlyKeys(block, ["type", "source"])
        ? undefined
        : source.type === "base64"
          ? "partial"
          : "none";
    }
    case "tool_use": {
      const caller = block.caller;
      const directCaller =
        isRecord(caller) &&
        caller.type === "direct" &&
        hasOnlyKeys(caller, ["type"]);
      return hasOnlyKeys(block, [
        "type",
        "id",
        "name",
        "input",
        ...(directCaller ? ["caller"] : []),
        "token_continuity",
      ])
        ? undefined
        : "partial";
    }
    case "tool_result": {
      if (!hasOnlyKeys(block, ["type", "tool_use_id", "content", "is_error"])) {
        return "partial";
      }
      return Array.isArray(block.content) &&
        block.content.some(
          (nested) =>
            isRecord(nested) &&
            !["text", "image"].includes(nested.type as string),
        )
        ? "partial"
        : undefined;
    }
    case "document": {
      const source = block.source as Record<string, unknown>;
      if (source.type === "text") return "partial";
      if (source.type !== "content") return "none";
      if (typeof source.content === "string") return "partial";
      return (source.content as Array<Record<string, unknown>>).some(
        (entry) => entry.type === "text",
      )
        ? "partial"
        : "none";
    }
    case "search_result":
      return "partial";
    case "server_tool_use":
    case "web_search_tool_result":
    case "web_fetch_tool_result":
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
    case "container_upload":
      return "none";
    default:
      return undefined;
  }
}

function buildContentSupplement(
  request: ValidatedAnthropicSourceRequest,
): AnthropicProjectionSupplement["content"] {
  const content: AnthropicProjectionSupplement["content"][number][] = [];
  for (const [sourceMessageIndex, message] of request.messages.entries()) {
    if (!Array.isArray(message.content)) continue;
    for (const [sourceContentIndex, candidate] of message.content.entries()) {
      if (!isRecord(candidate)) continue;
      const normalized = withoutContentCandidateOnlyFields(
        candidate,
        `$.messages[${sourceMessageIndex}].content[${sourceContentIndex}]`,
      );
      const piRepresentation = contentPiRepresentation(
        normalized as Record<string, unknown>,
      );
      const idPrefix = `content[${sourceMessageIndex}:${sourceContentIndex}]`;
      const source = Object.freeze({
        kind: "message-content" as const,
        messageIndex: sourceMessageIndex,
        contentIndex: sourceContentIndex,
      });
      const messageAttachment = Object.freeze({
        kind: "message-content" as const,
        messageIndex: sourceMessageIndex,
        contentIndex: sourceContentIndex,
      });
      const common = {
        source,
        sourceMessageIndex,
        sourceContentIndex,
        effectiveRole:
          message.role === "assistant" ? "assistant" as const : "user" as const,
      };
      const block = normalized as Record<string, unknown>;
      switch (block.type) {
        case "text": {
          if (!Object.hasOwn(block, "citations")) break;
          content.push(Object.freeze({
            ...common,
            id: anthropicCandidateId(`${idPrefix}.citations`),
            kind: "text-citations" as const,
            piRepresentation: "partial" as const,
            piAttachment: messageAttachment,
            value: block.citations as readonly ReadonlyJsonObject[] | null,
          }));
          break;
        }
        case "image": {
          const imageSource = block.source as ReadonlyJsonObject;
          if (imageSource.type !== "url") break;
          content.push(Object.freeze({
            ...common,
            id: anthropicCandidateId(`${idPrefix}.source`),
            kind: "url-image-source" as const,
            piRepresentation: "none" as const,
            value: imageSource as { readonly type: "url"; readonly url: string },
          }));
          break;
        }
        case "document": {
          const representation = piRepresentation ?? "none";
          content.push(Object.freeze({
            ...common,
            id: anthropicCandidateId(`${idPrefix}.source`),
            kind: "document-source" as const,
            piRepresentation: representation,
            ...(representation === "partial" ? { piAttachment: messageAttachment } : {}),
            value: block.source as ReadonlyJsonObject,
          }));
          if (
            Object.hasOwn(block, "citations") ||
            Object.hasOwn(block, "context") ||
            Object.hasOwn(block, "title")
          ) {
            content.push(Object.freeze({
              ...common,
              id: anthropicCandidateId(`${idPrefix}.metadata`),
              kind: "document-metadata" as const,
              piRepresentation: "none" as const,
              value: Object.freeze({
                ...(Object.hasOwn(block, "citations")
                  ? { citations: block.citations as ReadonlyJsonObject | null }
                  : {}),
                ...(Object.hasOwn(block, "context")
                  ? { context: block.context as string | null }
                  : {}),
                ...(Object.hasOwn(block, "title")
                  ? { title: block.title as string | null }
                  : {}),
              }),
            }));
          }
          break;
        }
        case "search_result":
          content.push(Object.freeze({
            ...common,
            id: anthropicCandidateId(`${idPrefix}.searchResult`),
            kind: "search-result" as const,
            piRepresentation: "partial" as const,
            piAttachment: messageAttachment,
            value: normalized,
          }));
          break;
        case "tool_use": {
          if (!isRecord(block.caller) || block.caller.type === "direct") break;
          content.push(Object.freeze({
            ...common,
            id: anthropicCandidateId(`${idPrefix}.caller`),
            kind: "client-tool-use-caller" as const,
            piRepresentation: "partial" as const,
            piAttachment: Object.freeze({
              kind: "tool-call" as const,
              callId: block.id as string,
            }),
            value: block.caller as AnthropicCaller,
          }));
          break;
        }
        case "tool_result": {
          if (!Array.isArray(block.content)) break;
          const contentLength = block.content.length;
          const richBlocks: Array<{
            readonly contentIndex: number;
            readonly piContentCount: 0 | 1;
            readonly value: ReadonlyJsonObject;
          }> = [];
          const references: Array<{ readonly contentIndex: number; readonly toolName: string }> = [];
          for (const [nestedIndex, nested] of block.content.entries()) {
            if (!isRecord(nested)) continue;
            if (nested.type === "tool_reference") {
              references.push(Object.freeze({
                contentIndex: nestedIndex,
                toolName: nested.tool_name as string,
              }));
            } else if (nested.type !== "text" && nested.type !== "image") {
              richBlocks.push(Object.freeze({
                contentIndex: nestedIndex,
                piContentCount:
                  contentPiRepresentation(nested) === "partial" ? 1 : 0,
                value: nested as ReadonlyJsonObject,
              }));
            }
          }
          const piAttachment = Object.freeze({
            kind: "tool-result" as const,
            callId: block.tool_use_id as string,
          });
          if (richBlocks.length > 0) {
            content.push(Object.freeze({
              ...common,
              id: anthropicCandidateId(`${idPrefix}.richContent`),
              kind: "rich-client-tool-result" as const,
              piRepresentation: "partial" as const,
              piAttachment,
              value: Object.freeze({
                contentLength,
                blocks: Object.freeze(richBlocks),
              }),
            }));
          }
          for (const reference of references) {
            content.push(Object.freeze({
              ...common,
              id: anthropicCandidateId(
                `${idPrefix}.content[${reference.contentIndex}].toolReference`,
              ),
              kind: "tool-reference" as const,
              piRepresentation: "partial" as const,
              piAttachment,
              value: Object.freeze({ contentLength, ...reference }),
            }));
          }
          break;
        }
        case "server_tool_use":
          content.push(Object.freeze({
            ...common,
            id: anthropicCandidateId(`${idPrefix}.serverUse`),
            kind: "server-tool-use" as const,
            piRepresentation: "none" as const,
            value: normalized,
          }));
          break;
        case "web_search_tool_result":
        case "web_fetch_tool_result":
        case "code_execution_tool_result":
        case "bash_code_execution_tool_result":
        case "text_editor_code_execution_tool_result":
        case "tool_search_tool_result":
          content.push(Object.freeze({
            ...common,
            id: anthropicCandidateId(`${idPrefix}.serverResult`),
            kind: "server-tool-result" as const,
            piRepresentation: "none" as const,
            value: normalized,
          }));
          break;
        case "container_upload":
          content.push(Object.freeze({
            ...common,
            id: anthropicCandidateId(`${idPrefix}.fileId`),
            kind: "container-upload" as const,
            piRepresentation: "none" as const,
            value: Object.freeze({ fileId: block.file_id as string }),
          }));
          break;
      }
    }
  }
  return Object.freeze(content);
}

function buildToolSupplement(
  tools: readonly ValidatedAnthropicTool[] | undefined,
): AnthropicProjectionSupplement["tools"] {
  if (tools === undefined) return Object.freeze([]);
  return Object.freeze(
    tools.flatMap<AnthropicProjectionSupplement["tools"][number]>(
      (tool, sourceToolIndex) => {
      const source = Object.freeze({
        kind: "tool-definition" as const,
        toolIndex: sourceToolIndex,
      });
      if (tool.kind === "server") {
        return [Object.freeze({
          id: anthropicCandidateId(`tools[${sourceToolIndex}].serverDefinition`),
          source,
          sourceToolIndex,
          name: tool.name,
          toolKind: "server" as const,
          kind: "server-tool-definition" as const,
          piRepresentation: "none" as const,
          value: withoutCandidateOnlyFields(
            tool.source,
            `$.tools[${sourceToolIndex}]`,
          ),
        })];
      }

      const piAttachment = Object.freeze({
        kind: "tool-definition" as const,
        toolName: tool.name,
      });
      const common = {
        source,
        piAttachment,
        sourceToolIndex,
        name: tool.name,
        toolKind: "custom" as const,
        piRepresentation: "partial" as const,
      };
      const candidates: AnthropicProjectionSupplement["tools"][number][] = [];
      if (tool.source.allowed_callers !== undefined) {
        candidates.push(Object.freeze({
          ...common,
          id: anthropicCandidateId(`tools[${sourceToolIndex}].allowedCallers`),
          kind: "custom-tool-caller-policy" as const,
          value: Object.freeze([...(tool.source.allowed_callers as string[])]) as readonly (
            | "direct"
            | "code_execution_20250825"
            | "code_execution_20260120"
          )[],
        }));
      }
      if (tool.source.defer_loading !== undefined) {
        candidates.push(Object.freeze({
          ...common,
          id: anthropicCandidateId(`tools[${sourceToolIndex}].deferLoading`),
          kind: "custom-tool-deferred-loading" as const,
          value: tool.source.defer_loading as boolean,
        }));
      }
      if (tool.source.eager_input_streaming !== undefined) {
        candidates.push(Object.freeze({
          ...common,
          id: anthropicCandidateId(`tools[${sourceToolIndex}].eagerInputStreaming`),
          kind: "custom-tool-input-streaming" as const,
          value: tool.source.eager_input_streaming as boolean | null,
        }));
      }
      if (tool.source.input_examples !== undefined) {
        candidates.push(Object.freeze({
          ...common,
          id: anthropicCandidateId(`tools[${sourceToolIndex}].inputExamples`),
          kind: "custom-tool-input-examples" as const,
          value: Object.freeze(
            (tool.source.input_examples as Record<string, unknown>[]).map(
              (example, exampleIndex) => immutableJsonObject(
                example,
                `$.tools[${sourceToolIndex}].input_examples[${exampleIndex}]`,
              ),
            ),
          ),
        }));
      }
        return candidates;
      },
    ),
  );
}

function cacheValue(value: unknown): AnthropicCacheControl | null {
  if (value === null) return null;
  const source = value as Record<string, unknown>;
  return Object.freeze(
    source.ttl === undefined ? {} : { ttl: source.ttl as "5m" | "1h" },
  );
}

function cacheCandidateId(
  messageIndex: number,
  contentIndex: number,
  nestedPath: readonly (string | number)[],
): AnthropicCandidateId {
  const suffix = nestedPath.map((segment) =>
    typeof segment === "number" ? `[${segment}]` : `.${segment}`
  ).join("");
  return anthropicCandidateId(
    `content[${messageIndex}:${contentIndex}]${suffix}.cacheControl`,
  );
}

function buildCacheSupplement(
  request: ValidatedAnthropicSourceRequest,
  ignoredContentBlocks: ReadonlySet<string>,
): AnthropicProjectionSupplement["cache"] {
  const cache: AnthropicProjectionSupplement["cache"][number][] = [];
  if (request.cacheControl.kind !== "omitted") {
    cache.push(Object.freeze({
      id: anthropicCandidateId("cacheControl"),
      kind: "cache-control" as const,
      source: Object.freeze({ kind: "request" as const, path: "$.cache_control" }),
      attachment: Object.freeze({ kind: "request" as const }),
      value: request.cacheControl.kind === "explicit-null"
        ? null
        : Object.freeze({ ...request.cacheControl.value }),
    }));
  }
  if (Array.isArray(request.systemSource)) {
    for (const [blockIndex, block] of request.systemSource.entries()) {
      if (!Object.hasOwn(block, "cache_control")) continue;
      cache.push(Object.freeze({
        id: anthropicCandidateId(`system[${blockIndex}].cacheControl`),
        kind: "cache-control" as const,
        source: Object.freeze({ kind: "system-block" as const, blockIndex }),
        attachment: Object.freeze({ kind: "system-block" as const, blockIndex }),
        value: cacheValue(block.cache_control),
      }));
    }
  }
  for (const [messageIndex, message] of request.messages.entries()) {
    if (!Array.isArray(message.content)) continue;
    for (const [contentIndex, block] of message.content.entries()) {
      if (!isRecord(block)) continue;
      if (ignoredContentBlocks.has(`${messageIndex}:${contentIndex}`)) continue;
      visitContentBlocks(block, (candidate, nestedPath) => {
        if (!Object.hasOwn(candidate, "cache_control")) return;
        cache.push(Object.freeze({
          id: cacheCandidateId(messageIndex, contentIndex, nestedPath),
          kind: "cache-control" as const,
          source: Object.freeze({
            kind: "message-content" as const,
            messageIndex,
            contentIndex,
            ...(nestedPath.length === 0
              ? {}
              : { nestedPath: Object.freeze([...nestedPath]) }),
          }),
          attachment: Object.freeze({
            kind: "message-content" as const,
            messageIndex,
            contentIndex,
            ...(nestedPath.length === 0
              ? {}
              : { nestedPath: Object.freeze([...nestedPath]) }),
          }),
          value: cacheValue(candidate.cache_control),
        }));
      });
    }
  }
  for (const [toolIndex, tool] of (request.tools ?? []).entries()) {
    if (!Object.hasOwn(tool.source, "cache_control")) continue;
    cache.push(Object.freeze({
      id: anthropicCandidateId(`tools[${toolIndex}].cacheControl`),
      kind: "cache-control" as const,
      source: Object.freeze({ kind: "tool-definition" as const, toolIndex }),
      attachment: Object.freeze({ kind: "tool-definition" as const, toolIndex }),
      value: cacheValue(tool.source.cache_control),
    }));
  }
  return Object.freeze(cache);
}

function buildSystemSupplement(
  request: ValidatedAnthropicSourceRequest,
): AnthropicProjectionSupplement["system"] {
  if (!Array.isArray(request.systemSource)) return Object.freeze([]);
  return Object.freeze(request.systemSource.map((block, blockIndex) =>
    Object.freeze({
      id: anthropicCandidateId(`system[${blockIndex}]`),
      kind: "structured-system-block" as const,
      source: Object.freeze({ kind: "system-block" as const, blockIndex }),
      blockIndex,
      value: withoutCandidateOnlyFields(block, `$.system[${blockIndex}]`),
    })
  ));
}

function buildConversationLayout(
  request: ValidatedAnthropicSourceRequest,
  content: AnthropicProjectionSupplement["content"],
  cache: AnthropicProjectionSupplement["cache"],
  repairs: readonly ConversationToolRepair[],
  ignoredContentBlocks: ReadonlySet<string>,
): AnthropicProjectionSupplement["conversation"] {
  const contentIds = new Map<string, AnthropicCandidateId[]>();
  for (const candidate of content) {
    const key = `${candidate.sourceMessageIndex}:${candidate.sourceContentIndex}`;
    const ids = contentIds.get(key) ?? [];
    ids.push(candidate.id);
    contentIds.set(key, ids);
  }
  const cacheIds = new Map<string, AnthropicCandidateId[]>();
  for (const candidate of cache) {
    if (candidate.attachment.kind !== "message-content") continue;
    const key = `${candidate.attachment.messageIndex}:${candidate.attachment.contentIndex}`;
    const ids = cacheIds.get(key) ?? [];
    ids.push(candidate.id);
    cacheIds.set(key, ids);
  }
  const repairEntries = (
    beforeMessageIndex: number,
    beforeContentIndex: number | undefined,
  ): AnthropicProjectionSupplement["conversation"]["messages"][number]["entries"] =>
    Object.freeze(
      repairs
        .filter((repair) =>
          repair.beforeMessageIndex === beforeMessageIndex &&
          repair.beforeContentIndex === beforeContentIndex
        )
        .map((repair) => Object.freeze({
          kind: "synthetic-tool-result" as const,
          callId: repair.callId,
          piAttachment: Object.freeze({
            kind: "tool-result" as const,
            callId: repair.callId,
          }),
          candidateIds: Object.freeze([]) as readonly [],
        })),
    );
  let sawMessageSystem = false;
  const messages: AnthropicProjectionSupplement["conversation"]["messages"][number][] = [];
  for (const [sourceMessageIndex, message] of request.messages.entries()) {
    const repairsBeforeMessage = repairEntries(sourceMessageIndex, undefined);
    if (repairsBeforeMessage.length > 0) {
      messages.push(Object.freeze({
        sourceMessageIndex,
        effectiveRole: "user" as const,
        entries: repairsBeforeMessage,
      }));
    }

    const firstMessageSystem = message.role === "system" && !sawMessageSystem;
    if (message.role === "system") sawMessageSystem = true;
    const sourceContent = message.content;
    const entries: AnthropicProjectionSupplement["conversation"]["messages"][number]["entries"][number][] = [];
    if (typeof sourceContent === "string") {
      entries.push(...repairEntries(sourceMessageIndex, 0));
      if (
        !firstMessageSystem &&
        !(message.role === "system" && sourceContent.length === 0) &&
        sourceContent.trim().length > 0
      ) {
        entries.push(Object.freeze({
          kind: "source-content" as const,
          sourceContentIndex: 0,
          piAttachment: Object.freeze({
            kind: "message-content" as const,
            messageIndex: sourceMessageIndex,
            contentIndex: 0,
          }),
          candidateIds: Object.freeze([]) as readonly AnthropicCandidateId[],
        }));
      }
    } else {
      for (const [sourceContentIndex, block] of (
        sourceContent as Array<Record<string, unknown>>
      ).entries()) {
        const key = `${sourceMessageIndex}:${sourceContentIndex}`;
        if (ignoredContentBlocks.has(key)) continue;
        entries.push(...repairEntries(sourceMessageIndex, sourceContentIndex));
        if (firstMessageSystem && block.type === "text") continue;
        if (
          message.role === "system" &&
          block.type === "text" &&
          block.text === ""
        ) continue;
        const ids = [
          ...(contentIds.get(key) ?? []),
          ...(cacheIds.get(key) ?? []),
        ];
        const normalized = withoutContentCandidateOnlyFields(
          block,
          `$.messages[${sourceMessageIndex}].content[${sourceContentIndex}]`,
        );
        const representation = contentPiRepresentation(
          normalized as Record<string, unknown>,
        );
        entries.push(Object.freeze({
          kind: "source-content" as const,
          sourceContentIndex,
          ...(representation === "none"
            ? {}
            : {
                piAttachment: Object.freeze({
                  kind: "message-content" as const,
                  messageIndex: sourceMessageIndex,
                  contentIndex: sourceContentIndex,
                }),
              }),
          candidateIds: Object.freeze(ids),
        }));
      }
    }
    if (entries.length === 0) continue;
    messages.push(Object.freeze({
      sourceMessageIndex,
      effectiveRole: message.role === "assistant" ? "assistant" : "user",
      entries: Object.freeze(entries),
    }));
  }
  const repairsAfterHistory = repairEntries(request.messages.length, undefined);
  if (repairsAfterHistory.length > 0) {
    messages.push(Object.freeze({
      sourceMessageIndex: request.messages.length,
      effectiveRole: "user" as const,
      entries: repairsAfterHistory,
    }));
  }
  return Object.freeze({ messages: Object.freeze(messages) });
}

export function convertValidatedAnthropicRequest(
  request: ValidatedAnthropicSourceRequest,
  receivedAt: number,
): AnthropicRequestConversion {
  return convertValidatedAnthropicRequestWithPolicy(request, receivedAt, {
    unknownContent: "error",
  });
}

export function convertValidatedAnthropicRequestWithPolicy(
  request: ValidatedAnthropicSourceRequest,
  receivedAt: number,
  policy: AnthropicRequestConversionPolicy,
): AnthropicRequestConversion {
  const notices: ConversionNotice[] = [];
  if (
    request.reasoning.effort.kind === "specified" &&
    request.reasoning.effort.normalizedFromUnknown !== undefined
  ) {
    notices.push(
      requestNotice(
        UNKNOWN_EFFORT_FALLBACK_NOTICE_CODE,
        "degrade",
        "$.output_config.effort",
      ),
    );
  }
  for (const key of request.unclaimedTopLevelKeys) {
    notices.push(requestNotice(
      UNCLAIMED_REQUEST_FIELD_NOTICE_CODE,
      "ignore",
      `$.${key}`,
    ));
  }
  const messages: Message[] = [];
  const reasoningHistory: AnthropicReasoningSemantics["history"][number][] = [];
  const reasoningContinuity: AnthropicReasoningSemantics["continuity"][number][] = [];
  const knownToolNames =
    request.tools === undefined
      ? undefined
      : new Set(request.tools.map((tool) => tool.name));
  const pendingCalls: PendingToolCall[] = [];
  const seenClientCallIds = new Set<string>();
  const conversationRepairs: ConversationToolRepair[] = [];
  const ignoredContentBlocks = new Set<string>();

  const pushRepairResults = (
    jsonPath: string,
    insertion: Omit<ConversationToolRepair, "callId">,
  ): void => {
    if (pendingCalls.length === 0) return;
    for (const call of pendingCalls) {
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        isError: true,
        content: [{ type: "text", text: INCOMPLETE_TOOL_CALL_RESULT_TEXT }],
        timestamp: receivedAt,
      });
      conversationRepairs.push(Object.freeze({
        ...insertion,
        callId: call.id,
      }));
      notices.push(
        requestNotice(
          UNRESOLVED_TOOL_CALL_REPAIRED_NOTICE_CODE,
          "degrade",
          jsonPath,
        ),
      );
    }
    pendingCalls.length = 0;
  };

  const context: Context = { messages };
  if (request.systemPrompt !== undefined) {
    context.systemPrompt = request.systemPrompt;
  }
  let hasMessageLevelSystem = false;

  const appendSystemPrompt = (text: string): void => {
    context.systemPrompt = context.systemPrompt === undefined
      ? text
      : `${context.systemPrompt}\n${text}`;
  };

  for (const [messageIndex, message] of request.messages.entries()) {
    const sourceRole = message.role as "user" | "assistant" | "system";
    const rawContent = message.content;
    const isFirstMessageLevelSystem =
      sourceRole === "system" && !hasMessageLevelSystem;
    if (isFirstMessageLevelSystem) {
      hasMessageLevelSystem = true;
      notices.push(
        requestNotice(
          MESSAGE_SYSTEM_DEGRADED_NOTICE_CODE,
          "degrade",
          "$.messages",
        ),
      );
      if (typeof rawContent === "string") {
        appendSystemPrompt(rawContent);
        continue;
      }
    }
    const role = sourceRole === "assistant" ? "assistant" : "user";
    const blocks: ConvertedBlock[] =
      typeof rawContent === "string" &&
        !(sourceRole === "system" && rawContent.length === 0)
        ? [{ type: "text", text: rawContent }]
        : [];
    const blockSourceIndexes: number[] = blocks.length === 0 ? [] : [-1];
    if (Array.isArray(rawContent)) {
      for (const [blockIndex, block] of rawContent.entries()) {
        if (
          isFirstMessageLevelSystem &&
          isRecord(block) &&
          block.type === "text"
        ) {
          appendSystemPrompt(block.text as string);
          continue;
        }
        if (
          sourceRole === "system" &&
          isRecord(block) &&
          block.type === "text" &&
          block.text === ""
        ) {
          continue;
        }
        const converted = convertBlock(
          block as Record<string, unknown>,
          pendingCalls,
          knownToolNames,
          notices,
          policy,
          `$.messages[${messageIndex}].content[${blockIndex}]`,
        );
        if (converted !== undefined) {
          blocks.push(converted);
          blockSourceIndexes.push(blockIndex);
        } else {
          ignoredContentBlocks.add(`${messageIndex}:${blockIndex}`);
        }
      }
    }

    if (role === "assistant") {
      pushRepairResults(
        `$.messages[${messageIndex}]`,
        { beforeMessageIndex: messageIndex },
      );
      const assistant = convertHistoricalAssistant(
        blocks,
        request.selector,
        receivedAt,
      );
      const previous = messages.at(-1);
      let piMessageIndex: number;
      let baseContentIndex: number;
      if (previous?.role === "assistant") {
        piMessageIndex = messages.length - 1;
        baseContentIndex = previous.content.length;
        previous.content.push(...assistant.content);
      } else {
        piMessageIndex = messages.length;
        baseContentIndex = 0;
        messages.push(assistant);
      }
      if (Array.isArray(rawContent)) {
        let representedPiContentCount = 0;
        for (const [convertedIndex, semanticBlock] of blocks.entries()) {
          const representsPiContent =
            semanticBlock.type === "text" ||
            semanticBlock.type === "thinking" ||
            semanticBlock.type === "toolUse" ||
            semanticBlock.type === "transcript";
          if (!representsPiContent) continue;
          const piContentIndex = baseContentIndex + representedPiContentCount;
          representedPiContentCount += 1;
          const sourceContentIndex = blockSourceIndexes[convertedIndex];
          if (sourceContentIndex === undefined || sourceContentIndex < 0) continue;
          const candidate = rawContent[sourceContentIndex];
          if (!isRecord(candidate)) continue;
          if (
            candidate.type === "thinking" ||
            candidate.type === "redacted_thinking"
          ) {
            reasoningHistory.push(
              Object.freeze({
                sourceMessageIndex: messageIndex,
                sourceContentIndex,
                piMessageIndex,
                piContentIndex,
                representation:
                  candidate.type === "thinking" ? "thinking" : "redacted",
              }),
            );
          }
          const decoded = decodeBlockContinuity(
            candidate,
            `$.messages[${messageIndex}].content[${sourceContentIndex}].token_continuity`,
          );
          notices.push(...decoded.notices);
          if (decoded.source !== undefined) {
            for (const attachment of decoded.attachments) {
              reasoningContinuity.push(
                Object.freeze({
                  sourceMessageIndex: messageIndex,
                  sourceContentIndex,
                  target: attachment.target,
                  ...(attachment.target === "toolCall"
                    ? { callId: attachment.callId }
                    : {}),
                  piMessageIndex,
                  piContentIndex,
                  source: decoded.source,
                  attachment,
                }),
              );
            }
          }
        }
      }
      pendingCalls.length = 0;
      for (const block of blocks) {
        if (block.type === "toolUse") {
          if (seenClientCallIds.has(block.id)) {
            throw new InvalidRequest(`Duplicate tool_use id in history: ${block.id}`);
          }
          seenClientCallIds.add(block.id);
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
    let repairedMissingCalls = false;
    const repairCallsMissingFromThisMessage = (sourceContentIndex: number): void => {
      if (repairedMissingCalls) return;
      repairedMissingCalls = true;
      pushRepairResults(
        `$.messages[${messageIndex}]`,
        { beforeMessageIndex: messageIndex, beforeContentIndex: sourceContentIndex },
      );
    };
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
    for (const [convertedIndex, block] of blocks.entries()) {
      const sourceContentIndex = Math.max(0, blockSourceIndexes[convertedIndex] ?? 0);
      if (block.type === "toolResult") {
        flushOrdinary();
        if (consumedResultIds.has(block.toolUseId)) {
          throw new InvalidRequest(
            `Orphan or duplicate tool_result id: ${block.toolUseId}`,
          );
        }
        consumedResultIds.add(block.toolUseId);
        const callIndex = pendingCalls.findIndex(
          (call) => call.id === block.toolUseId,
        );
        if (callIndex < 0) {
          throw new InvalidRequest(
            `Orphan or duplicate tool_result id: ${block.toolUseId}`,
          );
        }
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
        pendingCalls.splice(callIndex, 1);
      } else if (block.type === "transcript") {
        repairCallsMissingFromThisMessage(sourceContentIndex);
        ordinary.push({ type: "text", text: block.text });
      } else if (block.type === "toolUse") {
        throw new InvalidRequest(
          "tool_use is valid only in an assistant turn",
        );
      } else if (block.type === "thinking") {
        throw new InvalidRequest(
          "thinking is valid only in an assistant turn",
        );
      } else if (block.type === "supplementOnly") {
        repairCallsMissingFromThisMessage(sourceContentIndex);
      } else {
        repairCallsMissingFromThisMessage(sourceContentIndex);
        ordinary.push(block);
      }
    }
    flushOrdinary();
    if (sourceContentWasEmpty) {
      repairCallsMissingFromThisMessage(0);
      if (sourceRole !== "system") {
        // An explicitly empty source user message is preserved as an empty
        // UserMessage (frozen grammar boundary). Compatibility system turns
        // have no ordinary fragment after promotion and therefore disappear.
        messages.push({ role: "user", content: [], timestamp: receivedAt });
      }
    }
  }

  pushRepairResults(
    "$.messages",
    { beforeMessageIndex: request.messages.length },
  );

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
  if (request.reasoning.activation.kind === "enabled") {
    const budget = request.reasoning.activation.budgetTokens;
    const level =
      request.reasoning.effort.kind === "specified"
        ? request.reasoning.effort.level
        : budgetLevel(budget);
    const budgets: NonNullable<typeof options.thinkingBudgets> = {
      [level === "xhigh" || level === "max" ? "high" : level]:
        budget,
    };
    options.thinkingBudgets = Object.freeze(budgets);
  }
  if (request.metadataUserId.kind === "specified") {
    options.metadata = Object.freeze({ user_id: request.metadataUserId.value });
  }

  const requestSource = (path: string) =>
    Object.freeze({ kind: "request" as const, path });
  const presenceValue = <T>(presence: AnthropicPresence<T>): T | null | undefined =>
    presence.kind === "omitted"
      ? undefined
      : presence.kind === "explicit-null"
        ? null
        : presence.value;
  const contentSupplement = buildContentSupplement(request);
  const toolSupplement = buildToolSupplement(request.tools);
  const cacheSupplement = buildCacheSupplement(request, ignoredContentBlocks);
  const systemSupplement = buildSystemSupplement(request);
  const outputFormat = presenceValue(request.outputFormat);
  const metadataUserId = presenceValue(request.metadataUserId);
  const serviceTier = presenceValue(request.serviceTier);
  const inferenceGeo = presenceValue(request.inferenceGeo);
  const container = presenceValue(request.container);
  const controls: AnthropicProjectionSupplement["controls"] = Object.freeze({
    outputTokenCeiling: Object.freeze({
      id: anthropicCandidateId("maxTokens"),
      kind: "output-token-ceiling" as const,
      writer: "ceiling-verifier" as const,
      source: requestSource("$.max_tokens"),
      value: request.maxTokens,
    }),
    ...(request.temperature === undefined
      ? {}
      : {
          temperature: Object.freeze({
            id: anthropicCandidateId("sampling.temperature"),
            kind: "pi-verification" as const,
            writer: "pi-verifier" as const,
            source: requestSource("$.temperature"),
            value: request.temperature,
          }),
        }),
    ...(request.topP === undefined
      ? {}
      : {
          topP: Object.freeze({
            id: anthropicCandidateId("sampling.topP"),
            kind: "pi-first-projection" as const,
            writer: "pi-first-projector" as const,
            source: requestSource("$.top_p"),
            value: request.topP,
          }),
        }),
    ...(request.topK === undefined
      ? {}
      : {
          topK: Object.freeze({
            id: anthropicCandidateId("sampling.topK"),
            kind: "pi-first-projection" as const,
            writer: "pi-first-projector" as const,
            source: requestSource("$.top_k"),
            value: request.topK,
          }),
        }),
    ...(request.stopSequences === undefined
      ? {}
      : {
          stopSequences: Object.freeze({
            id: anthropicCandidateId("stopSequences"),
            kind: "target-projection" as const,
            writer: "target-projector" as const,
            source: requestSource("$.stop_sequences"),
            value: Object.freeze([...request.stopSequences]),
          }),
        }),
    ...(request.toolChoice === undefined
      ? {}
      : {
          toolChoice: Object.freeze({
            id: anthropicCandidateId("toolChoice"),
            kind: "tool-choice" as const,
            writer: "target-projector" as const,
            source: requestSource("$.tool_choice"),
            value: Object.freeze({ ...request.toolChoice }),
          }),
        }),
    ...(outputFormat === undefined
      ? {}
      : {
          outputFormat: Object.freeze({
            id: anthropicCandidateId("outputFormat"),
            kind: "target-projection" as const,
            writer: "target-projector" as const,
            source: requestSource("$.output_config.format"),
            value: outputFormat === null
              ? null
              : Object.freeze({ ...outputFormat }),
          }),
        }),
    ...(metadataUserId === undefined
      ? {}
      : {
          metadataUserId: Object.freeze({
            id: anthropicCandidateId("metadataUserId"),
            kind: "pi-first-projection" as const,
            writer: "pi-first-projector" as const,
            source: requestSource("$.metadata.user_id"),
            value: metadataUserId,
          }),
        }),
    ...(serviceTier === undefined
      ? {}
      : {
          serviceTier: Object.freeze({
            id: anthropicCandidateId("serviceTier"),
            kind: "target-projection" as const,
            writer: "target-projector" as const,
            source: requestSource("$.service_tier"),
            value: serviceTier,
          }),
        }),
    ...(inferenceGeo === undefined
      ? {}
      : {
          inferenceGeo: Object.freeze({
            id: anthropicCandidateId("inferenceGeo"),
            kind: "target-projection" as const,
            writer: "target-projector" as const,
            source: requestSource("$.inference_geo"),
            value: inferenceGeo,
          }),
        }),
    ...(container === undefined
      ? {}
      : {
          container: Object.freeze({
            id: anthropicCandidateId("container"),
            kind: "target-projection" as const,
            writer: "target-projector" as const,
            source: requestSource("$.container"),
            value: container,
          }),
        }),
    ...(request.finalAssistantPrefill
      ? {
          finalAssistantPrefill: Object.freeze({
            id: anthropicCandidateId("finalAssistantPrefill"),
            kind: "target-projection" as const,
            writer: "target-projector" as const,
            source: requestSource("$.messages"),
            value: true as const,
          }),
        }
      : {}),
  });
  const supplement: AnthropicProjectionSupplement = Object.freeze({
    controls,
    system: systemSupplement,
    conversation: buildConversationLayout(
      request,
      contentSupplement,
      cacheSupplement,
      conversationRepairs,
      ignoredContentBlocks,
    ),
    content: contentSupplement,
    tools: toolSupplement,
    cache: cacheSupplement,
  });
  const reasoning: AnthropicReasoningSemantics = Object.freeze({
    activation: request.reasoning.activation,
    effort: request.reasoning.effort,
    history: Object.freeze(reasoningHistory),
    continuity: Object.freeze(reasoningContinuity),
  });

  return {
    selector: request.selector,
    invocation: {
      pi: { context, options },
      reasoning,
      supplement,
    },
    client: {
      renderState: {
        selector: request.selector,
        stream: request.stream,
        directToolNames: Object.freeze(
          request.tools
            ?.filter((tool) => tool.kind === "custom")
            .map((tool) => tool.name) ?? [],
        ),
        thinkingDisplay:
          request.reasoning.activation.kind === "enabled" ||
          request.reasoning.activation.kind === "adaptive"
            ? request.reasoning.activation.display
            : Object.freeze({ kind: "omitted" as const }),
      },
      notices: Object.freeze(notices),
    },
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
    { unknownContent: "error" },
  );
}
