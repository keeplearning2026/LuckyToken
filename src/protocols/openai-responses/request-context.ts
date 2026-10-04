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

/** Match the existing Client converter's provable image-file materialization. */
function isImageDataUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^data:([^;]+);base64,(.*)$/su.exec(value);
  if (!match || !/^image\//iu.test(match[1] ?? "")) return false;
  const data = match[2] ?? "";
  return data.length > 0 && data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(data);
}

function hasImageParts(value: unknown, output: boolean): boolean {
  const parts = Array.isArray(value) ? value : output ? [value] : [];
  return parts.some((part) => {
    const block = record(part);
    const type = block?.type;
    if (!output && type === "input_file") return isImageDataUrl(block?.file_data);
    return type === "input_image" || (output && (type === "output_image" || type === "computer_screenshot"));
  });
}

function hasImage(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  return input.some((raw) => {
    const item = record(raw);
    if (!item) return false;
    if ((item.type === undefined || item.type === "message") && item.role === "user")
      return hasImageParts(item.content, false);
    switch (item.type) {
      case "image_generation_call":
        return !["in_progress", "generating", "searching", "failed"].includes(String(item.status))
          && isImageDataUrl(item.result);
      case "function_call_output": case "custom_tool_call_output":
      case "local_shell_call_output": case "shell_call_output":
      case "apply_patch_call_output": case "computer_call_output":
        return hasImageParts(item.output, true);
      default:
        return false;
    }
  });
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
