export type OnlineTestJob = Readonly<
  | { kind: "json"; marker: string }
  | { kind: "sse"; marker: string }
  | { kind: "cancel-recovery"; marker: string }
>;

export type OnlineCoverageDimension =
  | "request-controls"
  | "messages"
  | "thinking"
  | "tools"
  | "usage-terminal"
  | "json"
  | "sse";

export interface OnlineConformanceCase {
  readonly id: string;
  readonly covers: readonly OnlineCoverageDimension[];
}

function conformanceCase(
  id: string,
  covers: readonly OnlineCoverageDimension[],
): OnlineConformanceCase {
  return Object.freeze({ id, covers: Object.freeze([...covers]) });
}

export const ONLINE_CONFORMANCE_CASES: readonly OnlineConformanceCase[] =
  Object.freeze([
    conformanceCase("system-controls-json", [
      "request-controls",
      "messages",
      "usage-terminal",
      "json",
    ]),
    conformanceCase("atomic-sse-events", [
      "thinking",
      "usage-terminal",
      "sse",
    ]),
    conformanceCase("historical-text", ["messages", "json"]),
    conformanceCase("thinking-round-trip", ["messages", "thinking", "json"]),
    conformanceCase("max-tokens-terminal", [
      "request-controls",
      "usage-terminal",
      "json",
    ]),
    conformanceCase("concurrent-isolation", ["messages", "json"]),
    conformanceCase("provider-tool-call-round-trip", [
      "messages",
      "thinking",
      "tools",
      "usage-terminal",
      "json",
    ]),
    conformanceCase("tool-result-omitted", ["messages", "tools", "json"]),
    conformanceCase("tool-result-text", ["messages", "tools", "json"]),
    conformanceCase("tool-result-error", ["messages", "tools", "json"]),
  ]);

export const OFFLINE_ONLY_PROTOCOL_CASES = Object.freeze([
  "malformed-known-events",
  "unknown-events",
  "terminal-less-eof",
  "retry-and-backoff",
  "utf8-and-chunk-splits",
  "image-capability-gate",
] as const);

function jobs(
  kind: OnlineTestJob["kind"],
  count: number,
): OnlineTestJob[] {
  return Array.from({ length: count }, (_unused, index) =>
    Object.freeze({
      kind,
      marker: `LT_${kind.replace("-", "_").toUpperCase()}_${String(index + 1).padStart(2, "0")}`,
    }),
  );
}

export function createOnlineTestPlan(): readonly OnlineTestJob[] {
  return Object.freeze([
    ...jobs("json", 36),
    ...jobs("sse", 14),
    ...jobs("cancel-recovery", 5),
  ]);
}
