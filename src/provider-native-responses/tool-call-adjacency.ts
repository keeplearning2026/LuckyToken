import { rewriteModelJson } from "./common.js";
import type { ProviderResponsesOperation } from "./contract.js";

/**
 * Provider Native Responses request-side tool-call adjacency normalization.
 *
 * The lane keeps the client's JSON text authoritative. For ordinary
 * `operation === "responses"` bodies it may additionally defer an original
 * `role=developer` message item slice out of a fully validated, closed
 * tool-call group. Any qualification, span, or reconstruction failure falls
 * back to the model-only projection.
 */

export const TOOL_CALL_ADJACENCY_DEFERRED_NOTICE_CODE =
  "provider_native_tool_call_adjacency_deferred";
export const TOOL_CALL_GROUP_ABANDONED_NOTICE_CODE =
  "provider_native_tool_call_group_abandoned";
export const TOOL_CALL_GROUP_UNSUPPORTED_ITEM_NOTICE_CODE =
  "provider_native_tool_call_group_unsupported_item";

export type ProviderNativeBodyOutcome =
  | "model-only"
  | "deferred"
  | "abandoned"
  | "unsupported-item";

export interface ProviderNativeBodyProjection {
  readonly parsed: Record<string, unknown>;
  readonly text: string;
  readonly outcome: ProviderNativeBodyOutcome;
  readonly deferredMessages: number;
}

const CALL_FAMILIES: ReadonlyMap<string, string> = new Map([
  ["function_call", "function"],
  ["custom_tool_call", "custom_tool"],
]);

const OUTPUT_FAMILIES: ReadonlyMap<string, string> = new Map([
  ["function_call_output", "function"],
  ["custom_tool_call_output", "custom_tool"],
]);

const CLASSIFICATION_KEYS: readonly string[] = ["type", "call_id", "role", "id"];

interface ElementSpan {
  readonly start: number;
  readonly end: number;
}

interface ArrayLayout {
  readonly open: number;
  readonly close: number;
  readonly elements: readonly ElementSpan[];
  readonly lead: string;
  readonly separators: readonly string[];
  readonly tail: string;
}

interface KeyEntry {
  readonly key: string;
  readonly valueStart: number;
  readonly valueEnd: number;
}

interface ObjectScan {
  readonly entries: readonly KeyEntry[];
  readonly duplicate: boolean;
}

interface Move {
  readonly from: number;
  readonly to: number;
}

type Analysis =
  | { readonly kind: "none" }
  | { readonly kind: "abstain"; readonly outcome: "abandoned" | "unsupported-item" }
  | { readonly kind: "moves"; readonly order: readonly number[]; readonly movedCount: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/u.test(text[index]!)) index += 1;
  return index;
}

function endOfString(text: string, start: number): number {
  if (text[start] !== '"') return -1;
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
  return -1;
}

function endOfValue(text: string, start: number): number {
  const first = text[start];
  if (first === undefined) return -1;
  if (first === '"') return endOfString(text, start);
  if (first === "{" || first === "[") {
    const stack: string[] = [first === "{" ? "}" : "]"];
    let index = start + 1;
    while (index < text.length && stack.length > 0) {
      const char = text[index]!;
      if (char === '"') {
        const next = endOfString(text, index);
        if (next < 0) return -1;
        index = next;
        continue;
      }
      if (char === "{") stack.push("}");
      else if (char === "[") stack.push("]");
      else if (char === stack[stack.length - 1]) stack.pop();
      index += 1;
    }
    return stack.length === 0 ? index : -1;
  }
  let index = start;
  while (index < text.length && !/[,}\]]/u.test(text[index]!)) index += 1;
  return index;
}

function scanObject(text: string, start: number): ObjectScan | null {
  if (text[start] !== "{") return null;
  const entries: KeyEntry[] = [];
  const seen = new Set<string>();
  let duplicate = false;
  let index = skipWhitespace(text, start + 1);
  if (text[index] === "}") return { entries, duplicate };
  for (;;) {
    const keyEnd = endOfString(text, index);
    if (keyEnd < 0) return null;
    let key: unknown;
    try {
      key = JSON.parse(text.slice(index, keyEnd));
    } catch {
      return null;
    }
    if (typeof key !== "string") return null;
    if (seen.has(key)) duplicate = true;
    seen.add(key);
    index = skipWhitespace(text, keyEnd);
    if (text[index] !== ":") return null;
    index = skipWhitespace(text, index + 1);
    const valueEnd = endOfValue(text, index);
    if (valueEnd < 0) return null;
    entries.push({ key, valueStart: index, valueEnd });
    index = skipWhitespace(text, valueEnd);
    if (text[index] === ",") {
      index = skipWhitespace(text, index + 1);
      continue;
    }
    if (text[index] === "}") return { entries, duplicate };
    return null;
  }
}

function scanArray(text: string, open: number, valueEnd: number): ArrayLayout | null {
  const close = valueEnd - 1;
  if (text[close] !== "]") return null;
  const elements: ElementSpan[] = [];
  let index = skipWhitespace(text, open + 1);
  if (index === close) {
    return { open, close, elements, lead: "", separators: [], tail: "" };
  }
  for (;;) {
    const start = index;
    let end = endOfValue(text, start);
    if (end < 0 || end > close) return null;
    while (end > start && /\s/u.test(text[end - 1]!)) end -= 1;
    if (end === start) return null;
    elements.push({ start, end });
    index = skipWhitespace(text, end);
    if (index === close) break;
    if (text[index] !== ",") return null;
    index = skipWhitespace(text, index + 1);
    if (index >= close) return null;
  }
  const lead = text.slice(open + 1, elements[0]!.start);
  const tail = text.slice(elements[elements.length - 1]!.end, close);
  const separators: string[] = [];
  for (let k = 0; k + 1 < elements.length; k += 1) {
    separators.push(text.slice(elements[k]!.end, elements[k + 1]!.start));
  }
  return { open, close, elements, lead, separators, tail };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((entry, index) => deepEqual(entry, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]),
    );
  }
  return false;
}

function familyOf(item: Record<string, unknown>): { call?: string; output?: string } {
  const type = item.type;
  if (typeof type !== "string") return {};
  const call = CALL_FAMILIES.get(type);
  const output = OUTPUT_FAMILIES.get(type);
  return {
    ...(call === undefined ? {} : { call }),
    ...(output === undefined ? {} : { output }),
  };
}

function analyze(
  input: readonly unknown[],
  text: string,
  layout: ArrayLayout,
): Analysis {
  let violated = false;
  let sawCandidate = false;
  let sawUnsupported = false;

  for (let index = 0; index < input.length; index += 1) {
    const span = layout.elements[index];
    if (span === undefined) {
      violated = true;
      continue;
    }
    if (text[span.start] !== "{") continue;
    const scanned = scanObject(text, span.start);
    if (scanned === null) {
      violated = true;
      continue;
    }
    if (scanned.duplicate) violated = true;
    const classified = new Set<string>();
    for (const entry of scanned.entries) {
      if (!CLASSIFICATION_KEYS.includes(entry.key)) continue;
      if (classified.has(entry.key)) violated = true;
      classified.add(entry.key);
    }
  }

  const declared = new Map<string, string>();
  const produced = new Map<string, string>();
  for (const item of input) {
    if (!isRecord(item)) continue;
    const { call, output } = familyOf(item);
    const callId = item.call_id;
    if (call !== undefined) {
      if (typeof callId !== "string" || callId.length === 0 || declared.has(callId)) {
        violated = true;
      } else {
        declared.set(callId, call);
      }
      continue;
    }
    if (output !== undefined) {
      if (typeof callId !== "string" || callId.length === 0 || produced.has(callId)) {
        violated = true;
      } else {
        produced.set(callId, output);
      }
    }
  }
  for (const [callId, call] of declared) {
    if (produced.get(callId) !== call) violated = true;
  }
  for (const callId of produced.keys()) {
    if (!declared.has(callId)) violated = true;
  }

  const pending = new Map<string, string>();
  const moves: Move[] = [];
  let candidates: number[] = [];
  let inCallSegment = true;
  let seenOutput = false;
  const resetGroup = (): void => {
    pending.clear();
    candidates = [];
    inCallSegment = true;
    seenOutput = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!isRecord(item)) {
      violated = true;
      if (pending.size > 0) {
        sawUnsupported = true;
        resetGroup();
      }
      continue;
    }
    const { call, output } = familyOf(item);
    if (call !== undefined) {
      if (pending.size > 0 && !inCallSegment) {
        violated = true;
        resetGroup();
      }
      const callId = item.call_id;
      if (typeof callId === "string" && callId.length > 0) {
        pending.set(callId, call);
      } else {
        violated = true;
      }
      continue;
    }
    if (output !== undefined) {
      const callId = item.call_id;
      if (pending.size === 0) {
        violated = true;
        continue;
      }
      if (typeof callId !== "string" || pending.get(callId) !== output) {
        violated = true;
        resetGroup();
        continue;
      }
      pending.delete(callId);
      inCallSegment = false;
      seenOutput = true;
      if (pending.size === 0) {
        if (candidates.length > 0) {
          for (const from of candidates) moves.push({ from, to: index });
        }
        resetGroup();
      }
      continue;
    }
    if (pending.size === 0) continue;
    if (item.type === "message" && item.role === "developer" && seenOutput) {
      candidates.push(index);
      sawCandidate = true;
      inCallSegment = false;
      continue;
    }
    sawUnsupported = true;
    resetGroup();
  }
  if (pending.size > 0) violated = true;

  if (!violated && moves.length > 0) {
    const moved = new Set(moves.map((move) => move.from));
    const byTarget = new Map<number, number[]>();
    for (const move of moves) {
      const list = byTarget.get(move.to) ?? [];
      list.push(move.from);
      byTarget.set(move.to, list);
    }
    const order: number[] = [];
    for (let index = 0; index < input.length; index += 1) {
      if (moved.has(index)) continue;
      order.push(index);
      const inserted = byTarget.get(index);
      if (inserted !== undefined) order.push(...inserted);
    }
    if (order.length === input.length) {
      return { kind: "moves", order, movedCount: moves.length };
    }
    violated = true;
  }

  if (sawUnsupported) return { kind: "abstain", outcome: "unsupported-item" };
  if (sawCandidate) return { kind: "abstain", outcome: "abandoned" };
  return { kind: "none" };
}

function buildProjection(
  text: string,
  modelValue: ElementSpan | undefined,
  parsed: Record<string, unknown>,
  input: readonly unknown[],
  layout: ArrayLayout,
  order: readonly number[],
  movedCount: number,
  modelId: string,
): ProviderNativeBodyProjection | null {
  let interior = layout.lead;
  for (let index = 0; index < order.length; index += 1) {
    const span = layout.elements[order[index]!]!;
    interior += text.slice(span.start, span.end);
    if (index < order.length - 1) interior += layout.separators[index]!;
  }
  interior += layout.tail;

  const edits: Array<{ start: number; end: number; text: string }> = [
    { start: layout.open + 1, end: layout.close, text: interior },
  ];
  if (parsed.model !== modelId) {
    if (modelValue === undefined || text[modelValue.start] !== '"') return null;
    edits.push({
      start: modelValue.start,
      end: modelValue.end,
      text: JSON.stringify(modelId),
    });
  }
  edits.sort((left, right) => left.start - right.start);
  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index]!.start < edits[index - 1]!.end) return null;
  }

  let projected = text;
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index]!;
    projected = projected.slice(0, edit.start) + edit.text + projected.slice(edit.end);
  }

  let output: unknown;
  try {
    output = JSON.parse(projected);
  } catch {
    return null;
  }
  if (!isRecord(output)) return null;
  const outputInput = output.input;
  if (!Array.isArray(outputInput) || outputInput.length !== order.length) return null;
  for (let index = 0; index < order.length; index += 1) {
    if (!deepEqual(outputInput[index], input[order[index]!])) return null;
  }
  const inputKeys = Object.keys(parsed).sort();
  const outputKeys = Object.keys(output).sort();
  if (inputKeys.length !== outputKeys.length) return null;
  for (let index = 0; index < inputKeys.length; index += 1) {
    if (inputKeys[index] !== outputKeys[index]) return null;
  }
  for (const key of inputKeys) {
    if (key === "input" || key === "model") continue;
    if (!deepEqual(output[key], parsed[key])) return null;
  }
  if (output.model !== modelId && parsed.model !== output.model) return null;
  if (parsed.model !== modelId && output.model !== modelId) return null;

  const outputTop = scanObject(projected, 0);
  if (outputTop === null || outputTop.duplicate) return null;
  const outputInputEntry = outputTop.entries.find((entry) => entry.key === "input");
  if (outputInputEntry === undefined) return null;
  const outputLayout = scanArray(projected, outputInputEntry.valueStart, outputInputEntry.valueEnd);
  if (outputLayout === null || outputLayout.elements.length !== order.length) return null;
  if (outputLayout.lead !== layout.lead || outputLayout.tail !== layout.tail) return null;
  for (let index = 0; index < order.length; index += 1) {
    const expected = layout.elements[order[index]!]!;
    const actual = outputLayout.elements[index]!;
    if (projected.slice(actual.start, actual.end) !== text.slice(expected.start, expected.end)) {
      return null;
    }
    if (index < order.length - 1 && outputLayout.separators[index] !== layout.separators[index]) {
      return null;
    }
  }

  const reordered = order.map((source) => input[source]);
  return {
    parsed: { ...parsed, input: reordered },
    text: projected,
    outcome: "deferred",
    deferredMessages: movedCount,
  };
}

export function projectProviderNativeBody(
  rawBody: string,
  modelId: string,
  operation: ProviderResponsesOperation,
): ProviderNativeBodyProjection {
  const modelOnly = (outcome: ProviderNativeBodyOutcome): ProviderNativeBodyProjection => {
    const rewritten = rewriteModelJson(rawBody, modelId);
    return {
      parsed: rewritten.parsed,
      text: rewritten.text,
      outcome,
      deferredMessages: 0,
    };
  };

  if (operation !== "responses") return modelOnly("model-only");

  const top = scanObject(rawBody, 0);
  if (top === null || top.duplicate) return modelOnly("model-only");
  const inputEntry = top.entries.find((entry) => entry.key === "input");
  const modelEntry = top.entries.find((entry) => entry.key === "model");
  if (inputEntry === undefined || modelEntry === undefined) return modelOnly("model-only");
  if (rawBody[inputEntry.valueStart] !== "[") return modelOnly("model-only");

  const layout = scanArray(rawBody, inputEntry.valueStart, inputEntry.valueEnd);
  if (layout === null) return modelOnly("model-only");

  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(rawBody) as unknown;
    if (!isRecord(value)) return modelOnly("model-only");
    parsed = value;
  } catch {
    return modelOnly("model-only");
  }
  const input = parsed.input;
  if (!Array.isArray(input) || input.length !== layout.elements.length) {
    return modelOnly("model-only");
  }
  for (let index = 0; index < input.length; index += 1) {
    const span = layout.elements[index]!;
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawBody.slice(span.start, span.end));
    } catch {
      return modelOnly("model-only");
    }
    if (!deepEqual(decoded, input[index])) return modelOnly("model-only");
  }

  const analysis = analyze(input, rawBody, layout);
  if (analysis.kind === "none") return modelOnly("model-only");
  if (analysis.kind === "abstain") return modelOnly(analysis.outcome);

  const modelValue =
    parsed.model !== modelId
      ? { start: modelEntry.valueStart, end: modelEntry.valueEnd }
      : undefined;
  const projection = buildProjection(
    rawBody,
    modelValue,
    parsed,
    input,
    layout,
    analysis.order,
    analysis.movedCount,
    modelId,
  );
  if (projection === null) return modelOnly("abandoned");
  return projection;
}
