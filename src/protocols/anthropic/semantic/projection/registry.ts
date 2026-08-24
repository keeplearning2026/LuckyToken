import type { Model } from "@earendil-works/pi-ai";

import { supportsAnthropicBedrockProjection } from "./adapters/bedrock.js";

export type AnthropicPayloadProjectorId =
  | "commandcode-private"
  | "anthropic-messages"
  | "google"
  | "bedrock"
  | "pi-messages"
  | "mistral"
  | "openai-responses"
  | "openai-completions";

/** Selects only a real Adapter with at least one audited target mapping. */
export function selectAnthropicPayloadProjector(
  model: Model<string>,
): AnthropicPayloadProjectorId | undefined {
  switch (model.api) {
    case "commandcode-private":
      return "commandcode-private";
    case "anthropic-messages":
      return "anthropic-messages";
    case "google-generative-ai":
    case "google-vertex":
      return "google";
    case "bedrock-converse-stream":
      return supportsAnthropicBedrockProjection(model) ? "bedrock" : undefined;
    case "pi-messages":
      return "pi-messages";
    case "mistral-conversations":
      return "mistral";
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return "openai-responses";
    case "openai-completions":
      return "openai-completions";
    default:
      return undefined;
  }
}
