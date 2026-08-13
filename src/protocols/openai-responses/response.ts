import type { AssistantMessage } from "@earendil-works/pi-ai";

export class OutboundResponseFidelityFailure extends Error {
  readonly kind = "OutboundResponseFidelityFailure";

  constructor(message: string) {
    super(message);
    this.name = "OutboundResponseFidelityFailure";
  }
}

export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens_details?: { reasoning_tokens: number };
}

export interface ResponsesMessageOutputItem {
  type: "message";
  id: string;
  role: "assistant";
  status: "completed";
  content: Array<{ type: "output_text"; text: string; annotations: [] }>;
}

export interface ResponsesFunctionCallOutputItem {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: "completed";
}

export interface ResponsesCustomToolCallOutputItem {
  type: "custom_tool_call";
  id: string;
  call_id: string;
  name: string;
  input: string;
  status: "completed";
}

export interface ResponsesReasoningOutputItem {
  type: "reasoning";
  id: string;
  summary: Array<{ type: "summary_text"; text: string }>;
}

export type ResponsesOutputItem =
  | ResponsesMessageOutputItem
  | ResponsesFunctionCallOutputItem
  | ResponsesCustomToolCallOutputItem
  | ResponsesReasoningOutputItem;

export interface ResponsesResponseObject {
  id: string;
  object: "response";
  created_at: number;
  status: "completed" | "incomplete" | "in_progress";
  model: string;
  output: ResponsesOutputItem[];
  previous_response_id?: string;
  usage: ResponsesUsage;
  incomplete_details?: { reason: "max_output_tokens" };
}

export interface PreparedHttpResponse {
  readonly status: number;
  readonly contentType: "application/json" | "text/event-stream";
  readonly body: Uint8Array<ArrayBuffer>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OutboundResponseFidelityFailure(`${field} must be a non-empty string`);
  }
  return value;
}

function requireCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OutboundResponseFidelityFailure(
      `${field} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function convertUsage(message: AssistantMessage): ResponsesUsage {
  const usage = message.usage as unknown;
  if (!isRecord(usage)) {
    throw new OutboundResponseFidelityFailure("Pi usage must be an object");
  }
  const input = requireCount(usage.input, "usage.input");
  const output = requireCount(usage.output, "usage.output");
  const cacheRead = requireCount(usage.cacheRead, "usage.cacheRead");
  const cacheWrite = requireCount(usage.cacheWrite, "usage.cacheWrite");
  const reasoning =
    usage.reasoning === undefined
      ? 0
      : requireCount(usage.reasoning, "usage.reasoning");
  const total = requireCount(usage.totalTokens, "usage.totalTokens");
  const result: ResponsesUsage = {
    input_tokens: input + cacheRead + cacheWrite,
    output_tokens: output,
    total_tokens: total,
    input_tokens_details: { cached_tokens: cacheRead },
  };
  if (reasoning > 0) {
    result.output_tokens_details = { reasoning_tokens: reasoning };
  }
  return result;
}

function convertOutput(
  message: AssistantMessage,
  responseId: string,
  freeformToolNames: ReadonlySet<string>,
): ResponsesOutputItem[] {
  const output: ResponsesOutputItem[] = [];
  let textBlockIndex = 0;
  let toolCallIndex = 0;
  for (const block of message.content) {
    const raw = block as unknown;
    if (!isRecord(raw) || typeof raw.type !== "string") {
      throw new OutboundResponseFidelityFailure(
        "Pi assistant content must be tagged objects",
      );
    }
    if (raw.type === "thinking") {
      const thinking = raw.thinking;
      if (typeof thinking !== "string") {
        throw new OutboundResponseFidelityFailure(
          "Pi thinking content must be a string",
        );
      }
      output.push({
        type: "reasoning",
        id: `rs_${responseId}_${textBlockIndex}`,
        summary: [{ type: "summary_text", text: thinking }],
      });
      textBlockIndex += 1;
      continue;
    }
    if (raw.type === "text") {
      const text = raw.text;
      if (typeof text !== "string") {
        throw new OutboundResponseFidelityFailure(
          "Pi text content must be a string",
        );
      }
      output.push({
        type: "message",
        id: `msg_${responseId}_${textBlockIndex}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      });
      textBlockIndex += 1;
      continue;
    }
    if (raw.type !== "toolCall") {
      throw new OutboundResponseFidelityFailure(
        `Unsupported Pi assistant content: ${String(raw.type)}`,
      );
    }
    const callId = requireNonEmptyString(raw.id, "Pi toolCall.id");
    const name = requireNonEmptyString(raw.name, "Pi toolCall.name");
    const argumentsValue = raw.arguments;
    if (!isRecord(argumentsValue)) {
      throw new OutboundResponseFidelityFailure(
        "Pi toolCall.arguments must be an object",
      );
    }
    const argumentsJson = JSON.stringify(argumentsValue);
    if (argumentsJson === undefined) {
      throw new OutboundResponseFidelityFailure(
        "Pi toolCall.arguments did not serialize",
      );
    }
    if (freeformToolNames.has(name)) {
      // Freeform custom tools (e.g. apply_patch) must round-trip as
      // `custom_tool_call` with a raw `input` string, not as a JSON
      // `function_call`. Codex rejects a freeform tool invoked as
      // function_call ("incompatible payload").
      const input = argumentsValue.input;
      output.push({
        type: "custom_tool_call",
        id: `ctc_${responseId}_${toolCallIndex}`,
        call_id: callId,
        name,
        input: typeof input === "string" ? input : argumentsJson,
        status: "completed",
      });
    } else {
      output.push({
        type: "function_call",
        id: `fc_${responseId}_${toolCallIndex}`,
        call_id: callId,
        name,
        arguments: argumentsJson,
        status: "completed",
      });
    }
    toolCallIndex += 1;
  }
  return output;
}

function convertStopReason(
  stopReason: AssistantMessage["stopReason"],
): Pick<ResponsesResponseObject, "status" | "incomplete_details"> {
  if (stopReason === "stop" || stopReason === "toolUse") {
    return { status: "completed" };
  }
  if (stopReason === "length") {
    return {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    };
  }
  throw new OutboundResponseFidelityFailure(
    `Unsupported committed Pi stop reason: ${stopReason}`,
  );
}

function assertMessageEnvelope(message: AssistantMessage): void {
  const raw = message as unknown;
  if (!isRecord(raw) || raw.role !== "assistant" || !Array.isArray(raw.content)) {
    throw new OutboundResponseFidelityFailure(
      "Committed Pi message must be an assistant message with a content array",
    );
  }
  convertStopReason(message.stopReason);
}

export function convertAssistantMessageToResponses(
  message: AssistantMessage,
  clientModel: string,
  responseId: string,
  createdAt: number,
  previousResponseId: string | undefined,
  freeformToolNames: ReadonlySet<string> = new Set(),
): ResponsesResponseObject {
  assertMessageEnvelope(message);
  const output = convertOutput(message, responseId, freeformToolNames);
  const { status, incomplete_details } = convertStopReason(message.stopReason);
  const response: ResponsesResponseObject = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status,
    model: clientModel,
    output,
    usage: convertUsage(message),
  };
  if (previousResponseId !== undefined) {
    response.previous_response_id = previousResponseId;
  }
  if (incomplete_details !== undefined) {
    response.incomplete_details = incomplete_details;
  }
  return response;
}

export function renderResponsesError(
  status: number,
  type: string,
  message: string,
): PreparedHttpResponse {
  return {
    status,
    contentType: "application/json",
    body: new TextEncoder().encode(
      JSON.stringify({ error: { type, message } }),
    ),
  };
}
