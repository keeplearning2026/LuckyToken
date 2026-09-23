import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { normalizeNativeResponsesSse } from "../../src/protocols/openai-responses/native-sse-lifecycle-normalizer.js";

interface UpstreamArtifact {
  readonly responseBody?: unknown;
  readonly status?: unknown;
  readonly url?: unknown;
}

interface ParsedFrame {
  readonly index: number;
  readonly type: string;
  readonly payload?: Record<string, unknown>;
  readonly outputIndex?: number;
  readonly explicitItemId?: string;
  readonly nestedItemId?: string;
  readonly resolvedItemId?: string;
  readonly signature: string;
  readonly item?: Record<string, unknown>;
}

interface ItemCompleteness {
  readonly itemId: string;
  readonly itemType: string;
  readonly deltaFamily: string;
  readonly deltaCount: number;
  readonly deltaChars: number;
  readonly doneChars?: number;
  readonly deltaEqualsDone?: boolean;
}

interface CertificationRow {
  readonly artifact: string;
  readonly status?: unknown;
  readonly url?: unknown;
  readonly result: "unchanged" | "normalized" | "skipped";
  readonly movedFrameCount?: number;
  readonly skipReason?: string;
  readonly rawFrameCount: number;
  readonly normalizedFrameCount?: number;
  readonly invariants?: {
    readonly sameFrameCount: boolean;
    readonly sameSemanticFrameMultiset: boolean;
    readonly samePerItemFrameOrder: boolean;
    readonly sameDoneOrder: boolean;
    readonly sameDoneItemPayloads: boolean;
    readonly sameGlobalDoneSkeleton: boolean;
    readonly sameTerminalOrder: boolean;
    readonly contentBearingGlobalOrderChanged: boolean;
  };
  readonly rawDoneOrder: readonly string[];
  readonly normalizedDoneOrder?: readonly string[];
  readonly rawContentBearingOrder: readonly string[];
  readonly normalizedContentBearingOrder?: readonly string[];
  readonly movement?: {
    readonly movedFrameCountIndependent: number;
    readonly movedContentBearingFrameCount: number;
    readonly movedFrameTypes: Readonly<Record<string, number>>;
  };
  readonly completeness: readonly ItemCompleteness[];
  readonly predictedRawLifecycleWarnings: Readonly<Record<string, number>>;
  readonly predictedNormalizedLifecycleWarnings?: Readonly<Record<string, number>>;
}

const CONTENT_BEARING_TYPES = new Set([
  "response.output_text.delta",
  "response.refusal.delta",
  "response.reasoning.delta",
  "response.reasoning_text.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_part.added",
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
  "response.mcp_call_arguments.delta",
]);

const CODEX_ACTIVE_ITEM_WARNING_BY_TYPE = new Map<string, string>([
  ["response.output_text.delta", "OutputTextDelta without active item"],
  ["response.reasoning_summary_text.delta", "ReasoningSummaryDelta without active item"],
  ["response.reasoning_summary_part.added", "ReasoningSummaryPartAdded without active item"],
  ["response.reasoning_text.delta", "ReasoningRawContentDelta without active item"],
]);

function eventBlocks(wire: string): readonly string[] {
  const blocks = wire.match(/[\s\S]*?(?:\r\n\r\n|\n\n)/gu) ?? [];
  if (blocks.join("") !== wire) {
    throw new Error("SSE contains trailing bytes outside complete frames");
  }
  return blocks;
}

function canonicalPayload(payload: Record<string, unknown>): string {
  const clone = structuredClone(payload);
  delete clone.sequence_number;
  return JSON.stringify(clone);
}

function parseFrames(wire: string): ParsedFrame[] {
  const prelim = eventBlocks(wire).map((block, index) => {
    let eventType = "";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/u)) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) {
      return {
        index,
        type: eventType,
        signature: `event-only:${eventType}:${block.replace(/sequence_number[^\r\n]*/gu, "")}`,
      } satisfies ParsedFrame;
    }
    const joined = data.join("\n");
    if (joined === "[DONE]") {
      return {
        index,
        type: "[DONE]",
        signature: "[DONE]",
      } satisfies ParsedFrame;
    }
    const parsed = JSON.parse(joined) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`frame ${index} payload is not an object`);
    }
    const payload = parsed as Record<string, unknown>;
    const type = typeof payload.type === "string" ? payload.type : eventType;
    const outputIndex =
      typeof payload.output_index === "number" ? payload.output_index : undefined;
    const explicitItemId =
      typeof payload.item_id === "string" ? payload.item_id : undefined;
    const item =
      typeof payload.item === "object" &&
      payload.item !== null &&
      !Array.isArray(payload.item)
        ? (payload.item as Record<string, unknown>)
        : undefined;
    const nestedItemId = typeof item?.id === "string" ? item.id : undefined;
    return {
      index,
      type,
      payload,
      ...(outputIndex === undefined ? {} : { outputIndex }),
      ...(explicitItemId === undefined ? {} : { explicitItemId }),
      ...(nestedItemId === undefined ? {} : { nestedItemId }),
      signature: canonicalPayload(payload),
      ...(item === undefined ? {} : { item }),
    } satisfies ParsedFrame;
  });

  const indexToId = new Map<number, string>();
  for (const frame of prelim) {
    const id = frame.explicitItemId ?? frame.nestedItemId;
    if (id !== undefined && frame.outputIndex !== undefined) {
      indexToId.set(frame.outputIndex, id);
    }
  }
  return prelim.map((frame) => {
    const resolvedItemId =
      frame.explicitItemId ??
      frame.nestedItemId ??
      (frame.outputIndex === undefined ? undefined : indexToId.get(frame.outputIndex));
    return {
      ...frame,
      ...(resolvedItemId === undefined ? {} : { resolvedItemId }),
    };
  });
}

function multisetFingerprint(frames: readonly ParsedFrame[]): readonly string[] {
  return frames.map((frame) => frame.signature).sort();
}

function perItemFrameOrder(
  frames: readonly ParsedFrame[],
): Readonly<Record<string, readonly string[]>> {
  const result: Record<string, string[]> = {};
  for (const frame of frames) {
    if (frame.resolvedItemId === undefined) continue;
    (result[frame.resolvedItemId] ??= []).push(frame.signature);
  }
  return result;
}

function doneOrder(frames: readonly ParsedFrame[]): readonly string[] {
  return frames
    .filter((frame) => frame.type === "response.output_item.done")
    .map((frame) => frame.resolvedItemId ?? "<missing>");
}

function doneItemPayloads(frames: readonly ParsedFrame[]): readonly string[] {
  return frames
    .filter((frame) => frame.type === "response.output_item.done")
    .map((frame) =>
      JSON.stringify({
        id: frame.resolvedItemId ?? "<missing>",
        item: frame.item ?? null,
      }),
    );
}

function globalDoneSkeleton(frames: readonly ParsedFrame[]): readonly string[] {
  return frames
    .filter(
      (frame) =>
        frame.type === "response.output_item.done" ||
        frame.resolvedItemId === undefined,
    )
    .map((frame) =>
      frame.type === "response.output_item.done"
        ? `${frame.type}:${frame.resolvedItemId ?? "<missing>"}`
        : `${frame.type}:global`,
    );
}

function terminalOrder(frames: readonly ParsedFrame[]): readonly string[] {
  return frames
    .filter(
      (frame) =>
        frame.type === "response.completed" ||
        frame.type === "response.failed" ||
        frame.type === "response.incomplete" ||
        frame.type === "[DONE]",
    )
    .map((frame) => frame.type);
}

function contentBearingOrder(frames: readonly ParsedFrame[]): readonly string[] {
  return frames
    .filter((frame) => CONTENT_BEARING_TYPES.has(frame.type))
    .map((frame) =>
      JSON.stringify({
        itemId: frame.resolvedItemId ?? "<missing>",
        type: frame.type,
        payload: frame.signature,
      }),
    );
}

function movementStats(
  rawFrames: readonly ParsedFrame[],
  normalizedFrames: readonly ParsedFrame[],
): {
  readonly movedFrameCountIndependent: number;
  readonly movedContentBearingFrameCount: number;
  readonly movedFrameTypes: Readonly<Record<string, number>>;
} {
  const rawPositions = new Map<string, number[]>();
  for (const frame of rawFrames) {
    const positions = rawPositions.get(frame.signature) ?? [];
    positions.push(frame.index);
    rawPositions.set(frame.signature, positions);
  }

  let movedFrameCountIndependent = 0;
  let movedContentBearingFrameCount = 0;
  const movedFrameTypes: Record<string, number> = {};
  for (const frame of normalizedFrames) {
    const positions = rawPositions.get(frame.signature);
    assert.ok(positions && positions.length > 0, "normalized frame missing from raw multiset");
    const rawIndex = positions.shift()!;
    if (rawIndex === frame.index) continue;
    movedFrameCountIndependent += 1;
    movedFrameTypes[frame.type] = (movedFrameTypes[frame.type] ?? 0) + 1;
    if (CONTENT_BEARING_TYPES.has(frame.type)) movedContentBearingFrameCount += 1;
  }
  return {
    movedFrameCountIndependent,
    movedContentBearingFrameCount,
    movedFrameTypes,
  };
}

function itemType(item: Record<string, unknown> | undefined): string {
  return typeof item?.type === "string" ? item.type : "unknown";
}

function textFromDoneItem(item: Record<string, unknown>): string | undefined {
  const type = itemType(item);
  if (type === "message") {
    const content = Array.isArray(item.content) ? item.content : [];
    return content
      .filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" &&
          entry !== null &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>).type === "output_text",
      )
      .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
      .join("");
  }
  if (type === "function_call") {
    return typeof item.arguments === "string" ? item.arguments : undefined;
  }
  if (type === "custom_tool_call") {
    return typeof item.input === "string" ? item.input : undefined;
  }
  return undefined;
}

function completeness(frames: readonly ParsedFrame[]): readonly ItemCompleteness[] {
  const doneById = new Map<string, Record<string, unknown>>();
  for (const frame of frames) {
    if (
      frame.type === "response.output_item.done" &&
      frame.resolvedItemId !== undefined &&
      frame.item !== undefined
    ) {
      doneById.set(frame.resolvedItemId, frame.item);
    }
  }

  const families = [
    ["response.output_text.delta", "message.output_text", "delta"],
    ["response.function_call_arguments.delta", "function_call.arguments", "delta"],
    ["response.custom_tool_call_input.delta", "custom_tool_call.input", "delta"],
    ["response.reasoning.delta", "reasoning.delta", "delta"],
    ["response.reasoning_text.delta", "reasoning_text.delta", "delta"],
    ["response.reasoning_summary_text.delta", "reasoning_summary_text.delta", "delta"],
  ] as const;

  const results: ItemCompleteness[] = [];
  for (const [eventType, deltaFamily, field] of families) {
    const grouped = new Map<string, string[]>();
    for (const frame of frames) {
      if (frame.type !== eventType || frame.resolvedItemId === undefined) continue;
      const value = frame.payload?.[field];
      if (typeof value !== "string") continue;
      (grouped.get(frame.resolvedItemId) ?? (() => {
        const next: string[] = [];
        grouped.set(frame.resolvedItemId!, next);
        return next;
      })()).push(value);
    }

    for (const [itemId, deltas] of grouped) {
      const doneItem = doneById.get(itemId);
      const doneText = doneItem === undefined ? undefined : textFromDoneItem(doneItem);
      const joined = deltas.join("");
      results.push({
        itemId,
        itemType: itemType(doneItem),
        deltaFamily,
        deltaCount: deltas.length,
        deltaChars: joined.length,
        ...(doneText === undefined
          ? {}
          : {
              doneChars: doneText.length,
              deltaEqualsDone: joined === doneText,
            }),
      });
    }
  }
  return results;
}

function predictedLifecycleWarnings(
  frames: readonly ParsedFrame[],
): Readonly<Record<string, number>> {
  let activeItem: { readonly id: string; readonly type: string } | undefined;
  const counts: Record<string, number> = {};

  for (const frame of frames) {
    if (frame.type === "response.output_item.added") {
      const type = itemType(frame.item);
      if (
        frame.resolvedItemId !== undefined &&
        (type === "message" || type === "reasoning" || type === "web_search_call")
      ) {
        activeItem = { id: frame.resolvedItemId, type };
      }
      continue;
    }

    if (frame.type === "response.output_item.done") {
      activeItem = undefined;
      continue;
    }

    const warning = CODEX_ACTIVE_ITEM_WARNING_BY_TYPE.get(frame.type);
    if (warning !== undefined && activeItem === undefined) {
      counts[warning] = (counts[warning] ?? 0) + 1;
    }
  }

  return counts;
}

async function artifactFiles(input: string): Promise<readonly string[]> {
  const path = resolve(input);
  const info = await stat(path);
  if (info.isFile()) return [path];
  if (!info.isDirectory()) return [];
  return (await readdir(path))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(path, name));
}

async function certifyArtifact(path: string): Promise<CertificationRow | undefined> {
  const artifact = JSON.parse(await readFile(path, "utf8")) as UpstreamArtifact;
  if (typeof artifact.responseBody !== "string") return undefined;

  const rawWire = artifact.responseBody;
  const rawFrames = parseFrames(rawWire);
  const normalized = normalizeNativeResponsesSse(new TextEncoder().encode(rawWire));

  const base = {
    artifact: path,
    ...(artifact.status === undefined ? {} : { status: artifact.status }),
    ...(artifact.url === undefined ? {} : { url: artifact.url }),
    rawFrameCount: rawFrames.length,
    rawDoneOrder: doneOrder(rawFrames),
    rawContentBearingOrder: contentBearingOrder(rawFrames),
    completeness: completeness(rawFrames),
    predictedRawLifecycleWarnings: predictedLifecycleWarnings(rawFrames),
  } as const;

  if (normalized.kind === "skipped") {
    return {
      ...base,
      result: "skipped",
      skipReason: normalized.reason,
    };
  }

  if (normalized.kind === "unchanged") {
    return {
      ...base,
      result: "unchanged",
      normalizedFrameCount: rawFrames.length,
      normalizedDoneOrder: base.rawDoneOrder,
      normalizedContentBearingOrder: base.rawContentBearingOrder,
      predictedNormalizedLifecycleWarnings: base.predictedRawLifecycleWarnings,
    };
  }

  const normalizedWire = new TextDecoder().decode(normalized.body);
  const normalizedFrames = parseFrames(normalizedWire);
  const rawDone = doneOrder(rawFrames);
  const nextDone = doneOrder(normalizedFrames);
  const rawContent = contentBearingOrder(rawFrames);
  const nextContent = contentBearingOrder(normalizedFrames);

  return {
    ...base,
    result: "normalized",
    movedFrameCount: normalized.movedFrameCount,
    normalizedFrameCount: normalizedFrames.length,
    normalizedDoneOrder: nextDone,
    normalizedContentBearingOrder: nextContent,
    movement: movementStats(rawFrames, normalizedFrames),
    predictedNormalizedLifecycleWarnings: predictedLifecycleWarnings(normalizedFrames),
    invariants: {
      sameFrameCount: rawFrames.length === normalizedFrames.length,
      sameSemanticFrameMultiset:
        JSON.stringify(multisetFingerprint(rawFrames)) ===
        JSON.stringify(multisetFingerprint(normalizedFrames)),
      samePerItemFrameOrder:
        JSON.stringify(perItemFrameOrder(rawFrames)) ===
        JSON.stringify(perItemFrameOrder(normalizedFrames)),
      sameDoneOrder: JSON.stringify(rawDone) === JSON.stringify(nextDone),
      sameDoneItemPayloads:
        JSON.stringify(doneItemPayloads(rawFrames)) ===
        JSON.stringify(doneItemPayloads(normalizedFrames)),
      sameGlobalDoneSkeleton:
        JSON.stringify(globalDoneSkeleton(rawFrames)) ===
        JSON.stringify(globalDoneSkeleton(normalizedFrames)),
      sameTerminalOrder:
        JSON.stringify(terminalOrder(rawFrames)) ===
        JSON.stringify(terminalOrder(normalizedFrames)),
      contentBearingGlobalOrderChanged:
        JSON.stringify(rawContent) !== JSON.stringify(nextContent),
    },
  };
}

function assertCertified(row: CertificationRow): void {
  if (row.result !== "normalized") return;
  assert.ok(row.invariants, "normalized row must have invariants");
  const required = {
    sameFrameCount: row.invariants.sameFrameCount,
    sameSemanticFrameMultiset: row.invariants.sameSemanticFrameMultiset,
    samePerItemFrameOrder: row.invariants.samePerItemFrameOrder,
    sameDoneOrder: row.invariants.sameDoneOrder,
    sameDoneItemPayloads: row.invariants.sameDoneItemPayloads,
    sameGlobalDoneSkeleton: row.invariants.sameGlobalDoneSkeleton,
    sameTerminalOrder: row.invariants.sameTerminalOrder,
  };
  for (const [name, value] of Object.entries(required)) {
    assert.equal(value, true, `${basename(row.artifact)} failed invariant ${name}`);
  }
}

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  throw new Error(
    "usage: tsx provider-native-goat-corpus-certify.ts <upstream-artifact-dir-or-json> [...]",
  );
}

const files = (
  await Promise.all(inputs.map((input) => artifactFiles(input)))
).flat();
const rows: CertificationRow[] = [];
for (const file of files) {
  const row = await certifyArtifact(file);
  if (row === undefined) continue;
  assertCertified(row);
  rows.push(row);
}

const summary = {
  artifactCount: rows.length,
  normalized: rows.filter((row) => row.result === "normalized").length,
  unchanged: rows.filter((row) => row.result === "unchanged").length,
  skipped: rows.filter((row) => row.result === "skipped").length,
  movedFrames: rows.reduce((sum, row) => sum + (row.movedFrameCount ?? 0), 0),
  normalizedWithContentBearingGlobalOrderChange: rows.filter(
    (row) =>
      row.result === "normalized" &&
      row.invariants?.contentBearingGlobalOrderChanged === true,
  ).length,
  rawLifecycleWarnings: rows.reduce((sum, row) => {
    return (
      sum +
      Object.values(row.predictedRawLifecycleWarnings).reduce(
        (inner, value) => inner + value,
        0,
      )
    );
  }, 0),
  normalizedLifecycleWarnings: rows.reduce((sum, row) => {
    return (
      sum +
      Object.values(row.predictedNormalizedLifecycleWarnings ?? {}).reduce(
        (inner, value) => inner + value,
        0,
      )
    );
  }, 0),
};

process.stdout.write(JSON.stringify({ summary, rows }, null, 2) + "\n");
