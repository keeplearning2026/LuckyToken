import type {
  ReasoningAdapter,
  ReasoningHistoryPreparationInput,
} from "./contract.js";
import {
  fallback,
  findCompatibleThinkingContinuity,
  native,
  sourceMatchesTarget,
} from "./shared.js";
import { projectBedrockPayload } from "./payload.js";

function isAnthropicClaudeModel(id: string, name: string): boolean {
  const candidates = [id, name].map((value) => value.toLowerCase());
  return candidates.some(
    (value) =>
      value.includes("anthropic.claude") ||
      value.includes("anthropic/claude") ||
      value.includes("claude"),
  );
}

export const bedrockConverseReasoningAdapter: ReasoningAdapter = Object.freeze({
  id: "bedrock-converse-stream",
  api: "bedrock-converse-stream",
  projectPayload: projectBedrockPayload,
  prepareHistory(input: ReasoningHistoryPreparationInput) {
    if (!input.model.reasoning) {
      return fallback("target does not support reasoning");
    }
    if (!sourceMatchesTarget(input.history.source, input)) {
      return fallback("Bedrock reasoning provenance is not compatible with the target");
    }
    if (isAnthropicClaudeModel(input.model.id, input.model.name)) {
      const signature = findCompatibleThinkingContinuity(
        input,
        "opaque-signature",
      );
      return signature === undefined
        ? fallback("Bedrock Claude replay requires its reasoning signature")
        : native({ thinkingSignature: signature.value });
    }
    return native();
  },
});
