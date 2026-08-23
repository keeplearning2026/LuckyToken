import type { Model } from "@earendil-works/pi-ai";

import { anthropicMessagesReasoningAdapter } from "./adapters/anthropic-messages.js";
import { commandCodePrivateReasoningAdapter } from "./adapters/commandcode-private.js";
import { bedrockConverseReasoningAdapter } from "./adapters/bedrock-converse-stream.js";
import {
  googleGenerativeAIReasoningAdapter,
  googleVertexReasoningAdapter,
} from "./adapters/google.js";
import { mistralConversationsReasoningAdapter } from "./adapters/mistral-conversations.js";
import { openAICompletionsReasoningAdapter } from "./adapters/openai-completions.js";
import {
  azureOpenAIResponsesReasoningAdapter,
  openAICodexResponsesReasoningAdapter,
  openAIResponsesReasoningAdapter,
} from "./adapters/openai-responses-family.js";
import { piMessagesReasoningAdapter } from "./adapters/pi-messages.js";
import type { ReasoningAdapter } from "./adapters/contract.js";

const REGISTERED_ADAPTERS: readonly ReasoningAdapter[] = Object.freeze([
  anthropicMessagesReasoningAdapter,
  azureOpenAIResponsesReasoningAdapter,
  bedrockConverseReasoningAdapter,
  googleGenerativeAIReasoningAdapter,
  googleVertexReasoningAdapter,
  mistralConversationsReasoningAdapter,
  openAICodexResponsesReasoningAdapter,
  openAICompletionsReasoningAdapter,
  openAIResponsesReasoningAdapter,
  piMessagesReasoningAdapter,
  commandCodePrivateReasoningAdapter,
]);

const ADAPTERS = new Map<string, ReasoningAdapter>(
  REGISTERED_ADAPTERS.map((adapter) => [adapter.api, adapter]),
);

export const PINNED_REASONING_APIS: readonly string[] = Object.freeze([
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

export function resolveReasoningAdapter(
  model: Model<string>,
): ReasoningAdapter | undefined {
  return ADAPTERS.get(model.api);
}
