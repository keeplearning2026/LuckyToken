import {
  decodeTerminalUsageFact,
  type TerminalUsageClass,
  type TerminalUsageFact,
} from "@token/provider-contract/usage";

import { parseSseFrames, sseFramePayload, type SseFrame } from "../sse-lines.js";

const TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function token(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function frameEvent(frame: SseFrame): string | undefined {
  for (const line of frame.lines) {
    if (line.kind !== "field") continue;
    const match = line.text.match(/^event:\s*(.*)$/u);
    if (match !== null) return match[1]?.trim();
  }
  return undefined;
}

function responseFromPayload(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return isRecord(value.response) ? value.response : value;
}

function terminalSseResponse(text: string): Record<string, unknown> | undefined {
  let terminal: Record<string, unknown> | undefined;
  for (const frame of parseSseFrames(text)) {
    const payload = sseFramePayload(frame);
    if (payload.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      continue;
    }
    const event = frameEvent(frame);
    const parsedType = isRecord(parsed) && typeof parsed.type === "string"
      ? parsed.type
      : undefined;
    if (
      (event === undefined || !TERMINAL_EVENTS.has(event)) &&
      (parsedType === undefined || !TERMINAL_EVENTS.has(parsedType))
    ) {
      continue;
    }
    const candidate = responseFromPayload(parsed);
    if (candidate !== undefined) terminal = candidate;
  }
  return terminal;
}

function terminalClass(response: Record<string, unknown>): TerminalUsageClass {
  return response.status === "completed" ? "done" : "failed";
}

function extractUsage(
  response: Record<string, unknown>,
): TerminalUsageFact | undefined {
  if (!isRecord(response.usage)) return undefined;
  const rawInput = token(response.usage.input_tokens);
  const output = token(response.usage.output_tokens);
  if (rawInput === undefined || output === undefined) return undefined;

  const details = response.usage.input_tokens_details;
  if (details !== undefined && details !== null && !isRecord(details)) {
    return undefined;
  }
  const cachedValue = isRecord(details) ? details.cached_tokens : undefined;
  const writeValue = isRecord(details) ? details.cache_write_tokens : undefined;
  const cacheRead = cachedValue === undefined ? 0 : token(cachedValue);
  const cacheWrite = writeValue === undefined ? 0 : token(writeValue);
  if (
    cacheRead === undefined ||
    cacheWrite === undefined ||
    cacheRead + cacheWrite > rawInput
  ) {
    return undefined;
  }

  return decodeTerminalUsageFact({
    input: rawInput - cacheRead - cacheWrite,
    output,
    cacheRead,
    terminalClass: terminalClass(response),
  });
}

/** Extract one product usage fact from a terminal native Responses result. */
export function extractResponsesPassthroughUsage(
  body: Uint8Array,
  contentType: string,
  missingContentTypeBodyKind: "json" | "event-stream" = "json",
): TerminalUsageFact | undefined {
  const text = new TextDecoder().decode(body);
  let response: Record<string, unknown> | undefined;
  const normalizedContentType = contentType.trim().toLowerCase();
  if (
    normalizedContentType.includes("text/event-stream") ||
    (normalizedContentType.length === 0 &&
      missingContentTypeBodyKind === "event-stream")
  ) {
    response = terminalSseResponse(text);
  } else {
    try {
      response = responseFromPayload(JSON.parse(text) as unknown);
    } catch {
      return undefined;
    }
  }
  return response === undefined ? undefined : extractUsage(response);
}
