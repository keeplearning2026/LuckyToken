export type CommandCodeContentBlock =
  | { type: "text"; id: string; text: string }
  | { type: "reasoning"; id: string; text: string }
  | {
      type: "tool_use";
      id: string;
      toolName: string;
      input: unknown;
    };

export interface CommandCodeFinishEvent extends Record<string, unknown> {
  type: "finish";
  finishReason?: string;
  rawFinishReason?: string;
  totalUsage?: Record<string, unknown>;
  systemPromptTokens?: number;
}

export interface CommandCodeNormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CommandCodeResult {
  content: CommandCodeContentBlock[];
  finish: CommandCodeFinishEvent;
  rawUsage?: Record<string, unknown>;
  usage: CommandCodeNormalizedUsage;
  systemPromptTokens?: number;
}

export type CommandCodeProtocolErrorCode =
  | "NON_JSON_LINE"
  | "INVALID_EVENT"
  | "UNKNOWN_EVENT"
  | "INVALID_EVENT_FIELD"
  | "INVALID_BLOCK_LIFECYCLE"
  | "EMPTY_CONTENT_BLOCK";

export class CommandCodeProtocolError extends Error {
  readonly retryable = false;

  constructor(
    readonly code: CommandCodeProtocolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CommandCodeProtocolError";
  }
}

export class CommandCodeTransportError extends Error {
  readonly retryable = true;

  constructor() {
    super("CommandCode transport ended without finish or abort");
    this.name = "CommandCodeTransportError";
  }
}

export class CommandCodeAbortError extends Error {
  readonly retryable = false;

  constructor() {
    super("CommandCode response emitted abort");
    this.name = "CommandCodeAbortError";
  }
}

export class CommandCodePauseTurnError extends Error {
  readonly retryable = false;

  constructor() {
    super("CommandCode pause_turn is unsupported");
    this.name = "CommandCodePauseTurnError";
  }
}

export class CommandCodeStreamError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "CommandCodeStreamError";
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
  finalInput?: unknown;
}

type Slot = TextSlot | ReasoningSlot | ToolSlot;

const ZERO_USAGE: CommandCodeNormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
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
  private readonly slots: Slot[] = [];
  private readonly textById = new Map<string, TextSlot>();
  private readonly reasoningById = new Map<string, ReasoningSlot>();
  private readonly toolById = new Map<string, ToolSlot>();
  private finishEvent: CommandCodeFinishEvent | undefined;
  private rawUsage: Record<string, unknown> | undefined;
  private usage: CommandCodeNormalizedUsage = { ...ZERO_USAGE };
  private systemPromptTokens: number | undefined;
  private finalized = false;

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
    this.consumeEvent(parsed);
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
        `CommandCode ${open.kind} block ${open.id} remained open at EOF`,
      );
    }
    const effectiveRawReason =
      this.finishEvent.rawFinishReason ?? this.finishEvent.finishReason;
    if (effectiveRawReason === "pause_turn") {
      this.rollback();
      throw new CommandCodePauseTurnError();
    }

    const content = this.slots.map((slot): CommandCodeContentBlock => {
      if (slot.kind === "text") {
        return { type: "text", id: slot.id, text: slot.text };
      }
      if (slot.kind === "reasoning") {
        return { type: "reasoning", id: slot.id, text: slot.text };
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
    };
    if (this.rawUsage !== undefined) result.rawUsage = this.rawUsage;
    if (this.systemPromptTokens !== undefined) {
      result.systemPromptTokens = this.systemPromptTokens;
    }
    return result;
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
        if (this.toolById.has(id)) this.duplicateStart("tool", id);
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
        if (slot.inputEnded) this.lifecycle("tool delta after input end", id);
        slot.preview += requireString(event, "delta");
        return;
      }
      case "tool-input-end": {
        const id = requireString(event, "id", true);
        const slot = this.requireOpen(this.toolById, id, event.type);
        if (slot.inputEnded) this.lifecycle("repeated tool input end", id);
        slot.inputEnded = true;
        return;
      }
      case "tool-call": {
        const id = requireString(event, "toolCallId", true);
        const slot = this.requireOpen(this.toolById, id, event.type);
        if (!slot.inputEnded) this.lifecycle("tool call before input end", id);
        slot.finalToolName = requireString(event, "toolName", true);
        slot.finalInput = Object.hasOwn(event, "input")
          ? event.input
          : Object.hasOwn(event, "args")
            ? event.args
            : {};
        slot.state = "closed";
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
        this.finishEvent = event as CommandCodeFinishEvent;
        this.rawUsage = isRecord(event.totalUsage) ? event.totalUsage : undefined;
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
        const message =
          (typeof detail?.message === "string" ? detail.message : undefined) ??
          (typeof event.error === "string" ? event.error : "Stream error");
        this.rollback();
        throw new CommandCodeStreamError(
          message,
          event.isRetryable === true || detail?.isRetryable === true,
          typeof detail?.statusCode === "number" ? detail.statusCode : 500,
        );
      }
      case "abort":
        this.rollback();
        throw new CommandCodeAbortError();
      case "start":
      case "start-step":
      case "provider-metadata":
      case "finish-step":
        return;
      default:
        this.rollback();
        throw new CommandCodeProtocolError(
          "UNKNOWN_EVENT",
          `Unknown CommandCode event: ${event.type}`,
        );
    }
  }

  private reserveText(id: string): void {
    if (this.textById.has(id)) this.duplicateStart("text", id);
    const slot: TextSlot = { kind: "text", id, state: "open", text: "" };
    this.textById.set(id, slot);
    this.slots.push(slot);
  }

  private reserveReasoning(id: string): void {
    if (this.reasoningById.has(id)) this.duplicateStart("reasoning", id);
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
      this.lifecycle(`${String(eventType)} without matching open start`, id);
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
        `CommandCode ${slot.kind} block ${id} completed empty`,
      );
    }
    slot.state = "closed";
  }

  private duplicateStart(kind: string, id: string): never {
    this.rollback();
    throw new CommandCodeProtocolError(
      "INVALID_BLOCK_LIFECYCLE",
      `Duplicate CommandCode ${kind} start for ${id}`,
    );
  }

  private lifecycle(message: string, id: string): never {
    this.rollback();
    throw new CommandCodeProtocolError(
      "INVALID_BLOCK_LIFECYCLE",
      `CommandCode ${message}: ${id}`,
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
  }
}
