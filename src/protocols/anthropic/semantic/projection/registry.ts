import type { Model } from "@earendil-works/pi-ai";

import type { AnthropicSemanticInvocation } from "../invocation.js";
import type { AnthropicEffortPlan } from "../reasoning/contract.js";
import {
  projectAnthropicToAnthropicMessagesReasoning,
  projectAnthropicToAnthropicMessagesSupplement,
} from "./adapters/anthropic-messages.js";
import {
  projectAnthropicToBedrockReasoning,
  projectAnthropicToBedrockSupplement,
  supportsAnthropicBedrockProjection,
} from "./adapters/bedrock.js";
import {
  projectAnthropicToCommandCodePrivateReasoning,
  projectAnthropicToCommandCodePrivateSupplement,
} from "./adapters/commandcode-private.js";
import {
  projectAnthropicToGoogleReasoning,
  projectAnthropicToGoogleSupplement,
} from "./adapters/google.js";
import {
  projectAnthropicToMistralReasoning,
  projectAnthropicToMistralSupplement,
} from "./adapters/mistral.js";
import {
  projectAnthropicToOpenAICompletionsReasoning,
  projectAnthropicToOpenAICompletionsSupplement,
} from "./adapters/openai-completions.js";
import {
  projectAnthropicToOpenAIResponsesReasoning,
  projectAnthropicToOpenAIResponsesSupplement,
  type AnthropicResponsesTargetApi,
} from "./adapters/openai-responses.js";
import {
  projectAnthropicToPiMessagesReasoning,
  projectAnthropicToPiMessagesSupplement,
} from "./adapters/pi-messages.js";
import type { AnthropicPayloadProjectionResult } from "./contract.js";

export interface AnthropicTargetProjectionInput {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly effortPlan: AnthropicEffortPlan;
  readonly payload: unknown;
}

export interface AnthropicTargetAdapter {
  readonly id: string;
  /**
   * Optional separate reasoning phase. Adapters add this only when their
   * Provider wire requires reasoning work outside ordinary projection.
   */
  readonly projectReasoning?: (
    input: AnthropicTargetProjectionInput,
  ) => AnthropicPayloadProjectionResult;
  readonly projectSupplement?: (
    input: AnthropicTargetProjectionInput,
  ) => AnthropicPayloadProjectionResult;
}

function targetAdapter(
  id: string,
  projectSupplement: NonNullable<AnthropicTargetAdapter["projectSupplement"]>,
  projectReasoning: NonNullable<AnthropicTargetAdapter["projectReasoning"]>,
): AnthropicTargetAdapter {
  return Object.freeze({ id, projectSupplement, projectReasoning });
}

const COMMANDCODE_PRIVATE = targetAdapter(
  "commandcode-private",
  projectAnthropicToCommandCodePrivateSupplement,
  projectAnthropicToCommandCodePrivateReasoning,
);
const ANTHROPIC_MESSAGES = targetAdapter(
  "anthropic-messages",
  projectAnthropicToAnthropicMessagesSupplement,
  projectAnthropicToAnthropicMessagesReasoning,
);
function googleProjection(
  projection: typeof projectAnthropicToGoogleSupplement,
): NonNullable<AnthropicTargetAdapter["projectSupplement"]> {
  return (input) => {
    const api = input.model.api;
    if (api !== "google-generative-ai" && api !== "google-vertex") {
      throw new Error(`Anthropic Google Adapter received Pi API ${api}`);
    }
    return projection({ ...input, api });
  };
}
const GOOGLE = targetAdapter(
  "google",
  googleProjection(projectAnthropicToGoogleSupplement),
  googleProjection(projectAnthropicToGoogleReasoning),
);
const BEDROCK = targetAdapter(
  "bedrock",
  projectAnthropicToBedrockSupplement,
  projectAnthropicToBedrockReasoning,
);
const PI_MESSAGES = targetAdapter(
  "pi-messages",
  projectAnthropicToPiMessagesSupplement,
  projectAnthropicToPiMessagesReasoning,
);
const MISTRAL = targetAdapter(
  "mistral",
  projectAnthropicToMistralSupplement,
  projectAnthropicToMistralReasoning,
);
function responsesProjection(
  projection: typeof projectAnthropicToOpenAIResponsesSupplement,
): NonNullable<AnthropicTargetAdapter["projectSupplement"]> {
  return (input) => {
    const api = input.model.api;
    if (
      api !== "openai-responses" &&
      api !== "azure-openai-responses" &&
      api !== "openai-codex-responses"
    ) {
      throw new Error(`Anthropic Responses Adapter received Pi API ${api}`);
    }
    return projection({
      ...input,
      api: api as AnthropicResponsesTargetApi,
    });
  };
}
const OPENAI_RESPONSES = targetAdapter(
  "openai-responses",
  responsesProjection(projectAnthropicToOpenAIResponsesSupplement),
  responsesProjection(projectAnthropicToOpenAIResponsesReasoning),
);
const OPENAI_COMPLETIONS = targetAdapter(
  "openai-completions",
  projectAnthropicToOpenAICompletionsSupplement,
  projectAnthropicToOpenAICompletionsReasoning,
);

/** Selects only an Adapter with at least one audited target mapping. */
export function selectAnthropicTargetAdapter(
  model: Model<string>,
): AnthropicTargetAdapter | undefined {
  switch (model.api) {
    case "commandcode-private":
      return COMMANDCODE_PRIVATE;
    case "anthropic-messages":
      return ANTHROPIC_MESSAGES;
    case "google-generative-ai":
    case "google-vertex":
      return GOOGLE;
    case "bedrock-converse-stream":
      return supportsAnthropicBedrockProjection(model) ? BEDROCK : undefined;
    case "pi-messages":
      return PI_MESSAGES;
    case "mistral-conversations":
      return MISTRAL;
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return OPENAI_RESPONSES;
    case "openai-completions":
      return OPENAI_COMPLETIONS;
    default:
      return undefined;
  }
}
