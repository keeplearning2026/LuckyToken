import {
  decodeTerminalUsageFact,
  type TerminalUsageFact,
} from "@token/provider-contract/usage";
import {
  parseSseFrames,
  sseFramePayload,
} from "../protocols/sse-lines.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function token(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

interface UsageAccumulator {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function mergeReportedUsage(
  accumulator: UsageAccumulator,
  usage: Record<string, unknown>,
): boolean {
  for (const [wireName, targetName] of [
    ["input_tokens", "input"],
    ["cache_read_input_tokens", "cacheRead"],
    ["cache_creation_input_tokens", "cacheWrite"],
    ["output_tokens", "output"],
  ] as const) {
    if (!hasOwn(usage, wireName)) continue;
    const value = token(usage[wireName]);
    if (value === undefined) return false;
    accumulator[targetName] = value;
  }
  return true;
}

function completeUsage(
  accumulator: UsageAccumulator,
): TerminalUsageFact | undefined {
  const { input, cacheRead, cacheWrite, output } = accumulator;
  if (
    input === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    output === undefined
  ) {
    return undefined;
  }
  return decodeTerminalUsageFact({
    input,
    cacheRead,
    output,
    terminalClass: "done",
  });
}

function parseJsonUsage(text: string): TerminalUsageFact | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.type !== "message" || !isRecord(parsed.usage)) {
    return undefined;
  }
  const accumulator: UsageAccumulator = {};
  return mergeReportedUsage(accumulator, parsed.usage)
    ? completeUsage(accumulator)
    : undefined;
}

function parseSseUsage(text: string): TerminalUsageFact | undefined {
  const accumulator: UsageAccumulator = {};
  let sawMessageStart = false;
  let sawMessageStop = false;

  for (const frame of parseSseFrames(text)) {
    const payload = sseFramePayload(frame);
    if (payload.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      return undefined;
    }
    if (!isRecord(parsed)) return undefined;

    if (parsed.type === "message_start") {
      if (
        sawMessageStart ||
        !isRecord(parsed.message) ||
        !isRecord(parsed.message.usage) ||
        !mergeReportedUsage(accumulator, parsed.message.usage)
      ) {
        return undefined;
      }
      sawMessageStart = true;
      continue;
    }
    if (parsed.type === "message_delta") {
      if (!sawMessageStart) return undefined;
      if (
        parsed.usage !== undefined &&
        (!isRecord(parsed.usage) ||
          !mergeReportedUsage(accumulator, parsed.usage))
      ) {
        return undefined;
      }
      continue;
    }
    if (parsed.type === "message_stop") {
      if (!sawMessageStart) return undefined;
      sawMessageStop = true;
      break;
    }
  }

  return sawMessageStop ? completeUsage(accumulator) : undefined;
}

/**
 * Extract a complete normalized usage fact from one already-buffered native
 * Anthropic response. Streaming facts commit only after message_stop.
 * Unsupported encodings and any missing or invalid component produce no
 * observation; serving remains byte-preserving.
 */
export function extractAnthropicNativeTerminalUsage(
  body: Uint8Array,
  contentType: string,
): TerminalUsageFact | undefined {
  const normalizedContentType = contentType.toLowerCase();
  const text = new TextDecoder().decode(body);
  if (normalizedContentType.includes("text/event-stream")) {
    return parseSseUsage(text);
  }
  if (normalizedContentType.includes("application/json")) {
    return parseJsonUsage(text);
  }
  return undefined;
}
