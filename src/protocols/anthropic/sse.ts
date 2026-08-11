import {
  type AnthropicResponseMessage,
  type AnthropicResponseUsage,
  type AnthropicThinkingBlock,
  type AnthropicTextBlock,
  type AnthropicToolUseBlock,
  OutboundResponseFidelityFailure,
} from "./response.js";
import {
  assertAnthropicTargetSchema,
  type PreparedHttpResponse,
} from "./wire.js";

interface AnthropicStreamingMessage {
  id: string;
  container: null;
  content: [];
  model: string;
  role: "assistant";
  stop_details: null;
  stop_reason: null;
  stop_sequence: null;
  type: "message";
  usage: AnthropicResponseUsage;
}

interface AnthropicMessageDeltaUsage {
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
  output_tokens_details: { thinking_tokens: number } | null;
  server_tool_use: null;
}

export type AnthropicAtomicSseEvent =
  | { type: "message_start"; message: AnthropicStreamingMessage }
  | {
      type: "content_block_start";
      index: number;
      content_block:
        | AnthropicTextBlock
        | AnthropicThinkingBlock
        | AnthropicToolUseBlock;
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "signature_delta"; signature: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: {
        container: null;
        stop_details: null;
        stop_reason: AnthropicResponseMessage["stop_reason"];
        stop_sequence: null;
      };
      usage: AnthropicMessageDeltaUsage;
    }
  | { type: "message_stop" };

function fail(message: string): never {
  throw new OutboundResponseFidelityFailure(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => !fields.includes(key))
  ) {
    fail(`${label} does not have its exact schema fields`);
  }
}

function assertCount(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
}

function assertMessageDeltaUsage(value: unknown): void {
  if (!isRecord(value)) fail("Anthropic message_delta usage must be an object");
  assertFields(
    value,
    [
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      "input_tokens",
      "output_tokens",
      "output_tokens_details",
      "server_tool_use",
    ],
    "Anthropic message_delta usage",
  );
  for (const key of [
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "input_tokens",
    "output_tokens",
  ]) {
    assertCount(value[key], `Anthropic message_delta usage.${key}`);
  }
  if (value.server_tool_use !== null) {
    fail("Anthropic message_delta server_tool_use must be null");
  }
  if (value.output_tokens_details !== null) {
    if (!isRecord(value.output_tokens_details)) {
      fail("Anthropic message_delta output_tokens_details must be an object or null");
    }
    assertFields(
      value.output_tokens_details,
      ["thinking_tokens"],
      "Anthropic message_delta output_tokens_details",
    );
    assertCount(
      value.output_tokens_details.thinking_tokens,
      "Anthropic message_delta thinking_tokens",
    );
    if (
      (value.output_tokens_details.thinking_tokens as number) >
      (value.output_tokens as number)
    ) {
      fail("Anthropic message_delta thinking usage exceeds output usage");
    }
  }
}

function assertAtomicSseEvent(event: AnthropicAtomicSseEvent): void {
  const raw = event as unknown;
  if (!isRecord(raw) || typeof raw.type !== "string") {
    fail("Anthropic SSE event must be a tagged object");
  }
  if (event.type === "message_start") {
    assertFields(raw, ["type", "message"], "Anthropic message_start");
    const message = event.message as unknown;
    if (!isRecord(message)) fail("Anthropic message_start.message must be an object");
    assertFields(
      message,
      [
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
      ],
      "Anthropic message_start.message",
    );
    if (
      typeof message.id !== "string" ||
      message.id.length === 0 ||
      typeof message.model !== "string" ||
      message.model.length === 0 ||
      message.container !== null ||
      !Array.isArray(message.content) ||
      message.content.length !== 0 ||
      message.role !== "assistant" ||
      message.stop_details !== null ||
      message.stop_reason !== null ||
      message.stop_sequence !== null ||
      message.type !== "message"
    ) {
      fail("Anthropic message_start.message is malformed");
    }
    assertAnthropicTargetSchema({
      ...(event.message as Omit<AnthropicStreamingMessage, "stop_reason">),
      stop_reason: "end_turn",
    });
    return;
  }
  if (event.type === "content_block_start") {
    assertFields(
      raw,
      ["type", "index", "content_block"],
      "Anthropic content_block_start",
    );
    assertCount(event.index, "Anthropic content_block_start.index");
    const block = event.content_block as unknown;
    if (!isRecord(block)) fail("Anthropic content_block_start block is malformed");
    if (event.content_block.type === "text") {
      assertFields(
        block,
        ["citations", "text", "type"],
        "Anthropic streaming TextBlock",
      );
      if (event.content_block.citations !== null || event.content_block.text !== "") {
        fail("Anthropic streaming TextBlock start is malformed");
      }
      return;
    }
    if (event.content_block.type === "thinking") {
      assertFields(
        block,
        ["signature", "thinking", "type"],
        "Anthropic streaming ThinkingBlock",
      );
      if (
        event.content_block.thinking !== "" ||
        event.content_block.signature !== ""
      ) {
        fail("Anthropic streaming ThinkingBlock start is malformed");
      }
      return;
    }
    assertFields(
      block,
      ["id", "caller", "input", "name", "type"],
      "Anthropic streaming ToolUseBlock",
    );
    if (
      event.content_block.id.length === 0 ||
      event.content_block.name.length === 0 ||
      event.content_block.caller.type !== "direct" ||
      Object.keys(event.content_block.input).length !== 0
    ) {
      fail("Anthropic streaming ToolUseBlock start is malformed");
    }
    return;
  }
  if (event.type === "content_block_delta") {
    assertFields(
      raw,
      ["type", "index", "delta"],
      "Anthropic content_block_delta",
    );
    assertCount(event.index, "Anthropic content_block_delta.index");
    const delta = event.delta as unknown;
    if (!isRecord(delta)) fail("Anthropic content_block_delta.delta is malformed");
    if (event.delta.type === "text_delta") {
      assertFields(delta, ["type", "text"], "Anthropic text_delta");
      if (typeof event.delta.text !== "string") fail("Anthropic text_delta is malformed");
      return;
    }
    if (event.delta.type === "thinking_delta") {
      assertFields(delta, ["type", "thinking"], "Anthropic thinking_delta");
      if (typeof event.delta.thinking !== "string") {
        fail("Anthropic thinking_delta is malformed");
      }
      return;
    }
    if (event.delta.type === "signature_delta") {
      assertFields(delta, ["type", "signature"], "Anthropic signature_delta");
      if (typeof event.delta.signature !== "string") {
        fail("Anthropic signature_delta is malformed");
      }
      return;
    }
    assertFields(
      delta,
      ["type", "partial_json"],
      "Anthropic input_json_delta",
    );
    if (typeof event.delta.partial_json !== "string") {
      fail("Anthropic input_json_delta is malformed");
    }
    return;
  }
  if (event.type === "content_block_stop") {
    assertFields(raw, ["type", "index"], "Anthropic content_block_stop");
    assertCount(event.index, "Anthropic content_block_stop.index");
    return;
  }
  if (event.type === "message_delta") {
    assertFields(raw, ["type", "delta", "usage"], "Anthropic message_delta");
    const delta = event.delta as unknown;
    if (!isRecord(delta)) fail("Anthropic message_delta.delta must be an object");
    assertFields(
      delta,
      ["container", "stop_details", "stop_reason", "stop_sequence"],
      "Anthropic message_delta.delta",
    );
    if (
      event.delta.container !== null ||
      event.delta.stop_details !== null ||
      !["end_turn", "max_tokens", "tool_use"].includes(event.delta.stop_reason) ||
      event.delta.stop_sequence !== null
    ) {
      fail("Anthropic message_delta.delta is malformed");
    }
    assertMessageDeltaUsage(event.usage);
    return;
  }
  assertFields(raw, ["type"], "Anthropic message_stop");
}

export function createAnthropicAtomicSseEvents(
  target: AnthropicResponseMessage,
): AnthropicAtomicSseEvent[] {
  assertAnthropicTargetSchema(target);
  const events: AnthropicAtomicSseEvent[] = [
    {
      type: "message_start",
      message: {
        id: target.id,
        container: target.container,
        content: [],
        model: target.model,
        role: target.role,
        stop_details: null,
        stop_reason: null,
        stop_sequence: null,
        type: "message",
        usage: target.usage,
      },
    },
  ];

  target.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: { citations: null, text: "", type: "text" },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        },
        { type: "content_block_stop", index },
      );
      return;
    }
    if (block.type === "thinking") {
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: block.thinking },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: block.signature },
        },
        { type: "content_block_stop", index },
      );
      return;
    }
    const partialJson = JSON.stringify(block.input);
    if (partialJson === undefined) {
      fail(`Anthropic tool input ${index} did not serialize`);
    }
    events.push(
      {
        type: "content_block_start",
        index,
        content_block: {
          id: block.id,
          caller: { type: "direct" },
          input: {},
          name: block.name,
          type: "tool_use",
        },
      },
      {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: partialJson },
      },
      { type: "content_block_stop", index },
    );
  });

  events.push(
    {
      type: "message_delta",
      delta: {
        container: target.container,
        stop_details: target.stop_details,
        stop_reason: target.stop_reason,
        stop_sequence: target.stop_sequence,
      },
      usage: {
        cache_creation_input_tokens: target.usage.cache_creation_input_tokens,
        cache_read_input_tokens: target.usage.cache_read_input_tokens,
        input_tokens: target.usage.input_tokens,
        output_tokens: target.usage.output_tokens,
        output_tokens_details: target.usage.output_tokens_details,
        server_tool_use: target.usage.server_tool_use,
      },
    },
    { type: "message_stop" },
  );

  for (const event of events) assertAtomicSseEvent(event);
  return events;
}

function frameEvent(event: AnthropicAtomicSseEvent): string {
  try {
    return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  } catch {
    throw new OutboundResponseFidelityFailure(
      `Anthropic ${event.type} SSE serialization failed`,
    );
  }
}

export function renderAnthropicAtomicSse(
  target: AnthropicResponseMessage,
): PreparedHttpResponse {
  const events = createAnthropicAtomicSseEvents(target);
  const body = new TextEncoder().encode(events.map(frameEvent).join(""));
  return { status: 200, contentType: "text/event-stream", body };
}
