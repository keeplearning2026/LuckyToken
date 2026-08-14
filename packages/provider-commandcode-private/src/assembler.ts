import type {
  ConversionNotice,
  InvocationAttempt,
} from "@luckytoken/provider-contract/diagnostics";
import { COMMANDCODE_PROVIDER_ID } from "./constants.js";
import { CommandCodeNeutralFailureError } from "./failure.js";
import {
  captureCommandCodeStreamFailurePayload,
  DEFAULT_COMMANDCODE_FAILURE_CAPTURE_POLICY,
  type CommandCodeFailureCapturePolicy,
} from "./failure-capture.js";
import {
  cloneLosslessJsonObject,
  type LosslessJsonValue,
} from "./json.js";

export type CommandCodeContentBlock =
  | Readonly<{ type: "text"; id: string; text: string }>
  | Readonly<{ type: "reasoning"; id: string; text: string }>
  | Readonly<{
      type: "tool_use";
      id: string;
      toolName: string;
      input: Readonly<Record<string, LosslessJsonValue>>;
    }>;

export interface CommandCodeFinishEvent {
  type: "finish";
  finishReason?: string;
  rawFinishReason?: string;
}

export interface CommandCodeNormalizedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface CommandCodeResponseIdentity {
  readonly responseId: string;
  readonly responseModel: string;
}

export interface CommandCodeResponsePolicy {
  readonly pauseTurn: "stop" | "error";
  readonly unknownEvent: "error" | "ignore";
}

export interface CommandCodeResult {
  readonly content: readonly CommandCodeContentBlock[];
  readonly finish: Readonly<CommandCodeFinishEvent>;
  readonly rawUsage?: Readonly<Record<string, unknown>>;
  readonly usage: Readonly<CommandCodeNormalizedUsage>;
  readonly systemPromptTokens?: number;
  readonly responseIdentity?: Readonly<CommandCodeResponseIdentity>;
  readonly notices: readonly ConversionNotice[];
  /** Physical-attempt facts are attached by the attempts module after commit. */
  readonly attempts?: readonly InvocationAttempt[];
}

export type CommandCodeProtocolErrorCode =
  | "NON_JSON_LINE"
  | "INVALID_EVENT"
  | "UNKNOWN_EVENT"
  | "INVALID_EVENT_FIELD"
  | "INVALID_BLOCK_LIFECYCLE"
  | "EMPTY_CONTENT_BLOCK";

export class CommandCodeProtocolError extends CommandCodeNeutralFailureError {
  readonly retryable = false;

  constructor(
    readonly code: CommandCodeProtocolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(
      {
        kind: "protocol",
        providerCode: code,
        message,
        retryable: false,
      },
      options,
    );
    this.name = "CommandCodeProtocolError";
    Object.freeze(this);
  }
}

export class CommandCodeTransportError extends CommandCodeNeutralFailureError {
  readonly retryable = true;

  constructor() {
    super({
      kind: "transport",
      phase: "unexpected_eof",
      message: "CommandCode transport ended without finish or abort",
      retryable: true,
    });
    this.name = "CommandCodeTransportError";
    Object.freeze(this);
  }
}

export class CommandCodeAbortError extends CommandCodeNeutralFailureError {
  readonly retryable = false;

  constructor() {
    super({
      kind: "upstream_stream",
      providerType: "abort",
      message: "CommandCode response emitted abort",
      retryable: false,
    });
    this.name = "CommandCodeAbortError";
    Object.freeze(this);
  }
}

export class CommandCodePauseTurnError extends CommandCodeNeutralFailureError {
  readonly retryable = false;

  constructor() {
    super({
      kind: "protocol",
      providerType: "pause_turn",
      message: "CommandCode pause_turn rejected by Provider policy",
      retryable: false,
    });
    this.name = "CommandCodePauseTurnError";
    Object.freeze(this);
  }
}

export class CommandCodeStreamError extends CommandCodeNeutralFailureError {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
    providerType?: string,
    providerCode?: string,
    snapshot?: {
      readonly mediaType?: string;
      readonly capturedBytes: number;
      readonly totalBytes?: number;
      readonly sha256?: string;
      readonly truncated: boolean;
    },
    truncated = false,
  ) {
    super({
      kind: "upstream_stream",
      message,
      retryable,
      ...(statusCode === undefined ? {} : { status: statusCode }),
      ...(providerType === undefined ? {} : { providerType }),
      ...(providerCode === undefined ? {} : { providerCode }),
      ...(snapshot === undefined ? {} : { snapshot }),
      truncated,
    });
    this.name = "CommandCodeStreamError";
    Object.freeze(this);
  }
}

export function isRetryableCommandCodeResponseError(error: unknown): boolean {
  return (
    error instanceof CommandCodeTransportError ||
    (error instanceof CommandCodeStreamError && error.retryable)
  );
}

interface BaseSlot {
  id: string;
  state: "open" | "closed";
}

interface TextSlot extends BaseSlot {
  kind: "text";
  text: string;
}

interface ReasoningSlot extends BaseSlot {
  kind: "reasoning";
  text: string;
}

interface ToolSlot extends BaseSlot {
  kind: "tool";
  startToolName: string;
  preview: string;
  inputEnded: boolean;
  finalToolName?: string;
  finalInput?: Record<string, LosslessJsonValue>;
}

type Slot = TextSlot | ReasoningSlot | ToolSlot;

const ZERO_USAGE: CommandCodeNormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const DEFAULT_RESPONSE_POLICY: CommandCodeResponsePolicy = Object.freeze({
  pauseTurn: "stop",
  unknownEvent: "error",
});

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function safeFailureMessage(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
  return sanitized.length === 0 ? "CommandCode stream failed" : sanitized;
}

function safeProviderMetadata(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .trim();
  return sanitized.length === 0 ? undefined : sanitized;
}

function normalizeUsage(
  value: Record<string, unknown> | undefined,
): CommandCodeNormalizedUsage {
  if (value === undefined) return { ...ZERO_USAGE };
  const inputDetails = isRecord(value.inputTokenDetails)
    ? value.inputTokenDetails
    : undefined;
  return {
    inputTokens: numberOrZero(value.inputTokens),
    outputTokens: numberOrZero(value.outputTokens),
    cacheReadTokens: numberOrZero(inputDetails?.cacheReadTokens),
    cacheWriteTokens: numberOrZero(inputDetails?.cacheWriteTokens),
  };
}

function requireString(
  event: Record<string, unknown>,
  field: string,
  nonEmpty = false,
): string {
  const value = event[field];
  if (
    typeof value !== "string" ||
    (nonEmpty && value.length === 0)
  ) {
    throw new CommandCodeProtocolError(
      "INVALID_EVENT_FIELD",
      `${event.type as string}.${field} must be ${nonEmpty ? "a non-empty " : "a "}string`,
    );
  }
  return value;
}

export class CommandCodeContentAssembler {
  private readonly policy: CommandCodeResponsePolicy;
  private readonly failureCapture: CommandCodeFailureCapturePolicy;
  private readonly slots: Slot[] = [];
  private readonly textById = new Map<string, TextSlot>();
  private readonly reasoningById = new Map<string, ReasoningSlot>();
  private readonly toolById = new Map<string, ToolSlot>();
  private finishEvent: CommandCodeFinishEvent | undefined;
  private rawUsage: Record<string, unknown> | undefined;
  private usage: CommandCodeNormalizedUsage = { ...ZERO_USAGE };
  private systemPromptTokens: number | undefined;
  private responseIdentity: CommandCodeResponseIdentity | undefined;
  private readonly notices: ConversionNotice[] = [];
  private finalized = false;

  constructor(
    policy: CommandCodeResponsePolicy = DEFAULT_RESPONSE_POLICY,
    failureCapture: CommandCodeFailureCapturePolicy =
      DEFAULT_COMMANDCODE_FAILURE_CAPTURE_POLICY,
  ) {
    this.policy = Object.freeze({ ...policy });
    this.failureCapture = Object.freeze({ ...failureCapture });
  }

  consumeRawLine(rawLine: string): void {
    const line = rawLine.trim();
    if (line.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.rollback();
      throw new CommandCodeProtocolError(
        "NON_JSON_LINE",
        "CommandCode emitted a non-JSON line",
        { cause: error },
      );
    }
    if (
      !isRecord(parsed) ||
      typeof parsed.type !== "string" ||
      parsed.type.length === 0
    ) {
      this.rollback();
      throw new CommandCodeProtocolError(
        "INVALID_EVENT",
        "CommandCode JSON value is not an event object",
      );
    }
    try {
      this.consumeEvent(parsed);
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  finalizeAfterTransportEnd(): CommandCodeResult {
    if (this.finalized) throw new Error("CommandCode assembler finalized twice");
    this.finalized = true;
    if (this.finishEvent === undefined) {
      this.rollback();
      throw new CommandCodeTransportError();
    }
    const open = this.slots.find((slot) => slot.state === "open");
    if (open !== undefined) {
      this.rollback();
      throw new CommandCodeProtocolError(
        "INVALID_BLOCK_LIFECYCLE",
        `CommandCode ${open.kind} block remained open at EOF`,
      );
    }
    if (this.finishEvent.rawFinishReason === "pause_turn") {
      if (this.policy.pauseTurn === "error") {
        this.rollback();
        throw new CommandCodePauseTurnError();
      }
      this.notices.push(
        Object.freeze({
          adapter: COMMANDCODE_PROVIDER_ID,
          direction: "response",
          code: "pause_turn_degraded",
          action: "degrade",
        }),
      );
    }

    const content = this.slots.map((slot): CommandCodeContentBlock => {
      if (slot.kind === "text") {
        return { type: "text", id: slot.id, text: slot.text };
      }
      if (slot.kind === "reasoning") {
        return { type: "reasoning", id: slot.id, text: slot.text };
      }
      if (slot.finalInput === undefined) {
        this.rollback();
        throw new CommandCodeProtocolError(
          "INVALID_BLOCK_LIFECYCLE",
          "CommandCode tool block closed without final input",
        );
      }
      return {
        type: "tool_use",
        id: slot.id,
        toolName: slot.finalToolName as string,
        input: slot.finalInput,
      };
    });
    const result: CommandCodeResult = {
      content,
      finish: this.finishEvent,
      usage: { ...this.usage },
      notices: [...this.notices],
      ...(this.rawUsage === undefined ? {} : { rawUsage: this.rawUsage }),
      ...(this.systemPromptTokens === undefined
        ? {}
        : { systemPromptTokens: this.systemPromptTokens }),
      ...(this.responseIdentity === undefined
        ? {}
        : { responseIdentity: this.responseIdentity }),
    };
    return deepFreeze(result);
  }

  private consumeEvent(event: Record<string, unknown>): void {
    switch (event.type) {
      case "text-start":
        this.reserveText(requireString(event, "id", true));
        return;
      case "text-delta": {
        const slot = this.requireOpen(
          this.textById,
          requireString(event, "id", true),
          event.type,
        );
        slot.text += requireString(event, "text");
        return;
      }
      case "text-end":
        this.closeText(
          this.textById,
          requireString(event, "id", true),
          event.type,
        );
        return;
      case "reasoning-start":
        this.reserveReasoning(requireString(event, "id", true));
        return;
      case "reasoning-delta": {
        const slot = this.requireOpen(
          this.reasoningById,
          requireString(event, "id", true),
          event.type,
        );
        slot.text += requireString(event, "text");
        return;
      }
      case "reasoning-end":
        this.closeText(
          this.reasoningById,
          requireString(event, "id", true),
          event.type,
        );
        return;
      case "tool-input-start": {
        const id = requireString(event, "id", true);
        if (this.toolById.has(id)) this.duplicateStart("tool");
        const slot: ToolSlot = {
          kind: "tool",
          id,
          state: "open",
          startToolName: requireString(event, "toolName", true),
          preview: "",
          inputEnded: false,
        };
        this.toolById.set(id, slot);
        this.slots.push(slot);
        return;
      }
      case "tool-input-delta": {
        const id = requireString(event, "id", true);
        const slot = this.requireOpen(this.toolById, id, event.type);
        if (slot.inputEnded) this.lifecycle("tool delta after input end");
        slot.preview += requireString(event, "delta");
        return;
      }
      case "tool-input-end": {
        const id = requireString(event, "id", true);
        const slot = this.requireOpen(this.toolById, id, event.type);
        if (slot.inputEnded) this.lifecycle("repeated tool input end");
        slot.inputEnded = true;
        return;
      }
      case "tool-call": {
        const id = requireString(event, "toolCallId", true);
        const slot = this.requireOpen(this.toolById, id, event.type);
        if (!slot.inputEnded) this.lifecycle("tool call before input end");
        slot.finalToolName = requireString(event, "toolName", true);
        const candidate = Object.hasOwn(event, "input")
          ? event.input
          : Object.hasOwn(event, "args")
            ? event.args
            : {};
        try {
          slot.finalInput = cloneLosslessJsonObject(
            candidate,
            `CommandCode tool-call ${id} input`,
          );
        } catch (error) {
          this.rollback();
          throw new CommandCodeProtocolError(
            "INVALID_EVENT_FIELD",
            "CommandCode tool-call input must be a lossless JSON object",
            { cause: error },
          );
        }
        slot.state = "closed";
        return;
      }
      case "finish-step": {
        if (
          event.finishReason !== undefined &&
          typeof event.finishReason !== "string"
        ) {
          this.invalidField(
            "finish-step.finishReason must be a string when present",
          );
        }
        if (
          event.rawFinishReason !== undefined &&
          typeof event.rawFinishReason !== "string"
        ) {
          this.invalidField(
            "finish-step.rawFinishReason must be a string when present",
          );
        }
        if (event.usage !== undefined && !isRecord(event.usage)) {
          this.invalidField("finish-step.usage must be an object when present");
        }
        if (
          event.providerMetadata !== undefined &&
          !isRecord(event.providerMetadata)
        ) {
          this.invalidField(
            "finish-step.providerMetadata must be an object when present",
          );
        }
        if (!isRecord(event.response)) {
          this.invalidField("finish-step.response must be an object");
        }
        const response = event.response;
        const responseId = requireString(response, "id", true);
        const responseModel = requireString(response, "modelId", true);
        if (
          response.timestamp !== undefined &&
          typeof response.timestamp !== "string"
        ) {
          this.invalidField(
            "finish-step.response.timestamp must be a string when present",
          );
        }
        if (response.headers !== undefined) {
          if (!isRecord(response.headers)) {
            this.invalidField(
              "finish-step.response.headers must be an object when present",
            );
          }
          if (
            Object.values(response.headers).some(
              (value) => typeof value !== "string",
            )
          ) {
            this.invalidField(
              "finish-step.response.headers values must be strings",
            );
          }
        }
        this.responseIdentity = { responseId, responseModel };
        return;
      }
      case "finish": {
        if (
          event.finishReason !== undefined &&
          typeof event.finishReason !== "string"
        ) {
          this.invalidField("finish.finishReason must be a string when present");
        }
        if (
          event.rawFinishReason !== undefined &&
          typeof event.rawFinishReason !== "string"
        ) {
          this.invalidField("finish.rawFinishReason must be a string when present");
        }
        if (event.totalUsage !== undefined && !isRecord(event.totalUsage)) {
          this.invalidField("finish.totalUsage must be an object when present");
        }
        if (
          event.systemPromptTokens !== undefined &&
          (typeof event.systemPromptTokens !== "number" ||
            !Number.isFinite(event.systemPromptTokens))
        ) {
          this.invalidField(
            "finish.systemPromptTokens must be finite when present",
          );
        }
        this.finishEvent = {
          type: "finish",
          ...(typeof event.finishReason === "string"
            ? { finishReason: event.finishReason }
            : {}),
          ...(typeof event.rawFinishReason === "string"
            ? { rawFinishReason: event.rawFinishReason }
            : {}),
        };
        this.rawUsage = isRecord(event.totalUsage)
          ? cloneLosslessJsonObject(
              event.totalUsage,
              "CommandCode finish.totalUsage",
            )
          : undefined;
        this.usage = normalizeUsage(this.rawUsage);
        this.systemPromptTokens =
          typeof event.systemPromptTokens === "number"
            ? event.systemPromptTokens
            : undefined;
        return;
      }
      case "error": {
        if (!isRecord(event.error) && typeof event.error !== "string") {
          this.invalidField("error event requires string or object error");
        }
        const detail = isRecord(event.error) ? event.error : undefined;
        if (detail?.message !== undefined && typeof detail.message !== "string") {
          this.invalidField("error.message must be a string when present");
        }
        if (
          detail?.statusCode !== undefined &&
          typeof detail.statusCode !== "number"
        ) {
          this.invalidField("error.statusCode must be a number when present");
        }
        if (
          detail?.isRetryable !== undefined &&
          typeof detail.isRetryable !== "boolean"
        ) {
          this.invalidField("error.isRetryable must be boolean when present");
        }
        if (
          event.isRetryable !== undefined &&
          typeof event.isRetryable !== "boolean"
        ) {
          this.invalidField("event.isRetryable must be boolean when present");
        }
        if (
          typeof detail?.isRetryable === "boolean" &&
          typeof event.isRetryable === "boolean" &&
          detail.isRetryable !== event.isRetryable
        ) {
          this.invalidField("stream error retryability fields conflict");
        }
        if (detail?.type !== undefined && typeof detail.type !== "string") {
          this.invalidField("error.type must be a string when present");
        }
        if (detail?.code !== undefined && typeof detail.code !== "string") {
          this.invalidField("error.code must be a string when present");
        }
        const message = safeFailureMessage(
          (typeof detail?.message === "string" ? detail.message : undefined) ??
          (typeof event.error === "string" ? event.error : "Stream error"),
        );
        const statusCode =
          typeof detail?.statusCode === "number" &&
          Number.isInteger(detail.statusCode) &&
          detail.statusCode >= 300 &&
          detail.statusCode <= 599
            ? detail.statusCode
            : undefined;
        const captured = captureCommandCodeStreamFailurePayload(
          detail?.body,
          message,
          this.failureCapture,
        );
        this.rollback();
        throw new CommandCodeStreamError(
          captured.message,
          event.isRetryable === true || detail?.isRetryable === true,
          statusCode,
          safeProviderMetadata(detail?.type),
          safeProviderMetadata(detail?.code),
          captured.snapshot,
          captured.truncated,
        );
      }
      case "abort":
        this.rollback();
        throw new CommandCodeAbortError();
      case "start":
        return;
      case "start-step":
        if (!isRecord(event.request)) {
          this.invalidField("start-step.request must be an object");
        }
        if (event.warnings !== undefined && !Array.isArray(event.warnings)) {
          this.invalidField("start-step.warnings must be an array when present");
        }
        return;
      case "provider-metadata":
        if (!isRecord(event.providerMetadata)) {
          this.invalidField("provider-metadata.providerMetadata must be an object");
        }
        return;
      case "tool-result":
        requireString(event, "toolCallId", true);
        if (event.toolName !== undefined && typeof event.toolName !== "string") {
          this.invalidField("tool-result.toolName must be a string when present");
        }
        if (event.output !== undefined && !isRecord(event.output)) {
          this.invalidField("tool-result.output must be an object when present");
        }
        return;
      default:
        if (this.policy.unknownEvent === "ignore") {
          this.notices.push(
            Object.freeze({
              adapter: COMMANDCODE_PROVIDER_ID,
              direction: "response",
              code: "unknown_event_ignored",
              action: "ignore",
            }),
          );
          return;
        }
        this.rollback();
        throw new CommandCodeProtocolError(
          "UNKNOWN_EVENT",
          "Unknown CommandCode event",
        );
    }
  }

  private reserveText(id: string): void {
    if (this.textById.has(id)) this.duplicateStart("text");
    const slot: TextSlot = { kind: "text", id, state: "open", text: "" };
    this.textById.set(id, slot);
    this.slots.push(slot);
  }

  private reserveReasoning(id: string): void {
    if (this.reasoningById.has(id)) this.duplicateStart("reasoning");
    const slot: ReasoningSlot = {
      kind: "reasoning",
      id,
      state: "open",
      text: "",
    };
    this.reasoningById.set(id, slot);
    this.slots.push(slot);
  }

  private requireOpen<T extends BaseSlot>(
    map: Map<string, T>,
    id: string,
    eventType: unknown,
  ): T {
    const slot = map.get(id);
    if (slot === undefined || slot.state !== "open") {
      this.lifecycle(`${String(eventType)} without matching open start`);
    }
    return slot;
  }

  private closeText<T extends TextSlot | ReasoningSlot>(
    map: Map<string, T>,
    id: string,
    eventType: unknown,
  ): void {
    const slot = this.requireOpen(map, id, eventType);
    if (slot.text.trim().length === 0) {
      this.rollback();
      throw new CommandCodeProtocolError(
        "EMPTY_CONTENT_BLOCK",
        `CommandCode ${slot.kind} block completed empty`,
      );
    }
    slot.state = "closed";
  }

  private duplicateStart(kind: string): never {
    this.rollback();
    throw new CommandCodeProtocolError(
      "INVALID_BLOCK_LIFECYCLE",
      `Duplicate CommandCode ${kind} start`,
    );
  }

  private lifecycle(message: string): never {
    this.rollback();
    throw new CommandCodeProtocolError(
      "INVALID_BLOCK_LIFECYCLE",
      `CommandCode ${message}`,
    );
  }

  private invalidField(message: string): never {
    this.rollback();
    throw new CommandCodeProtocolError("INVALID_EVENT_FIELD", message);
  }

  private rollback(): void {
    this.slots.length = 0;
    this.textById.clear();
    this.reasoningById.clear();
    this.toolById.clear();
    this.finishEvent = undefined;
    this.rawUsage = undefined;
    this.usage = { ...ZERO_USAGE };
    this.systemPromptTokens = undefined;
    this.responseIdentity = undefined;
    this.notices.length = 0;
  }
}
