import type { Model } from "@earendil-works/pi-ai";

import { responsesToAnthropicMessagesProjector } from "./adapters/anthropic-messages.js";
import { responsesToBedrockConverseProjector } from "./adapters/bedrock.js";
import { responsesToCommandCodePrivateProjector } from "./adapters/commandcode-private.js";
import type { ResponsesTargetProjector } from "./adapters/contract.js";
import {
  responsesToGoogleGenerativeAIProjector,
  responsesToGoogleVertexProjector,
} from "./adapters/google.js";
import { responsesToMistralConversationsProjector } from "./adapters/mistral.js";
import { responsesToOpenAICompletionsProjector } from "./adapters/openai-completions.js";
import {
  responsesToAzureOpenAIResponsesProjector,
  responsesToOpenAICodexResponsesProjector,
  responsesToOpenAIResponsesProjector,
} from "./adapters/openai-responses.js";
import { responsesToPiMessagesProjector } from "./adapters/pi-messages.js";

const PROJECTORS: readonly ResponsesTargetProjector[] = Object.freeze([
  responsesToAnthropicMessagesProjector,
  responsesToAzureOpenAIResponsesProjector,
  responsesToBedrockConverseProjector,
  responsesToCommandCodePrivateProjector,
  responsesToGoogleGenerativeAIProjector,
  responsesToGoogleVertexProjector,
  responsesToMistralConversationsProjector,
  responsesToOpenAICodexResponsesProjector,
  responsesToOpenAICompletionsProjector,
  responsesToOpenAIResponsesProjector,
  responsesToPiMessagesProjector,
]);

const BY_API = new Map(PROJECTORS.map((projector) => [projector.api, projector]));

export function resolveResponsesTargetProjector(
  model: Model<string>,
): ResponsesTargetProjector | undefined {
  return BY_API.get(model.api);
}
