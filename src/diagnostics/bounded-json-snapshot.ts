const MAX_SYNCHRONOUS_JSON_SNAPSHOT_BYTES = 1 * 1_024 * 1_024;
const MAX_SYNCHRONOUS_JSON_SNAPSHOT_DEPTH = 32;
const MAX_SYNCHRONOUS_JSON_SNAPSHOT_NODES = 32_768;

export type BoundedJsonSnapshotUnavailableReason =
  | "synchronous_json_snapshot_limit_exceeded"
  | "synchronous_json_snapshot_cycle"
  | "synchronous_json_snapshot_unsupported";

export type BoundedJsonSnapshotResult =
  | Readonly<{ kind: "captured"; bytes: Uint8Array }>
  | Readonly<{
      kind: "unavailable";
      reason: BoundedJsonSnapshotUnavailableReason;
    }>;

class SnapshotUnavailable extends Error {
  constructor(readonly reason: BoundedJsonSnapshotUnavailableReason) {
    super(reason);
  }
}

interface SnapshotBudget {
  bytes: number;
  nodes: number;
  readonly parts: string[];
}

function appendPart(budget: SnapshotBudget, part: string): void {
  const bytes = Buffer.byteLength(part, "utf8");
  if (budget.bytes + bytes > MAX_SYNCHRONOUS_JSON_SNAPSHOT_BYTES) {
    throw new SnapshotUnavailable("synchronous_json_snapshot_limit_exceeded");
  }
  budget.bytes += bytes;
  budget.parts.push(part);
}

function appendJsonString(budget: SnapshotBudget, value: string): void {
  // Avoid asking JSON.stringify to scan an unbounded string. JSON escaping
  // can only increase its output size, so this is a safe early rejection.
  if (value.length > MAX_SYNCHRONOUS_JSON_SNAPSHOT_BYTES) {
    throw new SnapshotUnavailable("synchronous_json_snapshot_limit_exceeded");
  }
  appendPart(budget, JSON.stringify(value));
}

function enterNode(budget: SnapshotBudget, depth: number): void {
  budget.nodes += 1;
  if (
    budget.nodes > MAX_SYNCHRONOUS_JSON_SNAPSHOT_NODES ||
    depth > MAX_SYNCHRONOUS_JSON_SNAPSHOT_DEPTH
  ) {
    throw new SnapshotUnavailable("synchronous_json_snapshot_limit_exceeded");
  }
}

function appendValue(
  budget: SnapshotBudget,
  value: unknown,
  depth: number,
  ancestors: Set<object>,
  arrayPosition: boolean,
): boolean {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    if (!arrayPosition) return false;
    enterNode(budget, depth);
    appendPart(budget, "null");
    return true;
  }

  enterNode(budget, depth);
  if (value === null) {
    appendPart(budget, "null");
    return true;
  }
  if (typeof value === "string") {
    appendJsonString(budget, value);
    return true;
  }
  if (typeof value === "boolean") {
    appendPart(budget, value ? "true" : "false");
    return true;
  }
  if (typeof value === "number") {
    appendPart(budget, Number.isFinite(value) ? String(value) : "null");
    return true;
  }
  if (typeof value === "bigint") {
    throw new SnapshotUnavailable("synchronous_json_snapshot_unsupported");
  }
  if (typeof value !== "object") {
    throw new SnapshotUnavailable("synchronous_json_snapshot_unsupported");
  }
  if (ancestors.has(value)) {
    throw new SnapshotUnavailable("synchronous_json_snapshot_cycle");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_SYNCHRONOUS_JSON_SNAPSHOT_NODES) {
        throw new SnapshotUnavailable(
          "synchronous_json_snapshot_limit_exceeded",
        );
      }
      appendPart(budget, "[");
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) appendPart(budget, ",");
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        ) {
          appendValue(budget, undefined, depth + 1, ancestors, true);
        } else {
          appendValue(budget, descriptor.value, depth + 1, ancestors, true);
        }
      }
      appendPart(budget, "]");
      return true;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SnapshotUnavailable("synchronous_json_snapshot_unsupported");
    }
    appendPart(budget, "{");
    let emitted = 0;
    // for..in permits stopping at the node/byte bound without first
    // allocating an unbounded key array. Inherited names are rejected below.
    for (const name in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.value === undefined ||
        typeof descriptor.value === "function" ||
        typeof descriptor.value === "symbol"
      ) {
        continue;
      }
      if (emitted > 0) appendPart(budget, ",");
      appendJsonString(budget, name);
      appendPart(budget, ":");
      appendValue(budget, descriptor.value, depth + 1, ancestors, false);
      emitted += 1;
    }
    appendPart(budget, "}");
    return true;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Creates a request-local JSON snapshot without invoking object conversion
 * hooks or retaining the input. Work and output are both strictly bounded.
 */
export function createBoundedJsonSnapshot(
  value: unknown,
): BoundedJsonSnapshotResult {
  const budget: SnapshotBudget = { bytes: 0, nodes: 0, parts: [] };
  try {
    const emitted = appendValue(budget, value, 0, new Set(), false);
    if (!emitted) {
      return Object.freeze({
        kind: "unavailable",
        reason: "synchronous_json_snapshot_unsupported",
      });
    }
    const encoded = new TextEncoder().encode(budget.parts.join(""));
    if (encoded.byteLength > MAX_SYNCHRONOUS_JSON_SNAPSHOT_BYTES) {
      return Object.freeze({
        kind: "unavailable",
        reason: "synchronous_json_snapshot_limit_exceeded",
      });
    }
    const bytes = new Uint8Array(encoded.byteLength);
    bytes.set(encoded);
    return Object.freeze({ kind: "captured", bytes });
  } catch (error) {
    return Object.freeze({
      kind: "unavailable",
      reason:
        error instanceof SnapshotUnavailable
          ? error.reason
          : "synchronous_json_snapshot_unsupported",
    });
  }
}

