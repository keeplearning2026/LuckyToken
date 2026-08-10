import type { AssistantMessage } from "@earendil-works/pi-ai";

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
  content: Array<AnthropicTextBlock | AnthropicToolUseBlock>;
  model: string;
  role: "assistant";
  stop_details: null;
  stop_reason: "end_turn" | "max_tokens" | "tool_use";
  stop_sequence: null;
  type: "message";
  usage: AnthropicResponseUsage;
}

export type AnthropicTextMessage = AnthropicResponseMessage;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
): Array<AnthropicTextBlock | AnthropicToolUseBlock> {
  return message.content.map((block, index) => {
    const raw = block as unknown;
    if (!isRecord(raw) || typeof raw.type !== "string") {
      throw new OutboundResponseFidelityFailure(
        `Pi content[${index}] must be a tagged object`,
      );
    }
    if (raw.type === "thinking") {
      throw new OutboundResponseFidelityFailure(
        "ThinkingContent is outside the certified Anthropic v1 response path",
      );
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
      return { citations: null, text: raw.text, type: "text" };
    }
    if (raw.type !== "toolCall") {
      throw new OutboundResponseFidelityFailure(
        `Unsupported Pi assistant content: ${raw.type}`,
      );
    }
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
    return {
      id: raw.id,
      caller: { type: "direct" },
      input: copyToolInput(raw.arguments, `Pi content[${index}].arguments`),
      name: raw.name,
      type: "tool_use",
    };
  });
}

function convertStopReason(
  stopReason: AssistantMessage["stopReason"],
): AnthropicResponseMessage["stop_reason"] {
  if (stopReason === "stop") return "end_turn";
  if (stopReason === "length") return "max_tokens";
  if (stopReason === "toolUse") return "tool_use";
  throw new OutboundResponseFidelityFailure(
    `Unsupported committed Pi stop reason: ${stopReason}`,
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
  convertStopReason(message.stopReason);
}

export function assertOutboundResponseFidelity(message: AssistantMessage): void {
  assertMessageEnvelope(message);
  convertContent(message);
  convertUsage(message);
}

export function convertAssistantMessageToAnthropic(
  message: AssistantMessage,
  clientModel: string,
  messageId: string,
): AnthropicResponseMessage {
  if (
    typeof clientModel !== "string" ||
    clientModel.length === 0 ||
    typeof messageId !== "string" ||
    messageId.length === 0
  ) {
    throw new OutboundResponseFidelityFailure(
      "Anthropic response identity must be non-empty strings",
    );
  }
  assertMessageEnvelope(message);
  const content = convertContent(message);
  const stopReason = convertStopReason(message.stopReason);
  const usage = convertUsage(message);
  return {
    id: messageId,
    container: null,
    content,
    model: clientModel,
    role: "assistant",
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: null,
    type: "message",
    usage,
  };
}

export function renderAnthropicTextMessage(
  message: AssistantMessage,
  clientModel: string,
  messageId: string,
): AnthropicResponseMessage {
  return convertAssistantMessageToAnthropic(message, clientModel, messageId);
}
