import type { Context, Message } from "@earendil-works/pi-ai";

/**
 * An envelope query, NOT a semantic invocation. Its placeholder content must
 * never reach a provider: the experimental transport replaces the payload and
 * checks the serialized native body before sending it.
 *
 * Certified scope: Pi 1.0 Responses APIs. Today their Context-dependent
 * envelope inputs are Copilot's last initiator and vision presence. Tools,
 * reasoning, continuity and message text affect the body, which remains native.
 */
export interface ResponsesEnvelopeContext {
  readonly mode: "for-context";
  readonly context: Context;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasImage(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (Array.isArray(value)) return value.some((item) => hasImage(item, depth + 1));
  const item = record(value);
  if (!item) return false;
  if (item.type === "input_image" || item.type === "image" || item.type === "image_url") return true;
  return Object.values(item).some((child) => hasImage(child, depth + 1));
}

/** Pure, bounded extraction; no schema validation, reference resolution or IO. */
export function responsesEnvelopeContext(value: unknown, receivedAt: number): ResponsesEnvelopeContext {
  const body = record(value);
  if (!body) throw new TypeError("Responses envelope context requires an object");
  const input = body.input;
  const last = Array.isArray(input) ? input.at(-1) : undefined;
  const agent = Array.isArray(input) && input.length > 0 && record(last)?.role !== "user";
  const images = hasImage(input);
  const messages: Message[] = [];
  // Vision must be attached to user/toolResult content: this is what Pi's
  // Copilot helper inspects. Empty image data is an internal presence marker.
  if (!agent || images) {
    messages.push({
      role: "user",
      content: images ? [{ type: "image", data: "", mimeType: "image/png" }] : "",
      timestamp: receivedAt,
    });
  }
  if (agent) {
    // A trailing system message can be collapsed by Pi normalization, changing
    // Copilot's initiator. An assistant marker retains the non-user fact.
    messages.push({
      role: "assistant", content: [], api: "Token-envelope-query",
      provider: "Token-envelope-query", model: "Token-envelope-query",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: receivedAt,
    });
  }
  return { mode: "for-context", context: { messages } };
}
