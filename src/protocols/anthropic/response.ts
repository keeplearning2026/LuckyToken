import type { AssistantMessage } from "@earendil-works/pi-ai";

export interface AnthropicTextMessage {
  id: string;
  container: null;
  content: Array<{
    citations: null;
    text: string;
    type: "text";
  }>;
  model: string;
  role: "assistant";
  stop_details: null;
  stop_reason: "end_turn";
  stop_sequence: null;
  type: "message";
  usage: {
    cache_creation: null;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    inference_geo: null;
    input_tokens: number;
    output_tokens: number;
    output_tokens_details: null;
    server_tool_use: null;
    service_tier: null;
  };
}

export function renderAnthropicTextMessage(
  message: AssistantMessage,
  clientModel: string,
  messageId: string,
): AnthropicTextMessage {
  if (message.stopReason !== "stop") {
    throw new Error(`Unsupported walking-skeleton stop reason: ${message.stopReason}`);
  }

  const content = message.content.map((block) => {
    if (block.type !== "text") {
      throw new Error(`Unsupported walking-skeleton content: ${block.type}`);
    }
    return {
      citations: null,
      text: block.text,
      type: "text" as const,
    };
  });

  return {
    id: messageId,
    container: null,
    content,
    model: clientModel,
    role: "assistant",
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: message.usage.cacheWrite,
      cache_read_input_tokens: message.usage.cacheRead,
      inference_geo: null,
      input_tokens: message.usage.input,
      output_tokens: message.usage.output,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}
