import type { AssistantMessage } from "@earendil-works/pi-ai";

import { redactMessage } from "./error-rendering.js";

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
  output_tokens_details: { reasoning_tokens: number };
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
  namespace?: string;
  arguments: string;
  status: "completed";
}

export interface ResponsesCustomToolCallOutputItem {
  type: "custom_tool_call";
  id: string;
  call_id: string;
  name: string;
  namespace?: string;
  input: string;
  status: "completed";
}

export interface ResponsesReasoningOutputItem {
  type: "reasoning";
  id: string;
  summary: Array<{ type: "summary_text"; text: string }>;
  /** Restored only from a verified Responses-owned continuity envelope. */
  encrypted_content?: string;
}

/**
 * The versioned Responses-owned continuity envelope that may restore
 * `encrypted_content`. Only this exact shape (v1, the Responses authority and
 * id) is verified; a foreign signature never is.
 */
interface ResponsesContinuityEnvelopeV1 {
  readonly v: 1;
  readonly id: "openai-responses";
  readonly authority: "openai-responses";
  readonly encrypted_content: string;
}

/** Parse and verify a Responses continuity envelope; undefined when foreign,
 *  malformed, or missing the encrypted payload. */
function parseVerifiedContinuityEnvelope(
  signature: string,
): ResponsesContinuityEnvelopeV1 | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(signature);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.v !== 1) return undefined;
  if (envelope.id !== "openai-responses") return undefined;
  if (envelope.authority !== "openai-responses") return undefined;
  if (
    typeof envelope.encrypted_content !== "string" ||
    envelope.encrypted_content.length === 0
  ) {
    return undefined;
  }
  return envelope as unknown as ResponsesContinuityEnvelopeV1;
}

export type ResponsesOutputItem =
  | ResponsesMessageOutputItem
  | ResponsesFunctionCallOutputItem
  | ResponsesCustomToolCallOutputItem
  | ResponsesReasoningOutputItem;

/**
 * The SDK `ResponseError` shape carried inside a failed Response object. The
 * installed SDK models it as exactly `code` + `message`: `code` is a required
 * enum (never null, never an arbitrary string) and there is no `type`/`param`
 * field (those belong to the non-streaming ErrorObject envelope, which this
 * adapter renders separately). A failed terminal therefore always carries a
 * legal enum code — an upstream failure collapses to the SDK-mandated
 * `server_error` mapping, matching how the Responses API maps internal errors.
 */
export type ResponsesErrorCode =
  | "server_error"
  | "rate_limit_exceeded"
  | "invalid_prompt"
  | "vector_store_timeout"
  | "invalid_image"
  | "invalid_image_format"
  | "invalid_base64_image"
  | "invalid_image_url"
  | "image_too_large"
  | "image_too_small"
  | "image_parse_error"
  | "image_content_policy_violation"
  | "invalid_image_mode"
  | "image_file_too_large"
  | "unsupported_image_media_type"
  | "empty_image_file"
  | "failed_to_download_image"
  | "image_file_not_found";

export interface ResponsesError {
  readonly code: ResponsesErrorCode;
  readonly message: string;
}

export type ResponsesStatus = "completed" | "incomplete" | "failed";

export interface ResponsesResponseObject {
  id: string;
  object: "response";
  created_at: number;
  status: ResponsesStatus;
  error: ResponsesError | null;
  incomplete_details: { reason: "max_output_tokens" } | null;
  instructions: string | null;
  metadata: Readonly<Record<string, string>>;
  model: string;
  output: ResponsesOutputItem[];
  parallel_tool_calls: boolean;
  temperature: number | null;
  /** Only legal SDK tool_choice values are echoed; the target union is
   *  'none' | 'auto' | 'required' (or an allowed/function object). A residual
   *  render value that is not a legal echo normalizes to "auto". */
  tool_choice: "auto" | "none" | "required";
  tools: ResponsesEchoTool[];
  top_p: number | null;
  usage: ResponsesUsage;
  previous_response_id?: string;
}

/**
 * A rendered tool definition that describes only what actually took effect.
 * Hosted declarations that were dropped, forced choices, and parallel flags
 * never appear here. A freeform custom tool echoes under `custom` with the
 * SDK CustomTool shape: {type,name,description?,format?} — never a made-up
 * `input_schema` field the target type does not have.
 *
 * The two shapes mirror the installed SDK exactly: a function echo always
 * carries `parameters` (the SDK FunctionTool field is required) and a
 * `strict` boolean; a custom echo never carries parameters/strict (the SDK
 * CustomTool has no such fields) and instead optionally carries `format`.
 */
export interface ResponsesEchoFunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly namespace?: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict: boolean;
}

export interface ResponsesEchoCustomTool {
  readonly type: "custom";
  readonly name: string;
  readonly namespace?: string;
  readonly description: string;
  readonly format?: { readonly type: "text" };
}

export type ResponsesEchoTool =
  | ResponsesEchoFunctionTool
  | ResponsesEchoCustomTool;

/**
 * Immutable Responses-owned render facts, frozen at request conversion and
 * consumed once to render an honest Response. Only the effective normalized
 * state survives; raw caller intent that did not take effect never does.
 */
export interface ResponsesRenderState {
  readonly clientModel: string;
  readonly stream: boolean;
  readonly toolChoice?: string;
  readonly freeformToolNames?: ReadonlySet<string>;
  readonly namespaceReverse?: Readonly<
    Record<string, { namespace: string; child: string }>
  >;
  readonly metadataEcho?: Readonly<Record<string, string>>;
  readonly temperature?: number;
  readonly topP?: number;
  readonly tools?: readonly ResponsesEchoTool[];
  /** Adapter-local policy for unknown Pi content (response side). */
  readonly unknownPiContent?: "error" | "ignore";
  /** Optional request-local response-notice sink (surfaced by the handler). */
  readonly notices?: ConversionNoticeSink;
}

export interface PreparedHttpResponse {
  readonly status: number;
  readonly contentType: "application/json" | "text/event-stream";
  readonly body: Uint8Array<ArrayBuffer>;
}

/** A syntactically valid Responses response ID for public protocol helpers. */
export function validResponsesResponseId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

/** Minimal Responses-owned conversion-notice sink for response rendering. */
export interface ConversionNoticeSink {
  push(notice: {
    readonly adapter: string;
    readonly direction: "request" | "response";
    readonly code: string;
    readonly jsonPath?: string;
    readonly action: "ignore" | "degrade" | "xrepair";
  }): void;
}

/**
 * Ticket 20 additive fail-open usage codes. Usage is observability, never
 * model-visible semantic content: malformed usage degrades the Client Wire
 * usage representation with a bounded structured notice, but never discards
 * an otherwise valid response. No raw invalid value ever enters a notice
 * fact — the code and jsonPath are the whole warning.
 */
export const CLIENT_USAGE_UNAVAILABLE_NOTICE_CODE =
  "client_usage_unavailable";
export const CLIENT_USAGE_UNKNOWN_FIELDS_NOTICE_CODE =
  "client_usage_unknown_fields_ignored";
export const CLIENT_USAGE_REASONING_UNAVAILABLE_NOTICE_CODE =
  "client_usage_reasoning_unavailable";
export const CLIENT_USAGE_TOTAL_UNAVAILABLE_NOTICE_CODE =
  "client_usage_total_unavailable";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OutboundResponseFidelityFailure(`${field} must be a non-empty string`);
  }
  return value;
}

/** The allowlisted Pi usage fields the Responses adapter recognizes; any
 *  other usage-only key is ignored with a bounded warning and never leaks. */
const RESPONSES_USAGE_FIELDS = new Set([
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cacheWrite1h",
  "reasoning",
  "totalTokens",
  "cost",
]);

function optionalCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

/** The adapter-contract atomic fallback: every count zero, exactly per the
 *  Responses usage schema. Never clamps or repairs an individual invalid
 *  value into it. */
function atomicFallbackUsage(): ResponsesUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

/** Bounded degradation notice routed through the conversion-notice sink. */
function usageNotice(
  sink: ConversionNoticeSink,
  code: string,
  jsonPath: string,
): void {
  sink.push({
    adapter: "openai-responses",
    direction: "response",
    code,
    jsonPath,
    action: "degrade",
  });
}

/**
 * Fail-open Pi Usage → Responses usage conversion (Ticket 20 additive).
 *
 * - Required canonical components (input/cacheRead/cacheWrite/output) that
 *   are valid non-negative safe integers render per the target protocol
 *   when their target sums stay safe; any invalid required component, a
 *   non-object/missing usage object, or an unsafe target sum uses the one
 *   atomic all-zero fallback with a bounded warning. No individual value is
 *   clamped, repaired, or echoed.
 * - The target total is always derived from the target protocol formula
 *   (input_tokens + output_tokens); Pi `totalTokens` is never echoed. An
 *   invalid or partition-inconsistent Pi total emits a bounded warning.
 * - Invalid optional `reasoning` (including reasoning > output) renders the
 *   target's required neutral value (0) with a warning; valid required
 *   components stay.
 * - Extra/unknown usage-only keys are ignored with a bounded warning while
 *   allowlisted valid components still render; they never leak to the wire.
 * - `cacheWrite1h` has no Responses wire representation; the total cache
 *   write still flows into input_tokens and the key stays silently ignored.
 *
 * Strict fidelity for non-usage message/content/tool semantics is
 * unchanged.
 */
function convertUsage(
  message: AssistantMessage,
  notices: ConversionNoticeSink,
): ResponsesUsage {
  const usage = message.usage as unknown;
  if (!isRecord(usage)) {
    usageNotice(notices, CLIENT_USAGE_UNAVAILABLE_NOTICE_CODE, "$.usage");
    return atomicFallbackUsage();
  }
  for (const key of Object.keys(usage)) {
    if (!RESPONSES_USAGE_FIELDS.has(key)) {
      usageNotice(
        notices,
        CLIENT_USAGE_UNKNOWN_FIELDS_NOTICE_CODE,
        `$.usage.${key}`,
      );
    }
  }
  const input = optionalCount(usage.input);
  const output = optionalCount(usage.output);
  const cacheRead = optionalCount(usage.cacheRead);
  const cacheWrite = optionalCount(usage.cacheWrite);
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    usageNotice(notices, CLIENT_USAGE_UNAVAILABLE_NOTICE_CODE, "$.usage");
    return atomicFallbackUsage();
  }
  // The Responses contract is input_tokens = input + cacheRead + cacheWrite
  // (input includes cached tokens) and total_tokens = input_tokens +
  // output_tokens. When a required target sum stops being a safe integer,
  // the target cannot stay internally consistent: atomic fallback.
  const inputTokens = input + cacheRead + cacheWrite;
  const total = inputTokens + output;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(total)) {
    usageNotice(notices, CLIENT_USAGE_UNAVAILABLE_NOTICE_CODE, "$.usage");
    return atomicFallbackUsage();
  }
  let reasoning = 0;
  if (usage.reasoning !== undefined) {
    const parsed = optionalCount(usage.reasoning);
    if (parsed === undefined || parsed > output) {
      usageNotice(
        notices,
        CLIENT_USAGE_REASONING_UNAVAILABLE_NOTICE_CODE,
        "$.usage.reasoning",
      );
    } else {
      reasoning = parsed;
    }
  }
  // Pi totalTokens does not have one cross-provider meaning, so the wire
  // total is derived, never blindly echoed. A Pi total that is invalid or
  // inconsistent with the canonical component partition is a bounded
  // structured warning, never a failure.
  if (usage.totalTokens !== undefined) {
    const parsed = optionalCount(usage.totalTokens);
    if (
      parsed === undefined ||
      parsed !== input + cacheRead + cacheWrite + output
    ) {
      usageNotice(
        notices,
        CLIENT_USAGE_TOTAL_UNAVAILABLE_NOTICE_CODE,
        "$.usage.totalTokens",
      );
    }
  }
  return {
    input_tokens: inputTokens,
    output_tokens: output,
    total_tokens: total,
    input_tokens_details: { cached_tokens: cacheRead },
    output_tokens_details: { reasoning_tokens: reasoning },
  };
}

function convertOutput(
  message: AssistantMessage,
  responseId: string,
  freeformToolNames: ReadonlySet<string>,
  namespaceReverse: Readonly<Record<string, { namespace: string; child: string }>>,
  unknownPolicy: "error" | "ignore",
  notices: ConversionNoticeSink,
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
      // Verified Responses continuity: only a redacted thinking block whose
      // versioned envelope was created by the Responses adapter may restore
      // `encrypted_content`. An arbitrary opaque signature (foreign authority,
      // wrong version, non-redacted block, unparseable text) is never emitted
      // as Responses encrypted data — the visible summary is retained instead.
      const signature =
        raw.redacted === true && typeof raw.thinkingSignature === "string"
          ? parseVerifiedContinuityEnvelope(raw.thinkingSignature)
          : undefined;
      const item: ResponsesReasoningOutputItem = {
        type: "reasoning",
        id: `rs_${responseId}_${textBlockIndex}`,
        summary: [{ type: "summary_text", text: thinking }],
      };
      if (signature !== undefined) {
        item.encrypted_content = signature.encrypted_content;
      }
      output.push(item);
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
      // A future unknown Pi content block follows the adapter-local
      // response-side error|ignore policy, default error. Ignoring unknown
      // content never fabricates a completed status (the terminal is derived
      // from the Pi stop reason, never from content).
      if (unknownPolicy === "ignore") {
        notices.push({
          adapter: "openai-responses",
          direction: "response",
          code: "openai-responses_unknown_pi_content_ignored",
          action: "ignore",
        });
        continue;
      }
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
    // A namespace-flattened name reverses to the SDK shape: the child name
    // plus a namespace field, so the client can map the call back to the
    // original namespace tool.
    const reverse = namespaceReverse[name];
    const outputName = reverse?.child ?? name;
    const namespace = reverse?.namespace;
    if (freeformToolNames.has(name)) {
      // Freeform custom tools (e.g. apply_patch) must round-trip as
      // `custom_tool_call` with a raw `input` string, not as a JSON
      // `function_call`. Codex rejects a freeform tool invoked as
      // function_call ("incompatible payload").
      const input = argumentsValue.input;
      // The SDK models custom_tool_call.input as a string; a non-string
      // Pi argument is a fidelity failure, never a fabricated JSON fallback.
      if (typeof input !== "string") {
        throw new OutboundResponseFidelityFailure(
          "custom tool input must be a string",
        );
      }
      output.push({
        type: "custom_tool_call",
        id: `ctc_${responseId}_${toolCallIndex}`,
        call_id: callId,
        name: outputName,
        ...(namespace === undefined ? {} : { namespace }),
        input,
        status: "completed",
      });
    } else {
      output.push({
        type: "function_call",
        id: `fc_${responseId}_${toolCallIndex}`,
        call_id: callId,
        name: outputName,
        ...(namespace === undefined ? {} : { namespace }),
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
  message: AssistantMessage,
): Pick<
  ResponsesResponseObject,
  "status" | "error" | "incomplete_details"
> {
  if (stopReason === "stop" || stopReason === "toolUse") {
    return { status: "completed", error: null, incomplete_details: null };
  }
  if (stopReason === "length") {
    return {
      status: "incomplete",
      error: null,
      incomplete_details: { reason: "max_output_tokens" },
    };
  }
  if (stopReason === "error") {
    return {
      status: "failed",
      error: {
        message:
          typeof message.errorMessage === "string" &&
          message.errorMessage.length > 0
            ? message.errorMessage
            : "Upstream provider failed",
        // The SDK Response error code is a required enum; an internal/
        // upstream failure maps to the SDK-mandated `server_error`, never a
        // null or arbitrary string (the openai 6.x SDK types
        // ResponseError.code as a required enum).
        code: "server_error",
      },
      incomplete_details: null,
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
  convertStopReason(message.stopReason, message);
}

/**
 * Map a request-local render tool_choice to the legal SDK echo. Only the
 * target union 'none' | 'auto' | 'required' is echoed; any residual value
 * (including the request-local "allowed" filter marker, which the SDK models
 * as an allowed_tools object rather than a bare string) normalizes to the
 * SDK default "auto". A non-target value is never echoed as effective.
 */
/** Deep-clone and deep-freeze the echoed tools so no shared reference to the
 *  caller's render state can survive into the wire object. */
function deepFreezeTools(tools: readonly ResponsesEchoTool[]): ResponsesEchoTool[] {
  return tools.map((tool) => {
    if (tool.type === "function") {
      const clone: ResponsesEchoFunctionTool = {
        ...tool,
        parameters: deepFreeze(tool.parameters) as Readonly<
          Record<string, unknown>
        >,
      };
      return Object.freeze(clone) as ResponsesEchoTool;
    }
    return Object.freeze({ ...tool }) as ResponsesEchoTool;
  });
}

/** Recursively clone and freeze a plain value tree (null-prototype-safe). */
function deepFreeze(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => deepFreeze(entry)));
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      result[key] = deepFreeze(entry);
    }
    return Object.freeze(result);
  }
  return value;
}

function normalizeEchoedToolChoice(value: string | undefined): "auto" | "none" | "required" {
  if (value === "none" || value === "required") return value;
  return "auto";
}

export function convertAssistantMessageToResponses(
  message: AssistantMessage,
  renderState: ResponsesRenderState,
  responseId: string,
  createdAt: number,
  previousResponseId: string | undefined,
): ResponsesResponseObject {
  assertMessageEnvelope(message);
  const noticeSink: ConversionNoticeSink = {
    push(notice): void {
      if (renderState.notices !== undefined) renderState.notices.push(notice);
    },
  };
  const output = convertOutput(
    message,
    responseId,
    renderState.freeformToolNames ?? new Set(),
    renderState.namespaceReverse ?? {},
    renderState.unknownPiContent ?? "error",
    noticeSink,
  );
  const { status, error, incomplete_details } = convertStopReason(
    message.stopReason,
    message,
  );
  const response: ResponsesResponseObject = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status,
    error,
    incomplete_details,
    instructions: null,
    metadata: Object.freeze({ ...(renderState.metadataEcho ?? {}) }),
    model: renderState.clientModel,
    output,
    parallel_tool_calls: true,
    temperature: renderState.temperature ?? null,
    // The SDK Response tool_choice has no bare "allowed" string; the
    // allowed_tools filter is auto-mode filtering, so any residual "allowed"
    // render-state value is normalized to the legal "auto" echo. Never echo a
    // non-target value as effective.
    tool_choice: normalizeEchoedToolChoice(renderState.toolChoice),
    // Deep-snapshot the echoed tools: a hostile caller that later mutates the
    // shared tool schema (e.g. the nested `parameters` object) in place must
    // never corrupt the already-rendered wire object.
    tools: deepFreezeTools(renderState.tools ?? []),
    top_p: renderState.topP ?? null,
    usage: convertUsage(message, noticeSink),
  };
  if (previousResponseId !== undefined) {
    response.previous_response_id = previousResponseId;
  }
  return response;
}

export function renderResponsesError(
  status: number,
  type: string,
  message: string,
  code: string | null = null,
  param: string | null = null,
): PreparedHttpResponse {
  return {
    status,
    contentType: "application/json",
    body: new TextEncoder().encode(
      JSON.stringify({ error: { message: redactMessage(message), type, code, param } }),
    ),
  };
}

/** A prepared Responses error envelope carrying its status and safe headers. */
export interface PreparedResponsesError {
  readonly status: number;
  readonly type: string;
  readonly message: string;
  readonly code: string | null;
  readonly param: string | null;
  readonly safeHeaders: Readonly<Record<string, string>>;
}

/** Render a prepared Responses error as an HTTP Response with only the safe
 *  allowlisted headers attached. */
export function renderResponsesErrorResponse(
  error: PreparedResponsesError,
): Response {
  return new Response(
    new TextEncoder().encode(
      JSON.stringify({
        error: {
          message: error.message,
          type: error.type,
          code: error.code,
          param: error.param,
        },
      }),
    ),
    {
      status: error.status,
      headers: {
        "content-type": "application/json",
        ...error.safeHeaders,
      },
    },
  );
}
