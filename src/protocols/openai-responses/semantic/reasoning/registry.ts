import type { Model } from "@earendil-works/pi-ai";

import { responsesToAnthropicMessagesReasoningAdapter } from "./adapters/anthropic-messages.js";
import { responsesToCommandCodePrivateReasoningAdapter } from "./adapters/commandcode-private.js";
import { responsesToBedrockConverseReasoningAdapter } from "./adapters/bedrock-converse-stream.js";
import {
  responsesToGoogleGenerativeAIReasoningAdapter,
  responsesToGoogleVertexReasoningAdapter,
} from "./adapters/google.js";
import { responsesToMistralConversationsReasoningAdapter } from "./adapters/mistral-conversations.js";
import { responsesToOpenAICompletionsReasoningAdapter } from "./adapters/openai-completions.js";
import {
  responsesToAzureOpenAIResponsesReasoningAdapter,
  responsesToOpenAICodexResponsesReasoningAdapter,
  responsesToOpenAIResponsesReasoningAdapter,
} from "./adapters/openai-responses-family.js";
import { responsesToPiMessagesReasoningAdapter } from "./adapters/pi-messages.js";
import type { ResponsesReasoningAdapter } from "./adapters/contract.js";

const REGISTERED_ADAPTERS: readonly ResponsesReasoningAdapter[] = Object.freeze([
  responsesToAnthropicMessagesReasoningAdapter,
  responsesToAzureOpenAIResponsesReasoningAdapter,
  responsesToBedrockConverseReasoningAdapter,
  responsesToGoogleGenerativeAIReasoningAdapter,
  responsesToGoogleVertexReasoningAdapter,
  responsesToMistralConversationsReasoningAdapter,
  responsesToOpenAICodexResponsesReasoningAdapter,
  responsesToOpenAICompletionsReasoningAdapter,
  responsesToOpenAIResponsesReasoningAdapter,
  responsesToPiMessagesReasoningAdapter,
  responsesToCommandCodePrivateReasoningAdapter,
]);

const ADAPTERS = new Map<string, ResponsesReasoningAdapter>(
  REGISTERED_ADAPTERS.map((adapter) => [adapter.api, adapter]),
);

export const PINNED_RESPONSES_REASONING_APIS: readonly string[] = Object.freeze([
  "anthropic-messages",
  "azure-openai-responses",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "openai-codex-responses",
  "openai-completions",
  "openai-responses",
  "pi-messages",
]);

export function resolveResponsesReasoningAdapter(
  model: Model<string>,
): ResponsesReasoningAdapter | undefined {
  return ADAPTERS.get(model.api);
}
