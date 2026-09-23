export type NormalizationSkipReason =
  | "item_identity_conflict"
  | "incomplete_item_chain"
  | "unsupported_event_attribution"
  | "invalid_sse_structure"
  | "invalid_sequence_number"
  | "upstream_cursor_semantics"
  | "invalid_item_lifecycle";

export interface NativeResponsesNormalizationOptions {
  readonly upstreamCursorSemantics?: boolean;
}

export type NativeResponsesNormalizationResult =
  | { readonly kind: "unchanged"; readonly body: Uint8Array<ArrayBuffer> }
  | {
      readonly kind: "normalized";
      readonly body: Uint8Array<ArrayBuffer>;
      readonly movedFrameCount: number;
      readonly commitOrderDiffersFromOutputIndex: boolean;
    }
  | {
      readonly kind: "skipped";
      readonly body: Uint8Array<ArrayBuffer>;
      readonly reason: NormalizationSkipReason;
    };

interface DataSegment {
  readonly payloadStart: number;
  readonly payloadEnd: number;
  readonly rawStart: number;
}

interface Frame {
  readonly index: number;
  readonly raw: string;
  readonly type?: string;
  readonly itemId?: string;
  readonly outputIndex?: number;
  readonly isAdded: boolean;
  readonly isDone: boolean;
  readonly isTerminal: boolean;
  readonly clearlyItemLocal: boolean;
  readonly hasCursorId: boolean;
  readonly background: boolean;
  readonly sequenceSpan?: readonly [number, number];
}

interface Chain {
  readonly id: string;
  readonly frames: Frame[];
  outputIndex?: number;
  added: boolean;
  done: boolean;
}

const encoder = new TextEncoder();

function skip(
  body: Uint8Array<ArrayBuffer>,
  reason: NormalizationSkipReason,
): NativeResponsesNormalizationResult {
  return { kind: "skipped", body, reason };
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/u.test(text[index]!)) index += 1;
  return index;
}

function endOfString(text: string, start: number): number {
  if (text[start] !== '"') throw new Error("expected JSON string");
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') return index + 1;
  }
  throw new Error("unterminated JSON string");
}

function endOfValue(text: string, start: number): number {
  if (text[start] === '"') return endOfString(text, start);
  const opening = text[start];
  if (opening !== "{" && opening !== "[") {
    let index = start;
    while (
      index < text.length &&
      text[index] !== "," &&
      text[index] !== "}" &&
      text[index] !== "]"
    ) {
      index += 1;
    }
    return index;
  }
  const stack: string[] = [opening === "{" ? "}" : "]"];
  let index = start + 1;
  while (index < text.length && stack.length > 0) {
    const char = text[index]!;
    if (char === '"') {
      index = endOfString(text, index);
      continue;
    }
    if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === stack[stack.length - 1]) stack.pop();
    index += 1;
  }
  if (stack.length !== 0) throw new Error("unterminated JSON value");
  return index;
}

function topLevelPropertySpans(
  text: string,
): ReadonlyMap<string, ReadonlyArray<readonly [number, number]>> {
  let index = skipWhitespace(text, 0);
  if (text[index] !== "{") throw new Error("JSON payload must be an object");
  index += 1;
  const result = new Map<string, Array<readonly [number, number]>>();
  while (index < text.length) {
    index = skipWhitespace(text, index);
    if (text[index] === "}") {
      index = skipWhitespace(text, index + 1);
      if (index !== text.length) throw new Error("trailing JSON content");
      return result;
    }
    const keyStart = index;
    const keyEnd = endOfString(text, keyStart);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as unknown;
    if (typeof key !== "string") throw new Error("invalid JSON key");
    index = skipWhitespace(text, keyEnd);
    if (text[index] !== ":") throw new Error("missing property separator");
    index = skipWhitespace(text, index + 1);
    const valueStart = index;
    const valueEnd = endOfValue(text, valueStart);
    const spans = result.get(key) ?? [];
    spans.push([valueStart, valueEnd] as const);
    result.set(key, spans);
    index = skipWhitespace(text, valueEnd);
    if (text[index] === ",") {
      index += 1;
      continue;
    }
    if (text[index] !== "}") throw new Error("invalid property delimiter");
  }
  throw new Error("unterminated JSON object");
}

function itemLocalType(type: string | undefined): boolean {
  if (type === undefined) return false;
  return (
    type === "response.output_item.added" ||
    type === "response.output_item.done" ||
    type.startsWith("response.output_text.") ||
    type.startsWith("response.content_part.") ||
    type.startsWith("response.reasoning") ||
    type.startsWith("response.refusal.") ||
    type.startsWith("response.function_call_arguments.") ||
    type.startsWith("response.custom_tool_call_input.") ||
    type.startsWith("response.mcp_call_arguments.")
  );
}

function parseFrame(
  raw: string,
  index: number,
): Frame | { readonly error: NormalizationSkipReason } {
  const content = raw.endsWith("\r\n\r\n")
    ? raw.slice(0, -4)
    : raw.endsWith("\n\n")
      ? raw.slice(0, -2)
      : undefined;
  if (content === undefined) return { error: "invalid_sse_structure" };

  let eventType: string | undefined;
  let hasCursorId = false;
  const dataParts: string[] = [];
  const dataSegments: DataSegment[] = [];
  let joinedDataLength = 0;
  let rawOffset = 0;
  for (const match of content.matchAll(/([^\r\n]*)(\r\n|\n|$)/gu)) {
    const line = match[1] ?? "";
    const ending = match[2] ?? "";
    if (line.length === 0 && ending.length === 0) break;
    if (!line.startsWith(":")) {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      let valueOffset = colon < 0 ? line.length : colon + 1;
      if (value.startsWith(" ")) {
        value = value.slice(1);
        valueOffset += 1;
      }
      if (field === "event") {
        if (eventType !== undefined && eventType !== value) {
          return { error: "invalid_sse_structure" };
        }
        eventType = value;
      } else if (field === "data") {
        const payloadStart =
          joinedDataLength + (dataParts.length === 0 ? 0 : 1);
        dataParts.push(value);
        joinedDataLength = payloadStart + value.length;
        dataSegments.push({
          payloadStart,
          payloadEnd: payloadStart + value.length,
          rawStart: rawOffset + valueOffset,
        });
      } else if (field === "id" && value.length > 0) {
        hasCursorId = true;
      }
    }
    rawOffset += line.length + ending.length;
    if (ending.length === 0) break;
  }

  if (dataParts.length === 0) {
    return {
      index,
      raw,
      ...(eventType === undefined ? {} : { type: eventType }),
      isAdded: eventType === "response.output_item.added",
      isDone: eventType === "response.output_item.done",
      isTerminal:
        eventType === "response.completed" ||
        eventType === "response.failed" ||
        eventType === "response.incomplete",
      clearlyItemLocal: itemLocalType(eventType),
      hasCursorId,
      background: false,
    };
  }

  const data = dataParts.join("\n");
  if (data === "[DONE]") {
    return {
      index,
      raw,
      isAdded: false,
      isDone: false,
      isTerminal: true,
      clearlyItemLocal: false,
      hasCursorId,
      background: false,
    };
  }

  let payload: Record<string, unknown>;
  let spans: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: "invalid_sse_structure" };
    }
    payload = parsed as Record<string, unknown>;
    spans = topLevelPropertySpans(data);
  } catch {
    return { error: "invalid_sse_structure" };
  }

  for (const key of ["type", "item_id", "output_index", "item"]) {
    if ((spans.get(key)?.length ?? 0) > 1) {
      return { error: "invalid_sse_structure" };
    }
  }
  const sequenceSpans = spans.get("sequence_number") ?? [];
  if (sequenceSpans.length > 1) return { error: "invalid_sequence_number" };

  const itemSpans = spans.get("item") ?? [];
  if (itemSpans.length === 1) {
    const [itemStart, itemEnd] = itemSpans[0]!;
    const rawItem = data.slice(itemStart, itemEnd).trim();
    if (rawItem.startsWith("{")) {
      try {
        const itemProperties = topLevelPropertySpans(rawItem);
        if ((itemProperties.get("id")?.length ?? 0) > 1) {
          return { error: "invalid_sse_structure" };
        }
      } catch {
        return { error: "invalid_sse_structure" };
      }
    }
  }

  const payloadType = typeof payload.type === "string" ? payload.type : undefined;
  if (
    eventType !== undefined &&
    payloadType !== undefined &&
    eventType !== payloadType
  ) {
    return { error: "invalid_sse_structure" };
  }
  const type = payloadType ?? eventType;

  const item =
    typeof payload.item === "object" &&
    payload.item !== null &&
    !Array.isArray(payload.item)
      ? (payload.item as Record<string, unknown>)
      : undefined;
  const nestedId = typeof item?.id === "string" ? item.id : undefined;
  const explicitId =
    typeof payload.item_id === "string" ? payload.item_id : undefined;
  if (
    nestedId !== undefined &&
    explicitId !== undefined &&
    nestedId !== explicitId
  ) {
    return { error: "item_identity_conflict" };
  }

  let outputIndex: number | undefined;
  if (payload.output_index !== undefined) {
    if (
      !Number.isSafeInteger(payload.output_index) ||
      (payload.output_index as number) < 0
    ) {
      return { error: "item_identity_conflict" };
    }
    outputIndex = payload.output_index as number;
  }

  let sequenceSpan: readonly [number, number] | undefined;
  if (sequenceSpans.length === 1) {
    const [valueStart, valueEnd] = sequenceSpans[0]!;
    const rawValue = data.slice(valueStart, valueEnd);
    const leadingWhitespace =
      rawValue.length - rawValue.trimStart().length;
    const trailingWhitespace =
      rawValue.length - rawValue.trimEnd().length;
    const start = valueStart + leadingWhitespace;
    const end = valueEnd - trailingWhitespace;
    if (start >= end) return { error: "invalid_sequence_number" };
    const valueText = data.slice(start, end);
    let parsedSequence: unknown;
    try {
      parsedSequence = JSON.parse(valueText);
    } catch {
      return { error: "invalid_sequence_number" };
    }
    if (!Number.isSafeInteger(parsedSequence) || (parsedSequence as number) < 0) {
      return { error: "invalid_sequence_number" };
    }
    const segment = dataSegments.find(
      (candidate) =>
        start >= candidate.payloadStart && end <= candidate.payloadEnd,
    );
    if (segment === undefined) return { error: "invalid_sequence_number" };
    sequenceSpan = [
      segment.rawStart + start - segment.payloadStart,
      segment.rawStart + end - segment.payloadStart,
    ];
  }

  const response =
    typeof payload.response === "object" &&
    payload.response !== null &&
    !Array.isArray(payload.response)
      ? (payload.response as Record<string, unknown>)
      : undefined;
  const itemId = explicitId ?? nestedId;

  return {
    index,
    raw,
    ...(type === undefined ? {} : { type }),
    ...(itemId === undefined ? {} : { itemId }),
    ...(outputIndex === undefined ? {} : { outputIndex }),
    isAdded: type === "response.output_item.added",
    isDone: type === "response.output_item.done",
    isTerminal:
      type === "response.completed" ||
      type === "response.failed" ||
      type === "response.incomplete",
    clearlyItemLocal: itemLocalType(type),
    hasCursorId,
    background: payload.background === true || response?.background === true,
    ...(sequenceSpan === undefined ? {} : { sequenceSpan }),
  };
}

function renumber(frame: Frame, sequence: number): string | undefined {
  if (frame.sequenceSpan === undefined) return frame.raw;
  const [start, end] = frame.sequenceSpan;
  if (start < 0 || end > frame.raw.length || start >= end) return undefined;
  return `${frame.raw.slice(0, start)}${sequence}${frame.raw.slice(end)}`;
}

export function normalizeNativeResponsesSse(
  body: Uint8Array<ArrayBuffer>,
  options: NativeResponsesNormalizationOptions = {},
): NativeResponsesNormalizationResult {
  const hasUtf8Bom =
    body.byteLength >= 3 &&
    body[0] === 0xef &&
    body[1] === 0xbb &&
    body[2] === 0xbf;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return skip(body, "invalid_sse_structure");
  }
  if (text.length === 0) return { kind: "unchanged", body };

  const frameRaws: string[] = [];
  const delimiter = /\r\n\r\n|\n\n/gu;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = delimiter.exec(text)) !== null) {
    frameRaws.push(text.slice(start, match.index + match[0].length));
    start = match.index + match[0].length;
  }
  if (start !== text.length) return skip(body, "invalid_sse_structure");

  const frames: Frame[] = [];
  for (let index = 0; index < frameRaws.length; index += 1) {
    const parsed = parseFrame(frameRaws[index]!, index);
    if ("error" in parsed) return skip(body, parsed.error);
    frames.push(parsed);
  }

  const idToIndex = new Map<string, number>();
  const indexToId = new Map<number, string>();
  for (const frame of frames) {
    if (frame.itemId === undefined || frame.outputIndex === undefined) continue;
    const knownIndex = idToIndex.get(frame.itemId);
    const knownId = indexToId.get(frame.outputIndex);
    if (
      (knownIndex !== undefined && knownIndex !== frame.outputIndex) ||
      (knownId !== undefined && knownId !== frame.itemId)
    ) {
      return skip(body, "item_identity_conflict");
    }
    idToIndex.set(frame.itemId, frame.outputIndex);
    indexToId.set(frame.outputIndex, frame.itemId);
  }

  const chains = new Map<string, Chain>();
  const output: Frame[] = [];
  const doneChains: Chain[] = [];
  let cursorSemantics = options.upstreamCursorSemantics === true;
  let terminalSeen = false;

  for (const frame of frames) {
    cursorSemantics ||= frame.hasCursorId || frame.background;

    const itemId =
      frame.itemId ??
      (frame.outputIndex === undefined
        ? undefined
        : indexToId.get(frame.outputIndex));
    const itemLocal =
      itemId !== undefined ||
      frame.isAdded ||
      frame.isDone ||
      frame.clearlyItemLocal;

    if (terminalSeen && itemLocal) {
      return skip(body, "incomplete_item_chain");
    }

    if (!itemLocal) {
      if (frame.isTerminal) {
        for (const chain of chains.values()) {
          if (!chain.done) return skip(body, "incomplete_item_chain");
        }
        terminalSeen = true;
      }
      output.push(frame);
      continue;
    }

    if (itemId === undefined) {
      return skip(body, "unsupported_event_attribution");
    }

    let chain = chains.get(itemId);
    if (chain === undefined) {
      chain = {
        id: itemId,
        frames: [],
        ...(frame.outputIndex === undefined
          ? {}
          : { outputIndex: frame.outputIndex }),
        added: false,
        done: false,
      };
      chains.set(itemId, chain);
    }

    if (
      frame.outputIndex !== undefined &&
      chain.outputIndex !== undefined &&
      frame.outputIndex !== chain.outputIndex
    ) {
      return skip(body, "item_identity_conflict");
    }
    if (chain.outputIndex === undefined && frame.outputIndex !== undefined) {
      chain.outputIndex = frame.outputIndex;
    }
    if (chain.done) return skip(body, "invalid_item_lifecycle");

    if (frame.isAdded) {
      if (chain.added) return skip(body, "invalid_item_lifecycle");
      chain.added = true;
    }
    if (frame.isDone) chain.done = true;

    chain.frames.push(frame);
    if (frame.isDone) {
      if (!chain.added || chain.frames[0]?.isAdded !== true) {
        return skip(body, "invalid_item_lifecycle");
      }
      output.push(...chain.frames);
      doneChains.push(chain);
    }
  }

  for (const chain of chains.values()) {
    if (!chain.added || !chain.done) return skip(body, "incomplete_item_chain");
  }

  const reordered = output.some((frame, index) => frame.index !== index);
  if (cursorSemantics) return skip(body, "upstream_cursor_semantics");
  if (!reordered) return { kind: "unchanged", body };

  let sequence = 0;
  const rendered: string[] = [];
  for (const frame of output) {
    const next = renumber(frame, sequence);
    if (next === undefined) return skip(body, "invalid_sequence_number");
    rendered.push(next);
    if (frame.sequenceSpan !== undefined) sequence += 1;
  }

  const indexes = doneChains.map((chain) => chain.outputIndex);
  const commitOrderDiffersFromOutputIndex =
    indexes.every((value) => value !== undefined) &&
    indexes.some(
      (value, index) =>
        index > 0 && (indexes[index - 1] as number) > (value as number),
    );

  const encoded = encoder.encode(rendered.join(""));
  const normalizedBody = hasUtf8Bom
    ? (() => {
        const withBom = new Uint8Array(encoded.byteLength + 3);
        withBom.set([0xef, 0xbb, 0xbf], 0);
        withBom.set(encoded, 3);
        return withBom;
      })()
    : encoded;

  return {
    kind: "normalized",
    body: normalizedBody,
    movedFrameCount: output.reduce(
      (count, frame, index) => count + (frame.index === index ? 0 : 1),
      0,
    ),
    commitOrderDiffersFromOutputIndex,
  };
}
