import type { Usage } from "@earendil-works/pi-ai";

export type TerminalUsageClass = "done" | "failed" | "aborted" | "unsupported";

/**
 * Product usage captured at a terminal execution boundary.
 *
 * Semantic Conversion copies these values directly from Pi's final
 * AssistantMessage. Native preservation lanes may produce the same fact from
 * their own authoritative terminal wire. No Provider identity or pricing
 * information belongs in this contract.
 */
export interface TerminalUsageFact {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly terminalClass: TerminalUsageClass;
}

const TERMINAL_CLASSES: readonly TerminalUsageClass[] = Object.freeze([
  "done",
  "failed",
  "aborted",
  "unsupported",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTerminalClass(value: unknown): value is TerminalUsageClass {
  return TERMINAL_CLASSES.includes(value as TerminalUsageClass);
}

/**
 * Copies the three product metrics from Pi usage. Invalid runtime observations
 * are dropped so diagnostics can never change a successful model response.
 */
export function createTerminalUsageFact(
  usage: Usage,
  terminalClass: TerminalUsageClass,
): TerminalUsageFact | undefined {
  if (!isRecord(usage)) return undefined;
  const { input, output, cacheRead } = usage;
  if (
    !isTokenCount(input) ||
    !isTokenCount(output) ||
    !isTokenCount(cacheRead) ||
    !isTerminalClass(terminalClass)
  ) {
    return undefined;
  }
  return Object.freeze({ input, output, cacheRead, terminalClass });
}

/** Strict decoder for the persistence and Control Plane boundary. */
export function decodeTerminalUsageFact(
  value: unknown,
): TerminalUsageFact | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    !keys.every((key) =>
      ["input", "output", "cacheRead", "terminalClass"].includes(key),
    ) ||
    !isTokenCount(value.input) ||
    !isTokenCount(value.output) ||
    !isTokenCount(value.cacheRead) ||
    !isTerminalClass(value.terminalClass)
  ) {
    return undefined;
  }
  return Object.freeze({
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    terminalClass: value.terminalClass,
  });
}
