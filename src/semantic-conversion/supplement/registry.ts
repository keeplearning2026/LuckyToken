import type { Model } from "@earendil-works/pi-ai";

import { anthropicMessagesSupplementProjector } from "./projectors/anthropic.js";
import { bedrockConverseSupplementProjector } from "./projectors/bedrock.js";
import { commandCodePrivateSupplementProjector } from "./projectors/commandcode-private.js";
import type { SupplementProjector } from "./projectors/contract.js";
import {
  googleGenerativeAISupplementProjector,
  googleVertexSupplementProjector,
} from "./projectors/google.js";
import { mistralConversationsSupplementProjector } from "./projectors/mistral.js";
import { openAICompletionsSupplementProjector } from "./projectors/openai-completions.js";
import {
  azureOpenAIResponsesSupplementProjector,
  openAICodexResponsesSupplementProjector,
  openAIResponsesSupplementProjector,
} from "./projectors/openai-responses.js";
import { piMessagesSupplementProjector } from "./projectors/pi-messages.js";

const PROJECTORS: readonly SupplementProjector[] = Object.freeze([
  anthropicMessagesSupplementProjector,
  azureOpenAIResponsesSupplementProjector,
  bedrockConverseSupplementProjector,
  commandCodePrivateSupplementProjector,
  googleGenerativeAISupplementProjector,
  googleVertexSupplementProjector,
  mistralConversationsSupplementProjector,
  openAICodexResponsesSupplementProjector,
  openAICompletionsSupplementProjector,
  openAIResponsesSupplementProjector,
  piMessagesSupplementProjector,
]);

const BY_API = new Map(PROJECTORS.map((projector) => [projector.api, projector]));

export function resolveSupplementProjector(
  model: Model<string>,
): SupplementProjector | undefined {
  return BY_API.get(model.api);
}
