import type { Context, Message } from "@earendil-works/pi-ai";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function hasDeclaredImage(value: unknown): boolean {
  const block = record(value);
  if (block?.type === "image") return true;
  if (block?.type !== "document") return false;
  const source = record(block.source);
  return source?.type === "content" && Array.isArray(source.content)
    && source.content.some((part) => record(part)?.type === "image");
}

/** Query-only markers for installed Pi's Anthropic envelope consumers.
 * Never send their temporary payload: no text, schema or history is authoritative.
 * Initial top-level catalog presence is retained; historical tool-state updates
 * are not invented from unclaimed Client extensions. */
export function anthropicEnvelopeContext(value: unknown, receivedAt: number): Context {
  const body = record(value);
  if (!body) throw new TypeError("Anthropic envelope context requires an object");
  const input = Array.isArray(body.messages) ? body.messages : [];
  const last = record(input.at(-1));
  const agent = input.length > 0 && (last?.role !== "user"
    || (Array.isArray(last.content) && record(last.content.at(-1))?.type === "tool_result"));
  const images = input.some((raw) => {
    const message = record(raw);
    if (message?.role !== "user" || !Array.isArray(message.content)) return false;
    return message.content.some((rawBlock) => {
      const block = record(rawBlock);
      if (hasDeclaredImage(block)) return true;
      return block?.type === "tool_result" && Array.isArray(block.content)
        && block.content.some(hasDeclaredImage);
    });
  });
  return markers(agent, images, Array.isArray(body.tools) && body.tools.length > 0, receivedAt);
}

/** Collapse the max result, never its Native body, to currently certified facts. */
export function boundAnthropicEnvelopeContext(context: Context, receivedAt: number): Context {
  const last = context.messages.at(-1);
  const agent = last !== undefined && last.role !== "user";
  const images = context.messages.some((message) => (message.role === "user" || message.role === "toolResult")
    && Array.isArray(message.content) && message.content.some((part) => part.type === "image"));
  return markers(agent, images, (context.tools?.length ?? 0) > 0, receivedAt);
}

function markers(agent: boolean, images: boolean, hasTools: boolean, receivedAt: number): Context {
  const messages: Message[] = [];
  if (!agent || images) messages.push({
    role: "user", content: images ? [{ type: "image", data: "", mimeType: "image/png" }] : "",
    timestamp: receivedAt,
  });
  if (agent) messages.push({
    role: "assistant", content: [], api: "Token-envelope-query", provider: "Token-envelope-query", model: "Token-envelope-query",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: receivedAt,
  });
  return { messages, ...(hasTools ? {
    tools: [{ name: "Token-envelope-tool-presence", description: "Query-only presence marker", parameters: { type: "object", properties: {} } }],
  } : {}) };
}
