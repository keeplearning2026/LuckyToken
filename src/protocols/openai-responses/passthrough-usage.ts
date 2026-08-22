import {
  decodeNormalizedTerminalUsage,
  type NormalizedTerminalUsage,
} from "@luckytoken/provider-contract/usage";

import { parseSseFrames, sseFramePayload, type SseFrame } from "../sse-lines.js";

const EVIDENCE = "responses-terminal-usage-v1";
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
  if (isRecord(value.response)) return value.response;
  return value;
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

function partial(
  api: string,
  reason: "usage_absent" | "component_unreported" | "invalid_components",
  components: {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    reasoning?: number;
  },
): NormalizedTerminalUsage | undefined {
  return decodeNormalizedTerminalUsage({
    api,
    ...components,
    completeness: "partial",
    reason,
    evidence: EVIDENCE,
  });
}

function normalizeUsage(
  api: string,
  response: Record<string, unknown>,
): NormalizedTerminalUsage | undefined {
  if (response.usage === undefined || response.usage === null) {
    return partial(api, "usage_absent", {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
    });
  }
  if (!isRecord(response.usage)) return undefined;
  const usage = response.usage;
  const rawInput = token(usage.input_tokens);
  const output = token(usage.output_tokens);
  const wireTotal = token(usage.total_tokens);
  if (
    (usage.input_tokens !== undefined && rawInput === undefined) ||
    (usage.output_tokens !== undefined && output === undefined) ||
    (usage.total_tokens !== undefined && wireTotal === undefined)
  ) {
    return undefined;
  }

  const details = usage.input_tokens_details;
  if (details !== undefined && details !== null && !isRecord(details)) return undefined;
  const cachedValue = isRecord(details) ? details.cached_tokens : undefined;
  const writeValue = isRecord(details) ? details.cache_write_tokens : undefined;
  const cacheRead = cachedValue === undefined ? 0 : token(cachedValue);
  const cacheWrite = writeValue === undefined ? 0 : token(writeValue);
  if (cacheRead === undefined || cacheWrite === undefined) return undefined;

  const outputDetails = usage.output_tokens_details;
  if (outputDetails !== undefined && outputDetails !== null && !isRecord(outputDetails)) {
    return undefined;
  }
  const reasoningValue = isRecord(outputDetails)
    ? outputDetails.reasoning_tokens
    : undefined;
  const reasoning = reasoningValue === undefined ? undefined : token(reasoningValue);
  if (reasoningValue !== undefined && reasoning === undefined) return undefined;

  const partitionedInput = Math.max(0, (rawInput ?? 0) - cacheRead - cacheWrite);
  const components = {
    input: partitionedInput,
    cacheRead,
    cacheWrite,
    output: output ?? 0,
    ...(reasoning === undefined || reasoning > (output ?? 0) ? {} : { reasoning }),
  };
  if (rawInput === undefined || output === undefined || wireTotal === undefined) {
    return partial(api, "component_unreported", components);
  }

  const normalizedTotal =
    partitionedInput + cacheRead + cacheWrite + output;
  if (
    !Number.isSafeInteger(normalizedTotal) ||
    normalizedTotal !== wireTotal ||
    (reasoning !== undefined && reasoning > output)
  ) {
    return partial(api, "invalid_components", components);
  }
  const denominator = partitionedInput + cacheRead + cacheWrite;
  return decodeNormalizedTerminalUsage({
    api,
    ...components,
    normalizedTotal,
    ...(denominator > 0 ? { cacheHitRate: cacheRead / denominator } : {}),
    completeness: "complete",
    evidence: EVIDENCE,
  });
}

/**
 * Extract terminal Responses-wire usage from one buffered passthrough result.
 * The function never derives Complete usage from a non-terminal SSE event.
 */
export function extractResponsesPassthroughUsage(
  body: Uint8Array,
  contentType: string,
  api: string,
  missingContentTypeBodyKind: "json" | "event-stream" = "json",
): NormalizedTerminalUsage | undefined {
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
  return response === undefined ? undefined : normalizeUsage(api, response);
}
