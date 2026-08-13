import type { AssistantMessage } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import type { ConversionNotice } from "../../invocation-diagnostics/index.js";

export class OutboundResponseFidelityFailure extends Error {
  readonly kind = "OutboundResponseFidelityFailure";

  constructor(message: string) {
    super(message);
    this.name = "OutboundResponseFidelityFailure";
  }
}

export interface AnthropicTextBlock {
  citations: null;
  text: string;
  type: "text";
}

export interface AnthropicThinkingBlock {
  signature: string;
  thinking: string;
  type: "thinking";
}

export interface AnthropicRedactedThinkingBlock {
  data: string;
  type: "redacted_thinking";
}

export interface AnthropicToolUseBlock {
  id: string;
  caller: { type: "direct" };
  input: Record<string, JsonValue>;
  name: string;
  type: "tool_use";
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface AnthropicResponseUsage {
  cache_creation: {
    ephemeral_1h_input_tokens: number;
    ephemeral_5m_input_tokens: number;
  } | null;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  inference_geo: null;
  input_tokens: number;
  output_tokens: number;
  output_tokens_details: { thinking_tokens: number } | null;
  server_tool_use: null;
  service_tier: null;
}

export interface AnthropicResponseMessage {
  id: string;
  container: null;
  content: Array<
    | AnthropicTextBlock
    | AnthropicThinkingBlock
    | AnthropicRedactedThinkingBlock
    | AnthropicToolUseBlock
  >;
  model: string;
  role: "assistant";
  stop_details: null;
  stop_reason: "end_turn" | "max_tokens" | "tool_use";
  stop_sequence: null;
  type: "message";
  usage: AnthropicResponseUsage;
}

export type AnthropicTextMessage = AnthropicResponseMessage;

export interface AnthropicResponseConversion {
  readonly message: AnthropicResponseMessage;
  readonly notices: readonly ConversionNotice[];
}

export interface AnthropicResponseRenderState {
  readonly selector: string;
  readonly createMessageId?: () => string;
}

export interface AnthropicResponseConversionPolicy {
  readonly unknownPiContent: "error" | "ignore";
}

const ASSISTANT_MESSAGE_FIELDS = new Set([
  "role",
  "content",
  "api",
  "provider",
  "model",
  "responseModel",
  "responseId",
  "diagnostics",
  "usage",
  "stopReason",
  "deferred",
  "errorMessage",
  "rawStopReason",
  "endTurn",
  "timestamp",
]);
const USAGE_FIELDS = new Set([
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cacheWrite1h",
  "reasoning",
  "totalTokens",
  "cost",
]);

export const MISSING_THINKING_SIGNATURE_NOTICE_CODE =
  "anthropic_missing_thinking_signature";
export const UNKNOWN_PI_CONTENT_IGNORED_NOTICE_CODE =
  "anthropic_unknown_pi_content_ignored";
export const STOP_REASON_NORMALIZED_NOTICE_CODE =
  "anthropic_stop_reason_normalized";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseNotice(
  code: string,
  action: ConversionNotice["action"],
  jsonPath?: string,
): ConversionNotice {
  return Object.freeze({
    adapter: "anthropic-messages",
    direction: "response",
    code,
    ...(jsonPath === undefined ? {} : { jsonPath }),
    action,
  });
}

function assertAllowedFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new OutboundResponseFidelityFailure(
      `${field} contains an unclassified field: ${unknown}`,
    );
  }
}

function copyJsonValue(
  value: unknown,
  ancestors: Set<object>,
  field: string,
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new OutboundResponseFidelityFailure(
        `${field} contains a non-lossless JSON number`,
      );
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new OutboundResponseFidelityFailure(
      `${field} contains a non-JSON value`,
    );
  }
  if (ancestors.has(value)) {
    throw new OutboundResponseFidelityFailure(`${field} contains a cycle`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index)) ||
        Object.getOwnPropertySymbols(value).length > 0
      ) {
        throw new OutboundResponseFidelityFailure(
          `${field} contains a sparse or extended array`,
        );
      }
      return value.map((entry, index) =>
        copyJsonValue(entry, ancestors, `${field}[${index}]`),
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new OutboundResponseFidelityFailure(
        `${field} contains a non-semantic JSON object`,
      );
    }
    const keys = Object.keys(value);
    if (Reflect.ownKeys(value).length !== keys.length) {
      throw new OutboundResponseFidelityFailure(
        `${field} contains non-JSON object properties`,
      );
    }
    const copied: Record<string, JsonValue> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new OutboundResponseFidelityFailure(
          `${field} contains an accessor or custom serialization`,
        );
      }
      copied[key] = copyJsonValue(
        descriptor.value,
        ancestors,
        `${field}.${key}`,
      );
    }
    return copied;
  } finally {
    ancestors.delete(value);
  }
}

function copyToolInput(value: unknown, field: string): Record<string, JsonValue> {
  if (!isRecord(value)) {
    throw new OutboundResponseFidelityFailure(
      `${field} must be a non-null, non-array JSON object`,
    );
  }
  const copied = copyJsonValue(value, new Set(), field);
  if (!isRecord(copied)) {
    throw new OutboundResponseFidelityFailure(
      `${field} must remain an object after validation`,
    );
  }
  return copied as Record<string, JsonValue>;
}

function requireCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OutboundResponseFidelityFailure(
      `${field} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function convertUsage(message: AssistantMessage): AnthropicResponseUsage {
  const usage = message.usage as unknown;
  if (!isRecord(usage)) {
    throw new OutboundResponseFidelityFailure("Pi usage must be an object");
  }
  assertAllowedFields(usage, USAGE_FIELDS, "Pi usage");
  const input = requireCount(usage.input, "usage.input");
  const output = requireCount(usage.output, "usage.output");
  const cacheRead = requireCount(usage.cacheRead, "usage.cacheRead");
  const cacheWrite = requireCount(usage.cacheWrite, "usage.cacheWrite");

  let outputDetails: { thinking_tokens: number } | null = null;
  if (usage.reasoning !== undefined) {
    const reasoning = requireCount(usage.reasoning, "usage.reasoning");
    if (reasoning > output) {
      throw new OutboundResponseFidelityFailure(
        "usage.reasoning must be a subset of usage.output",
      );
    }
    outputDetails = { thinking_tokens: reasoning };
  }

  let cacheCreation: AnthropicResponseUsage["cache_creation"] = null;
  if (usage.cacheWrite1h !== undefined) {
    const cacheWrite1h = requireCount(
      usage.cacheWrite1h,
      "usage.cacheWrite1h",
    );
    if (cacheWrite1h > cacheWrite) {
      throw new OutboundResponseFidelityFailure(
        "usage.cacheWrite1h must be a subset of usage.cacheWrite",
      );
    }
    cacheCreation = {
      ephemeral_1h_input_tokens: cacheWrite1h,
      ephemeral_5m_input_tokens: cacheWrite - cacheWrite1h,
    };
  }

  return {
    cache_creation: cacheCreation,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    inference_geo: null,
    input_tokens: input,
    output_tokens: output,
    output_tokens_details: outputDetails,
    server_tool_use: null,
    service_tier: null,
  };
}

function convertContent(
  message: AssistantMessage,
  notices: ConversionNotice[],
  policy: AnthropicResponseConversionPolicy,
): Array<
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicToolUseBlock
> {
  const projected: Array<
    | AnthropicTextBlock
    | AnthropicThinkingBlock
    | AnthropicRedactedThinkingBlock
    | AnthropicToolUseBlock
  > = [];
  message.content.forEach((block, index) => {
    const raw = block as unknown;
    if (!isRecord(raw) || typeof raw.type !== "string") {
      throw new OutboundResponseFidelityFailure(
        `Pi content[${index}] must be a tagged object`,
      );
    }
    const path = `$.content[${index}]`;
    if (raw.type === "thinking") {
      assertAllowedFields(
        raw,
        new Set(["type", "thinking", "thinkingSignature", "redacted"]),
        `Pi content[${index}]`,
      );
      if (typeof raw.thinking !== "string") {
        throw new OutboundResponseFidelityFailure(
          `Pi content[${index}].thinking must be a string`,
        );
      }
      if (
        raw.thinkingSignature !== undefined &&
        typeof raw.thinkingSignature !== "string"
      ) {
        throw new OutboundResponseFidelityFailure(
          `Pi content[${index}].thinkingSignature must be a string when present`,
        );
      }
      if (raw.redacted !== undefined && typeof raw.redacted !== "boolean") {
        throw new OutboundResponseFidelityFailure(
          `Pi content[${index}].redacted must be a boolean when present`,
        );
      }
      if (raw.redacted === true) {
        const data = raw.thinkingSignature;
        if (typeof data !== "string" || data.length === 0) {
          throw new OutboundResponseFidelityFailure(
            `Pi content[${index}] redacted thinking requires opaque data`,
          );
        }
        projected.push({ data, type: "redacted_thinking" });
        return;
      }
      const signature = raw.thinkingSignature;
      if (signature === undefined) {
        notices.push(
          responseNotice(
            MISSING_THINKING_SIGNATURE_NOTICE_CODE,
            "degrade",
            `${path}.thinkingSignature`,
          ),
        );
      }
      projected.push({
        signature: signature ?? "",
        thinking: raw.thinking,
        type: "thinking",
      });
      return;
    }
    if (raw.type === "text") {
      assertAllowedFields(
        raw,
        new Set(["type", "text", "textSignature"]),
        `Pi content[${index}]`,
      );
      if (typeof raw.text !== "string") {
        throw new OutboundResponseFidelityFailure(
          `Pi content[${index}].text must be a string`,
        );
      }
      projected.push({ citations: null, text: raw.text, type: "text" });
      return;
    }
    if (raw.type === "toolCall") {
      assertAllowedFields(
        raw,
        new Set([
          "type",
          "id",
          "name",
          "arguments",
          "thoughtSignature",
          "namespace",
        ]),
        `Pi content[${index}]`,
      );
      if (
        typeof raw.id !== "string" ||
        raw.id.length === 0 ||
        typeof raw.name !== "string" ||
        raw.name.length === 0
      ) {
        throw new OutboundResponseFidelityFailure(
          `Pi content[${index}] tool identity must be non-empty strings`,
        );
      }
      projected.push({
        id: raw.id,
        caller: { type: "direct" },
        input: copyToolInput(raw.arguments, `Pi content[${index}].arguments`),
        name: raw.name,
        type: "tool_use",
      });
      return;
    }
    if (policy.unknownPiContent === "ignore") {
      notices.push(
        responseNotice(
          UNKNOWN_PI_CONTENT_IGNORED_NOTICE_CODE,
          "ignore",
          `${path}.type`,
        ),
      );
      return;
    }
    throw new OutboundResponseFidelityFailure(
      `Unsupported Pi assistant content: ${String(raw.type)}`,
    );
  });
  return projected;
}

function resolveStopReason(
  message: AssistantMessage,
  projected: Array<
    | AnthropicTextBlock
    | AnthropicThinkingBlock
    | AnthropicRedactedThinkingBlock
    | AnthropicToolUseBlock
  >,
): { stopReason: AnthropicResponseMessage["stop_reason"]; mismatch: boolean } {
  if (message.stopReason === "length") {
    return { stopReason: "max_tokens", mismatch: false };
  }
  if (
    message.stopReason === "stop" ||
    message.stopReason === "toolUse"
  ) {
    const hasToolUse = projected.some((block) => block.type === "tool_use");
    if (hasToolUse) {
      return { stopReason: "tool_use", mismatch: message.stopReason !== "toolUse" };
    }
    return { stopReason: "end_turn", mismatch: message.stopReason !== "stop" };
  }
  // pending/error/aborted/deferred and any future stop reason are not
  // committed success terminals; projecting them into a legal Anthropic
  // stop_reason would fabricate success. They are handled by execution/error
  // boundaries and must never reach the converter.
  throw new OutboundResponseFidelityFailure(
    `Unsupported Pi stop reason: ${String(message.stopReason)}`,
  );
}

function assertMessageEnvelope(message: AssistantMessage): void {
  const raw = message as unknown;
  if (!isRecord(raw)) {
    throw new OutboundResponseFidelityFailure(
      "Committed Pi message must be an object",
    );
  }
  assertAllowedFields(raw, ASSISTANT_MESSAGE_FIELDS, "Committed Pi message");
  if (raw.role !== "assistant") {
    throw new OutboundResponseFidelityFailure(
      "Committed Pi message must have assistant role",
    );
  }
  if (!Array.isArray(raw.content)) {
    throw new OutboundResponseFidelityFailure(
      "Committed Pi message content must be an array",
    );
  }
  if (raw.deferred !== undefined) {
    throw new OutboundResponseFidelityFailure(
      "Deferred Pi state is outside the Anthropic v1 renderer",
    );
  }
}

function validResponseId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    return Object.freeze(value);
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function createResponseId(
  message: AssistantMessage,
  renderState: AnthropicResponseRenderState,
): string {
  if (validResponseId(message.responseId)) {
    return message.responseId;
  }
  if (renderState.createMessageId !== undefined) {
    const generated = renderState.createMessageId();
    if (validResponseId(generated)) return generated;
  }
  return `msg_${randomUUID()}`;
}

export function convertAssistantMessageToAnthropic(
  message: AssistantMessage,
  clientModel: string,
  messageId: string,
): AnthropicResponseMessage {
  return convertAssistantMessageToAnthropicWithPolicy(
    message,
    { selector: clientModel, createMessageId: () => messageId },
    { unknownPiContent: "error" },
  ).message;
}

export function convertAssistantMessageToAnthropicWithPolicy(
  message: AssistantMessage,
  renderState: AnthropicResponseRenderState,
  policy: AnthropicResponseConversionPolicy,
): AnthropicResponseConversion {
  const selector = renderState.selector;
  if (typeof selector !== "string" || selector.length === 0) {
    throw new OutboundResponseFidelityFailure(
      "Anthropic response selector must be a non-empty string",
    );
  }
  assertMessageEnvelope(message);
  const notices: ConversionNotice[] = [];
  const id = createResponseId(message, renderState);
  const content = convertContent(message, notices, policy);
  const stop = resolveStopReason(message, content);
  if (stop.mismatch) {
    notices.push(
      responseNotice(
        STOP_REASON_NORMALIZED_NOTICE_CODE,
        "degrade",
        "$.stop_reason",
      ),
    );
  }
  const usage = convertUsage(message);
  const result: AnthropicResponseMessage = {
    id,
    container: null,
    content,
    model: selector,
    role: "assistant",
    stop_details: null,
    stop_reason: stop.stopReason,
    stop_sequence: null,
    type: "message",
    usage,
  };
  return {
    message: deepFreeze(result),
    notices: deepFreeze(notices),
  };
}

export function assertOutboundResponseFidelity(message: AssistantMessage): void {
  assertMessageEnvelope(message);
  convertContent(message, [], { unknownPiContent: "error" });
  convertUsage(message);
}

export function renderAnthropicTextMessage(
  message: AssistantMessage,
  clientModel: string,
  messageId: string,
): AnthropicResponseMessage {
  return convertAssistantMessageToAnthropic(message, clientModel, messageId);
}
