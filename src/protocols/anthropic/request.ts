import type { Context } from "@earendil-works/pi-ai";

export class AnthropicRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicRequestError";
  }
}

export interface AnthropicTextInvocation {
  selector: string;
  context: Context;
  maxTokens: number;
  renderState: {
    clientModel: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAnthropicTextInvocation(
  value: unknown,
  receivedAt: number,
): AnthropicTextInvocation {
  if (!isRecord(value)) {
    throw new AnthropicRequestError("Request body must be a JSON object");
  }

  const { model, max_tokens: maxTokens, messages } = value;
  if (typeof model !== "string" || model.length === 0) {
    throw new AnthropicRequestError("model must be a non-empty string");
  }
  if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) <= 0) {
    throw new AnthropicRequestError("max_tokens must be a positive safe integer");
  }
  if (!Array.isArray(messages) || messages.length !== 1) {
    throw new AnthropicRequestError("The walking skeleton accepts exactly one user message");
  }

  const message = messages[0];
  if (
    !isRecord(message) ||
    message.role !== "user" ||
    typeof message.content !== "string"
  ) {
    throw new AnthropicRequestError("The walking skeleton accepts one string user message");
  }

  return {
    selector: model,
    context: {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: message.content }],
          timestamp: receivedAt,
        },
      ],
    },
    maxTokens: maxTokens as number,
    renderState: { clientModel: model },
  };
}
