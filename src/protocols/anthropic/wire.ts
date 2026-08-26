import {
  type AnthropicResponseMessage,
  OutboundResponseFidelityFailure,
} from "./response.js";

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "billing_error"
  | "permission_error"
  | "not_found_error"
  | "conflict_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"
  | "timeout_error"
  | "overloaded_error";

export interface PreparedHttpResponse {
  readonly status: number;
  readonly contentType: "application/json" | "text/event-stream";
  readonly body: Uint8Array<ArrayBuffer>;
  readonly headers?: Readonly<Record<string, string>>;
}

const MESSAGE_FIELDS = new Set([
  "id",
  "container",
  "content",
  "model",
  "role",
  "stop_details",
  "stop_reason",
  "stop_sequence",
  "type",
  "usage",
]);
const USAGE_FIELDS = new Set([
  "cache_creation",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "inference_geo",
  "input_tokens",
  "output_tokens",
  "output_tokens_details",
  "server_tool_use",
  "service_tier",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new OutboundResponseFidelityFailure(message);
}

function assertExactFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
  label: string,
): void {
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    fail(`${label} does not have its exact schema fields`);
  }
}

function contentFields(
  block: Record<string, unknown>,
  required: readonly string[],
): ReadonlySet<string> {
  return new Set([
    ...required,
    ...(block.token_continuity === undefined
      ? []
      : ["token_continuity"]),
  ]);
}

function assertContinuityExtension(
  block: Record<string, unknown>,
  label: string,
): void {
  if (block.token_continuity === undefined) return;
  assertJsonValue(
    block.token_continuity,
    new Set(),
    `${label}.token_continuity`,
  );
}

function assertCount(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
}

function assertJsonValue(
  value: unknown,
  ancestors: Set<object>,
  label: string,
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail(`${label} contains a non-lossless JSON number`);
    }
    return;
  }
  if (typeof value !== "object") fail(`${label} contains a non-JSON value`);
  if (ancestors.has(value)) fail(`${label} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      const propertyNames = Object.getOwnPropertyNames(value);
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index)) ||
        Object.getOwnPropertySymbols(value).length > 0 ||
        propertyNames.length !== keys.length + 1 ||
        propertyNames.some((key) => key !== "length" && !keys.includes(key))
      ) {
        fail(`${label} contains a sparse or extended array`);
      }
      value.forEach((entry, index) =>
        assertJsonValue(entry, ancestors, `${label}[${index}]`),
      );
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(`${label} contains a non-semantic JSON object`);
    }
    const keys = Object.keys(value);
    if (Reflect.ownKeys(value).length !== keys.length) {
      fail(`${label} contains non-JSON object properties`);
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        fail(`${label} contains an accessor or custom serialization`);
      }
      assertJsonValue(descriptor.value, ancestors, `${label}.${key}`);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function assertAnthropicTargetSchema(
  target: AnthropicResponseMessage,
): void {
  const raw = target as unknown;
  if (!isRecord(raw)) fail("Anthropic target Message must be an object");
  assertExactFields(raw, MESSAGE_FIELDS, "Anthropic target Message");
  if (
    typeof raw.id !== "string" ||
    raw.id.length === 0 ||
    typeof raw.model !== "string" ||
    raw.model.length === 0 ||
    raw.container !== null ||
    raw.role !== "assistant" ||
    raw.stop_details !== null ||
    raw.stop_sequence !== null ||
    raw.type !== "message" ||
    !["end_turn", "max_tokens", "tool_use", "refusal"].includes(
      raw.stop_reason as string,
    ) ||
    !Array.isArray(raw.content)
  ) {
    fail("Anthropic target Message envelope is malformed");
  }

  raw.content.forEach((block, index) => {
    if (!isRecord(block)) fail(`Anthropic content[${index}] must be an object`);
    if (block.type === "text") {
      assertExactFields(
        block,
        contentFields(block, ["citations", "text", "type"]),
        `Anthropic content[${index}]`,
      );
      if (block.citations !== null || typeof block.text !== "string") {
        fail(`Anthropic content[${index}] TextBlock is malformed`);
      }
      assertContinuityExtension(block, `Anthropic content[${index}]`);
      return;
    }
    if (block.type === "thinking") {
      assertExactFields(
        block,
        contentFields(block, ["signature", "thinking", "type"]),
        `Anthropic content[${index}]`,
      );
      if (
        typeof block.thinking !== "string" ||
        typeof block.signature !== "string"
      ) {
        fail(`Anthropic content[${index}] ThinkingBlock is malformed`);
      }
      assertContinuityExtension(block, `Anthropic content[${index}]`);
      return;
    }
    if (block.type === "redacted_thinking") {
      assertExactFields(
        block,
        contentFields(block, ["data", "type"]),
        `Anthropic content[${index}]`,
      );
      if (typeof block.data !== "string" || block.data.length === 0) {
        fail(`Anthropic content[${index}] RedactedThinkingBlock is malformed`);
      }
      assertContinuityExtension(block, `Anthropic content[${index}]`);
      return;
    }
    if (block.type !== "tool_use") {
      fail(`Anthropic content[${index}] has an unsupported type`);
    }
    assertExactFields(
      block,
      contentFields(block, ["id", "caller", "input", "name", "type"]),
      `Anthropic content[${index}]`,
    );
    if (
      typeof block.id !== "string" ||
      block.id.length === 0 ||
      typeof block.name !== "string" ||
      block.name.length === 0 ||
      !isRecord(block.caller) ||
      Object.keys(block.caller).length !== 1 ||
      block.caller.type !== "direct" ||
      !isRecord(block.input)
    ) {
      fail(`Anthropic content[${index}] ToolUseBlock is malformed`);
    }
    assertJsonValue(block.input, new Set(), `Anthropic content[${index}].input`);
    assertContinuityExtension(block, `Anthropic content[${index}]`);
  });

  if (!isRecord(raw.usage)) fail("Anthropic target usage must be an object");
  assertExactFields(raw.usage, USAGE_FIELDS, "Anthropic target usage");
  for (const field of [
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "input_tokens",
    "output_tokens",
  ]) {
    assertCount(raw.usage[field], `Anthropic usage.${field}`);
  }
  if (
    raw.usage.inference_geo !== null ||
    raw.usage.server_tool_use !== null ||
    raw.usage.service_tier !== null
  ) {
    fail("Anthropic target usage required-nullable fields are malformed");
  }
  if (raw.usage.cache_creation !== null) {
    if (!isRecord(raw.usage.cache_creation)) {
      fail("Anthropic target cache_creation must be an object or null");
    }
    assertExactFields(
      raw.usage.cache_creation,
      new Set(["ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens"]),
      "Anthropic target cache_creation",
    );
    const cache1h = raw.usage.cache_creation.ephemeral_1h_input_tokens;
    const cache5m = raw.usage.cache_creation.ephemeral_5m_input_tokens;
    assertCount(cache1h, "Anthropic usage cache 1h");
    assertCount(cache5m, "Anthropic usage cache 5m");
    if (
      (cache1h as number) + (cache5m as number) !==
      (raw.usage.cache_creation_input_tokens as number)
    ) {
      fail("Anthropic target cache creation breakdown is inconsistent");
    }
  }
  if (raw.usage.output_tokens_details !== null) {
    if (!isRecord(raw.usage.output_tokens_details)) {
      fail("Anthropic target output_tokens_details must be an object or null");
    }
    assertExactFields(
      raw.usage.output_tokens_details,
      new Set(["thinking_tokens"]),
      "Anthropic target output_tokens_details",
    );
    const thinking = raw.usage.output_tokens_details.thinking_tokens;
    assertCount(thinking, "Anthropic usage thinking tokens");
    if (
      (thinking as number) > (raw.usage.output_tokens as number)
    ) {
      fail("Anthropic target thinking usage exceeds output usage");
    }
  }
  assertJsonValue(target, new Set(), "Anthropic target Message");
}

function encodeJson(value: unknown): Uint8Array<ArrayBuffer> {
  let json: string;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) fail("Anthropic JSON serialization produced no body");
    json = serialized;
  } catch (error) {
    if (error instanceof OutboundResponseFidelityFailure) throw error;
    throw new OutboundResponseFidelityFailure("Anthropic JSON serialization failed");
  }
  return new TextEncoder().encode(json);
}

export function renderAnthropicJsonSuccess(
  target: AnthropicResponseMessage,
): PreparedHttpResponse {
  assertAnthropicTargetSchema(target);
  return {
    status: 200,
    contentType: "application/json",
    body: encodeJson(target),
  };
}

export function renderAnthropicError(
  status: number,
  type: string,
  message: string,
  requestId?: string,
  safeHeaders?: Readonly<Record<string, string>>,
): PreparedHttpResponse {
  if (!ANTHROPIC_ERROR_TYPES.has(type)) {
    throw new OutboundResponseFidelityFailure(
      `Unsafe Anthropic error type: ${type}`,
    );
  }
  const sanitizedMessage = sanitizeErrorText(message);
  const error = {
    type: "error",
    error: { type, message: sanitizedMessage },
    ...(requestId === undefined ? {} : { request_id: requestId }),
  };
  return {
    status,
    contentType: "application/json",
    ...(safeHeaders === undefined
      ? {}
      : { headers: Object.freeze({ ...safeHeaders }) }),
    body: encodeJson(error),
  };
}

const ANTHROPIC_ERROR_TYPES: ReadonlySet<string> = new Set([
  "invalid_request_error",
  "authentication_error",
  "billing_error",
  "permission_error",
  "not_found_error",
  "conflict_error",
  "request_too_large",
  "rate_limit_error",
  "api_error",
  "timeout_error",
  "overloaded_error",
]);

function sanitizeErrorText(value: string): string {
  const withoutControls = value.replace(/[\u0000-\u001f\u007f]/gu, " ");
  const bounded = withoutControls.slice(0, 4_096);
  return bounded
    .replace(/\b(?:bearer|basic)\s+\S+/giu, "[REDACTED]")
    .replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9._-]{8,}\b/giu, "[REDACTED]");
}
